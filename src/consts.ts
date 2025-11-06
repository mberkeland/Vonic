import { AudioType, AudioMediaType, TextMediaType } from "./types";

export const DefaultInferenceConfiguration = {
  maxTokens: 1024,
  topP: 0.9,
  temperature: 0.7,
};

export const DefaultAudioInputConfiguration = {
  audioType: "SPEECH" as AudioType,
  encoding: "base64",
  mediaType: "audio/lpcm" as AudioMediaType,
  sampleRateHertz: 16000,
  sampleSizeBits: 16,
  channelCount: 1,
};

export const DefaultToolSchema = JSON.stringify({
  type: "object",
  properties: {},
  required: [],
});
export const BrandedToolSchema = JSON.stringify({
  type: "object",
  properties: {},
  required: [],
});
export const NYCToolSchema = JSON.stringify({
  type: "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "The user question about the Summit"
    }
  },
  "required": ["query"]
});
export const ceeceeSchema = JSON.stringify({
  type: "object",
  properties: {
    "summary": {
      "type": "string",
      "description": "Brief summary of the conversation, covering the caller's goal, emotions, and resolution."
    },
    "primary_skill": {
      "type": "string",
      "description": "The determined Primary Skill needed, which must be either 'Sales','Support', or 'VIP'"
    },
    "reasoning": {
      "type": "string",
      "description": "One-sentence explanation for choosing this Primary Skill, citing transcript evidence or caller data."
    },
  },
  required: [
    "summary",
    "primary_skill"
  ]
});

export const AlphaToolSchema = JSON.stringify({
  type: "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Provides information about users, claims, and policies, based on ssn (social security number) or claim numbers"
    }
  },
  "required": ["query"]
});

export const WeatherToolSchema = JSON.stringify({
  type: "object",
  properties: {
    latitude: {
      type: "string",
      description: "Geographical WGS84 latitude of the location.",
    },
    longitude: {
      type: "string",
      description: "Geographical WGS84 longitude of the location.",
    },
  },
  required: ["latitude", "longitude"],
});

export const DefaultTextConfiguration = {
  mediaType: "text/plain" as TextMediaType,
};

export const DefaultSystemPrompt =
  `# Role & Scope

You are Ceecee, a real-time voice/text assistant for the company, 'Blake's Whoopie Cushions.' Provide friendly, accurate information about products, billing issues, technical support, and general company information.

Tone & Delivery
Maintain a friendly, bubbly, and clear tone
Keep responses under 15 seconds
Use follow-up questions when clarification is needed
Avoid technical jargon unless user requests specifics

Uncertainty Handling
For unanswerable questions
'Im not sure, we can certainly ask the correct Blakes Representative about that. 
 
To start a conversation, say: 'Hi there, I am Ceecee, your AI Voice Agent for the Blake's Whoopie Cushions, Inc.  How can I help you today?' 
 
To terminate a conversation, say: "Let me transfer you to the agent best able to help you."

Always use the present tense. Avoid future and past tenses unless absolutely necessary.
`;

export const DefaultAudioOutputConfiguration = {
  ...DefaultAudioInputConfiguration,
  sampleRateHertz: 16000, // TODO: You may need to adjust this for your voice to sound normal
  voiceId: "tiffany", //"tiffany" or "amy"
};

export const dTools = [
  {
    toolSpec: {
      name: "getDateAndTimeTool",
      description:
        "Get information about the current date and time.",
      inputSchema: {
        json: DefaultToolSchema,
      },
    },
  },
  {
    toolSpec: {
      name: "getWeatherTool",
      description:
        "Get the current weather for a given location, based on its WGS84 coordinates.",
      inputSchema: {
        json: WeatherToolSchema,
      },
    },
  },
  {
    toolSpec: {
      name: "ceecee",
      description:
        "Call this tool only after final confirmation of the user's intentions, when we know the user wants to talk to an agent, make a purchase, or when we have determined the primary skill needed to meet the user's needs.",
      inputSchema: {
        json: ceeceeSchema
      },
      url: "https://vids.vonage.com/mcp/ceecee",
      key: "",
    },
  },
]; 