import {
  BedrockRuntimeClient,
  BedrockRuntimeClientConfig,
  InvokeModelWithBidirectionalStreamCommand,
  InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import axios from "axios";
//@ts-ignore
import https from "https";
import {
  NodeHttp2Handler,
  NodeHttp2HandlerOptions,
} from "@smithy/node-http-handler";
import { Provider } from "@smithy/types";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { InferenceConfig } from "./types";
import { Subject } from "rxjs";
import { take } from "rxjs/operators";
import { firstValueFrom } from "rxjs";
import {
  DefaultAudioInputConfiguration,
  DefaultAudioOutputConfiguration,
  DefaultSystemPrompt,
  DefaultTextConfiguration,
  dTools,
} from "./consts";
import { BedrockKnowledgeBaseClient } from "./bedrock-kb-client";

export interface NovaSonicBidirectionalStreamClientConfig {
  requestHandlerConfig?:
  | NodeHttp2HandlerOptions
  | Provider<NodeHttp2HandlerOptions | void>;
  clientConfig: Partial<BedrockRuntimeClientConfig>;
  inferenceConfig?: InferenceConfig;
}

export class StreamSession {
  private audioBufferQueue: Buffer[] = [];
  private maxQueueSize = 200; // Maximum number of audio chunks to queue
  private isProcessingAudio = false;
  private isActive = true;

  constructor(
    private sessionId: string,
    private client: NovaSonicBidirectionalStreamClient
  ) { }

  // Register event handlers for this specific session
  public onEvent(
    eventType: string,
    handler: (data: any) => void
  ): StreamSession {
    this.client.registerEventHandler(this.sessionId, eventType, handler);
    return this; // For chaining
  }

  public async setupPromptStart(
    audioConfig: typeof DefaultAudioOutputConfiguration = DefaultAudioOutputConfiguration
  ): Promise<void> {
    this.client.setupPromptStartEvent(this.sessionId, audioConfig);
  }

  public async setupSystemPrompt(
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): Promise<void> {
    this.client.setupSystemPromptEvent(
      this.sessionId,
      textConfig,
      systemPromptContent
    );
  }

  public async setupStartAudio(
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): Promise<void> {
    this.client.setupStartAudioEvent(this.sessionId, audioConfig);
  }

  // Stream audio for this session
  public async streamAudio(audioData: Buffer): Promise<void> {
    if (!this.isActive || !this.client.isSessionReady(this.sessionId)) {
      console.log("Inactive stream, dropping audio")
      return;
    }
    // Check queue size to avoid memory issues
    if (this.audioBufferQueue.length >= this.maxQueueSize) {
      // Queue is full, drop oldest chunk
      this.audioBufferQueue.shift();
      console.log("Audio queue full, dropping oldest chunk: ", this.audioBufferQueue.length, this.maxQueueSize);
    }

    // Queue the audio chunk for streaming
    this.audioBufferQueue.push(audioData);
    this.processAudioQueue();
  }

  // Process audio queue for continuous streaming
  private async processAudioQueue() {
    if (
      this.isProcessingAudio ||
      this.audioBufferQueue.length === 0 ||
      !this.isActive
    )
      return;

    this.isProcessingAudio = true;
    try {
      // Process all chunks in the queue, up to a reasonable limit
      let processedChunks = 0;
      const maxChunksPerBatch = 5; // Process max 5 chunks at a time to avoid overload

      while (
        this.audioBufferQueue.length > 0 &&
        processedChunks < maxChunksPerBatch &&
        this.isActive
      ) {
        const audioChunk = this.audioBufferQueue.shift();
        if (audioChunk && this.isActive) {
          await this.client.streamAudioChunk(this.sessionId, audioChunk);
          processedChunks++;
        }
      }
    } finally {
      this.isProcessingAudio = false;

      // If there are still items in the queue, schedule the next processing using setTimeout
      if (this.audioBufferQueue.length > 0 && this.isActive) {
        setTimeout(() => this.processAudioQueue(), 0);
      }
    }
  }
  // Get session ID
  public getSessionId(): string {
    return this.sessionId;
  }

  public async endAudioContent(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendContentEnd(this.sessionId);
  }

  public async endPrompt(): Promise<void> {
    if (!this.isActive) return;
    await this.client.sendPromptEnd(this.sessionId);
  }

  public async close(): Promise<void> {
    if (!this.isActive) return;

    this.isActive = false;
    this.audioBufferQueue = []; // Clear any pending audio

    await this.client.sendSessionEnd(this.sessionId);
    console.log(`Session ${this.sessionId} close completed`);
  }
}

// Session data type
interface SessionData {
  queue: Array<any>;
  queueSignal: Subject<void>;
  closeSignal: Subject<void>;
  responseSubject: Subject<any>;
  toolUseContent: any;
  toolUseId: string;
  toolName: string;
  responseHandlers: Map<string, (data: any) => void>;
  promptName: string;
  inferenceConfig: InferenceConfig;
  isActive: boolean;
  isPromptStartSent: boolean;
  isAudioContentStartSent: boolean;
  audioContentId: string;
  needsHangup: boolean;
  tools: Array<any>;
  isReady: boolean;
}

export class NovaSonicBidirectionalStreamClient {
  private bedrockRuntimeClient: BedrockRuntimeClient;
  private inferenceConfig: InferenceConfig;
  private activeSessions: Map<string, SessionData> = new Map();
  private sessionLastActivity: Map<string, number> = new Map();
  private sessionCleanupInProgress = new Set<string>();

  constructor(config: NovaSonicBidirectionalStreamClientConfig) {
    const nodeHttp2Handler = new NodeHttp2Handler({
      requestTimeout: 300000,
      sessionTimeout: 300000,
      disableConcurrentStreams: false,
      maxConcurrentStreams: 20,
      ...config.requestHandlerConfig,
    });

    if (!config.clientConfig.credentials) {
      throw new Error("No credentials provided");
    }

    this.bedrockRuntimeClient = new BedrockRuntimeClient({
      ...config.clientConfig,
      credentials: config.clientConfig.credentials,
      region: config.clientConfig.region || "us-east-1",
      requestHandler: nodeHttp2Handler,
    });

    this.inferenceConfig = {
      //      this.inferenceConfig = config.inferenceConfig ?? {
      maxTokens: 3000, //800, //1024,
      //topP: 0.9,
      topK: 5,
      temperature: 0.01, //0.2, // Was 0.7
    };
    /*
        const applyGuardrailInput = {
          guardrailIdentifier: "x85t4nhck494"
        };
    
        try {
          const applyGuardrailCommand = new ApplyGuardrailCommand(applyGuardrailInput);
          const response = this.bedrockRuntimeClient.send(applyGuardrailCommand);
          console.log("Guardrail applied:", response);
        } catch (error) {
          console.error("Error applying guardrail:", error);
        }
    */

  }

  public isSessionActive(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isActive;
  }
  public isSessionReady(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    return !!session && session.isReady;
  }

  public getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  public getLastActivityTime(sessionId: string): number {
    return this.sessionLastActivity.get(sessionId) || 0;
  }

  private updateSessionActivity(sessionId: string): void {
    this.sessionLastActivity.set(sessionId, Date.now());
  }

  public isCleanupInProgress(sessionId: string): boolean {
    return this.sessionCleanupInProgress.has(sessionId);
  }

  // Create a new streaming session
  public createStreamSession(
    sessionId: string = randomUUID(),
    tools?: Array<any>,
    temp?: number,
    config?: NovaSonicBidirectionalStreamClientConfig,
  ): StreamSession {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Stream session with ID ${sessionId} already exists`);
    }
    if (temp) {
      this.inferenceConfig.temperature = temp;
    }
    console.log("Using inferenceConfig: ", this.inferenceConfig)
    const session: SessionData = {
      queue: [],
      queueSignal: new Subject<void>(),
      closeSignal: new Subject<void>(),
      responseSubject: new Subject<any>(),
      toolUseContent: null,
      toolUseId: "",
      toolName: "",
      responseHandlers: new Map(),
      promptName: randomUUID(),
      inferenceConfig: config?.inferenceConfig ?? this.inferenceConfig,
      isActive: true,
      isPromptStartSent: false,
      isAudioContentStartSent: false,
      audioContentId: randomUUID(),
      needsHangup: false,
      tools: tools,
      isReady: false,
    };

    this.activeSessions.set(sessionId, session);

    return new StreamSession(sessionId, this);
  }

  private async processToolUse(
    toolName: string,
    toolUseContent: object,
    tools: Array<any>
  ): Promise<Object> {
    const tool = toolName.toLowerCase();

    switch (tool) {
      case "getdateandtimetool":
        const date = new Date().toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
        });
        const pstDate = new Date(date);
        return {
          date: pstDate.toISOString().split("T")[0],
          year: pstDate.getFullYear(),
          month: pstDate.getMonth() + 1,
          day: pstDate.getDate(),
          dayOfWeek: pstDate
            .toLocaleString("en-US", { weekday: "long" })
            .toUpperCase(),
          timezone: "PST",
          formattedTime: pstDate.toLocaleTimeString("en-US", {
            hour12: true,
            hour: "2-digit",
            minute: "2-digit",
          }),
        };
      case "getnyc":
        console.log(`********************************************************************************************* getNYC tool:  ${JSON.stringify(toolUseContent)} `);
        const kbContent = await this.parseToolUseContent(toolUseContent);
        if (!kbContent) {
          throw new Error('NYC parsedContent is undefined');
        }
        return this.queryKB(kbContent?.query, kbContent?.maxResults, 'OWELQLIRZB');
      case "getalphatech":
        console.log(`********************************************************************************************* getAlphaTech tool:  ${JSON.stringify(toolUseContent)} `);
        const alContent = await this.parseToolUseContent(toolUseContent);
        if (!alContent) {
          throw new Error('AlphaTech parsedContent is undefined');
        }
        return this.queryKB(alContent?.query, alContent?.maxResults, 'FHTBJIUFCV');
      case "getbrandedcalling":
        console.log(`********************************************************************************************* getBrandedCalling tool`);
        return {
          latitude: 28.429512, //37.243856,  //Orlando convention center
          longitude: -81.462511, //-121.823796,
          //hint: "Please return the closest street name and intersection",
          //branded_data: "It is really really close to you now",
        };
      case "getweathertool":
        console.log(`weather tool`);
        const parsedContent =
          await this.parseToolUseContentForWeather(toolUseContent);
        console.log("parsed content");
        if (!parsedContent) {
          throw new Error("parsedContent is undefined");
        }
        return this.fetchWeatherData(
          parsedContent?.latitude,
          parsedContent?.longitude
        );
      default:
        console.log(`Tool ${tool} not natively supported, check for dynamic `, toolUseContent);
        console.log("My Tools: ", tools);
        var cur = tools.find((atool) => ((atool.toolSpec.name.toLowerCase() == tool)))
        if (cur && cur.toolSpec.url && cur.toolSpec.url.length>4 ) {
          const results = await this.getURL(
            cur.toolSpec.url,
            toolUseContent
          );
          return results;
        } else if (cur && cur.toolSpec.key && '' + cur.toolSpec.key.toLowerCase().startsWith('kb:')) {
          var kbid = cur.toolSpec.key?.substring(3)?.trim();
          console.log("Using dynamic KB Id: ", kbid, toolUseContent)
          const kbContent = await this.parseToolUseContent(toolUseContent);
          if (!kbContent) {
            throw new Error('Dynamic KB parsedContent is undefined');
          }
          console.log("Got back kbContent: ",kbContent)
          return this.queryKB(kbContent?.query, kbContent?.maxResults, kbid);
        }
        throw new Error(`Tool ${tool} not supported`);
    }
  }
  private async parseToolUseContent(toolUseContent: any): Promise<{ query: string; maxResults: number; } | null> {
    try {
      // Check if the content field exists and is a string
      if (toolUseContent && typeof toolUseContent.content === 'string') {
        // Parse the JSON string into an object
        const parsedContent = JSON.parse(toolUseContent.content);

        // Return the parsed content
        return {
          query: parsedContent.query,
          maxResults: parsedContent?.maxResults
        };
      }

      return null;
    } catch (error) {
      console.error("Failed to parse tool use content:", error);
      return null;
    }
  }

  private async queryKB(query: string, numberOfResults: number = 3, kbId: string): Promise<Object> {
    // Create a client instance
    const kbClient = new BedrockKnowledgeBaseClient();

    // Replace with your actual Knowledge Base ID
    const KNOWLEDGE_BASE_ID = kbId; 

    try {
      console.log(`Searching for: "${query}"`);

      // Retrieve information from the Knowledge Base
      const results = await kbClient.retrieveFromKnowledgeBase({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        query,
        numberOfResults: numberOfResults
      });

      console.log(`Results: ${JSON.stringify(results)}`);

      return { results: results };

    } catch (error) {
      console.error("Query Error:", error);
      return {};
    }
  }
  private async parseToolUseContentForWeather(
    toolUseContent: any
  ): Promise<{ latitude: number; longitude: number } | null> {
    try {
      // Check if the content field exists and is a string
      if (toolUseContent && typeof toolUseContent.content === "string") {
        // Parse the JSON string into an object
        const parsedContent = JSON.parse(toolUseContent.content);
        console.log(`parsedContent ${parsedContent}`);
        // Return the parsed content
        return {
          latitude: parsedContent.latitude,
          longitude: parsedContent.longitude,
        };
      }
      return null;
    } catch (error) {
      console.error("Failed to parse tool use content:", error);
      return null;
    }
  }
  private async getURL(
    url: string,
    toolUseContent: any
  ): Promise<Record<string, any>> {
    try {
      const parsedContent = JSON.parse(toolUseContent.content);
      console.log("Getting remote data, url= ", url, parsedContent)
      const response = await axios.post(url,
        parsedContent
      );
      const remoteData = response.data;
      console.log("remoteData:", remoteData);
      return {
        response: remoteData,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`Error fetching remote data: ${error.message}`, error);
      } else {
        console.error(
          `Unexpected remote data error: ${error instanceof Error ? error.message : String(error)} `,
          error
        );
      }
      throw error;
    }
  }

  private async fetchWeatherData(
    latitude: number,
    longitude: number
  ): Promise<Record<string, any>> {
    const ipv4Agent = new https.Agent({ family: 4 });
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;

    try {
      const response = await axios.get(url, {
        httpsAgent: ipv4Agent,
        timeout: 5000,
        headers: {
          "User-Agent": "MyApp/1.0",
          Accept: "application/json",
        },
      });
      const weatherData = response.data;
      console.log("weatherData:", weatherData);

      return {
        weather_data: weatherData,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`Error fetching weather data: ${error.message}`, error);
      } else {
        console.error(
          `Unexpected error: ${error instanceof Error ? error.message : String(error)} `,
          error
        );
      }
      throw error;
    }
  }

  // Stream audio for a specific session
  public async initiateSession(sessionId: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Stream session ${sessionId} not found`);
    }
    try {
      this.setupSessionStartEvent(sessionId);

      // Create the bidirectional stream with session-specific async iterator
      const asyncIterable = this.createSessionAsyncIterable(sessionId);

      console.log(`Starting bidirectional stream for session ${sessionId}...`);
      var response;
      try {
        response = await this.bedrockRuntimeClient.send(
          new InvokeModelWithBidirectionalStreamCommand({
            modelId: "amazon.nova-2-sonic-v1:0",
            body: asyncIterable,
          })
        );
      } catch (err) {
        console.log("InvokeModelWithBidirectionalStreamCommand error! ", err);
        if (session.isActive) {
          session.isActive = false;
          this.activeSessions.delete(sessionId);
          this.sessionLastActivity.delete(sessionId);
        }
        return false;
      }
      console.log(
        `Stream established for session ${sessionId}, processing responses...`
      );
      console.log("ResponseStream response for the NovaSonic instantiation: ", response)
      // Process responses for this session
      await this.processResponseStream(sessionId, response);
      return true;

    } catch (error) {
      console.error(`Error in initiateSession ${sessionId}: `, session.isActive, error);
      this.dispatchEventForSession(sessionId, "error", {
        source: "bidirectionalStream",
        error,
      });

      // Make sure to clean up if there's an error
      if (session.isActive) {
        this.closeSession(sessionId);
      }
      return false;
    }
  }

  // Dispatch events to handlers for a specific session
  private dispatchEventForSession(
    sessionId: string,
    eventType: string,
    data: any
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(
          `Error in ${eventType} handler for session ${sessionId}: `,
          e
        );
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get("any");
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}: `, e);
      }
    }
  }

  private createSessionAsyncIterable(
    sessionId: string
  ): AsyncIterable<InvokeModelWithBidirectionalStreamInput> {
    if (!this.isSessionActive(sessionId)) {
      console.log(
        `Cannot create async iterable: Session ${sessionId} not active`
      );
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
        }),
      };
    }

    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Cannot create async iterable: Session ${sessionId} not found`
      );
    }

    let eventCount = 0;

    return {
      [Symbol.asyncIterator]: () => {
        console.log(
          `AsyncIterable iterator requested for session ${sessionId}`
        );

        return {
          next: async (): Promise<
            IteratorResult<InvokeModelWithBidirectionalStreamInput>
          > => {
            try {
              // Check if session is still active
              if (!session.isActive || !this.activeSessions.has(sessionId)) {
                console.log(
                  `Iterator closing for session ${sessionId}, done = true`
                );
                return { value: undefined, done: true };
              }
              // Wait for items in the queue or close signal
              if (session.queue.length === 0) {
                try {
                  await Promise.race([
                    firstValueFrom(session.queueSignal.pipe(take(1))),
                    firstValueFrom(session.closeSignal.pipe(take(1))).then(
                      () => {
                        throw new Error("Stream closed");
                      }
                    ),
                  ]);
                } catch (error) {
                  if (error instanceof Error) {
                    if (
                      error.message === "Stream closed" ||
                      !session.isActive
                    ) {
                      // This is an expected condition when closing the session
                      if (this.activeSessions.has(sessionId)) {
                        console.log(
                          `Session \${ sessionId } closed during wait`
                        );
                      }
                      return { value: undefined, done: true };
                    }
                  } else {
                    console.error(`Error on event close`, error);
                  }
                }
              }

              // If queue is still empty or session is inactive, we're done
              if (session.queue.length === 0 || !session.isActive) {
                console.log(`Queue empty or session inactive: ${sessionId} `, session.isActive);
                return { value: undefined, done: true };
              }

              // Get next item from the session's queue
              const nextEvent = session.queue.shift();
              eventCount++;

              return {
                value: {
                  chunk: {
                    bytes: new TextEncoder().encode(JSON.stringify(nextEvent)),
                  },
                },
                done: false,
              };
            } catch (error) {
              console.error(`Error in session ${sessionId} iterator: `, error);
              session.isActive = false;
              return { value: undefined, done: true };
            }
          },

          return: async (): Promise<
            IteratorResult<InvokeModelWithBidirectionalStreamInput>
          > => {
            console.log(`Iterator return () called for session ${sessionId}`);
            session.isActive = false;
            return { value: undefined, done: true };
          },

          throw: async (
            error: any
          ): Promise<
            IteratorResult<InvokeModelWithBidirectionalStreamInput>
          > => {
            console.log(
              `Iterator throw () called for session ${sessionId} with error: `,
              error
            );
            session.isActive = false;
            throw error;
          },
        };
      },
    };
  }

  // Process the response stream from AWS Bedrock
  private async processResponseStream(
    sessionId: string,
    response: any
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.log("No active session yet...", sessionId)
      return;
    }
    try {
      for await (const event of response.body) {
        if (!session.isActive) {
          console.log(
            `Session ${sessionId} is no longer active, stopping response processing`
          );
          break;
        }
        if (event.chunk?.bytes) {
          try {
            this.updateSessionActivity(sessionId);
            const textResponse = new TextDecoder().decode(event.chunk.bytes);
            session.isReady = true;
            try {
              const jsonResponse = JSON.parse(textResponse);
              if (jsonResponse.event?.contentStart) {
                this.dispatchEvent(
                  sessionId,
                  "contentStart",
                  jsonResponse.event.contentStart
                );
              } else if (jsonResponse.event?.textOutput) {
                this.dispatchEvent(
                  sessionId,
                  "textOutput",
                  jsonResponse.event.textOutput
                );
              } else if (jsonResponse.event?.audioOutput) {
                this.dispatchEvent(
                  sessionId,
                  "audioOutput",
                  jsonResponse.event.audioOutput
                );
              } else if (jsonResponse.event?.toolUse) {
                this.dispatchEvent(
                  sessionId,
                  "toolUse",
                  jsonResponse.event.toolUse
                );

                // Store tool use information for later
                session.toolUseContent = jsonResponse.event.toolUse;
                session.toolUseId = jsonResponse.event.toolUse.toolUseId;
                session.toolName = jsonResponse.event.toolUse.toolName;
              } else if (
                jsonResponse.event?.contentEnd &&
                jsonResponse.event?.contentEnd?.type === "TOOL"
              ) {
                // Process tool use
                console.log(`Processing tool use for session ${sessionId}`);
                this.dispatchEvent(sessionId, "toolEnd", {
                  toolUseContent: session.toolUseContent,
                  toolUseId: session.toolUseId,
                  toolName: session.toolName,
                });

                console.log("calling tooluse");
                console.log("tool use content : ", session.toolUseContent);
                // function calling
                const toolResult = await this.processToolUse(
                  session.toolName,
                  session.toolUseContent,
                  session.tools
                );
                console.log("Got toolResult: ", toolResult);

                // Send tool result
                this.sendToolResult(sessionId, session.toolUseId, toolResult);

                // Also dispatch event about tool result
                this.dispatchEvent(sessionId, "toolResult", {
                  toolUseId: session.toolUseId,
                  result: toolResult,
                });
              } else if (jsonResponse.event?.contentEnd) {
                this.dispatchEvent(
                  sessionId,
                  "contentEnd",
                  jsonResponse.event.contentEnd
                );
              } else {
                // Handle other events
                const eventKeys = Object.keys(jsonResponse.event || {});
                // If we want to print out the token usage, uncomment the following line
                //if(eventKeys[0] == 'usageEvent')  console.log(`Usage event: `,jsonResponse);
              }
            } catch (e) {
              console.log(
                `Raw text response for session ${sessionId}(parse error): `,
                textResponse
              );
            }
          } catch (e) {
            console.error(
              `Error processing response chunk for session ${sessionId}: `,
              e
            );
          }
        } else if (event.modelStreamErrorException) {
          console.error(
            `Model stream error for session ${sessionId}: `,
            event.modelStreamErrorException
          );
          this.dispatchEvent(sessionId, "error", {
            type: "modelStreamErrorException",
            details: event.modelStreamErrorException,
          });
        } else if (event.internalServerException) {
          console.error(
            `Internal server error for session ${sessionId}: `,
            event.internalServerException
          );
          this.dispatchEvent(sessionId, "error", {
            type: "internalServerException",
            details: event.internalServerException,
          });
        }
      }

      console.log(
        `Response stream processing complete for session ${sessionId}`
      );
      this.dispatchEvent(sessionId, "streamComplete", {
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        `Error processing response stream for session ${sessionId} `
      );
      this.dispatchEvent(sessionId, "error", {
        source: "responseStream",
        message: "Error processing response stream",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Add an event to a session's queue
  private addEventToSessionQueue(sessionId: string, event: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive) return;

    this.updateSessionActivity(sessionId);
    session.queue.push(event);
    session.queueSignal.next();
  }

  // Set up initial events for a session
  private setupSessionStartEvent(sessionId: string): void {
    console.log(`Setting up initial events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    // Session start event
    console.log("InferenceConfig at start of session: ", session.inferenceConfig)
    this.addEventToSessionQueue(sessionId, {
      event: {
        sessionStart: {
          inferenceConfiguration: session.inferenceConfig,
        },
      },
    });
  }
  public setupPromptStartEvent(sessionId: string, audioConfig: typeof DefaultAudioOutputConfiguration = DefaultAudioOutputConfiguration): void {
    console.log(`Setting up prompt start event for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    var tools = session.tools;
    console.log("Applied tools: ", tools);
    this.addEventToSessionQueue(sessionId, {
      event: {
        promptStart: {
          promptName: session.promptName,
          textOutputConfiguration: {
            mediaType: "text/plain",
          },
          audioOutputConfiguration: audioConfig,
          toolUseOutputConfiguration: {
            mediaType: "application/json",
          },
          toolConfiguration: {
            tools: tools,
          },
        },
      },
    });
    session.isPromptStartSent = true;
  }

  public setupSystemPromptEvent(
    sessionId: string,
    textConfig: typeof DefaultTextConfiguration = DefaultTextConfiguration,
    systemPromptContent: string = DefaultSystemPrompt
  ): void {
    console.log(`Setting up systemPrompt events for session ${sessionId}...`);
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    // Text content start
    const textPromptID = randomUUID();
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: textPromptID,
          type: "TEXT",
          interactive: true,
          role: "SYSTEM",
          textInputConfiguration: textConfig,
        },
      },
    });

    // Text input content
    this.addEventToSessionQueue(sessionId, {
      event: {
        textInput: {
          promptName: session.promptName,
          contentName: textPromptID,
          content: systemPromptContent,
        },
      },
    });

    // Text content end
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: textPromptID,
        },
      },
    });
  }

  public setupStartAudioEvent(
    sessionId: string,
    audioConfig: typeof DefaultAudioInputConfiguration = DefaultAudioInputConfiguration
  ): void {
    console.log(
      `Setting up startAudioContent event for session ${sessionId}...`
    );
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    console.log(`Using audio content ID: ${session.audioContentId}`);
    // Audio content start
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: audioConfig,
        },
      },
    });
    session.isAudioContentStartSent = true;
    console.log(`Initial events setup complete for session ${sessionId}`);
  }

  // Stream an audio chunk for a session
  public async streamAudioChunk(
    sessionId: string,
    audioData: Buffer
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isActive || !session.audioContentId) {
      const err = new Error(`Invalid session ${sessionId} for audio streaming`);
      throw err;
    }
    // Convert audio to base64
    const base64Data = audioData.toString("base64");

    this.addEventToSessionQueue(sessionId, {
      event: {
        audioInput: {
          promptName: session.promptName,
          contentName: session.audioContentId,
          content: base64Data,
        },
      },
    });
  }

  // Send tool result back to the model
  private async sendToolResult(
    sessionId: string,
    toolUseId: string,
    result: any
  ): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    console.log("inside tool result");
    if (!session || !session.isActive) return;

    console.log(
      `Sending tool result for session ${sessionId}, tool use ID: ${toolUseId}`
    );
    const contentId = randomUUID();

    // Tool content start
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentStart: {
          promptName: session.promptName,
          contentName: contentId,
          interactive: false,
          type: "TOOL",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId: toolUseId,
            type: "TEXT",
            textInputConfiguration: {
              mediaType: "text/plain",
            },
          },
        },
      },
    });

    // Tool content input
    const resultContent =
      typeof result === "string" ? result : JSON.stringify(result);
    this.addEventToSessionQueue(sessionId, {
      event: {
        toolResult: {
          promptName: session.promptName,
          contentName: contentId,
          content: resultContent,
        },
      },
    });

    // Tool content end
    this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: contentId,
        },
      },
    });

    console.log(`Tool result sent for session ${sessionId}`);
  }

  public async sendContentEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isAudioContentStartSent) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        contentEnd: {
          promptName: session.promptName,
          contentName: session.audioContentId,
        },
      },
    });

    // Wait to ensure it's processed
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  public async sendPromptEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.isPromptStartSent) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        promptEnd: {
          promptName: session.promptName,
        },
      },
    });

    // Wait to ensure it's processed
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  public async sendSessionEnd(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    await this.addEventToSessionQueue(sessionId, {
      event: {
        sessionEnd: {},
      },
    });

    // Wait to ensure it's processed
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Now it's safe to clean up
    session.isActive = false;
    session.closeSignal.next();
    session.closeSignal.complete();
    this.activeSessions.delete(sessionId);
    this.sessionLastActivity.delete(sessionId);
    console.log(`Session ${sessionId} closed and removed from active sessions`);
  }

  // Register an event handler for a session
  public registerEventHandler(
    sessionId: string,
    eventType: string,
    handler: (data: any) => void
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.responseHandlers.set(eventType, handler);
  }

  // Dispatch an event to registered handlers
  private dispatchEvent(sessionId: string, eventType: string, data: any): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const handler = session.responseHandlers.get(eventType);
    if (handler) {
      try {
        handler(data);
      } catch (e) {
        console.error(
          `Error in ${eventType} handler for session ${sessionId}:`,
          e
        );
      }
    }

    // Also dispatch to "any" handlers
    const anyHandler = session.responseHandlers.get("any");
    if (anyHandler) {
      try {
        anyHandler({ type: eventType, data });
      } catch (e) {
        console.error(`Error in 'any' handler for session ${sessionId}:`, e);
      }
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    if (this.sessionCleanupInProgress.has(sessionId)) {
      console.log(
        `Cleanup already in progress for session ${sessionId}, skipping`
      );
      return;
    }
    this.sessionCleanupInProgress.add(sessionId);
    try {
      console.log(`Starting close process for session ${sessionId}`);
      await this.sendContentEnd(sessionId);
      await this.sendPromptEnd(sessionId);
      await this.sendSessionEnd(sessionId);
      console.log(`Session ${sessionId} cleanup complete`);
    } catch (error) {
      console.error(
        `Error during closing sequence for session ${sessionId}:`,
        error
      );

      // Ensure cleanup happens even if there's an error
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.isActive = false;
        this.activeSessions.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
      }
    } finally {
      // Always clean up the tracking set
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }

  // Same for forceCloseSession:
  public forceCloseSession(sessionId: string): void {
    if (
      this.sessionCleanupInProgress.has(sessionId) ||
      !this.activeSessions.has(sessionId)
    ) {
      console.log(
        `Session ${sessionId} already being cleaned up or not active`
      );
      return;
    }

    this.sessionCleanupInProgress.add(sessionId);
    try {
      const session = this.activeSessions.get(sessionId);
      if (!session) return;

      console.log(`Force closing session ${sessionId}`);

      // Immediately mark as inactive and clean up resources
      session.isActive = false;
      session.closeSignal.next();
      session.closeSignal.complete();
      this.activeSessions.delete(sessionId);
      this.sessionLastActivity.delete(sessionId);

      console.log(`Session ${sessionId} force closed`);
    } finally {
      this.sessionCleanupInProgress.delete(sessionId);
    }
  }
}
