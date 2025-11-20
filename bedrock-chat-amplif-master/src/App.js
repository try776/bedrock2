import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { post, get } from '@aws-amplify/api'; 
import ReactMarkdown from 'react-markdown';
import imageCompression from 'browser-image-compression';
import './App.css';

// --- KONSTANTEN & TYPEN ---
const apiName = 'bedrockAPI'; 
const MAX_TEXTAREA_HEIGHT = 120; 
const POLLING_INTERVAL = 3000; 
const MAX_POLLING_ATTEMPTS = 200; 

const osintTasks = [
    { name: 'Deep OSINT Report', value: 'Full OSINT Report' },
    { name: 'Standard Chat & Vision', value: 'Standard-Chat' },
];

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]); 
        reader.onerror = (error) => reject(error);
        reader.readAsDataURL(file); 
    });

// --- HAUPTKOMPONENTE ---
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

    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, loadingText, scrollToBottom]);

    // Auto-Resize für Textarea
    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'; 
            const scrollHeight = textareaRef.current.scrollHeight;
            textareaRef.current.style.height = `${Math.min(scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
        }
    }, [prompt, isOsintMode]);

    const clearImageData = useCallback(() => {
        if (imagePreviewUrl) {
            URL.revokeObjectURL(imagePreviewUrl);
        }
        setImageFile(null);
        setImagePreviewUrl(null);
    }, [imagePreviewUrl]);

    useEffect(() => {
        return () => {
            if (imagePreviewUrl) {
                URL.revokeObjectURL(imagePreviewUrl);
            }
        };
    }, [imagePreviewUrl]);

    const handleClearChat = () => {
        if (messages.length === 0 || isLoading) return; 
        if (window.confirm("Möchten Sie den Chat wirklich leeren?")) {
            setMessages([]);
            setPrompt(''); 
            clearImageData(); 
            setLoadingText('Bereit');
        }
    };

    const copyToClipboard = useCallback((text) => {
        const stringText = Array.isArray(text) ? text.join('') : String(text);
        navigator.clipboard.writeText(stringText).then(() => {
            console.log("Text kopiert"); 
        }).catch(err => {
            console.error('Kopieren fehlgeschlagen', err);
        });
    }, []);

    const markdownComponents = useMemo(() => ({
        h1: ({ node, children, ...props }) => <h1 className="report-h1" {...props}>{children}</h1>,
        h2: ({ node, children, ...props }) => <h2 className="report-h2" {...props}>{children}</h2>,
        h3: ({ node, children, ...props }) => <h3 className="report-h3" {...props}>{children}</h3>,
        p: ({ node, children, ...props }) => <p className="report-p" {...props}>{children}</p>,
        li: ({ node, children, ...props }) => <li className="report-li" {...props}>{children}</li>,
        a: ({ node, children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
        ),
        table: ({ node, children, ...props }) => (
            <div className="table-wrapper"><table {...props}>{children}</table></div>
        ),
        code: ({ node, inline, className, children, ...props }) => {
            return inline ? 
              <code className="inline-code" {...props}>{children}</code> :
              <div className="code-block-wrapper">
                  <pre className="code-block" {...props}><code>{children}</code></pre>
                  <button className="copy-code-btn" onClick={() => copyToClipboard(children)}>Copy</button>
              </div>
        }
    }), [copyToClipboard]);

    const handleImageChange = async (e) => {
        if (isLoading) return; 
        if (imagePreviewUrl) clearImageData();
        const file = e.target.files && e.target.files[0];
        if (!file) return;

        const options = { maxSizeMB: 0.8, maxWidthOrHeight: 1920, useWebWorker: true };
        
        try {
            setLoadingText('Bild komprimiere...');
            const compressedFile = await imageCompression(file, options);
            setImageFile(compressedFile);
            setImagePreviewUrl(URL.createObjectURL(compressedFile));
            setLoadingText('Bereit');
        } catch (error) {
            console.error("Komprimierung fehlgeschlagen, nutze Original", error);
            setImageFile(file);
            setImagePreviewUrl(URL.createObjectURL(file));
            setLoadingText('Bereit');
        }
        e.target.value = null;
    };

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

    const handleSubmit = useCallback(async (e, shortcutPrompt = null) => {
        if (e) e.preventDefault();
        
        const currentPromptText = shortcutPrompt || prompt;
        
        if (isLoading) return;
        
        const hasPromptOrImage = !!currentPromptText || !!imageFile;
        if (!hasPromptOrImage) return;

        const effectivePrompt = currentPromptText || (imageFile ? "BILDANALYSE STARTEN" : "");
        const is72hMode = effectivePrompt.startsWith("MODE_72H:");

        let displayContent = effectivePrompt;
        if (is72hMode) {
            displayContent = `⚡ 72h Scan: ${effectivePrompt.replace("MODE_72H:", "")}`;
        } 
        
        const userMessage = {
            author: 'user',
            type: 'text',
            content: displayContent,
            image: imagePreviewUrl,
        };

        setMessages((prev) => [...prev, userMessage]);
        setPrompt('');
        
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        
        clearImageData(); 
        setIsLoading(true);

        let imageBase64 = null;
        let imageMediaType = null;
        
        if (imageFile && !isOsintMode) {
            setLoadingText('Bild Upload...');
            try {
                imageBase64 = await fileToBase64(imageFile);
                imageMediaType = imageFile.type;
            } catch (err) {
                setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: "Fehler beim Bild-Upload." }]);
                setIsLoading(false);
                setLoadingText('Bereit.');
                return;
            }
        }

        try {
            setLoadingText('Starte...');
            
            const bodyPayload = {
                prompt: effectivePrompt,
                mode: selectedTask,
                imageBase64: imageBase64,
                imageMediaType: imageMediaType
            };

            const startResponse = await post({
                apiName: apiName,
                path: '/chat',
                options: { body: bodyPayload }
            }).response;

            const startData = await startResponse.body.json();
            
            if (startData.jobId) {
                const pollingResult = await startPolling(startData.jobId);
                
                if (pollingResult.success) {
                    setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: pollingResult.result }]);
                } else {
                    setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: `❌ ${pollingResult.message}` }]);
                }
            } else if (startData.response) {
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
    }, [prompt, selectedTask, imageFile, imagePreviewUrl, clearImageData, startPolling, isOsintMode]);

    const handleShortcutSubmit = (action) => {
        if (isLoading) return;

        if (action === "72h") { 
            if (!prompt) { 
                setPrompt(isOsintMode ? "Land oder Region eingeben" : "");
                alert("Bitte geben Sie zuerst ein Land oder eine Region ein."); 
                return; 
            }
            const prefix = "MODE_72H";
            handleSubmit(null, `${prefix}:${prompt}`);
        } else {
            handleSubmit(null, action);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e); 
        }
    };
    
    const handleTaskChange = (e) => {
        const newValue = e.target.value;
        setSelectedTask(newValue);
        if (newValue !== 'Standard-Chat') {
            clearImageData();
        }
        if (messages.length > 0) {
            if (window.confirm("Moduswechsel leert den Chat. OK?")) {
                setMessages([]);
                setPrompt('');
            } else {
                // Reset select if user cancels
            }
        }
    };

    return (
        <div className="App">
            {/* --- HEADER --- */}
            <header>
                <div className="header-content">
                    <select 
                        className="mode-select"
                        value={selectedTask} 
                        onChange={handleTaskChange} 
                        disabled={isLoading}
                    >
                        {osintTasks.map((task) => <option key={task.value} value={task.value}>{task.name}</option>)}
                    </select>
                    
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
                        <div style={{fontSize: "3rem", marginBottom: "1rem"}}>{isOsintMode ? "🌍" : "👋"}</div>
                        <h3 style={{margin: "0 0 8px 0", fontWeight: 600}}>{isOsintMode ? "Lagezentrum" : "Hallo!"}</h3>
                        <p>{isOsintMode ? "Region eingeben für 72h Scan." : "Was kann ich für dich tun?"}</p>
                    </div>
                ) : (
                    messages.map((msg, index) => (
                        <div key={index} className={`message ${msg.author === 'user' ? 'user' : 'bot'}`}>
                            {msg.image && (
                                <img src={msg.image} alt="Upload" className="message-image" style={{maxWidth: '100%', borderRadius: '8px', marginBottom: '8px'}} />
                            )}
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

            {/* --- INPUT BEREICH (Fixed Bottom) --- */}
            <form className="input-area" onSubmit={handleSubmit}>
                
                {/* Shortcuts / Bildvorschau (Floating above Input) */}
                {(imagePreviewUrl || (!isLoading && !prompt && !isOsintMode)) && (
                    <div className="floating-extras">
                        {imagePreviewUrl && (
                            <div className="image-preview-chip">
                                <img src={imagePreviewUrl} alt="Preview" />
                                <button type="button" onClick={clearImageData}>×</button>
                            </div>
                        )}
                        {!imagePreviewUrl && !isOsintMode && !prompt && (
                            <div className="shortcuts">
                                <button type="button" onClick={() => handleShortcutSubmit("Erkläre mir die News.")}>News</button>
                                <button type="button" onClick={() => handleShortcutSubmit("Python Code Beispiel.")}>Code</button>
                            </div>
                        )}
                    </div>
                )}

                {/* Input Zeile */}
                <div className="input-row">
                    {!isOsintMode && (
                        <div className="file-input-wrapper">
                            <input type="file" id="file-upload" accept="image/*" onChange={handleImageChange} disabled={isLoading} style={{display:'none'}} />
                            <label htmlFor="file-upload" className="icon-btn" title="Bild hochladen">
                                <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 1 5.66 5.66l-9.2 9.19a2 2 0 1-2.83-2.83l8.49-8.48"></path>
                                </svg>
                            </label>
                        </div>
                    )}

                    <textarea
                        className="input-field"
                        ref={textareaRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={isOsintMode ? "Region für 72h Scan..." : "Nachricht..."}
                        disabled={isLoading}
                        rows={1}
                    />

                    {isOsintMode && !isLoading && prompt && (
                         <button type="button" className="send-button" style={{backgroundColor: '#ef4444'}} onClick={() => handleShortcutSubmit("72h")}>
                            72h
                         </button>
                    )}

                    {(!isOsintMode || (isOsintMode && prompt)) && (
                        <button type="submit" className="send-button" disabled={isLoading || (!prompt && !imageFile)}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="22" y1="2" x2="11" y2="13"></line>
                                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                            </svg>
                        </button>
                    )}
                </div>
            </form>
        </div>
    );
}

export default App;