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
const REGION = process.env.REGION || "eu-central-1";
const MAX_SOURCES_PER_CATEGORY = 10; 
const TIMEOUT_MS = 6000;

// --- CLIENTS ---
// Bedrock nutzen wir hier aus us-east-1 für maximale Modell-Verfügbarkeit
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' }); 
// DynamoDB ist in deiner lokalen Region (eu-central-1)
const ddbClient = new DynamoDBClient({ region: REGION });
const MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0'; 

// HILFSFUNKTION: Status in DynamoDB aktualisieren
async function updateJobStatus(jobId, status, message = "") {
    console.log(`STATUS UPDATE [${jobId}]: ${status} - ${message}`);
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
    } catch (e) { 
        console.error("Failed to update status in DynamoDB:", e); 
    }
}

// Such-Vektoren generieren
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

// Daten abrufen
async function fetchFeedData(url, sourceLabel, timeLimitDate = null) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OsintBot/2.2; +http://your-app.com)' },
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
            
            // Zeit-Filter prüfen
            if (timeLimitDate && pubDateObj < timeLimitDate) return;

            // HTML aus Beschreibung entfernen
            let rawDesc = $(element).find('description').text();
            let cleanDesc = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);

            if (title && link) {
                items.push({
                    id: `${sourceLabel}_${i}`,
                    source: source,
                    date: !isNaN(pubDateObj) ? pubDateObj.toISOString().split('T')[0] : "N/A",
                    timestamp: pubDateObj.getTime(),
                    title: title,
                    summary: cleanDesc,
                    url: link 
                });
            }
        });
        return items;
    } catch (error) {
        console.warn(`Skipping feed ${sourceLabel}: ${error.message}`);
        return [];
    }
}

export const handler = async (event) => {
    console.log("🚀 OSINT WORKER STARTED", JSON.stringify(event));
    
    let payload = event;
    // Falls der Payload als String im Body kommt (manchmal bei Direct Invoke)
    if (event.body && typeof event.body === 'string') { 
        try { payload = JSON.parse(event.body); } catch(e){} 
    } else if (event.body && typeof event.body === 'object') {
        payload = event.body;
    }

    const { jobId, prompt } = payload; 
    
    if (!jobId) {
        console.error("❌ KEINE JOB ID ERHALTEN. Abbruch.");
        return;
    }

    try {
        const rawPrompt = (prompt || "Unbekannt");
        const is72h = rawPrompt.startsWith("MODE_72H:");
        const searchTopic = rawPrompt.replace("MODE_72H:", "").replace("Region Scan:", "").trim();
        const timeParam = is72h ? "qdr:h72" : "qdr:w";
        const timeLabel = is72h ? "Letzte 72 Stunden" : "Letzte 7 Tage";

        let limitDate = null;
        if (is72h) limitDate = new Date(Date.now() - (72 * 60 * 60 * 1000));

        // 1. GATHERING PHASE
        await updateJobStatus(jobId, "FETCHING", `Scanne Nachrichten zu: '${searchTopic}'...`);

        const searchVectors = generateSearchVectors(searchTopic, timeParam);
        const fetchPromises = searchVectors.map(vec => fetchFeedData(vec.url, vec.label, limitDate));
        
        const results = await Promise.all(fetchPromises);
        
        let allItems = results.flat();
        allItems.sort((a, b) => b.timestamp - a.timestamp);

        // Deduplizierung
        const uniqueItems = [];
        const urlsSeen = new Set();
        allItems.forEach(item => {
            if (!urlsSeen.has(item.url)) {
                urlsSeen.add(item.url);
                uniqueItems.push(item);
            }
        });

        console.log(`📦 Gefundene Artikel: ${uniqueItems.length}`);

        if (uniqueItems.length === 0) {
            throw new Error(`Keine Nachrichten im Zeitraum (${timeLabel}) gefunden.`);
        }

        // 2. ANALYZING PHASE
        await updateJobStatus(jobId, "ANALYZING", `${uniqueItems.length} Artikel gefunden. Starte KI-Analyse...`);

        // Kontext begrenzen, damit Prompt nicht explodiert
        const intelContext = JSON.stringify(uniqueItems.slice(0, 45)); 

        const systemPrompt = `
DU BIST: Elite Intelligence Analyst. 
AUFTRAG: Erstelle einen professionellen OSINT-Lagebericht für "${searchTopic}".

QUELLEN-REGELN:
- Nutze NUR die bereitgestellten JSON-Daten.
- Halluziniere KEINE Fakten.
- Datum Format: YYYY-MM-DD.

OUTPUT FORMAT (Markdown):

# 🚨 LAGEBERICHT: ${searchTopic}
*Zeitraum: ${timeLabel} | Quellen: ${uniqueItems.length}*

## 📌 KRITISCHE ENTWICKLUNGEN

1. **[Prägnante Schlagzeile]**
   - **Fakten:** Was ist passiert?
   - **Analyse:** Bedeutung/Auswirkung.
   - 📅 *[Datum]* | 🔗 [Quelle](URL)

(Maximal 5-6 wichtigste Cluster)

---
## ⚠️ RISIKO-MATRIX
* **Trend:** [Positiv / Negativ / Neutral]
* **Sicherheitslage:** [Ruhig / Angespannt / Kritisch]
* **Fazit:** Strategische Zusammenfassung (2-3 Sätze).
`;

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

        // 3. ABSCHLUSS
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
        console.error("❌ JOB FAILED:", error);
        await updateJobStatus(jobId, "FAILED", `Abbruch: ${error.message}`);
    }
};