import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import expressWs from "express-ws";
import * as path from "path";
import { fromEnv } from "@aws-sdk/credential-providers";
import { NovaSonicBidirectionalStreamClient } from "./client";
import { Buffer } from "node:buffer";
import WebSocket from "ws";
import {
  Session,
  ActiveSession,
  SessionEventData,
  WebhookResponse,
} from "./types";
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  DefaultTextConfiguration,
  DefaultToolSchema,
  WeatherToolSchema,
  dTools,
} from "./consts";

import { v4 as uuidv4 } from "uuid";
import { vcr } from '@vonage/vcr-sdk';
//import utils from './vutils.cjs';
import { ConversationRole } from "@aws-sdk/client-bedrock-runtime";
import { MCPClient } from "mcp-client";
import axios from "axios";

const { readFileSync, createWriteStream } = require('fs');
const dgram = require('node:dgram'); // UDP client
const { spawn, execSync } = require('child_process');
const getFileHeaders = require('wav-headers');
const fs = require('fs');

require('events').EventEmitter.defaultMaxListeners = 0;

const server_url = process.env.VCR_INSTANCE_PUBLIC_URL;
const server_wss = server_url.replace("https:", "wss:");
console.log("URLs: ", server_url, server_wss)
require('dotenv').config();
console.log("AWS Key: ", process.env.AWS_ACCESS_KEY_ID)
const app = express();
const wsInstance = expressWs(app);
const Pusher = require("pusher");
var pusher;
var pchannel = "nova";
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
const AWS_PROFILE_NAME: string = process.env.AWS_PROFILE || "";
const bedrockClient = new NovaSonicBidirectionalStreamClient({
  requestHandlerConfig: {
    maxConcurrentStreams: 10,
  },
  clientConfig: {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: fromEnv(),
  },
});

const vcrstate = vcr.getInstanceState();
//console.log("VCR Global Session: ", vcr.getGlobalSession());


var gTemp = 0.2;
// redis these?
//var cons = [];
var sessions = [];
var finals = [];
// end redis

const connectionType: string = "vonage";
// Spawn off the audio VAD/Cleanup process
var sendBackProcessedAudio = false; //(process.env.SEND_BACK_PROCESSED_AUDIO == 'true') ?? false;
var filter = process.env.filter?.toLowerCase?.() == "true";
var maxfilters = 40;
var testnumbers = "";
var audio;
if (filter && process.env.audio) {
  console.log("Using audio processor: ", "public/" + process.env.audio)
  audio = spawn("public/" + process.env.audio, ['public/Vonage_Engineering_sound_manager_license_key.dat']);
  audio.on('exit', function (code, signal) {
    console.log('child process exited with ' +
      `code ${code} and signal ${signal}`);
  });
  audio.stdout.on('data', (data) => {
    //console.log(`stdout: ${data}`);
  });

  audio.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });
  audio.on('close', (code) => {
    console.log(`child process exited with code ${code}`);
  });
}
if (process.env.pusher_id) {
  pusher = new Pusher({
    appId: process.env.pusher_id,
    key: process.env.pusher_key,
    secret: process.env.pusher_secret,
    useTLS: true, // optional, defaults to false
    cluster: "us3"
  });
}

/////////////////////////////// Audio stuff.....
const udpSignalingPort = 32768;
const udpFirstPort = 32769;
const udpLastPort = 65535;
const aspHost = process.env.asphost || 'localhost';
// TBD clear all ports on Immersitech ASP service <<<<<<<<<

const maxPorts = udpLastPort - udpFirstPort + 1;
const udpPorts = new Set();

