import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { post, get } from '@aws-amplify/api'; 
import ReactMarkdown from 'react-markdown';
// Wir behalten den Import, falls du Bild-Upload später wieder aktivieren willst,
// nutzen ihn aber aktuell nicht, um das UI sauber zu halten.
// import imageCompression from 'browser-image-compression'; 
import './App.css';

// --- KONSTANTEN ---
const apiName = 'bedrockAPI'; 
const MAX_TEXTAREA_HEIGHT = 120; 
const POLLING_INTERVAL = 3000; 
const MAX_POLLING_ATTEMPTS = 200; 

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- HAUPTKOMPONENTE ---
function App() {
    // UI State
    const [messages, setMessages] = useState([]);
    const [prompt, setPrompt] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [loadingText, setLoadingText] = useState('Bereit');
    
    // Refs
    const messagesEndRef = useRef(null);
    const textareaRef = useRef(null);
    
    // Scroll to bottom
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, loadingText, scrollToBottom]);

    // Auto-Resize Textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'; 
            const scrollHeight = textareaRef.current.scrollHeight;
            textareaRef.current.style.height = `${Math.min(scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
        }
    }, [prompt]);

    // Chat leeren
    const handleClearChat = () => {
        if (messages.length === 0 || isLoading) return; 
        if (window.confirm("Bericht-Verlauf wirklich löschen?")) {
            setMessages([]);
            setPrompt(''); 
            setLoadingText('Bereit');
        }
    };

    // Copy Funktion für Code-Blöcke
    const copyToClipboard = useCallback((text) => {
        const stringText = Array.isArray(text) ? text.join('') : String(text);
        navigator.clipboard.writeText(stringText).then(() => {
            console.log("Kopiert"); 
        }).catch(err => console.error(err));
    }, []);

    // Markdown Komponenten
    const markdownComponents = useMemo(() => ({
        h1: ({ node, children, ...props }) => <h1 className="report-h1" {...props}>{children}</h1>,
        h2: ({ node, children, ...props }) => <h2 className="report-h2" {...props}>{children}</h2>,
        h3: ({ node, children, ...props }) => <h3 className="report-h3" {...props}>{children}</h3>,
        p: ({ node, children, ...props }) => <p className="report-p" {...props}>{children}</p>,
        li: ({ node, children, ...props }) => <li className="report-li" {...props}>{children}</li>,
        a: ({ node, children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
        table: ({ node, children, ...props }) => <div className="table-wrapper"><table {...props}>{children}</table></div>,
        code: ({ node, inline, className, children, ...props }) => {
            return inline ? 
              <code className="inline-code" {...props}>{children}</code> :
              <div className="code-block-wrapper">
                  <pre className="code-block" {...props}><code>{children}</code></pre>
                  <button className="copy-code-btn" onClick={() => copyToClipboard(children)}>Copy</button>
              </div>
        }
    }), [copyToClipboard]);

    // Polling Funktion (unverändert wichtig für OSINT)
    const startPolling = useCallback(async (jobId) => {
        let jobStatus = "QUEUED"; 
        let finalResult = "";
        let attempts = 0;

        while (jobStatus !== "COMPLETED" && jobStatus !== "FAILED" && attempts < MAX_POLLING_ATTEMPTS) {
            attempts++;
            
            if (jobStatus === "QUEUED") setLoadingText(`⏳ Warteschlange (${attempts})...`);
            else if (jobStatus === "FETCHING") setLoadingText(`🔍 Sammle Daten (${attempts})...`);
            else if (jobStatus === "ANALYZING") setLoadingText(`🧠 KI Analysiert (${attempts})...`);
            else setLoadingText(`Verarbeite (${attempts})...`);

            await wait(POLLING_INTERVAL); 

            try {
                const checkRequest = get({
                    apiName: apiName,
                    path: '/chat',
                    options: { queryParams: { jobId: jobId } }
                });
                const checkResponse = await checkRequest.response;
                const checkData = await checkResponse.body.json();
                
                jobStatus = checkData.status;
                
                if (jobStatus === "COMPLETED") {
                    finalResult = checkData.result;
                    break; 
                }
                
                if (jobStatus === "FAILED") {
                    return { success: false, message: checkData.result || checkData.message || "Analyse fehlgeschlagen." };
                }
                
            } catch (networkError) {
                console.warn("Polling error:", networkError);
                continue; 
            }
        }
        
        if (!finalResult && jobStatus !== "FAILED") {
            return { success: false, message: `Zeitüberschreitung.` };
        }
        
        return { success: true, result: finalResult };
    }, []);

    const handleSubmit = useCallback(async (e) => {
        if (e) e.preventDefault();
        
        // Input Validierung
        if (isLoading || !prompt.trim()) return;

        // WICHTIG: Hier setzen wir den Modus hart auf 72h
        // Das Prefix "MODE_72H:" sorgt dafür, dass dein Backend weiß was zu tun ist,
        // auch wenn wir keine UI dafür haben.
        const effectivePrompt = `MODE_72H:${prompt}`; 
        const displayContent = `⚡ 72h Scan Auftrag: ${prompt}`;

        // Nachricht im Chat anzeigen
        const userMessage = {
            author: 'user',
            type: 'text',
            content: displayContent,
            image: null,
        };

        setMessages((prev) => [...prev, userMessage]);
        setPrompt('');
        
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        setIsLoading(true);

        try {
            setLoadingText('Starte System...');
            
            // PAYLOAD: Wir senden genau das, was das alte Backend erwartet
            // Wir "faken" quasi die Auswahl "Full OSINT Report"
            const bodyPayload = {
                prompt: effectivePrompt,
                mode: 'Full OSINT Report', // <--- HIER IST DER FIX! Wir senden den Mode hartcodiert.
                imageBase64: null,
                imageMediaType: null
            };

            const startResponse = await post({
                apiName: apiName,
                path: '/chat',
                options: { body: bodyPayload }
            }).response;

            const startData = await startResponse.body.json();
            
            // Wenn JobID kommt -> Polling starten (OSINT Verhalten)
            if (startData.jobId) {
                const pollingResult = await startPolling(startData.jobId);
                
                if (pollingResult.success) {
                    setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: pollingResult.result }]);
                } else {
                    setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: `❌ ${pollingResult.message}` }]);
                }
            } 
            // Fallback für synchronen Chat (falls Backend anders antwortet)
            else if (startData.response) {
                setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: startData.response }]);
            } else {
                throw new Error("Ungültige Serverantwort.");
            }

        } catch (error) {
            console.error('App Error:', error);
            let errMsg = "Verbindungsfehler.";
            if (error.message) errMsg = error.message;
            setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: `❌ ${errMsg}` }]);
        } finally {
            setIsLoading(false);
            setLoadingText('Bereit.');
        }
    }, [prompt, isLoading, startPolling]);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e); 
        }
    };

    return (
        <div className="App">
            {/* --- HEADER (Bereinigt: Keine Dropdowns mehr) --- */}
            <header>
                <div className="header-content">
                    <div style={{fontWeight: 'bold', fontSize: '1.2rem'}}>
                        🌍 OSINT :: 72H SCAN
                    </div>
                    
                    {messages.length > 0 && (
                         <button className="icon-btn" onClick={handleClearChat} title="Chat leeren" disabled={isLoading}>
                            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                         </button>
                    )}
                </div>
            </header>

            {/* --- CHAT BEREICH --- */}
            <div className="chat-container">
                {messages.length === 0 ? (
                    <div className="empty-state">
                        <div style={{fontSize: "3rem", marginBottom: "1rem"}}>🌍</div>
                        <h3 style={{margin: "0 0 8px 0", fontWeight: 600}}>Dashboard</h3>
                        <p>Region eingeben für 72h Scan.</p>
                    </div>
                ) : (
                    messages.map((msg, index) => (
                        <div key={index} className={`message ${msg.author === 'user' ? 'user' : 'bot'}`}>
                            <div className="markdown-content">
                                <ReactMarkdown components={markdownComponents}>
                                    {msg.content}
                                </ReactMarkdown>
                            </div>
                        </div>
                    ))
                )}

                {isLoading && (
                    <div className="loading-bubble">
                        <div className="dot"></div>
                        <div className="dot"></div>
                        <div className="dot"></div>
                        <span style={{marginLeft: '10px', fontSize: '0.85rem', color: '#6b7280'}}>{loadingText}</span>
                    </div>
                )}
                <div ref={messagesEndRef} />
            </div>

            {/* --- INPUT BEREICH (Bereinigt: Keine Bild-Buttons, keine Shortcuts) --- */}
            <form className="input-area" onSubmit={handleSubmit}>
                <div className="input-row">
                    <textarea
                        className="input-field"
                        ref={textareaRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Region eingeben (z.B. 'Paris','Europa' oder 'Global' )..."
                        disabled={isLoading}
                        rows={1}
                    />

                    <button type="submit" className="send-button" disabled={isLoading || !prompt}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </div>
            </form>
        </div>
    );
}

export default App;