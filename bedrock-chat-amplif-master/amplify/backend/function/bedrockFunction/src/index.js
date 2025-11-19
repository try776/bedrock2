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
const ENV = process.env.ENV;
// REGION wird auf eu-central-1 (Frankfurt) festgelegt.
const REGION = 'eu-central-1'; 
const TABLE_NAME = process.env.STORAGE_OSINTJOBS_NAME || "OsintJobs";

// WICHTIG: Umstellung auf MISTRAL PIXTRAL (EU Cross-Region Inference Profile)
const MODEL_ID = "eu.mistral.pixtral-large-2502-v1:0";

const WORKER_FUNCTION_NAME = `osintWorker-${ENV}`; 

// --- CLIENTS ---
const bedrockClient = new BedrockRuntimeClient({ region: REGION }); 
const lambdaClient = new LambdaClient({ region: REGION });
const ddbClient = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
    // Wichtiger Log, um die korrekte Ausführung zu bestätigen
    console.log("🚀 BEDROCK FUNCTION (MISTRAL PIXTRAL) STARTED"); 
    
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": "application/json"
    };

    try {
        // --- STATUS ABFRAGE (GET) ---
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
                    body: JSON.stringify({ status: "NOT_FOUND", message: "Job nicht gefunden." })
                };
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    jobId,
                    status: data.Item.status?.S || "UNKNOWN",
                    message: data.Item.message?.S || "", 
                    result: data.Item.result?.S || ""
                })
            };
        }

        // --- NEUER REQUEST (POST) ---
        let body = {};
        if (event.body) {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        }

        const { prompt, mode, imageBase64, imageMediaType } = body;

        // >>> FALL A: OSINT JOB <<<
        if (mode === 'Full OSINT Report') {
            const jobId = uuidv4();
            const timestamp = new Date().toISOString();

            console.log(`Starte OSINT Job: ${jobId} in ${REGION} mit Worker: ${WORKER_FUNCTION_NAME}`);

            await ddbClient.send(new PutItemCommand({
                TableName: TABLE_NAME,
                Item: {
                    id: { S: jobId },
                    status: { S: "QUEUED" },
                    message: { S: "Job wird initialisiert..." },
                    createdAt: { S: timestamp },
                    prompt: { S: prompt }
                }
            }));

            // Asynchroner Aufruf des OSINT Workers
            await lambdaClient.send(new InvokeCommand({
                FunctionName: WORKER_FUNCTION_NAME, 
                InvocationType: 'Event', 
                Payload: JSON.stringify({ jobId, prompt })
            }));

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ 
                    jobId: jobId, 
                    status: "QUEUED",
                    message: "OSINT Analyse (Mistral Pixtral) gestartet." 
                })
            };
        }

        // >>> FALL B: STANDARD CHAT / VISION MIT MISTRAL <<<
        else {
            let userMessageContent = [{ type: "text", text: prompt || "Hallo" }];

            // Bilddaten für Mistral Pixtral vorbereiten
            if (imageBase64) {
                console.log("Verarbeite Bilddaten für Mistral Pixtral.");
                userMessageContent.push({
                    type: "image_url",
                    image_url: {
                        // Base64 muss in eine Data URL eingebettet werden
                        url: `data:${imageMediaType || 'image/jpeg'};base64,${imageBase64}`
                    }
                });
            }

            // MISTRAL PAYLOAD STRUKTUR
            const mistralPayload = {
                messages: [{ role: "user", content: userMessageContent }],
                max_tokens: 2000,
                temperature: 0.7 // Standardwert
            };

            const command = new InvokeModelCommand({
                modelId: MODEL_ID,
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify(mistralPayload)
            });

            const response = await bedrockClient.send(command);
            const jsonResponse = JSON.parse(new TextDecoder().decode(response.body));
            
            // MISTRAL RESPONSE PARSING (choices[0].message.content)
            const finalResponse = jsonResponse.choices?.[0]?.message?.content || "Fehler beim Parsen der Mistral-Antwort.";

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ response: finalResponse })
            };
        }

    } catch (error) {
        console.error("❌ ERROR in BedrockFunction:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: error.message })
        };
    }
};