var udpClientSignaling;
if (filter) {

  udpClientSignaling = dgram.createSocket('udp4');

  udpClientSignaling.on('error', (err) => {
    console.log(`udpClientSignaling error:\n${err.stack}`);
    udpClientSignaling.close();
  });

  udpClientSignaling.on('message', (msg, rinfo) => {

    // very verbose log
    // console.log(`udpClient got: ${msg} from ${rinfo.address}:${rinfo.port}`);

    console.log('rcv msg signaling client, port:', rinfo.port);

    // const port = rinfo.port;

    // const portString = String(port);

    // if (port == udpSignalingPort) {

    const bufferCommand = msg.subarray(0, 2);
    const command = parseInt(bufferCommand.toString("hex"), 16);

    const bufferRelatedPort = msg.subarray(2, 4);
    const relatedPort = parseInt(bufferRelatedPort.toString("hex"), 16);

    console.log('\nreceived on signaling port ...');
    console.log('command:', command);
    console.log('related port:', relatedPort);

    switch (command) {
      case 2:
        console.log(`port ${relatedPort} ERROR !!!`);
        app.set('udp_port_' + relatedPort, false);
        break;

      case 3:
        console.log(`port ${relatedPort} opened`);
        app.set('udp_port_' + relatedPort, true);
        break;

      case 4:
        console.log(`port ${relatedPort} closed`);
        app.set('udp_port_' + relatedPort, false);
        udpPorts.delete(relatedPort); // port is now available again
        break;

      default:
        console.log(`received unknown command ${command} !!!`);
    }

    //--

    udpClientSignaling.on('listening', () => {

      const signalingAddress = udpClientSignaling.address();
      console.log(`UDP signaling traffic on ${signalingAddress.address}:${signalingAddress.port}`);

    });

  });
}
async function openPort(port) {

  const hexString = '0000' + port.toString(16).toUpperCase().padStart(4, 0);
  console.log('open port hex string:', hexString);

  const payloadToSp = Buffer.from(hexString, 'hex');

  let status;

  udpClientSignaling.send(payloadToSp, udpSignalingPort, aspHost, function (error) {
    if (error) {
      console.log('error trying to open port', port, ':', error);
      status = false;
    }
    else {
      console.log('open port', port, 'command sent');
      status = true;
      vcrstate.increment("currentfilters", 1);
    }
  });

  return status;

};

//---

async function closePort(port) {

  app.set('udp_port_' + port, false); // set port as not available

  const hexString = '0001' + port.toString(16).toUpperCase().padStart(4, 0);
  console.log('close port hex string:', hexString);

  const payloadToSp = Buffer.from(hexString, 'hex');

  let status;

  udpClientSignaling.send(payloadToSp, udpSignalingPort, aspHost, function (error) {
    if (error) {
      console.log('close port', port, 'error:', error);
      status = false;
    }
    else {
      console.log('close port', port, 'command sent');
      status = true;
      vcrstate.decrement("currentfilters", 1);
    }
  });

  return status;

};

//---

async function getUdpPort() {

  let port = udpFirstPort;

  while (udpPorts.has(port)) {
    port++;
  };

  if (port <= udpLastPort) { udpPorts.add(port) };

  if (port == udpLastPort + 1) { port = 0 };  // no more ports available

  // port = 32770; // just for testing error report

  if (port != 0) {
    openPort(port); // Open port on the Immersitech ASP server
  }

  return (port) // was udpFirstPort!!!

}

//--

async function removeUdpPort(port) {

  const portClosed = await closePort(port);

  if (portClosed) { // Do not release it YET, wait for Immersitech to let it go
    //    udpPorts.delete(port);
    return (true);
  } else {  // THis does not matter, the command was sent, it doesn;t wait so this always happens
    //console.log('>>> ERROR - Failed to close UDP port on Immersitech middelware server:', port);
    return (false);
  };

}
////////////////////////////// End Audio stuff

// const connectionType: string = "json";

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

wsInstance.getWss().on("connection", (ws: WebSocket) => {
  console.log("Websocket connection is open");
});

