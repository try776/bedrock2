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
const MAX_SOURCES_TOTAL = 60; // Massiv erhöht für breite Datenbasis
const TIMEOUT_MS = 9000;

// --- CLIENTS ---
const bedrockClient = new BedrockRuntimeClient({ region: REGION }); 
const ddbClient = new DynamoDBClient({ region: REGION });

// Modell: Claude 3 Sonnet (Ideal für komplexe Analysen)
const MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0";

// --- HILFSFUNKTIONEN ---

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

// Erweiterter Link Decoder (Handhabt jetzt Google & Bing Redirects)
function resolveOriginalUrl(url) {
    try {
        // Google Logic
        if (url.includes('news.google.com') && url.includes('/articles/')) {
            const splitUrl = url.split('/articles/');
            if (splitUrl.length >= 2) {
                const base64Part = splitUrl[1].split('?')[0];
                const decodedBuffer = Buffer.from(base64Part, 'base64').toString('latin1');
                const urlMatch = decodedBuffer.match(/(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/);
                return urlMatch ? urlMatch[0] : url;
            }
        }
        // Bing Logic (Bing News nutzt oft direkte Links, aber sicherheitshalber)
        return url;
    } catch (e) { return url; }
}

// Verbesserter Ähnlichkeits-Check (Jaccard + Längen-Bias)
function calculateSimilarity(str1, str2) {
    const s1 = str1.toLowerCase().replace(/[^\w\s]/g, '');
    const s2 = str2.toLowerCase().replace(/[^\w\s]/g, '');
    const set1 = new Set(s1.split(/\s+/));
    const set2 = new Set(s2.split(/\s+/));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
}

// 🚀 Such-Vektoren: Jetzt mit Google UND Bing + Krisen-Keywords
const generateSearchVectors = (topic, timeParamGoogle) => {
    const encodedTopic = encodeURIComponent(topic);
    
    // Google Base (Zeitparameter wird übergeben)
    const gBase = `https://news.google.com/rss/search?hl=de&gl=CH&ceid=CH:de&scoring=n&tbs=${timeParamGoogle}`;
    
    // Bing Base (Format=RSS)
    const bBase = `https://www.bing.com/news/search?format=rss&q=${encodedTopic}`;

    const vectors = [
        // 1. Allgemeine Lage (Google & Bing Mix)
        { label: "MAIN_G", url: `${gBase}&q=${encodedTopic}` },
        { label: "MAIN_B", url: `${bBase}` },

        // 2. Infrastruktur & Versorgung (Feature 1)
        { label: "INFRA", url: `${gBase}&q=${encodedTopic} AND (Strom OR Wasser OR Internet OR Krankenhaus OR Straße OR Blockade)` },

        // 3. Gerüchte & Unbestätigtes (Für die "Grauzone" Rubrik)
        { label: "RUMOR", url: `${gBase}&q=${encodedTopic} AND (unbestätigt OR angeblich OR Gerücht OR Augenzeugen OR viral)` },

        // 4. Geo & Hilfe (Feature 2)
        { label: "AID", url: `${gBase}&q=${encodedTopic} AND (Evakuierung OR Sammelpunkt OR Spenden OR Hilfe OR Notunterkunft)` }
    ];

    return vectors;
};

// Fetcher
async function fetchFeedData(url, sourceLabel, timeLimitDate = null) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrisisMonitor/4.0)' },
            timeout: TIMEOUT_MS 
        });
        const $ = cheerio.load(response.data, { xmlMode: true });
        const items = [];
        
        $('item').each((i, element) => {
            const title = $(element).find('title').text().trim();
            const rawLink = $(element).find('link').text().trim();
            const pubDateRaw = $(element).find('pubDate').text();
            const source = $(element).find('source').text() || "Unknown Source";
            const pubDateObj = new Date(pubDateRaw);
            
            if (timeLimitDate && pubDateObj < timeLimitDate) return;

            let cleanDesc = $(element).find('description').text()
                .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);

            const realUrl = resolveOriginalUrl(rawLink);

            if (title && realUrl) {
                items.push({
                    source, 
                    date: !isNaN(pubDateObj) ? pubDateObj.toISOString() : "N/A",
                    timestamp: pubDateObj.getTime(), 
                    title, 
                    summary: cleanDesc, 
                    url: realUrl,
                    type: sourceLabel // Speichert den Typ (z.B. RUMOR oder INFRA)
                });
            }
        });
        return items;
    } catch (error) { return []; }
}

