import React, { useState, useRef, useEffect, useMemo } from 'react';
import { post, get } from '@aws-amplify/api'; 
import ReactMarkdown from 'react-markdown';
import imageCompression from 'browser-image-compression';
import './App.css';

const apiName = 'bedrockAPI'; 

const osintTasks = [
  { name: 'Standard Chat & Vision', value: 'Standard-Chat' },
  { name: 'Deep OSINT Report', value: 'Full OSINT Report' },
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
  const [loadingText, setLoadingText] = useState('System bereit');
  
  const messagesEndRef = useRef(null);
  
  const isOsintMode = selectedTask === 'Full OSINT Report';

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, loadingText]);

  const clearImageData = () => {
    if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);
    setImageFile(null);
    setImagePreviewUrl(null);
  };

  const markdownComponents = useMemo(() => ({
    a: ({node, ...props}) => (
        // eslint-disable-next-line jsx-a11y/anchor-has-content
        <a {...props} target="_blank" rel="noopener noreferrer">{props.children}</a>
    )
  }), []);

  // --- HAUPTLOGIK ---
  const handleSubmit = async (e, shortcutPrompt = null) => {
    if (e) e.preventDefault();
    const currentPromptText = shortcutPrompt || prompt;
    
    if (isLoading) return;
    if (isOsintMode && !currentPromptText) return;
    if (!isOsintMode && !currentPromptText && !imageFile) return;

    const effectivePrompt = currentPromptText || (imageFile ? "BILDANALYSE STARTEN" : "");
    const is72hMode = effectivePrompt.startsWith("MODE_72H:");

    const userMessage = {
      author: 'user',
      type: 'text',
      content: is72hMode ? `Quick Scan: ${effectivePrompt.replace("MODE_72H:", "")}` : effectivePrompt,
      image: imagePreviewUrl,
    };
    setMessages((prev) => [...prev, userMessage]);
    setPrompt('');
    clearImageData();
    setIsLoading(true);

    let imageBase64 = null;
    let imageMediaType = null;
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

        // 2. Verarbeitung
        if (startData.jobId) {
            // --- ASYNC MODUS ---
            const jobId = startData.jobId;
            let jobStatus = "QUEUED"; // Start-Status anpassen
            let finalResult = "";
            let attempts = 0;

            // HIER WAR DER FEHLER: Wir müssen auch bei "QUEUED" warten!
            while ((jobStatus === "PROCESSING" || jobStatus === "QUEUED") && attempts < 120) {
                attempts++;
                
                // Status Text Updates für besseres UX
                if(jobStatus === "QUEUED") setLoadingText(`In Warteschlange (${attempts})...`);
                else if(attempts > 2) setLoadingText(`Analysiere Quellen (${attempts})...`);

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
                        break; // Schleife verlassen wenn fertig
                    }
                    
                    if (jobStatus === "FAILED") {
                        throw new Error(checkData.result || "Analyse fehlgeschlagen");
                    }
                
                } catch (networkError) {
                    console.warn("Polling transient error:", networkError);
                    // Wir brechen hier nicht ab, sondern versuchen es weiter (Polling Logik)
                    continue; 
                }
            }
            
            if (!finalResult && jobStatus !== "FAILED") throw new Error("Timeout: Keine Antwort innerhalb des Zeitlimits.");
            
            setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: finalResult }]);

        } else if (startData.response) {
            // --- SYNC MODUS ---
            setMessages((prev) => [...prev, { author: 'ai', type: 'text', content: startData.response }]);
        } else {
            throw new Error("Ungültige Serverantwort.");
        }

    } catch (error) {
        console.error('App Error:', error);
        let errMsg = "Verbindungsfehler zum Server.";
        
        if (error.message) errMsg = error.message;
        try {
            if (error.response) {
               const errBody = await error.response.body.json();
               if (errBody.error) errMsg = errBody.error;
            }
        } catch (e) { }

        setMessages((prev) => [...prev, { author: 'ai', type: 'error', content: `❌ ${errMsg}` }]);
    } finally {
        setIsLoading(false);
        setLoadingText('Bereit.');
    }
  };

  // --- HELPER ---
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

  const handleShortcutSubmit = (action) => {
    if (action === "72h") {
        if (!prompt) { alert("Bitte Land oder Region eingeben."); return; }
        handleSubmit(null, `MODE_72H:${prompt}`);
    } else {
        setPrompt(action);
        handleSubmit(null, action);
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
        </div>
      </nav>

      <div className="chat-window">
        <div className="chat-container-width">
            {messages.length === 0 ? (
              <div className="empty-state">
                 <div className="empty-icon">{isOsintMode ? "🌍" : "👋"}</div>
                 <h3>{isOsintMode ? "Regionale Lageanalyse" : "Wie kann ich helfen?"}</h3>
                 <p>{isOsintMode ? "Geben Sie ein Land oder eine Region ein, um den Bericht zu starten." : "Laden Sie ein Bild hoch oder stellen Sie eine Frage."}</p>
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
                  </div>
                  <span className="message-role">{msg.author === 'user' ? 'Sie' : 'AI Assistant'}</span>
                </div>
              ))
            )}
            {isLoading && (
                <div className="message-wrapper ai">
                    <div className="loading-bubble">
                        <div className="typing-dot"></div>
                        <div className="typing-dot"></div>
                        <div className="typing-dot"></div>
                        <span style={{marginLeft: '10px', fontSize: '12px', color: '#666'}}>{loadingText}</span>
                    </div>
                </div>
            )}
            <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="input-area-wrapper">
        <form className="input-container" onSubmit={handleSubmit}>
            
            {!isLoading && (
                <div className="shortcut-bar">
                    {isOsintMode ? (
                        <button type="button" className="chip-button primary" onClick={() => handleShortcutSubmit("72h")}>⚡ Last 72H Quick-Scan </button>
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
            
            {imageFile && !isOsintMode && (
              <div className="file-preview">
                <div className="preview-thumb">
                    <img src={imagePreviewUrl} alt="Vorschau" />
                </div>
                <span className="file-name">{imageFile.name}</span>
                <button type="button" className="remove-file" onClick={clearImageData} disabled={isLoading}>×</button>
              </div>
            )}

            <div className="input-row">
              {!isOsintMode && (
                <div className="upload-wrapper">
                  <input type="file" id="file-upload" accept="image/*" onChange={handleImageChange} disabled={isLoading} />
                  <label htmlFor="file-upload" className={`icon-button ${isLoading ? 'disabled' : ''}`} title="Bild hochladen">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                  </label>
                </div>
              )}
              
              <input 
                type="text" 
                value={prompt} 
                onChange={(e) => setPrompt(e.target.value)} 
                placeholder={isOsintMode ? "Land oder Region eingeben..." : "Schreiben Sie eine Nachricht..."} 
                disabled={isLoading} 
              />
              
              <button type="submit" className="send-button" disabled={isLoading || (!prompt && !imageFile && !isOsintMode) || (isOsintMode && !prompt)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
              </button>
            </div>
        </form>
      </div>
    </div>
  );
}

export default App;