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
import { URL } from 'url';

// --- KONFIGURATION ---
const TABLE_NAME = process.env.STORAGE_OSINTJOBS_NAME || "OsintJobs";
const REGION = process.env.REGION || "eu-central-1"; 
const MAX_SOURCES_TOTAL = 80; // Erhöht für Cross-Language
const TIMEOUT_MS = 20000; // Erhöht auf 20s für HTTP-Resolving

// Domains, die wir bevorzugen (Credibility Boost)
const TRUSTED_DOMAINS = ['reuters', 'apnews', 'tagesschau', 'nzz', 'bbc', 'cnn', 'zeit', 'spiegel'];
// Domains, die wir ignorieren (Spam/Low Value)
const BLACKLIST_DOMAINS = ['pinterest', 'ebay', 'amazon', 'temu'];

// --- CLIENTS ---
const bedrockClient = new BedrockRuntimeClient({ region: REGION }); 
const ddbClient = new DynamoDBClient({ region: REGION });

// UPGRADE: Claude 3.5 Sonnet (Beste Logik am Markt aktuell)
// Falls in deiner Region noch nicht verfügbar, fallback auf 'anthropic.claude-3-sonnet-20240229-v1:0'
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

// 🔧 PRO LINK RESOLVER: Folgt echten HTTP Redirects
// Das ist langsamer, aber der einzige Weg, Google Links 100% zu fixen.
async function resolveRealUrl(url) {
    // Nur auflösen, wenn es nach Redirect aussieht
    if (!url.includes('google.com') && !url.includes('r.search.yahoo')) return url;
    
    try {
        const response = await axios.head(url, {
            maxRedirects: 5,
            timeout: 3000,
            validateStatus: (status) => status >= 200 && status < 400
        });
        // Axios folgt Redirects automatisch, response.request.res.responseUrl ist das Ziel
        return response.request.res.responseUrl || url;
    } catch (e) {
        // Fallback: Base64 Decoding Versuch für Google
        if (url.includes('articles/')) {
            try {
                const base64Part = url.split('articles/')[1].split('?')[0];
                const decoded = Buffer.from(base64Part, 'base64').toString('latin1');
                const match = decoded.match(/(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/);
                return match ? match[0] : url;
            } catch (err) { return url; }
        }
        return url; 
    }
}

// Score Berechnung für Sortierung
function calculateQualityScore(item) {
    let score = 0;
    const text = (item.title + " " + item.summary).toLowerCase();
    
    // 1. Domain Trust
    if (TRUSTED_DOMAINS.some(d => item.url.includes(d))) score += 5;
    
    // 2. Aktualität (letzte 2h gibt Bonus)
    const hoursAgo = (Date.now() - item.timestamp) / (1000 * 60 * 60);
    if (hoursAgo < 2) score += 3;

    // 3. Keyword Dichte (Relevant vs Spam)
    if (text.length > 50) score += 1;
    
    return score;
}

// DuckDuckGo HTML Scraper (Kein RSS)
async function fetchDuckDuckGo(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=de-de`;
    try {
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 5000
        });
        const $ = cheerio.load(response.data);
        const items = [];
        
        $('.result').each((i, el) => {
            if (i > 10) return;
            const title = $(el).find('.result__a').text().trim();
            const link = $(el).find('.result__a').attr('href');
            const snippet = $(el).find('.result__snippet').text().trim();
            
            if (title && link && !link.includes('duckduckgo.com/y.js')) { // Werbung filtern
                 // DDG Links müssen oft dekodiert werden
                 const decodedLink = decodeURIComponent(link.replace('//duckduckgo.com/l/?uddg=', '').split('&')[0]);
                 items.push({
                    source: "DuckDuckGo Search",
                    date: new Date().toISOString().split('T')[0], // DDG liefert kein Datum im HTML
                    timestamp: Date.now(),
                    title,
                    summary: snippet,
                    url: decodedLink,
                    type: "WEB_SEARCH"
                 });
            }
        });
        return items;
    } catch (e) {
        console.warn("DDG Fetch Error:", e.message);
        return [];
    }
}

// Standard RSS Fetcher
async function fetchFeedData(url, sourceLabel, timeLimitDate = null) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OSINT-Bot/5.0)' },
            timeout: 5000 
        });
        const $ = cheerio.load(response.data, { xmlMode: true });
        const items = [];
        
        $('item').each((i, element) => {
            const title = $(element).find('title').text().trim();
            const rawLink = $(element).find('link').text().trim();
            const pubDateRaw = $(element).find('pubDate').text();
            const source = $(element).find('source').text() || "News Feed";
            const pubDateObj = new Date(pubDateRaw);
            
            if (timeLimitDate && pubDateObj < timeLimitDate) return;

            let cleanDesc = $(element).find('description').text()
                .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);

            // Blacklist Filter
            if (BLACKLIST_DOMAINS.some(d => rawLink.includes(d))) return;

            items.push({
                source, 
                date: !isNaN(pubDateObj) ? pubDateObj.toISOString() : "N/A",
                timestamp: pubDateObj.getTime(), 
                title, 
                summary: cleanDesc, 
                url: rawLink, // Wir resolven später nur die besten
                type: sourceLabel 
            });
        });
        return items;
    } catch (error) { return []; }
}

export const handler = async (event) => {
    console.log("🚀 OSINT WORKER v5 (Deep Search) STARTED");
    
    let payload = event.body && typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
    const { jobId, prompt } = payload; 
    
    if (!jobId) return { statusCode: 400, body: "No JobID" };

    try {
        const rawPrompt = (prompt || "Unbekannt");
        const is72h = rawPrompt.startsWith("MODE_72H:");
        const searchTopic = rawPrompt.replace("MODE_72H:", "").replace("Region Scan:", "").trim();
        
        const timeParamG = is72h ? "qdr:h72" : "qdr:w"; 
        const timeLabel = is72h ? "AKUT-LAGE (72h)" : "Lagebild (7 Tage)";
        let limitDate = is72h ? new Date(Date.now() - (72 * 60 * 60 * 1000)) : null;

        await updateJobStatus(jobId, "FETCHING", `Starte Multi-Source Scan (Google, Bing, DDG) für: '${searchTopic}'...`);

        // --- 1. SUCH-VEKTOREN ---
        const encodedTopic = encodeURIComponent(searchTopic);
        const encodedTopicEn = encodeURIComponent(searchTopic + " news"); // Feature: Englisch

        const tasks = [
            // Google Main (DE)
            fetchFeedData(`https://news.google.com/rss/search?hl=de&gl=CH&ceid=CH:de&scoring=n&q=${encodedTopic}&tbs=${timeParamG}`, "GOOGLE_DE", limitDate),
            // Google English (Feature: Cross-Language)
            fetchFeedData(`https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&scoring=n&q=${encodedTopicEn}&tbs=${timeParamG}`, "GOOGLE_EN", limitDate),
            // Bing News
            fetchFeedData(`https://www.bing.com/news/search?format=rss&q=${encodedTopic}`, "BING", limitDate),
            // DuckDuckGo (Feature: Web Scrape)
            fetchDuckDuckGo(searchTopic),
            // Yahoo News (Fallback Source)
            fetchFeedData(`https://news.search.yahoo.com/rss?p=${encodedTopic}`, "YAHOO", limitDate)
        ];

        const results = await Promise.all(tasks);
        let allItems = results.flat();

        // --- 2. FILTERUNG & SCORING ---
        const uniqueItems = [];
        const urlsSeen = new Set();
        
        // Scoring hinzufügen
        allItems = allItems.map(item => ({...item, score: calculateQualityScore(item)}));
        // Sortieren nach Score + Datum (Wichtigste zuerst)
        allItems.sort((a, b) => (b.score + b.timestamp/10000000000) - (a.score + a.timestamp/10000000000));

        for (const item of allItems) {
            if (!urlsSeen.has(item.url)) {
                urlsSeen.add(item.url);
                uniqueItems.push(item);
            }
        }

        const topItems = uniqueItems.slice(0, 45); // Kontext Fenster schützen

        // --- 3. LINK RESOLVING (Feature: Link Fix) ---
        // Wir resolven nur die Top Items, um Timeouts zu vermeiden
        await updateJobStatus(jobId, "RESOLVING", `Validiere Links und Metadaten für ${topItems.length} Quellen...`);
        
        const resolvedItems = await Promise.all(topItems.map(async (item) => {
            const realUrl = await resolveRealUrl(item.url);
            return { ...item, url: realUrl };
        }));

        // --- 4. ANALYSE ---
        await updateJobStatus(jobId, "ANALYZING", `Claude 3.5 analysiert Datenpunkte...`);

        const systemPrompt = `DU BIST: Senior Intelligence Analyst (OSINT).
        THEMA: "${searchTopic}" | ZEITRAUM: ${timeLabel}
        AUFGABE: Erstelle eine präzise Sicherheitsanalyse.

        INPUT DATEN METRIKEN:
        - Artikel Gesamt: ${allItems.length}
        - Quellen: Google, Bing, DuckDuckGo, Yahoo
        - Velocity: ${allItems.filter(i => (Date.now() - i.timestamp) < 3600000).length} Artikel in der letzten Stunde.

        OUTPUT FORMAT (Markdown):
        
        # 🛡️ INTELLIGENCE REPORT: ${searchTopic}
        
        ## ⚡ EXECUTIVE DASHBOARD
        * **Bedrohungslage**: [Niedrig/Mittel/Hoch]
        * **Narrativ-Konsens**: [Einheitlich / Stark Widersprüchlich]
        * **Top-Quellen**: Welche Medien treiben das Thema?

        ## 🔍 TIEFENANALYSE (Fakten & Verifikation)
        Nutze die "Score" Metrik der Input-Daten, um relevante von irrelevanten News zu trennen.
        * **[Haupt-Ereignis/Entwicklung]**
          * *Details*: Was ist bestätigt?
          * *Kontext*: Was bedeutet das strategisch?
          * *Quellen*: [Quelle] - 🔗 [Link](URL)

        ## 🌍 INTERNATIONALE PERSPEKTIVE
        Gibt es Unterschiede zwischen deutschen und englischen Berichten (falls vorhanden)?

        ## 📉 TRENDS & SIGNALE
        * **Sentiment**: Wie ist die Stimmung?
        * **Desinformation?**: Hinweise auf Fake News/Gerüchte?
        
        ## 🔮 OUTLOOK
        Was ist in den nächsten 24h zu erwarten?`;

        const command = new InvokeModelCommand({
            modelId: MODEL_ID,
            body: JSON.stringify({
                anthropic_version: 'bedrock-2023-05-31',
                max_tokens: 4000,
                system: systemPrompt,
                messages: [{ role: 'user', content: `Analysiere diese verifizierten Daten:\n${JSON.stringify(resolvedItems)}` }]
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
                ":m": { S: "Deep Scan & Analyse abgeschlossen." },
                ":u": { S: new Date().toISOString() }
            }
        }));
        
        console.log("✅ DEEP SEARCH JOB COMPLETED");
        return { statusCode: 200, body: "OK" };

    } catch (error) {
        console.error("❌ FAILED:", error);
        await updateJobStatus(jobId, "FAILED", `Error: ${error.message}`);
        return { statusCode: 500, body: error.message };
    }
};