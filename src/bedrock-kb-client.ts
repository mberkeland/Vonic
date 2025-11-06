import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
    RetrieveCommandInput,
    RetrieveCommandOutput,
    InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";


import { fromIni, fromEnv } from "@aws-sdk/credential-providers";


// Define interfaces for type safety
interface RetrieveOptions {
    knowledgeBaseId: string;
    query: string;
    numberOfResults?: number;
    retrievalFilter?: Record<string, any>;
}

interface RetrievalResult {
    content: string;
    metadata: {
        source: string;
        location?: string;
        title?: string;
        excerpt?: string;
    };
    score: number;
}
const AWS_PROFILE_NAME = process.env.AWS_PROFILE || '';


class BedrockKnowledgeBaseClient {
    private client: BedrockAgentRuntimeClient;
    private sclient: BedrockRuntimeClient;
    constructor(region: string = 'us-east-1') {
        this.client = new BedrockAgentRuntimeClient({
            region,
            credentials: fromEnv(),
        });
        this.sclient = new BedrockRuntimeClient({
            region,
            credentials: fromEnv(),
        });
    }
    async summarizeText(text) {
        var LITE_MODEL_ID = "us.amazon.nova-micro-v1:0"
        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 100,
            messages: [{ role: "user", content: `summarize this chat without producing linefeeds: ${text}` }]
        };
        /*
         const payload = {
             messages: [{ role: "user", content: `Summarize this text: ${text}` }],
         }
             */
        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
            body: JSON.stringify(payload),
            contentType: "application/json"
        });
        try {
            const response = await this.sclient.send(command);
            const result = JSON.parse(new TextDecoder().decode(response.body));
            console.log("Summarization results: ", result.content[0])
            return result.content[0].text;
        } catch (e) {
            return "No summary available."
        }
    }
    // Retrieves information from the Bedrock Knowledge Base
    async retrieveFromKnowledgeBase(options: RetrieveOptions): Promise<Object> {
        const { knowledgeBaseId, query, numberOfResults = 50, retrievalFilter } = options;

        try {
            // Build the command input
            console.log("Setting up kbId: ", knowledgeBaseId)
            const input: RetrieveCommandInput = {
                knowledgeBaseId,
                retrievalQuery: {
                    text: query
                },
                retrievalConfiguration: {
                    vectorSearchConfiguration: {
                        numberOfResults
                    }
                }
            };

            // Execute the retrieval command
            const command = new RetrieveCommand(input);

            // Use type assertion if you need to add filter parameters
            if (retrievalFilter) {
                (command.input as any).filter = retrievalFilter;
            }

            const response: RetrieveCommandOutput = await this.client.send(command);

            // Process and format the results
            if (!response.retrievalResults || response.retrievalResults.length === 0) {
                return [];
            }

            // Safely map the results with correct type handling
            const results: RetrievalResult[] = [];

            for (const result of response.retrievalResults) {
                // Extract content - ensure it's a string
                const content = result.content?.text || "";

                // Extract source with proper null checking
                let source = "Unknown source";
                let location: string | undefined = undefined;

                if (result.location?.s3Location) {
                    source = result.location.s3Location.uri?.split('/').pop() || "Unknown S3 file";
                    location = result.location.s3Location.uri;
                } else if (result.location?.confluenceLocation) {
                    source = result.location.confluenceLocation.url || "Unknown Confluence page";
                    location = result.location.confluenceLocation.url;
                } else if (result.location?.webLocation) {
                    source = "Web source";
                    // Access URL property safely
                    const webLocation: any = result.location.webLocation;
                    if (webLocation && (webLocation.url || webLocation.uri)) {
                        location = webLocation.url || webLocation.uri;
                    }
                }
                // Safely extract metadata
                const title = result.metadata?.title;
                const excerpt = result.metadata?.excerpt;

                const metadata = {
                    source,
                    location,
                    title: typeof title === 'string' ? title : "",
                    excerpt: typeof excerpt === 'string' ? excerpt : ""
                };

                console.log(metadata)

                // Get relevance score
                const score = result.score || 0;

                results.push({
                    content,
                    metadata,
                    score
                });
            }
            return results;
        } catch (error) {
            console.error("Error retrieving from Bedrock Knowledge Base:", error);
            throw error;
        }
    }
}

export { BedrockKnowledgeBaseClient, RetrieveOptions, RetrievalResult };