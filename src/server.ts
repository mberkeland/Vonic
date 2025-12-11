import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import { fromEnv } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient } from "./client";
import { Buffer } from "node:buffer";
import WebSocket from "ws";
import http from "http";
import { parse } from "url";
import {
  Session,
  ActiveSession,
  SessionEventData,
} from "./types";
import {
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  dTools,
} from "./consts";

import { MCPClient } from "mcp-client";
import axios from "axios";

const fs = require('fs');

require('events').EventEmitter.defaultMaxListeners = 0;

const server_url = process.env.VCR_INSTANCE_PUBLIC_URL;
const server_wss = server_url.replace("https:", "wss:");
console.log("URLs: ", server_url, server_wss)
require('dotenv').config();
const app = express();
var brain = process.env.brain;
var currentPrompt = DefaultSystemPrompt;
app.use(bodyParser.json());
app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "OPTIONS,GET,POST,PUT,DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");
  next();
});
var toFile = server_url.includes('debug');
var fileClient = null;
const bedrockClient = new NovaSonicBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: fromEnv(),
  },
});
var gTemp = 0.2;
var sessions: any = [];
var finals: any = [];
/* Periodically check for and close inactive sessions (every minute).
 * Sessions with no activity for over 5 minutes will be force closed
 */
setInterval(() => {
  //console.log("Running session cleanup check");
  const now = Date.now();
  const sess = bedrockClient.getActiveSessions();
  if (sess?.length) {
    console.log("Active sessions: ", sess?.length)
    sess.forEach((sessionId: string) => {
      const lastActivity = bedrockClient.getLastActivityTime(sessionId);

      const fiveMinsInMs = 5 * 60 * 1000;
      if (now - lastActivity > fiveMinsInMs) {
        console.log(`Closing inactive session ${sessionId} due to inactivity.`);
        try {
          bedrockClient.forceCloseSession(sessionId);
        } catch (error: unknown) {
          console.error(
            `Error force closing inactive session ${sessionId}:`,
            error
          );
        }
      }
    });
  }
}, 60000);

// Track active websocket connections with their session IDs
const activeSessions = new Map<WebSocket, ActiveSession>();

app.get('/_/health', async (req, res) => {
  res.sendStatus(200);
});
app.get('/_/metrics', async (req, res) => {
  res.sendStatus(200);
});
app.get("/keepalive", (req, res) => {
  res.sendStatus(200);
});
async function getClient(url: string) {
  console.log("Getting mcp server...")
  const client = new MCPClient({
    name: "Test",
    version: "1.0.0",
  });
  await client.connect({
    type: "httpStream",
    url: url,
  });
  console.log("Established MCP client connection to: ", url)
  return client;
}
// Create HTTP server and attach ws server to it
const port: number = parseInt(process.env.VCR_PORT || "8010");
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: "/socket" });

