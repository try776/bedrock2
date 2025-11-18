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

// KONFIGURATION
const TABLE_NAME = process.env.STORAGE_OSINTJOBS_NAME || "OsintJobs";
// Erhöht auf 10, um nach dem Filtern noch genug übrig zu haben
const MAX_SOURCES_PER_CATEGORY = 10; 
const TIMEOUT_MS = 6000; // Reduziert auf 6s pro Feed, damit Gesamtzeit kürzer bleibt

// AWS CLIENTS
const MODEL_ID = 'anthropic.claude-3-5-sonnet-20240620-v1:0'; 
const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' }); 
const ddbClient = new DynamoDBClient({ region: process.env.REGION });

// HILFSFUNKTION: Status-Update in DynamoDB schreiben
async function updateJobStatus(jobId, status, message = "") {
    try {
        await ddbClient.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { id: { S: jobId } },
            UpdateExpression: "SET #s = :s, #msg = :m",
            ExpressionAttributeNames: { "#s": "status", "#msg": "message" }, // 'message' Feld für UI Feedback
            ExpressionAttributeValues: { ":s": { S: status }, ":m": { S: message } }
        }));
    } catch (e) { console.warn("Status update failed", e); }
}

/**
 * Generiert Such-Vektoren inkl. einer "General" Fallback-Kategorie
 */
const generateSearchVectors = (topic, timeParam) => {
    const baseUrl = "https://news.google.com/rss/search?hl=de&gl=CH&ceid=CH:de&scoring=n";
    const encodedTopic = encodeURIComponent(topic);
    
    const sectors = [
        // NEU: Generelle Suche als "Staubsauger" für alle News, falls spezifische Sektoren leer sind
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

async function fetchFeedData(url, sourceLabel, timeLimitDate = null) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OsintBot/2.1; +http://example.com)' },
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
            
            // STRIKTER 72H FILTER
            if (timeLimitDate && pubDateObj < timeLimitDate) return;

            const formattedDate = !isNaN(pubDateObj) 
                ? pubDateObj.toISOString().split('T')[0] 
                : "Unbekannt";

            // Beschreibung bereinigen
            let rawDesc = $(element).find('description').text();
            let cleanDesc = rawDesc.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);

            if (title && link) {
                items.push({
                    id: `${sourceLabel}_${i}`,
                    source: source,
                    date: formattedDate,
                    timestamp: pubDateObj.getTime(),
                    title: title,
                    summary: cleanDesc,
                    url: link 
                });
            }
        });
        return items;
    } catch (error) {
        // Wir loggen nur, brechen aber nicht ab. Leere Liste zurückgeben.
        console.warn(`Fetch failed for ${sourceLabel}: ${error.message}`);
        return [];
    }
}

export const handler = async (event) => {
    console.log("🚀 WORKER STARTED");
    let payload = event;
    if (event.body) { try { payload = JSON.parse(event.body); } catch(e){} }
    const { jobId, prompt } = payload; 
    if (!jobId) return;

    try {
        const rawPrompt = (prompt || "Unbekannt");
        const is72h = rawPrompt.startsWith("MODE_72H:");
        const searchTopic = rawPrompt.replace("MODE_72H:", "").replace("Region Scan:", "").trim();
        const timeParam = is72h ? "qdr:h72" : "qdr:w";
        const timeLabel = is72h ? "Letzte 72 Stunden" : "Letzte 7 Tage";

        let limitDate = null;
        if (is72h) limitDate = new Date(Date.now() - (72 * 60 * 60 * 1000));

        // 1. STATUS UPDATE: GATHERING
        await updateJobStatus(jobId, "FETCHING", `Durchsuche Quellen nach '${searchTopic}'...`);

        const searchVectors = generateSearchVectors(searchTopic, timeParam);
        const fetchPromises = searchVectors.map(vec => fetchFeedData(vec.url, vec.label, limitDate));
        
        // Wichtig: Wir warten auf alle, auch wenn welche fehlschlagen (Fehler werden in fetchFeedData abgefangen)
        const results = await Promise.all(fetchPromises);
        
        let allItems = results.flat();
        allItems.sort((a, b) => b.timestamp - a.timestamp);

        // Deduplizierung (Verbessert: Nutzt Titel + Quelle um "gleiche Story andere Zeitung" zu behalten, aber exakte Duplikate zu löschen)
        const uniqueItems = [];
        const urlsSeen = new Set();
        allItems.forEach(item => {
            if (!urlsSeen.has(item.url)) {
                urlsSeen.add(item.url);
                uniqueItems.push(item);
            }
        });

        console.log(`📦 Found ${uniqueItems.length} items`);

        if (uniqueItems.length === 0) {
            throw new Error(`Keine aktuellen Nachrichten in den letzten ${is72h ? '72h' : '7 Tagen'} gefunden.`);
        }

        // 2. STATUS UPDATE: ANALYZING
        await updateJobStatus(jobId, "ANALYZING", `${uniqueItems.length} Artikel gefunden. KI analysiert Zusammenhänge...`);

        const intelContext = JSON.stringify(uniqueItems.slice(0, 45)); // Max 45 Items für Puffer

        const systemPrompt = `
DU BIST: Elite Intelligence Analyst. 
AUFTRAG: Erstelle einen OSINT-Lagebericht für "${searchTopic}".

QUELLEN-REGELN:
- Nutze NUR die bereitgestellten JSON-Daten.
- Zeige IMMER das Datum (Feld "date") an.
- Kopiere die URL (Feld "url") 1:1.
- Priorisiere Ereignisse, die jünger als 24h sind.

OUTPUT FORMAT (Markdown):

# 🚨 LAGEBERICHT: ${searchTopic}
*Zeitraum: ${timeLabel} | Quellen: ${uniqueItems.length}*

## 📌 KRITISCHE ENTWICKLUNGEN

1. **[Prägnante Schlagzeile]**
   - **Sachverhalt:** Was ist passiert? (Faktenbasiert)
   - **Implikation:** Was bedeutet das für Stabilität/Sicherheit?
   - 📅 *[YYYY-MM-DD]* | 🔗 [Quelle](URL_HIER)

(Maximal 6 wichtigste Themen)

---
## ⚠️ RISIKO-MATRIX
* **Trend:** [Positiv / Negativ / Neutral]
* **Sicherheitslage:** [Ruhig / Angespannt / Kritisch]
* **Assessment:** Kurze Einschätzung der Gesamtlage für Entscheidungsträger.
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

        // 3. FINALER STATUS
        await ddbClient.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { id: { S: jobId } },
            UpdateExpression: "SET #s = :s, #r = :r, #u = :u",
            ExpressionAttributeNames: { "#s": "status", "#r": "result", "#u": "updatedAt" },
            ExpressionAttributeValues: { 
                ":s": { S: "COMPLETED" }, 
                ":r": { S: finalReport },
                ":u": { S: new Date().toISOString() }
            }
        }));

    } catch (error) {
        console.error("❌ FAILED:", error);
        await updateJobStatus(jobId, "FAILED", `Fehler: ${error.message}`);
    }
};