export const handler = async (event) => {
    console.log("🚀 OSINT WORKER v4 (CRISIS EDITION) STARTED");
    
    let payload = event.body && typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
    const { jobId, prompt } = payload; 
    
    if (!jobId) return { statusCode: 400, body: "No JobID" };

    try {
        const rawPrompt = (prompt || "Unbekannt");
        const is72h = rawPrompt.startsWith("MODE_72H:");
        const searchTopic = rawPrompt.replace("MODE_72H:", "").replace("Region Scan:", "").trim();
        
        // Zeit-Parameter
        const timeParamG = is72h ? "qdr:h72" : "qdr:w"; 
        const timeLabel = is72h ? "Letzte 72 Stunden (AKUT)" : "Letzte 7 Tage";
        let limitDate = is72h ? new Date(Date.now() - (72 * 60 * 60 * 1000)) : null;

        await updateJobStatus(jobId, "FETCHING", `Aktiviere Krisen-Monitoring für: '${searchTopic}'...`);

        // 1. Aggressives Fetching (Google & Bing)
        const searchVectors = generateSearchVectors(searchTopic, timeParamG);
        const results = await Promise.all(searchVectors.map(vec => fetchFeedData(vec.url, vec.label, limitDate)));
        
        let allItems = results.flat().sort((a, b) => b.timestamp - a.timestamp);

        // 2. Smart Deduplication
        const uniqueItems = [];
        const titlesSeen = [];
        
        allItems.forEach(item => {
            const isUrlDuplicate = uniqueItems.some(u => u.url === item.url);
            // Titel-Check etwas lockerer für "Breaking News", die sich oft wiederholen
            const isTitleDuplicate = titlesSeen.some(t => calculateSimilarity(t, item.title) > 0.85);

            if (!isUrlDuplicate && !isTitleDuplicate) {
                uniqueItems.push(item);
                titlesSeen.push(item.title);
            }
        });

        // Limitierung für AI Input (Wichtigste zuerst)
        const contextItems = uniqueItems.slice(0, 50);

        if (contextItems.length === 0) throw new Error("Keine Daten im Zielgebiet gefunden.");

        await updateJobStatus(jobId, "ANALYZING", `${contextItems.length} Intel-Points gefunden. Claude 3 erstellt Lagebeurteilung...`);

        // 3. Der "Crisis" System Prompt
        const systemPrompt = `DU BIST: Leiter Krisenstab / Intelligence Officer. 
        AUFGABE: Erstelle ein operatives Lagebild für Einsatzkräfte/Entscheider.
        THEMA: "${searchTopic}" | ZEITRAUM: ${timeLabel}
        QUELLE DATEN: JSON News Feed.
        
        ANWEISUNG: Sei extrem präzise. Trenne Fakten von Gerüchten. Extrahiere Orte.

        STRUKTUR DES BERICHTS (Markdown):
        
        # 🚨 LAGEBEURTEILUNG: ${searchTopic}
        *(Stand: ${new Date().toLocaleString('de-DE')})*
        
        ## 🚦 STATUS DASHBOARD
        * **Gefahrenstufe**: [Niedrig/Mittel/Kritisch/Katastrophal]
        * **Infrastruktur**: [Stabil/Teilweise Ausfall/Zusammenbruch]
        * **Informationslage**: [Klar/Widersprüchlich/Chaotisch]

        ## 📌 GESICHERTE ERKENNTNISSE (Verified Intel)
        Nur Fakten, die von reputablen Quellen (dpa, Reuters, Behörden) bestätigt sind.
        * **[Ereignis]**: Details. (📍 Ort | 🔗 [Quelle](URL))

        ## ❓ GRAUZONE / UNBESTÄTIGTE MELDUNGEN
        Hier kommen Meldungen hin, die als "angeblich", "laut Berichten" oder "viral" markiert sind.
        > ⚠️ *Warnung: Diese Informationen sind nicht verifiziert.*
        * [Gerücht/Meldung 1]
        * [Gerücht/Meldung 2]

        ## 🏗️ INFRASTRUKTUR & VERSORGUNG
        Status zu: Strom, Internet, Wasser, Straßen, Flughäfen.
        * **Status**: ...

        ## 🗺️ GEO-TARGETING & HILFE
        Identifizierte Orte für Logistik oder Gefahr.
        * **Gefahrenzonen**: [Orte auflisten]
        * **Hilfspunkte**: [Sammelstellen, Krankenhäuser]

        ## 🔮 PROGNOSE (Nächste 24h)
        Kurze taktische Einschätzung.`;

        const command = new InvokeModelCommand({
            modelId: MODEL_ID,
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 4000, // Max Output erhöht für detaillierte Berichte
                system: systemPrompt,
                messages: [{ role: 'user', content: `Verarbeite diese Intel-Daten:\n${JSON.stringify(contextItems)}` }]
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
                ":m": { S: "Operatives Lagebild erstellt." },
                ":u": { S: new Date().toISOString() }
            }
        }));
        
        console.log("✅ CRISIS JOB COMPLETED");
        return { statusCode: 200, body: "OK" };

    } catch (error) {
        console.error("❌ FAILED:", error);
        await updateJobStatus(jobId, "FAILED", `Crit Error: ${error.message}`);
        return { statusCode: 500, body: error.message };
    }
};