// Main websocket handling: move express-ws handler here
wss.on("connection", async (ws: WebSocket, req) => {
  // Parse query params from the socket request URL
  const parsedUrl = parse(req.url || "", true);
  const q: any = parsedUrl.query || {};

  const sessionId = '' + q.sessionId;
  const resultsUrl = '' + (q.results ?? '');
  const streamId = q.streamid ?? '';
  console.log("New client parameters:", q);
  const source_num = q.phone ?? '';
  var Uinterval: any = null;
  var myPrompt = currentPrompt;
  var stopSending = false;
  var lang = q.lang ?? "en";
  var voice = "tiffany"
  var temp = parseFloat(q.temp ?? 0.01);
  var promptId = q.promptId ?? '';
  console.log("Using passed in promptId: ", promptId)
  var utterances: any[] = [];
  switch (('' + lang).toLowerCase()) {
    case 'en':
    case 'us':
    case 'fr':
    case 'es':
    case 'it':
    case 'de':
      voice = 'tiffany';
      break;
    case 'gb':
      voice = 'amy';
      break;
    case 'pt':
      voice = 'camila';
      break;
    case 'hi':
      voice = 'aditi';
      break;
    default:
      break;
  }
  var tools: any[] = [];
  dTools.forEach((tool) => {
    if (tool.toolSpec.name == 'getDateAndTimeTool' || tool.toolSpec.name == 'getWeatherTool' ) {
      tools.push(tool);
      console.log("Pushing tool: ", tool)
    }
  });
  console.log("Pushed tools: ", tools)
  sessions[sessionId] = { needsHangup: false, needsFlush: false, block: true, ws: ws, tools: tools };
  const sendError = (message: string, details: string) => {
    console.error("sendError, Error:", details);
    try {
      ws.send(JSON.stringify({ event: "error", data: { message, details } }));
    } catch (e) {
      console.error("failed sending error to client", e);
    }
  };
  async function endFlow() {
    if (resultsUrl) {
      console.log("Sending hangup and utterances.")
      try {
        axios.post(resultsUrl, { hangup: true, sessionId: sessionId, utterances: utterances });
      } catch (e) {
        console.log("Error sending to resultsUrl ", resultsUrl, (e as any)?.status)
      }
    }
  }
  async function sendResults(results: any, sessionId: string) {
    results.sessionId = sessionId;
    results.time = Date.now();

    console.log("Sending hangup final disposition. ", results)
    try {
      axios.post(resultsUrl, results);
    } catch (e) {
      console.log("Error sendResults to resultsUrl ", resultsUrl, (e as any)?.status)
    }
    sessions[sessionId].needsHangup = true;
  }
  function setUpEventHandlers(
    session: Session,
    ws: WebSocket,
    sessionId: string
  ): void {
    function handleSessionEvent(
      session: Session,
      ws: WebSocket,
      eventName: string,
      isError: boolean = false
    ) {
      session.onEvent(eventName, (data: SessionEventData) => {
        console[isError ? "error" : "debug"]("Server received event: " + eventName, data);
        try {
          ws.send(JSON.stringify({ event: { [eventName]: { ...data } } }));
        } catch (err) {
          console.log("Caught error trying to write to WS: ", err)
        }
        if (eventName == 'toolResult') {
          if (data.result?.latitude) { // Yep, send an RCS
            console.log("Got location, send RCS? ", eventName, sessions[sessionId].phone, data.result?.latitude ?? 'No Latitude')
            sessions[sessionId].location = { longitude: '' + data.result?.longitude, latitude: '' + data.result?.latitude }
          }
          // Check for specific tool handling (transfer, report, query for more, etc) from theBrain here...
          if (data.result?.response?.outcome) { // Report back and end call?
            console.log("Tool has determined the needed skillset! ", data, data.result.response);
            sessions[sessionId].needsHangup = true;
            sendResults(data.result.response, sessionId);
          }
        }
        if (eventName == 'textOutput') {
          console.log("Handling special text output!!! Session: ")
          if (data.role == "USER") {
            console.log("Reset the deadman timer!!!!")
            sessions[sessionId].deads = 0;
            if (sessions[sessionId].deadtimer) {
              console.log("Reset the deadman timer!!!!")
              clearInterval(sessions[sessionId].deadtimer);
              sessions[sessionId].deadtimer = null;
            }
          }
          if (data.role == "ASSISTANT") {
            if (sessions[sessionId].deadtimer) {
              console.log("Reset the assistant deadman timer!!!!")
              clearInterval(sessions[sessionId].deadtimer);
              sessions[sessionId].deadtimer = null;
            }
            sessions[sessionId].deadtimer = setInterval(async () => {
              sessions[sessionId].deads++;
              console.log("Deadman timer hit...", sessions[sessionId].deads)
              if (sessions[sessionId].deads > 2) {
                try {
                  // HANGUP HERE
                  if (resultsUrl) {
                    endFlow();
                  }
                  sessions[sessionId]?.ws?.close()
                } catch (e) {
                  console.log("Unable to hang up deadman call ", sessionId)
                }
                clearInterval(sessions[sessionId].deadtimer);
                sessions[sessionId].deadtimer = null;
              }
            }, 20000);
          }
          if (data.content.toLowerCase().includes("goodbye") || data.content.toLowerCase().includes("have a great day") || data.content.toLowerCase().includes("let me transfer you") || data.content.toLowerCase().includes("let me connect you with")) {
            sessions[sessionId].needsHangup = true;
            console.log("Got a goodbye... shut it down! ", session)
          }
          try {
            if (finals[data.contentId] || data.role === 'USER') {
              console.log("Pushing data upstream...", data)
              data.streamId = streamId;
              data.phone_to = source_num;
              data.NSsessionId = data.sessionId;
              data.sessionId = sessionId;
              if (resultsUrl) {
                data.time = Date.now();
                axios.post(resultsUrl, data);
                utterances.push(data);
              }
              delete finals[data.contentId];
            }
          } catch (e) {
            console.log("Error with pusher");
          }
          if (data.content?.startsWith('{ "interrupted"') && !sessions[sessionId].block) { // Aggressive barge-in!
            console.log("Detecting textOutput barge in...")
            ws.send(JSON.stringify({ action: "clear" }));
            sessions[sessionId].needsFlush = true;
          }
        }
        if (sessions[sessionId].needsHangup && (eventName === 'contentEnd') && (data.type === 'AUDIO') && (data.stopReason === 'END_TURN')) {
          console.log("Ok. shut this down NOW!");
          setTimeout(() => {
            if (!sessions[sessionId]) {
              return;
            }
            try {
              //HANGUP HERE
              if (resultsUrl) {
                endFlow();
              }
              sessions[sessionId]?.ws?.close()
            } catch (e) {
              console.log("Unable to hang up call ", sessionId)
            }
          }, 10000) //20000
        }
        if ((eventName === 'contentStart') && (data.role === 'ASSISTANT') && (data.type === 'TEXT') && data.additionalModelFields.includes('FINAL')) { // Final assesment of the text
          finals[data.contentId] = true;
        }
        if (!sessions[sessionId].block && (eventName === 'contentStart') && (data.role === 'USER') && (data.type === 'TEXT')) { // Barge in?
          console.log("Detecting barge in...")
          ws.send(JSON.stringify({ action: "clear" }));
          sessions[sessionId].needsFlush = true;
        }
      });
    }

    handleSessionEvent(session, ws, "contentStart");
    handleSessionEvent(session, ws, "textOutput");
    handleSessionEvent(session, ws, "error", true);
    handleSessionEvent(session, ws, "toolUse");
    handleSessionEvent(session, ws, "toolResult");
    handleSessionEvent(session, ws, "contentEnd");

    session.onEvent("streamComplete", () => {
      console.log("Stream completed for client:", sessionId);
      ws.send(JSON.stringify({ event: "streamComplete" }));
    });

    const CHUNK_SIZE_BYTES = 640;
    const SAMPLES_PER_CHUNK = CHUNK_SIZE_BYTES / 2;

    let audioBuffer: Int16Array | null = null;
    let sndcnt = 0;
    var interval = setInterval(() => {
      if (sessions[sessionId].needsFlush) {
        sessions[sessionId].needsFlush = false;
        console.log("Flushing input buffer for barge-in!!!!")
        ws.send(JSON.stringify({ action: "clear" }));
        audioBuffer = new Int16Array(0);
      } else if (audioBuffer && audioBuffer.length) {
        const chunk = audioBuffer.slice(0, SAMPLES_PER_CHUNK);
        try {
          ws.send(chunk);
        } catch (e) {
          console.error("Error sending audio chunk to client", e);
        }
        audioBuffer = audioBuffer.slice(SAMPLES_PER_CHUNK)
        if (!(sndcnt++ % 50)) {
          console.log("Sent up the socket: ", sndcnt)
        }
      }
    }, 18) // 18 ms Interval for feeding the websocket.
    setTimeout(() => { // Block barge-in at the beginning...
      console.log("Freeing up barge-in block")
      sessions[sessionId].block = false;
    }, 5000);
    session.onEvent("audioOutput", (data: SessionEventData) => {
      const buffer = Buffer.from(data["content"], "base64");
      const newPcmSamples = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / Int16Array.BYTES_PER_ELEMENT
      );
      if (audioBuffer && audioBuffer.length && (buffer.length / Int16Array.BYTES_PER_ELEMENT > 640)) {
        console.log("New audio sample: ", buffer.length / Int16Array.BYTES_PER_ELEMENT, audioBuffer.length)
      }
      let combinedSamples: Int16Array;
      if (audioBuffer) {
        combinedSamples = new Int16Array(
          audioBuffer.length + newPcmSamples.length
        );
        combinedSamples.set(audioBuffer);
        combinedSamples.set(newPcmSamples, audioBuffer.length);
      } else {
        combinedSamples = newPcmSamples;
      }
      audioBuffer = combinedSamples;
    });
  }
  const initializeSession = async () => {
    try {
      const session = bedrockClient.createStreamSession(sessionId, tools, temp);
      bedrockClient.initiateSession(sessionId)
        .then((success) => {
          // Catch this for too-many-streams error?
          console.log("InitializeSession success? ", success)
          if (!success) {
            stopSending = true;
            if (Uinterval) {
              clearInterval(Uinterval);
              Uinterval = null;
            }
            console.log("Playing busy message")
            // BUSY MESSAGE?
            setTimeout(() => {
              if (!sessions[sessionId]) {
                return;
              }
              try {
                if (resultsUrl) {
                  endFlow()
                }
                sessions[sessionId]?.ws?.close()
              } catch (e) {
                console.log("Unable to hang up call on initiateSession", sessionId)
              }
            }, 23000)
          }
          return;
        }).catch((error) => {
          console.error("Error initializing the session and waiting: ", error);
          return;
        })
      activeSessions.set(ws, { sessionId, session });
      setUpEventHandlers(session, ws, sessionId);
      var currentAudio = { ...DefaultAudioOutputConfiguration };
      currentAudio.voiceId = voice;
      await session.setupPromptStart(currentAudio);
      await session.setupSystemPrompt(
        undefined,
        myPrompt//"You are Claude, an AI assistant having a voice conversation. Keep responses concise and conversational."
      );
      await session.setupStartAudio();

      console.log(`Session ${sessionId} fully initialized and ready for audio`);
      ws.send(
        JSON.stringify({
          event: "sessionReady",
          message: "Session initialized and ready for audio",
        })
      );
      if (!Uinterval) Uinterval = setInterval(async () => { // In case the UUID has not shown up in the webhook event yet... 
        if (bedrockClient.isSessionReady(sessionId)) {
          if (Uinterval) {
            clearInterval(Uinterval);
            Uinterval = null;
          }
          var file = "hellot.pcm";
          if (lang == 'es') file = "hablame.wav"
          if (lang == 'fr') file = "parlemoi.pcm"
          if (lang == 'de') file = "deutsch.pcm"
          if (lang == 'it') file = "italiano.pcm"
          console.log("Using file: ", file)
          fs.readFile("public/" + file, async (err, buffer) => {
            if (err) {
              console.error('Error reading audio file:', err);
              return;
            }
            console.log('Audio file loaded into Buffer, sending :', buffer.length);
            await session.streamAudio(buffer);
          });
        }
      }, 500);
    } catch (error) {
      console.log("Failed to in initializesession stuff initialize session", error)
      sendError("Failed to initialize session", String(error));
      try { ws.close(); } catch (e) { }
    }
  };
  const handleMessage = async (msg: Buffer | string) => {
    const sessionData = activeSessions.get(ws);
    if (!sessionData) {
      sendError("Session not found", "No active session for this connection");
      return;
    }
    const { session } = sessionData;
    try {
      let audioBuffer: Buffer | undefined;
      try {
        const jsonMsg = JSON.parse(msg.toString());
        if (jsonMsg.event?.audioInput) {
          throw new Error("Received audioInput during initialization");
        }
        console.log("Event received of type:", jsonMsg);
        switch (jsonMsg.type) {
          case "promptStart":
            await session.setupPromptStart();
            break;
          case "systemPrompt":
            console.log("Setting up system prompt from JSON: ", jsonMsg.data)
            await session.setupSystemPrompt(undefined, jsonMsg.data);
            break;
          case "audioStart":
            await session.setupStartAudio();
            break;
          case "stopAudio":
            await session.endAudioContent();
            await session.endPrompt();
            console.log("Session cleanup complete");
            break;
          case "barge":
            console.log("Clearing ws buffer on barge in")
            var cmd = { action: "clear" };
            ws.send(JSON.stringify(cmd));
            break;
          default:
          //ws.send(msg);
        }
      } catch (e) {
        // Handle audio processing

        audioBuffer = Buffer.from(msg as Buffer);
        if (audioBuffer && !stopSending) {
          await session.streamAudio(audioBuffer);
        }
      }
    } catch (error) {
      sendError("Error processing message", String(error));
    }
  };
  //////////////////////////// Audio processing
  ws.on("message", handleMessage as any);
  ws.on("close", async () => {
    console.log("Client disconnected:", sessionId);
    if (Uinterval) {
      clearInterval(Uinterval);
      Uinterval = null;
    }
    if (!sessions[sessionId]) return;
    if (sessions[sessionId]?.deadtimer) {
      clearInterval(sessions[sessionId].deadtimer);
    }
    if (resultsUrl) {
      endFlow();
    }
    const sessionData = activeSessions.get(ws);
    if (!sessionData) {
      console.log(`No session to clean up for: ${sessionId}`);
      activeSessions.delete(ws);
      return;
    }
    const { session } = sessionData;
    if (!bedrockClient.isSessionActive(sessionId)) {
      activeSessions.delete(ws);
      return;
    }
    try {
      await Promise.race([
        (async () => {
          await session.endAudioContent();
          await session.endPrompt();
          await session.close();
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Session cleanup timeout")), 3000)
        ),
      ]);
      console.log(`Successfully cleaned up session: ${sessionId}`);
      if (sessions[sessionId]?.ws) {
        console.log("Terminating!")
        sessions[sessionId]?.ws?.terminate();
      }
    } catch (error) {
      console.error(`Error cleaning up session ${sessionId}:`, error);
      try {
        bedrockClient.forceCloseSession(sessionId);
        console.log(`Force closed session: ${sessionId}`);
      } catch (e) {
        console.error(`Failed to force close session ${sessionId}:`, e);
      }
    } finally {
      activeSessions.delete(ws);
    }
  });
  initializeSession();
});