app.get('/_/health', async (req, res) => {
  res.sendStatus(200);
});
app.get('/_/metrics', async (req, res) => {
  res.sendStatus(200);
});
app.get("/keepalive", (req, res) => {
  //console.log("Keepalive: " + req.query);
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
    url: url,//"http://localhost:8080/mcp",
  });
  console.log("Established MCP client connection to: ", url)
  return client;
}

async function deadConnection(id) {
  if (!id) return true;
  var exists = await vcrstate.get('' + id);
  if (exists && ('' + exists).length > 5) {
    return true;
  }

  return false;
}
wsInstance.app.ws("/socket", async (ws: WebSocket, req: Request) => {
  const handleClose = async () => {
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
    if (sessions[sessionId]?.mediaUdpPort) {
      removeUdpPort(sessions[sessionId].mediaUdpPort);
      sessions[sessionId].mediaUdpPort = null;
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
      //sessions[sessionId]=null;
    }
  };
  const sessionId = '' + req.query.sessionId; //uuidv4();
  console.log("New client connected:", sessionId);
  console.log("New client parameters:", req.query);
  if (await deadConnection(sessionId)) {
    console.log("Closing WS connection due to deadconnection for sessionId: ", sessionId);
    ws.close();
    await handleClose();
    return;
  }
  const resultsUrl = '' + req.query.results; //uuidv4();
  console.log("resultsUrl = ", resultsUrl)
  vcrstate.set('' + sessionId, sessionId).then(() => {
    vcrstate.expire('' + sessionId, 21610);
    console.log("Setting session expiry to 6 hours ", sessionId)
  })

  const con_uuid = req.query.con_uuid;
  const isVideo = req.query.video;
  const useFilter = req.query.usefilter;
  const streamId = req.query.streamid ?? '';

  const sendError = (message: string, details: string) => {
    console.error("sendError, Error:", details);
    ws.send(JSON.stringify({ event: "error", data: { message, details } }));
  };
  const source_num = req.query.orig_to ?? '';
  var Uinterval = null;
  var cntr = 0;
  var myPrompt = currentPrompt;
  var myTools = '';
  var stopSending = false;
  var pid = 0;
  var temp = 0.01;
  var promptId = req.query.promptId ?? '';
  console.log("Using passed in promptId: ", promptId)
  var cur = null;
  var orig_number = req.query.orig_number ?? null;
  var LOOPBACK = false;
  var voice = "tiffany";
  var options = {
    channels: 1,
    sampleRate: 16000,
    bitDepth: 16,
    dataLength: 0
  };
  var utterances = [];
  if (cur) {
    myPrompt = cur.prompt;
    myTools = cur.tools ? cur.tools : '';
    pid = cur.id;
    temp = cur.temp ? parseFloat('' + cur.temp) : 0.01;
    console.log("Using special prompt: ", cur.id, cur.title, source_num, cur.phones, myTools)
  }
  var brainVals; // GET Values from TheBrain here!!!!
  //language, temperature
  var gender = 'female';
  try {
    var url = brain + '/' + sessionId + '/prompt';
    console.log("Getting prompt from: ", url)
    var myResp = await axios.get(url);
    brainVals = myResp.data;
    console.log("Got brainVals! ", brainVals.prompt, brainVals.agent)
    if (brainVals.agent.gender) gender = brainVals.agent.gender;
    if (brainVals.agent.temperature) temp = parseFloat(brainVals.agent.gender);
  } catch (e) {
    console.log("Unable to contact the Brain!", e.status)
  }
  var lang = 'en';
  if (brainVals) {
    if (brainVals.prompt) myPrompt = brainVals.prompt;
    if (brainVals.language) {
      lang = brainVals.language;
      switch (('' + brainVals.lang).toLowerCase()) {
        case 'en':
          voice = 'tiffany';
          if (gender == 'male') voice = 'matthew';
          break;
        case 'us':
          voice = 'tiffany';
          if (gender == 'male') voice = 'matthew';
          break;
        case 'gb':
          voice = 'amy';
          break;
        case 'fr':
          voice = 'ambre';
          if (gender == 'male') voice = 'florian';
          break;
        case 'es':
          voice = 'lupe';
          if (gender == 'male') voice = 'carlos';
          break;
        case 'it':
          voice = 'beatrice';
          if (gender == 'male') voice = 'lorenzo';
          break;
        case 'de':
          voice = 'greta';
          if (gender == 'male') voice = 'lennart';
          break;
        default:
          break;
      }
    }
  }
  var tools = [];
  dTools.forEach((tool) => {
    //console.log("Tool? ", session.tools,tool.toolSpec.name )
    if (tool.toolSpec.name == 'getDateAndTimeTool' || tool.toolSpec.name == 'getWeatherTool' || tool.toolSpec.name == 'ceecee') {
      tools.push(tool);
      console.log("Pushing tool: ", tool)
    }
  });
  if (brainVals?.tools?.length) {
    brainVals.tools.forEach((tool) => {
      console.log("Tool? ", tool.name)
      var atool = {
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: {
            json: tool.inputschema
          },
          url: tool.url,
          key: tool.key,
        }
      }
      tools.push(atool);
      console.log("Pushing dynamic tool: ", atool)
    });
  }
  console.log("Pushed tools: ", tools)
  sessions[sessionId] = { needsHangup: false, needsFlush: false, block: true, ws: ws, tools: tools };
  var badcnt = 0;
  if (con_uuid) {
    sessions[sessionId].closetimer = setInterval(async () => {
      badcnt++;
      var con = await vcrstate.get('' + con_uuid);
      if ((con && con["close"]) || (badcnt > 125)) {
        //    if (sessions[sessionId].close) {
        console.log("Closetimer hit, with close indicator (or badcnt) ", badcnt);
        if (Uinterval) {
          clearInterval(Uinterval);
          Uinterval = null;
        }
        sessions[sessionId].close = false;
        clearInterval(sessions[sessionId].closetimer);
        sessions[sessionId].closetimer = null;
        console.log("Call completed, closing socket: ", sessionId)
        if (sessions[sessionId].deadtimer) {
          clearInterval(sessions[sessionId].deadtimer);
          sessions[sessionId].deadtimer = null;
        }
        ws.close();
      }
      //console.log("closetimer");
    }, 5000);
  }
  async function endFlow() {
    if (resultsUrl) {
      console.log("Sending hangup and utterances.")
      try {
        axios.post(resultsUrl, { hangup: true, sessionId: sessionId, utterances: utterances });
      } catch (e) {
        console.log("Error sending to resultsUrl ", resultsUrl, e.status)
      }
    }
  }
  async function sendResults(results, sessionId) {
    results.sessionId = sessionId;
    results.time = Date.now();

    console.log("Sending hangup final disposition. ", results)
    try {
      axios.post(resultsUrl, results);
    } catch (e) {
      console.log("Error sendResults to resultsUrl ", resultsUrl, e.status)
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
            //              sendLocation(sessions[sessionId].phone, locText, data.result?.latitude, data.result?.longitude)
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
                  if (sessions[sessionId].mediaUdpPort) {
                    removeUdpPort(sessions[sessionId].mediaUdpPort);
                    sessions[sessionId].mediaUdpPort = null;
                  }
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
              } else {
                try {
                  /*
                  console.log("Deadman cons: ", sessionId, sessions[sessionId].cons)
                  var con = await vcrstate.get(sessions[sessionId].cons);
                  if (con) {
                    console.log("Got con from vcrstate: ", con)
                  }
                */
                } catch (err) {
                }
              }
            }, 20000);
          }
          if (data.content.toLowerCase().includes("goodbye") || data.content.toLowerCase().includes("have a great day") || data.content.toLowerCase().includes("let me transfer you") || data.content.toLowerCase().includes("let me connect you with")) {
            sessions[sessionId].needsHangup = true;
            console.log("Got a goodbye... shut it down! ", session)
          }
          try {
            if (finals[data.contentId] || data.role === 'USER') {
              console.log("Pushing trigger...", pchannel, data)
              data.pid = pid;
              data.streamId = streamId;
              data.phone_to = source_num;
              data.NSsessionId = data.sessionId;
              data.sessionId = sessionId;
              if (pusher) pusher.trigger(pchannel, "event", data);
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
              if (sessions[sessionId].mediaUdpPort) {
                removeUdpPort(sessions[sessionId].mediaUdpPort);
                sessions[sessionId].mediaUdpPort = null;
              }
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
        ws.send(chunk);
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
      //let audioBuffer: Int16Array | null = null;
      const buffer = Buffer.from(data["content"], "base64");
      const newPcmSamples = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.length / Int16Array.BYTES_PER_ELEMENT
      );
      if (audioBuffer && audioBuffer.length && (buffer.length / Int16Array.BYTES_PER_ELEMENT > 640)) {
        console.log("New audio sample: ", buffer.length / Int16Array.BYTES_PER_ELEMENT, audioBuffer.length)
      }
      if (connectionType === "json") {
        console.log("data", data);
        ws.send(JSON.stringify({ event: { audioOutput: { ...data } } }));
      } else if (connectionType === "vonage") {
        let combinedSamples: Int16Array;
        if (audioBuffer) {
          //console.log("Combining samples: ", audioBuffer.length, newPcmSamples.length)
          combinedSamples = new Int16Array(
            audioBuffer.length + newPcmSamples.length
          );
          combinedSamples.set(audioBuffer);
          combinedSamples.set(newPcmSamples, audioBuffer.length);
          //console.log("Combining audioBuffers");
        } else {
          combinedSamples = newPcmSamples;
        }
        audioBuffer = combinedSamples;
      }
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
            if (sessions[sessionId]?.mediaUdpPort) {
              removeUdpPort(sessions[sessionId].mediaUdpPort);
              sessions[sessionId].mediaUdpPort = null;
            }
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
      if (!Uinterval /*&& (con_uuid || isVideo)*/) Uinterval = setInterval(async () => { // In case the UUID has not shown up in the webhook event yet... 
        console.log("Checking for hello con or isVideo...", isVideo, con_uuid)
        if (/*isVideo &&*/ bedrockClient.isSessionReady(sessionId)) {
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
      ws.close();
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
        if (connectionType === "json") {
          const msgJson = JSON.parse(msg.toString());
          audioBuffer = Buffer.from(msgJson.event.audioInput.content, "base64");
        } else if (connectionType === "vonage") {
          audioBuffer = Buffer.from(msg as Buffer);
        }
        if (audioBuffer && !stopSending) {
          if (filter && udpClientMedia) {
            //ws.send(msg)
            let payloadToSp = Buffer.from('0005', 'hex'); // set payload message header code
            // apply htons processing on audio payload before sending to signal processing server
            const buffer: Buffer = Buffer.from(msg as Buffer);
            for (let i = 0; i < 320; i++) {
              //              const buffer: Buffer = Buffer.from(msg as Buffer);
              let x = i * 2;
              payloadToSp = Buffer.concat([payloadToSp, Buffer.from(buffer.subarray(x + 1, (x) + 2))]);
              payloadToSp = Buffer.concat([payloadToSp, Buffer.from(buffer.subarray(x, (x) + 1))]);
            }
            udpClientMedia.send(payloadToSp, mediaUdpPort, aspHost, function (error) {
              if (error) {
                console.log('>>> error sending payload to UDP port', mediaUdpPort, error);
              }
            });
          } else {
            await session.streamAudio(audioBuffer);
          }
        }
      }
    } catch (error) {
      sendError("Error processing message", String(error));
    }
  };
  //////////////////////////// Audio processing
  var udpClientMedia;
  var mediaUdpPort;
  var startTime = Date.now();
  if (LOOPBACK) {
    ws.on('message', (msg) => {
      if (typeof msg === "string") {
        console.log(msg);
      } else {
        ws.send(msg)
      }
    });

    ws.on('close', () => {
      console.log("websocket closed")
    })
  } else {
    if (filter) {
      var used = await vcrstate.get("currentfilters");
      testnumbers = await vcrstate.get("testnumbers") ?? "";
      var maxfilters = await vcrstate.get("filters") ?? 100;
      console.log(`MAX FILTERS= ${maxfilters}, USED= ${used}`)
      if (testnumbers.includes('' + orig_number)) {
        console.log("Skipping filtering for test number")
      } else if ((used !== null) && (parseInt('' + used) >= parseInt('' + maxfilters))) {
        console.log(`MAX FILTERS= ${maxfilters}, USED= ${used}... skip filtering on this`)
      } else if (isVideo && !useFilter) {
        console.log("Skipping audio filter for video connection (unless specifically requested. ", isVideo, useFilter);
      } else if (testnumbers.includes('' + orig_number)) {
        console.log(`Testnumber detected... skip filtering on this`, orig_number, testnumbers);
      } else {
        udpClientMedia = dgram.createSocket('udp4');
        mediaUdpPort = await getUdpPort();
        sendBackProcessedAudio = true; //(process.env.SEND_BACK_PROCESSED_AUDIO == 'true') ?? false;
        console.log('Got UDP port:', mediaUdpPort);

        if (mediaUdpPort != 0) {
          sessions[sessionId].mediaUdpPort = mediaUdpPort;
          udpClientMedia.on('error', (err) => {
            console.log(`udpClientMedia error:\n${err.stack}`);
            udpClientMedia.close();
          });

          //--

          udpClientMedia.on('message', async (msg, rinfo) => {
            const sessionData = activeSessions.get(ws);
            if (!sessionData || stopSending) {
              //sendError("Session not found", "No active session for this connection");
              return;
            }
            const { session } = sessionData;
            // console.log('message size:', msg.length);

            // console.log('rcv msg media client, port:', rinfo.port, 'uuid:', originalUuid);

            let payloadFromSp = Buffer.alloc(0);

            // apply ntohs processing on audio payload received from signal processor
            for (let i = 0; i < 320; i++) {
              payloadFromSp = Buffer.concat([payloadFromSp, Buffer.from(msg.subarray(i * 2 + 1, (i * 2) + 2))]);
              payloadFromSp = Buffer.concat([payloadFromSp, Buffer.from(msg.subarray(i * 2, (i * 2) + 1))]);
            }
            if (sendBackProcessedAudio) {
              cntr++;
              if (!(cntr % 100) || payloadFromSp.length > 640) console.log("Sending back processed audio " + cntr, Date.now() - startTime, payloadFromSp.length)
              await session.streamAudio(payloadFromSp);
              //ws.send(payloadFromSp); // send back the processed audio
            }
          });
        }
      }// Filter
    }
    //////////////////////////// End audio processing
    initializeSession();
    ws.on("message", handleMessage);
    ws.on("close", handleClose);
  } // Not loopback
});

/* SERVER LOGIC */
setInterval(() => {
  const wss = wsInstance.getWss();
  wss.clients.forEach(function each(client) {
    //    if (client.readyState === WebSocket.OPEN) {
    console.log("GOT OPEN SOCKET!!! ", client.readyState, client.url)
    if (client.readyState == client.CLOSING) {
      client.terminate();
    }
    //    }
  })
}, 1000);

const port: number = parseInt(process.env.VCR_PORT || "8010");
const server = app.listen(port, () =>
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
      ws.close();
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

app.get('/_/health', async (req, res) => {
  res.sendStatus(200);
});
app.get('/_/metrics', async (req, res) => {
  res.sendStatus(200);
});

app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});
