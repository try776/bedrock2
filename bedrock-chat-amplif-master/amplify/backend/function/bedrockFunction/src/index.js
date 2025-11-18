/* Amplify Params - DO NOT EDIT
    ENV
    REGION
    STORAGE_OSINTJOBS_NAME
    NAME: BEDROCKFUNCTION
Amplify Params - DO NOT EDIT */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { v4 as uuidv4 } from 'uuid';

// --- KONFIGURATION ---
const REGION = process.env.REGION || 'us-east-1';
const TABLE_NAME = process.env.STORAGE_OSINTJOBS_NAME || "OsintJobs";

// WICHTIG: Wir zwingen den Code, immer den "dev" Worker zu nehmen, um Fehler zu vermeiden
const WORKER_FUNCTION_NAME = 'osintWorker-dev'; 

// --- CLIENTS ---
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' }); // Bedrock ist in us-east-1
const lambdaClient = new LambdaClient({ region: REGION });
const ddbClient = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
    // CORS Header für React
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": "application/json"
    };

    try {
        // ---------------------------------------------------------
        // TEIL 1: STATUS ABFRAGE (GET)
        // ---------------------------------------------------------
        if (event.httpMethod === 'GET' && event.queryStringParameters?.jobId) {
            const jobId = event.queryStringParameters.jobId;
            
            const data = await ddbClient.send(new GetItemCommand({
                TableName: TABLE_NAME,
                Key: { id: { S: jobId } }
            }));

            if (!data.Item) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ status: "NOT_FOUND", message: "Job noch nicht bereit" })
                };
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    jobId,
                    status: data.Item.status?.S || "UNKNOWN",
                    // NEU: Message auch zurückgeben
                    message: data.Item.message?.S || "", 
                    result: data.Item.result?.S || ""
                })
            };
        }

        // ---------------------------------------------------------
        // TEIL 2: NEUER REQUEST (POST)
        // ---------------------------------------------------------
        let body = {};
        if (event.body) {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        }

        const { prompt, mode, imageBase64, imageMediaType } = body;

        // >>> FALL A: OSINT JOB (Langläufer) <<<
        if (mode === 'Full OSINT Report') {
            const jobId = uuidv4();
            const timestamp = new Date().toISOString();

            // 1. Eintrag in DB erstellen (damit Polling sofort etwas findet)
            await ddbClient.send(new PutItemCommand({
                TableName: TABLE_NAME,
                Item: {
                    id: { S: jobId },
                    status: { S: "QUEUED" }, // Status: In Warteschlange
                    createdAt: { S: timestamp },
                    prompt: { S: prompt }
                }
            }));

            // 2. Worker asynchron starten
            const workerPayload = { jobId, prompt };
            
            await lambdaClient.send(new InvokeCommand({
                FunctionName: WORKER_FUNCTION_NAME, 
                InvocationType: 'Event', // 'Event' = Fire & Forget (Async)
                Payload: JSON.stringify(workerPayload)
            }));

            // 3. Sofort antworten
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    jobId: jobId, 
                    status: "QUEUED",
                    message: "OSINT Analyse gestartet." 
                })
            };
        }

        // >>> FALL B: STANDARD CHAT / VISION (Direkte Antwort) <<<
        else {
            // Payload für Claude 3 bauen
            let userMessageContent = [{ type: "text", text: prompt || "Hallo" }];

            if (imageBase64) {
                userMessageContent.push({
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: imageMediaType || "image/jpeg",
                        data: imageBase64
                    }
                });
            }

            const command = new InvokeModelCommand({
                modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify({
                    anthropic_version: "bedrock-2023-05-31",
                    max_tokens: 2000,
                    messages: [{ role: "user", content: userMessageContent }]
                })
            });

            const response = await bedrockClient.send(command);
            const jsonResponse = JSON.parse(new TextDecoder().decode(response.body));
            
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ response: jsonResponse.content[0].text })
            };
        }

    } catch (error) {
        console.error("ERROR in BedrockFunction:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};