/* SERVER LOGIC */
setInterval(() => {
  wss.clients.forEach(function each(client: any) {
    console.log("GOT OPEN SOCKET!!! ", client.readyState, client.url)
    if (client.readyState == client.CLOSING) {
      client.terminate();
    }
  })
}, 1000);

const server = httpServer.listen(port, () =>
  console.log(`Original server listening on port ${port}`)
);

// Gracefully shut down.
process.on("SIGINT", async () => {
  console.log("Shutting down servers...");

  const forceExitTimer = setTimeout(() => {
    console.error("Forcing server shutdown after timeout");
    process.exit(1);
  }, 5000);

  try {
    const sessionPromises: Promise<void>[] = [];
    activeSessions.forEach(({ sessionId }, ws) => {
      console.log(`Closing session ${sessionId} during shutdown`);
      sessionPromises.push(
        bedrockClient.closeSession(sessionId).catch((error: unknown) => {
          console.error(
            `Error closing session ${sessionId} during shutdown:`,
            error
          );
          bedrockClient.forceCloseSession(sessionId);
        })
      );
      try { ws.close(); } catch (e) { }
    });

    await Promise.all(sessionPromises);
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
    ]);

    clearTimeout(forceExitTimer);
    console.log("Servers shut down");
    process.exit(0);
  } catch (error: unknown) {
    console.error("Error during server shutdown:", error);
    process.exit(1);
  }
});