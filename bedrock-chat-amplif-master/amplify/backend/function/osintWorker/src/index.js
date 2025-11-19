/* Amplify Params - DO NOT EDIT
   ENV
   REGION
   STORAGE_OSINTJOBS_NAME
   NAME: OSINTWORKER
Amplify Params - DO NOT EDIT */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import axios from 'axios';
import * as cheerio from 'cheerio';

// --- KONFIGURATION ---
const TABLE_NAME = process.env.STORAGE_OSINTJOBS_NAME || "OsintJobs";
// WICHTIG: Frankfurt erzwingen
const REGION = "eu-central-1"; 
const MAX_SOURCES_PER_CATEGORY = 10; 
const TIMEOUT_MS = 6000;

// --- CLIENTS ---
// Bedrock Client jetzt in Frankfurt
const bedrockClient = new BedrockRuntimeClient({ region: REGION }); 
const ddbClient = new DynamoDBClient({ region: REGION });

// NEUESTES MODELL: Claude 3.5 Sonnet
const MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0'; 

// HILFSFUNKTION: Status Update
async function updateJobStatus(jobId, status, message = "") {
    console.log(`STATUS: ${status} - ${message}`);
    try {
        await ddbClient.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { id: { S: jobId } },
            UpdateExpression: "SET #s = :s, #msg = :m, #u = :u",
            ExpressionAttributeNames: { "#s": "status", "#msg": "message", "#u": "updatedAt" },
            ExpressionAttributeValues: { 
                ":s": { S: status }, 
                ":m": { S: message },
                ":u": { S: new Date().toISOString() }
            }
        }));
    } catch (e) { console.error("DB Update Failed:", e); }
}

// Such-Vektoren (Gleichbleibend)
const generateSearchVectors = (topic, timeParam) => {
    const baseUrl = "https://news.google.com/rss/search?hl=de&gl=CH&ceid=CH:de&scoring=n";
    const encodedTopic = encodeURIComponent(topic);
    
    const sectors = [
        { id: "GENERAL_NEWS", query: `${encodedTopic}` }, 
        { id: "POLITICS", query: `${encodedTopic} (Regierung OR Parlament OR Gesetz OR Abstimmung)` },
        { id: "SECURITY", query: `${encodedTopic} (Polizei OR Kriminalität OR Unfall OR Sicherheit)` },
        { id: "ECONOMY", query: `${encodedTopic} (Wirtschaft OR Bank OR Firmen OR Konkurs)` },
        { id: "SOCIAL", query: `${encodedTopic} (Demo OR Protest OR Gesellschaft OR Bildung)` }
    ];

    return sectors.map(sector => ({
        label: sector.id,
        url: `${baseUrl}&q=${sector.query}&tbs=${timeParam}`
    }));
};

// Fetcher (Gleichbleibend)
async function fetchFeedData(url, sourceLabel, timeLimitDate = null) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OsintBot/2.2)' },
            timeout: TIMEOUT_MS 
        });
        const $ = cheerio.load(response.data, { xmlMode: true });
        const items = [];
        $('item').each((i, element) => {
            if (items.length >= MAX_SOURCES_PER_CATEGORY) return false;
            const title = $(element).find('title').text().trim();
            const link = $(element).find('link').text().trim();
            const pubDateRaw = $(element).find('pubDate').text();
            const source = $(element).find('source').text() || "Unknown";
            const pubDateObj = new Date(pubDateRaw);
            
            if (timeLimitDate && pubDateObj < timeLimitDate) return;

            let rawDesc = $(element).find('description').text();
            let cleanDesc = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);

            if (title && link) {
                items.push({
                    id: `${sourceLabel}_${i}`,
                    source, date: !isNaN(pubDateObj) ? pubDateObj.toISOString().split('T')[0] : "N/A",
                    timestamp: pubDateObj.getTime(), title, summary: cleanDesc, url: link 
                });
            }
        });
        return items;
    } catch (error) { return []; }
}

export const handler = async (event) => {
    console.log("🚀 OSINT WORKER (Frankfurt) STARTED");
    let payload = event.body && typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
    const { jobId, prompt } = payload; 
    if (!jobId) return;

    try {
        const rawPrompt = (prompt || "Unbekannt");
        const is72h = rawPrompt.startsWith("MODE_72H:");
        const searchTopic = rawPrompt.replace("MODE_72H:", "").replace("Region Scan:", "").trim();
        const timeParam = is72h ? "qdr:h72" : "qdr:w";
        const timeLabel = is72h ? "Letzte 72 Stunden" : "Letzte 7 Tage";
        let limitDate = is72h ? new Date(Date.now() - (72 * 60 * 60 * 1000)) : null;

        await updateJobStatus(jobId, "FETCHING", `Scanne Nachrichten (Frankfurt Node) zu: '${searchTopic}'...`);

        const searchVectors = generateSearchVectors(searchTopic, timeParam);
        const results = await Promise.all(searchVectors.map(vec => fetchFeedData(vec.url, vec.label, limitDate)));
        
        let allItems = results.flat().sort((a, b) => b.timestamp - a.timestamp);
        const uniqueItems = [];
        const urlsSeen = new Set();
        allItems.forEach(item => {
            if (!urlsSeen.has(item.url)) { urlsSeen.add(item.url); uniqueItems.push(item); }
        });

        if (uniqueItems.length === 0) throw new Error("Keine Nachrichten gefunden.");

        await updateJobStatus(jobId, "ANALYZING", `${uniqueItems.length} Artikel. KI-Analyse (Claude 3.5) läuft...`);

        const intelContext = JSON.stringify(uniqueItems.slice(0, 45)); 
        const systemPrompt = `DU BIST: Elite Intelligence Analyst. THEMA: "${searchTopic}". 
        INPUT: JSON News Daten. OUTPUT: Markdown Lagebericht (Deutsch).
        STRUKTUR: 
        # 🚨 LAGEBERICHT: ${searchTopic} (${timeLabel})
        ## 📌 KRITISCHE ENTWICKLUNGEN (Max 5)
        * **[Titel]**: Fakten + Analyse. (📅 Datum | 🔗 [Quelle](URL))
        ## ⚠️ RISIKO-MATRIX
        * Trend / Sicherheitslage / Fazit.`;

        const command = new InvokeModelCommand({
            modelId: MODEL_ID,
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 3000,
                system: systemPrompt,
                messages: [{ role: 'user', content: `Daten:\n${intelContext}` }]
            }),
            contentType: 'application/json',
        });

        const res = await bedrockClient.send(command);
        const jsonResponse = JSON.parse(new TextDecoder().decode(res.body));
        const finalReport = jsonResponse.content[0].text;

        await ddbClient.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { id: { S: jobId } },
            UpdateExpression: "SET #s = :s, #r = :r, #u = :u, #msg = :m",
            ExpressionAttributeNames: { "#s": "status", "#r": "result", "#u": "updatedAt", "#msg": "message" },
            ExpressionAttributeValues: { 
                ":s": { S: "COMPLETED" }, 
                ":r": { S: finalReport },
                ":m": { S: "Analyse abgeschlossen." },
                ":u": { S: new Date().toISOString() }
            }
        }));
        console.log("✅ JOB COMPLETED");

    } catch (error) {
        console.error("❌ FAILED:", error);
        await updateJobStatus(jobId, "FAILED", `Fehler: ${error.message}`);
    }
};