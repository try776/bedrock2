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
const MAX_SOURCES_PER_VECTOR = 20; 
const TIMEOUT_MS = 25000; 

// Priorisierte Quellen für Sicherheitslagen
const HIGH_PRIORITY_DOMAINS = [
    'reuters', 'apnews', 'bbc', 'cnn', 'aljazeera', 
    'ukdefencejournal', 'navalnews', 'janes', // Defense Spezifisch
    'meteoalarm', 'wetter', 'weather', // Wetter
    'polizei', 'police', 'mil', 'gov' // Behörden
];

const IGNORE_DOMAINS = ['tripadvisor', 'booking', 'pinterest', 'ebay', 'temu', 'tiktok.com/video'];

// --- CLIENTS ---
const bedrockClient = new BedrockRuntimeClient({ region: REGION }); 
const ddbClient = new DynamoDBClient({ region: REGION });

// MODEL: MISTRAL PIXTRAL (EU INFERENCE PROFILE)
const MODEL_ID = "eu.mistral.pixtral-large-2502-v1:0";

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

// Erweiterter Link Resolver (MIT VERBESSERTEM FALLBACK FÜR GOOGLE NEWS)
async function resolveRealUrl(url) {
    // 1. URLs, die keine Google/Search-Links sind, sofort zurückgeben
    if (!url.includes('google.com') && !url.includes('r.search.yahoo') && !url.includes('duckduckgo')) return url;

    // 2. Head Request versuchen (löst Redirects bis zu 3x auf)
    try {
        const response = await axios.head(url, {
            maxRedirects: 5, // Erhöhe auf 5 für mehr Robustheit
            timeout: 4000,   // Erhöhe Timeout leicht
            validateStatus: (status) => status >= 200 && status < 400
        });
        // Die finale URL nach allen Redirects
        return response.request.res.responseUrl || url;
    } catch (e) {
        // console.warn(`Head request failed for ${url}. Trying URL decoding fallback.`);

        // 3. Fallback 1: Deep Decoding für Base64-codierte Google News Links (articles/)
        if (url.includes('articles/')) {
            try {
                // Versuche, die Base64-Part zu extrahieren
                const base64Part = url.split('articles/')[1].split('?')[0];
                const decoded = Buffer.from(base64Part, 'base64').toString('latin1');
                const match = decoded.match(/(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/);
                return match ? match[0] : url; // Gib die erste gefundene HTTP(s) URL zurück
            } catch (err) { /* ignore, try next fallback */ }
        }

        // 4. Fallback 2: Versuche, die URL zu decodieren, falls sie URL-codiert ist
        try {
            const decodedUrl = decodeURIComponent(url);
            // Wenn die Decodierung funktioniert und eine nicht-Google-URL ergibt, diese zurückgeben
            if (decodedUrl.startsWith('http') && !decodedUrl.includes('google.com')) {
                return decodedUrl;
            }
        } catch (err) { /* ignore */ }

        // 5. Wenn alles fehlschlägt, die Original-URL zurückgeben (sie ist möglicherweise nicht auflösbar)
        return url;
    }
}

// Berechnet Relevanz-Score
function calculateIntelScore(item) {
    let score = 0;
    const text = (item.title + " " + item.summary).toLowerCase();
    const securityKeywords = ['attack', 'angriff', 'military', 'militär', 'ship', 'schiff', 'marine', 'navy', 'police', 'polizei', 'alert', 'warnung', 'storm', 'sturm', 'cyber', 'outage', 'ausfall'];
    
    if (securityKeywords.some(k => text.includes(k))) score += 10;
    if (HIGH_PRIORITY_DOMAINS.some(d => item.url.includes(d))) score += 5;
    const hoursAgo = (Date.now() - item.timestamp) / (1000 * 60 * 60);
    if (hoursAgo < 4) score += 3;
    
    return score;
}

// Fetcher DuckDuckGo (UNVERÄNDERT)
async function fetchDuckDuckGo(query, label) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=de-de`;
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelBot/6.0)' },
            timeout: 6000
        });
        const $ = cheerio.load(response.data);
        const items = [];
        $('.result').each((i, el) => {
            if (i > 8) return;
            const title = $(el).find('.result__a').text().trim();
            const link = $(el).find('.result__a').attr('href');
            const snippet = $(el).find('.result__snippet').text().trim();
            
            if (title && link && !link.includes('duckduckgo.com/y.js')) {
                 const decodedLink = decodeURIComponent(link.replace('//duckduckgo.com/l/?uddg=', '').split('&')[0]);
                 items.push({
                    source: "DuckDuckGo",
                    date: new Date().toISOString().split('T')[0],
                    timestamp: Date.now(),
                    title,
                    summary: snippet,
                    url: decodedLink,
                    type: label
                 });
            }
        });
        return items;
    } catch (e) { return []; }
}

// Fetcher RSS (UNVERÄNDERT)
async function fetchRSS(url, label) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IntelBot/6.0)' },
            timeout: 6000
        });
        const $ = cheerio.load(response.data, { xmlMode: true });
        const items = [];
        
        $('item').each((i, element) => {
            if (items.length >= MAX_SOURCES_PER_VECTOR) return false;
            const title = $(element).find('title').text().trim();
            const rawLink = $(element).find('link').text().trim();
            const pubDateRaw = $(element).find('pubDate').text();
            const source = $(element).find('source').text() || "Source";
            
            if (IGNORE_DOMAINS.some(d => rawLink.includes(d))) return;

            items.push({
                source, 
                timestamp: new Date(pubDateRaw).getTime(),
                date: new Date(pubDateRaw).toISOString(),
                title, 
                summary: $(element).find('description').text().replace(/<[^>]*>/g, ' ').substring(0, 300), 
                url: rawLink,
                type: label
            });
        });
        return items;
    } catch (e) { return []; }
}

export const handler = async (event) => {
    console.log("🚀 OSINT WORKER v6 (MISTRAL PIXTRAL + STRICT TIME) STARTED");
    
    let payload = event.body && typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
    const { jobId, prompt } = payload; 
    if (!jobId) return { statusCode: 400, body: "No JobID" };

    try {
        const rawPrompt = (prompt || "Unbekannt");
        
        // --- ANPASSUNG: Entfernt 7-Tage-Logik, konzentriert sich auf 72h ---
        
        // Entfernt alle Modus-Präfixe (MODE_72H: und MODE_7D:)
        const location = rawPrompt
            .replace(/^MODE_72H:/, "") 
            .replace(/^MODE_7D:/, "") // Entfernt den alten 7D Prefix für eine saubere Eingabe
            .replace("Region Scan:", "")
            .trim();
        
        // Hardcode auf 72h Parameter und Label
        const timeParam = "qdr:h72";
        const timeLabel = "AKUT (72h)";

        await updateJobStatus(jobId, "FETCHING", `Sammle Intelligence Data für: ${location} (Modus: ${timeLabel})...`);

        const encodedLoc = encodeURIComponent(location);
        const googleBase = `https://news.google.com/rss/search?hl=de&gl=CH&ceid=CH:de&scoring=n&tbs=${timeParam}`;
        const googleEnBase = `https://news.google.com/rss/search?hl=en-US&gl=US&ceid=US:en&scoring=n&tbs=${timeParam}`;

        const tasks = [
            fetchRSS(`${googleBase}&q=${encodedLoc}`, "MAIN_DE"),
            fetchRSS(`${googleEnBase}&q=${encodedLoc}`, "MAIN_EN"),
            fetchRSS(`${googleBase}&q=${encodedLoc}+AND+(Militär+OR+Marine+OR+Polizei+OR+Einsatz+OR+Spionage+OR+Russland+OR+Schiff+OR+Navy+OR+Military)`, "DEFENSE"),
            fetchRSS(`${googleEnBase}&q=${encodedLoc}+AND+(Military+OR+Navy+OR+Police+OR+Spy+OR+Russian+OR+Vessel+OR+Incident)`, "DEFENSE_EN"),
            fetchRSS(`${googleBase}&q=${encodedLoc}+AND+(Sturm+OR+Unwetter+OR+Warnung+OR+Stromausfall+OR+Überschwemmung+OR+Verkehr)`, "INFRA_WEATHER"),
            fetchDuckDuckGo(`${location} weather warning severe storm alert`, "WEATHER_ALERT"),
            fetchRSS(`${googleBase}&q=${encodedLoc}+AND+(site:reddit.com+OR+site:twitter.com+OR+site:x.com)+AND+(Video+OR+Bericht+OR+Breaking)`, "SOCIAL_SIGNAL")
        ];

        const results = await Promise.all(tasks);
        let allItems = results.flat();

        // --- STRIKTES ZEITFILTER (Server-Side Enforcement - Hardcode auf 72h) ---
        const NOW = Date.now();
        // Harter 72-Stunden-Filter
        const MAX_AGE_MS = (72 * 60 * 60 * 1000); 
        
        const initialCount = allItems.length;
        
        allItems = allItems.filter(item => {
            if (!item.timestamp || isNaN(item.timestamp)) return false;
            const ageMs = NOW - item.timestamp;
            return ageMs <= MAX_AGE_MS;
        });

        console.log(`🕒 Zeit-Filter: ${initialCount} -> ${allItems.length} Items verbleiben (Limit: 72h)`);
        // ----------------------------------------------------------

        const uniqueItems = [];
        const urlsSeen = new Set();
        
        allItems = allItems.map(item => ({ ...item, intelScore: calculateIntelScore(item) }));
        allItems.sort((a, b) => b.intelScore - a.intelScore);

        for (const item of allItems) {
            if (!urlsSeen.has(item.url)) {
                urlsSeen.add(item.url);
                uniqueItems.push(item);
            }
        }
        
        const topIntel = uniqueItems.slice(0, 50);

        await updateJobStatus(jobId, "RESOLVING", `Validiere ${topIntel.length} Intelligence Points...`);
        
        const resolvedIntel = await Promise.all(topIntel.map(async (item) => {
            const realUrl = await resolveRealUrl(item.url);
            return { ...item, url: realUrl };
        }));

        await updateJobStatus(jobId, "ANALYZING", `Erstelle SITREP (Situation Report)...`);
        
        const systemPrompt = `DU BIST: Chief Intelligence Analyst (J2 Division).
        OPERATIVES ZIEL: Erstelle ein 'High-Level Intelligence Briefing' (SITREP) für politische und militärische Entscheidungsträger.
        ZIELGEBIET: "${location}" | BEOBACHTUNGSZEITRAUM: ${timeLabel}
        
        PRIMÄR-DIREKTIVEN (ICD 203 STANDARD):
        1. **ANALYSE STATT ZUSAMMENFASSUNG**: Liste nicht nur auf, was passiert ist. Erkläre, was es bedeutet ("So What?").
        2. **PRÄZISION**: Nutze spezifische Bezeichnungen (z.B. statt "Schiff" → "Fregatte Admiral Gorshkov"; statt "Panzer" → "T-72B3").
        3. **QUELLENKRITIK**: Wenn Quellen widersprüchlich sind, hebe dies hervor ("Diskrepanz im Meldungsaufkommen").
        4. **FILTER**: Ignoriere ziviles Rauschen (Tourismus, Promi-News, Sport), es sei denn, es hat sicherheitsrelevante Implikationen.
        5. **SPRACHE**: Strenges, militärisches Deutsch (Behördenstil). Keine Emotionen.
        
        INPUT DATEN (Verifiziert & Resolvierte Links):
        ${JSON.stringify(resolvedIntel)}

        STRUKTUR & FORMAT (Markdown):
        
        # 📑 INTELLIGENCE BRIEFING: ${location.toUpperCase()}
        **Klassifizierung:** TLP:AMBER (Open Source / Derivative)
        **Datum:** ${new Date().toISOString().split('T')[0]}
        
        ---

        ## 🚨 BLUF (Bottom Line Up Front)
        *Eine prägnante Zusammenfassung der Gesamtlage in maximal 3 Sätzen. Was ist die Kern-Bedrohung oder das wichtigste Ereignis?*

        ## 📊 KEY JUDGMENTS (Schlüsselbewertungen)
        * 1-3 analytische Schlussfolgerungen mit Wahrscheinlichkeitsangaben.*
        * Bsp: *"Es ist **hochwahrscheinlich**, dass die Truppenbewegungen an der Grenze zunehmen werden."*

        ## ⚔️ MILITARY & KINETIC ACTIVITY (Militär & Sicherheit)
        *Detaillierte Aufschlüsselung von Marine, Luftwaffe, Bodentruppen, Paramilitärs.*
        * **[Spezifische Einheit/Plattform]**: 
          * *Lage*: Was wurde beobachtet? (📍 Ort/Koordinaten falls vorh.)
          * *Analyse*: Strategische Relevanz.
          * *Quelle*: 🔗 [Publikation](URL)

        ## 🌩️ INFRASTRUCTURE & ENVIRONMENTAL HAZARDS
        *Kritische Infrastruktur (KRITIS), Energie, Cyber, Wetterkatastrophen.*
        * **[Sektor]**: Status (🟢 Stabil / 🟡 Gestört / 🔴 Kritisch)
          * *Details*: ...

        ## 🗣️ SOCIAL & INFORMATION ENVIRONMENT
        *Stimmung in der Bevölkerung, Proteste, Desinformation, Narrative.*
        * **Sentiment**: [Ruhig / Angespannt / Volatil]
        * **Signale**: ...

        ## 🔮 PROGNOSE (24h - 72h OUTLOOK)
        *Was ist als nächstes zu erwarten?*
        * **Kurzfristig**: ...
        * **Risiko**: ...

        ## ⚠️ INTELLIGENCE GAPS (Lücken)
        *Was wissen wir NICHT? (z.B. "Unklarheit über genaue Mannstärke in Sektor X").*`;

        // --- MISTRAL PIXTRAL SPEZIFISCHER AUFRUF ---
        const mistralPayload = {
            messages: [
                { 
                    role: 'user', 
                    content: systemPrompt + "\n\n" + "Generiere den Bericht jetzt auf Basis der gelieferten Intelligence Daten." 
                }
            ],
            max_tokens: 4096,
            temperature: 0.7,
            top_p: 0.9
        };

        const command = new InvokeModelCommand({
            modelId: MODEL_ID,
            body: JSON.stringify(mistralPayload),
            contentType: 'application/json',
            accept: 'application/json'
        });

        const res = await bedrockClient.send(command);
        const jsonResponse = JSON.parse(new TextDecoder().decode(res.body));
        
        const finalReport = jsonResponse.choices[0].message.content;

        await ddbClient.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: { id: { S: jobId } },
            UpdateExpression: "SET #s = :s, #r = :r, #u = :u, #msg = :m",
            ExpressionAttributeNames: { "#s": "status", "#r": "result", "#u": "updatedAt", "#msg": "message" },
            ExpressionAttributeValues: { 
                ":s": { S: "COMPLETED" }, 
                ":r": { S: finalReport },
                ":m": { S: "SITREP erstellt." },
                ":u": { S: new Date().toISOString() }
            }
        }));
        
        console.log("✅ JOB COMPLETED");
        return { statusCode: 200, body: "OK" };

    } catch (error) {
        console.error("❌ FAILED:", error);
        await updateJobStatus(jobId, "FAILED", `Error: ${error.message}`);
        return { statusCode: 500, body: error.message };
    }
};