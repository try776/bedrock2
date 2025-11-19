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

const ENV = process.env.ENV;
const REGION = 'eu-central-1'; 
const TABLE_NAME = process.env.STORAGE_OSINTJOBS_NAME || "OsintJobs";

// Umstellung auf Mistral Pixtral (EU Profile)
const MODEL_ID = "eu.mistral.pixtral-large-2502-v1:0";

const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });
const ddbClient = new DynamoDBClient({ region: REGION });

export const handler = async (event) => {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": "application/json"
    };

    try {
        // ... (GET BLOCK FÜR JOB STATUS BLEIBT GLEICH) ...

        // --- POST REQUEST ---
        let body = {};
        if (event.body) {
            body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        }
        const { prompt, mode, imageBase64, imageMediaType } = body;

        // FALL A: OSINT JOB (Bleibt gleich, ruft nur den Worker auf)
        if (mode === 'Full OSINT Report') {
             // ... (Code wie gehabt, Worker wird asynchron getriggert)
        }

        // >>> FALL B: STANDARD CHAT / VISION MIT MISTRAL PIXTRAL <<<
        else {
            let content = [];
            
            // 1. Text Prompt
            content.push({ type: "text", text: prompt || "Hallo" });

            // 2. Bild (Falls vorhanden) - Mistral Pixtral Format
            if (imageBase64) {
                content.push({
                    type: "image_url",
                    image_url: {
                        url: `data:${imageMediaType || 'image/jpeg'};base64,${imageBase64}`
                    }
                });
            }

            const mistralPayload = {
                messages: [{ role: "user", content: content }],
                max_tokens: 2000,
                temperature: 0.7
            };

            const command = new InvokeModelCommand({
                modelId: MODEL_ID,
                contentType: "application/json",
                accept: "application/json",
                body: JSON.stringify(mistralPayload)
            });

            const response = await bedrockClient.send(command);
            const jsonResponse = JSON.parse(new TextDecoder().decode(response.body));
            
            // Mistral Response Parsing
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ response: jsonResponse.choices[0].message.content })
            };
        }

    } catch (error) {
        console.error("ERROR in BedrockFunction:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};