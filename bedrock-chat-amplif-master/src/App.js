import React, { useState, useRef, useEffect, useMemo } from 'react';
import { post, get } from '@aws-amplify/api'; 
import ReactMarkdown from 'react-markdown';
import imageCompression from 'browser-image-compression';
import './App.css';

const apiName = 'bedrockAPI'; 

// ÄNDERUNG 1: Reihenfolge getauscht, damit OSINT der Default (Index 0) ist
const osintTasks = [
    { name: 'Deep OSINT Report', value: 'Full OSINT Report' },
    { name: 'Standard Chat & Vision', value: 'Standard-Chat' },
];

// Hilfsfunktion für Pausen
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = (error) => reject(error);
    });

function App() {
    const [selectedTask, setSelectedTask] = useState(osintTasks[0].value);
    const [messages, setMessages] = useState([]);
    const [prompt, setPrompt] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [imageFile, setImageFile] = useState(null);
    const [imagePreviewUrl, setImagePreviewUrl] = useState(null);
    const [loadingText, setLoadingText] = useState('Bereit');
    
    const messagesEndRef = useRef(null);
    const textareaRef = useRef(null);
    
    const isOsintMode = selectedTask === 'Full OSINT Report';

    // Auto-Scroll zum Ende
    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, loadingText]);

    // Auto-Resize für Textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'inherit'; // Reset
            const scrollHeight = textareaRef.current.scrollHeight;
            textareaRef.current.style.height = `${Math.min(scrollHeight, 150)}px`;
        }
    }, [prompt]);

    const clearImageData = () => {
        if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
        setImageFile(null);
        setImagePreviewUrl(null);
    };

    const handleClearChat = () => {
        if (window.confirm("Möchten Sie den Chat wirklich leeren?")) {
            setMessages([]);
        }
    };

    const copyToClipboard = (text) => {
        navigator.clipboard.writeText(text).then(() => {
            // Optional: Kleines Feedback (Toast) könnte hier hin
        });
    };

    // NEU: Markdown Konfiguration mit vereinheitlichtem Styling (Klassen müssen in App.css definiert werden)
    const markdownComponents = useMemo(() => ({
        h1: ({ node, ...props }) => <h1 className="report-h1" {...props} />,
        h2: ({ node, ...props }) => <h2 className="report-h2" {...props} />,
        h3: ({ node, ...props }) => <h3 className="report-h3" {...props} />,
        p: ({ node, ...props }) => <p className="report-p" {...props} />,
        li: ({ node, ...props }) => <li className="report-li" {...props} />,
        a: ({node, ...props}) => (
            // eslint-disable-next-line jsx-a11y/anchor-has-content
            <a {...props} target="_blank" rel="noopener noreferrer">{props.children}</a>
        ),
        table: ({node, ...props}) => (
            <div className="table-wrapper"><table {...props}>{props.children}</table></div>
        ),
        code: ({node, inline, className, children, ...props}) => {
            return inline ? 
              <code className="inline-code" {...props}>{children}</code> :
              <div className="code-block-wrapper">
                  <pre className="code-block" {...props}><code>{children}</code></pre>
                  <button className="copy-code-btn" onClick={() => copyToClipboard(String(children))}>Copy</button>
              </div>
        }
    }), []);

    // --- HAUPTLOGIK ---
    const handleSubmit = async (e, shortcutPrompt = null) => {
        // HINWEIS: Bei entferntem Sende-Button wird Submit nur durch ENTER ausgelöst.
        if (e) e.preventDefault();
        const currentPromptText = shortcutPrompt || prompt;
        
        if (isLoading) return;
        // Für OSINT: Submit nur über die speziellen Buttons, die ein shortcutPrompt setzen
        // Oder über ENTER, falls der User es gewohnt ist.
        if (isOsintMode && !currentPromptText && !shortcutPrompt) return; 
        if (!isOsintMode && !currentPromptText && !imageFile) return;

        const effectivePrompt = currentPromptText || (imageFile ? "BILDANALYSE STARTEN" : "");
        
        // ÄNDERUNG 2: Nur noch 72h Mode erkennen und anzeigen (7d wurde entfernt)
        const is72hMode = effectivePrompt.startsWith("MODE_72H:");

        let displayContent = effectivePrompt;
        if (is72hMode) {
            displayContent = `⚡ 72h Scan: ${effectivePrompt.replace("MODE_72H:", "")}`;
        } 
        
        // Da MODE_7D entfernt wurde, ist die Logik hier vereinfacht.
        

        const userMessage = {
            author: 'user',
            type: 'text',
            content: displayContent,
            image: imagePreviewUrl,
        };

        setMessages((prev) => [...prev, userMessage]);
        setPrompt('');
        
        // Textarea Höhe zurücksetzen
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        
        clearImageData();
        setIsLoading(true);

        let imageBase64 = null;
        let imageMediaType = null;
        
        // Bild verarbeiten (nur im Chat Modus erlaubt)
        if (imageFile && !isOsintMode) {
            try {
                imageBase64 = await fileToBase64(imageFile);
                imageMediaType = imageFile.type;
            } catch (err) {
                console.error("Bild Fehler", err);
                setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: "Fehler beim Bild-Upload." }]);
                setIsLoading(false);
                return;
            }
        }

        try {
            setLoadingText('Initialisiere Analyse...');
            
            const bodyPayload = {
                prompt: effectivePrompt,
                mode: selectedTask,
                imageBase64: imageBase64,
                imageMediaType: imageMediaType
            };

            // 1. Job Starten (POST)
            const startRequest = post({
                apiName: apiName,
                path: '/chat',
                options: { body: bodyPayload }
            });
            
            const startResponse = await startRequest.response;
            const startData = await startResponse.body.json();

            // 2. Verarbeitung (Polling)
            if (startData.jobId) {
                 const jobId = startData.jobId;
                 let jobStatus = "QUEUED"; 
                 let finalResult = "";
                 let attempts = 0;
                 const maxAttempts = 200; // ca. 10 Minuten Timeout

                 while (jobStatus !== "COMPLETED" && jobStatus !== "FAILED" && attempts < maxAttempts) {
                     attempts++;
                     
                     // Dynamischer Statustext
                     if (jobStatus === "QUEUED") setLoadingText(`In Warteschlange (${attempts})...`);
                     else if (jobStatus === "FETCHING") setLoadingText(`🔍 Sammle Daten (${attempts})...`);
                     else if (jobStatus === "ANALYZING") setLoadingText(`🧠 KI Analysiert (${attempts})...`);
                     else setLoadingText(`Verarbeite (${attempts})...`);

                     await wait(3000); // 3s Warten

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
                             throw new Error(checkData.result || checkData.message || "Analyse fehlgeschlagen");
                         }
                     
                     } catch (networkError) {
                         console.warn("Polling error (ignoring temporary network glitch):", networkError);
                         continue; 
                     }
                 }
                 
                 if (!finalResult && jobStatus !== "FAILED") {
                      throw new Error(`Zeitüberschreitung nach ${attempts * 3} Sekunden.`);
                 }
                 
                 setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: finalResult }]);

            } else if (startData.response) {
                // --- SYNC MODUS (Direkte Antwort) ---
                setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: startData.response }]);
            } else {
                throw new Error("Ungültige Serverantwort.");
            }

        } catch (error) {
            console.error('App Error:', error);
            let errMsg = "Verbindungsfehler zum Server.";
            if (error.message) errMsg = error.message;
            setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: `❌ ${errMsg}` }]);
        } finally {
            setIsLoading(false);
            setLoadingText('Bereit.');
        }
    };

    // --- HANDLERS ---
    const handleImageChange = async (e) => {
        if (imagePreviewUrl) clearImageData();
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        
        const options = { maxSizeMB: 0.8, maxWidthOrHeight: 1920, useWebWorker: true };
        try {
            const compressedFile = await imageCompression(file, options);
            setImageFile(compressedFile);
            setImagePreviewUrl(URL.createObjectURL(compressedFile));
        } catch (error) {
            console.error("Komprimierung fehlgeschlagen, nutze Original", error);
            setImageFile(file);
            setImagePreviewUrl(URL.createObjectURL(file));
        }
        e.target.value = null;
    };

    // ÄNDERUNG 3: Neue Logic für die Shortcuts (NUR 72h)
    const handleShortcutSubmit = (action) => {
        // Logik für OSINT Modi, die eine Eingabe im Textfeld benötigen
        if (action === "72h") { // Fokus nur auf 72h
            if (!prompt) { 
                // HINWEIS: alert() ist nicht empfohlen. Da dies jedoch existierender Code ist, belassen wir es.
                alert("Bitte geben Sie zuerst ein Land oder eine Region in das Textfeld ein."); 
                return; 
            }
            const prefix = "MODE_72H"; // Hardcode auf 72h Prefix
            handleSubmit(null, `${prefix}:${prompt}`);
        } else {
            // Logik für Standard Chat Shortcuts (Setzen Prompt und senden sofort)
            setPrompt(action);
            handleSubmit(null, action);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            // Erlaubt das Senden auch ohne den Sende-Button (wichtig für Chat-Modus)
            handleSubmit(e); 
        }
    };

    return (
        <div className="App">
            <nav className="navbar">
                <div className="navbar-content">
                    <div className="nav-brand">
                        <span className="brand-icon">✧</span>
                        <span className="brand-name">Intelligence Suite</span>
                    </div>
                    
                    <div className="nav-controls">
                        <div className="mode-selector">
                            <select 
                                id="task-select" 
                                value={selectedTask} 
                                onChange={(e) => { setSelectedTask(e.target.value); if (e.target.value !== 'Standard-Chat') clearImageData(); }} 
                                disabled={isLoading}
                            >
                                {osintTasks.map((task) => <option key={task.value} value={task.value}>{task.name}</option>)}
                            </select>
                            <span className={`mode-badge ${isOsintMode ? 'badge-osint' : 'badge-vision'}`}>
                                {isOsintMode ? "PRO OSINT" : "AI ASSISTANT"}
                            </span>
                        </div>
                        {messages.length > 0 && (
                            <button className="clear-btn" onClick={handleClearChat} title="Chat leeren">🗑️</button>
                        )}
                    </div>
                </div>
            </nav>

            <div className="chat-window">
                <div className="chat-container-width">
                    {messages.length === 0 ? (
                        <div className="empty-state">
                            <div className="empty-icon">{isOsintMode ? "🌍" : "👋"}</div>
                            <h3>{isOsintMode ? "Lagezentrum" : "Wie kann ich helfen?"}</h3>
                            <p>{isOsintMode ? "Geben Sie ein Land oder eine Region ein, um einen Echtzeit-Bericht zu erstellen." : "Laden Sie ein Bild hoch oder stellen Sie eine Frage."}</p>
                        </div>
                    ) : (
                        messages.map((msg, index) => (
                            <div key={index} className={`message-wrapper ${msg.author}`}>
                                <div className={`message-bubble ${msg.type === 'error' ? 'error' : ''}`}>
                                    {msg.image && <img src={msg.image} alt="Upload" className="uploaded-image" />}
                                    {msg.content && (
                                      <div className="markdown-content">
                                        <ReactMarkdown components={markdownComponents}>
                                            {msg.content}
                                        </ReactMarkdown>
                                      </div>
                                    )}
                                    {msg.author === 'ai' && msg.type !== 'error' && (
                                        <div className="msg-actions">
                                            <button onClick={() => copyToClipboard(msg.content)} className="action-btn" title="Kopieren">📋</button>
                                        </div>
                                    )}
                                </div>
                                <span className="message-role">{msg.author === 'user' ? 'Sie' : 'AI Analyst'}</span>
                            </div>
                        ))
                    )}
                    {isLoading && (
                        <div className="message-wrapper ai">
                            <div className="loading-bubble">
                                <div className="typing-dot"></div>
                                <div className="typing-dot"></div>
                                <div className="typing-dot"></div>
                                <span className="loading-text">{loadingText}</span>
                            </div>
                        </div>
                    )}
                    <div ref={messagesEndRef} />
                </div>
            </div>

            <div className="input-area-wrapper">
                <form className="input-container" onSubmit={handleSubmit}>
                    
                    {/* Dateivorschau bleibt oben */}
                    {imageFile && !isOsintMode && (
                      <div className="file-preview">
                        <div className="preview-thumb">
                            <img src={imagePreviewUrl} alt="Vorschau" />
                        </div>
                        <span className="file-name">{imageFile.name}</span>
                        <button type="button" className="remove-file" onClick={clearImageData} disabled={isLoading}>×</button>
                      </div>
                    )}

                    {/* Haupteingabezeile (enthält jetzt NICHT den Sende-Button) */}
                    <div className="input-row">
                      {!isOsintMode && (
                        <div className="upload-wrapper">
                          <input type="file" id="file-upload" accept="image/*" onChange={handleImageChange} disabled={isLoading} />
                          <label htmlFor="file-upload" className={`icon-button ${isLoading ? 'disabled' : ''}`} title="Bild hochladen">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 4 0 1 5.66 5.66l-9.2 9.19a2 2 2 0 1-2.83-2.83l8.49-8.48"></path></svg>
                          </label>
                        </div>
                      )}
                      
                      <textarea
                        ref={textareaRef}
                        value={prompt} 
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={isOsintMode ? "Z.B. 'Berlin' oder 'Japan' oder 'Europa' für den 72h-Scan" : "Nachricht eingeben... (Shift+Enter für neue Zeile)"} 
                        disabled={isLoading} 
                        rows={1}
                      />
                      
                      {/* Generischer Sende-Button nur im Standard-Chat-Modus anzeigen */}
                      {!isOsintMode && !imageFile && (
                          <button type="submit" className="send-button" disabled={isLoading || !prompt}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                          </button>
                      )}
                    </div>

                    {/* Shortcut-Buttons (jetzt NUR 72h für OSINT) */}
                    {!isLoading && (
                        <div className="shortcut-bar">
                            {isOsintMode ? (
                                <>
                                    <button type="button" className="chip-button primary" onClick={() => handleShortcutSubmit("72h")}>⚡ 72h Scan starten</button>
                                    {/* Alter 7d-Button entfernt */}
                                </>
                            ) : (
                                imageFile && (
                                    <>
                                        <button type="button" className="chip-button" onClick={() => handleShortcutSubmit("Was ist auf dem Bild?")}>Bild beschreiben</button>
                                        <button type="button" className="chip-button" onClick={() => handleShortcutSubmit("Extrahiere Text")}>Text auslesen</button>
                                    </>
                                )
                            )}
                        </div>
                    )}
                </form>
            </div>
        </div>
    );
}

export default App;