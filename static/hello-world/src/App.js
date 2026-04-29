import React, { useState, useEffect } from 'react';
import { invoke, view } from '@forge/bridge';

// I possibili contesti di rendering dell'app, basati sul tipo di modulo Forge attivo.
// Ogni contesto adatta layout, dimensioni e comportamento dell'UI.
const CONTEXTS = {
  FULL_PAGE: 'fullPage',      // confluence:globalPage - chatbot a tutta pagina
  MODAL: 'modal',             // confluence:contentAction - modale grande
  SPACE_PAGE: 'spacePage',    // confluence:spacePage - pagina nella sidebar dello space
  BYLINE: 'byline',           // confluence:contentBylineItem - inline sotto il titolo
  BANNER: 'banner',           // confluence:pageBanner - banner in cima alla pagina
};

// Mappa il tipo di modulo Forge al contesto interno dell'app
function detectContext(moduleType) {
  if (moduleType.includes('globalPage')) return CONTEXTS.FULL_PAGE;
  if (moduleType.includes('contentAction')) return CONTEXTS.MODAL;
  if (moduleType.includes('spacePage')) return CONTEXTS.SPACE_PAGE;
  if (moduleType.includes('contentBylineItem')) return CONTEXTS.BYLINE;
  if (moduleType.includes('pageBanner')) return CONTEXTS.BANNER;
  return CONTEXTS.FULL_PAGE; // fallback
}

// Configurazioni di stile per ogni contesto
const LAYOUT = {
  [CONTEXTS.FULL_PAGE]: { chatHeight: '500px', padding: '24px', maxWidth: '800px', titleSize: '22px', inputPadding: '12px', buttonPadding: '12px 24px' },
  [CONTEXTS.MODAL]:     { chatHeight: '460px', padding: '20px', maxWidth: '100%',  titleSize: '20px', inputPadding: '12px', buttonPadding: '12px 20px' },
  [CONTEXTS.SPACE_PAGE]:{ chatHeight: '65vh',  padding: '12px', maxWidth: '100%',  titleSize: '16px', inputPadding: '8px',  buttonPadding: '8px 14px' },
  [CONTEXTS.BYLINE]:    { chatHeight: '340px', padding: '8px',  maxWidth: '100%',  titleSize: '14px', inputPadding: '7px',  buttonPadding: '7px 12px' },
  [CONTEXTS.BANNER]:    { chatHeight: '300px', padding: '10px', maxWidth: '100%',  titleSize: '14px', inputPadding: '8px',  buttonPadding: '8px 14px' },
};

function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [context, setContext] = useState(CONTEXTS.FULL_PAGE);
  // Il banner e il byline sono compatti: permettiamo di espandere/collassare la chat
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    view.getContext().then((ctx) => {
      const moduleType = ctx?.extension?.type || '';
      setContext(detectContext(moduleType));
    }).catch(() => {});
  }, []);

  const sendMessage = async () => {
    if (!input.trim()) return;

    const userMsg = { role: 'user', text: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const result = await invoke('askChatbot', { question: input });
      setMessages(prev => [...prev, { role: 'bot', text: result.answer, sources: result.sources || [] }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'bot', text: 'Errore tecnico di connessione.', sources: [] }]);
    } finally {
      setLoading(false);
    }
  };

  const layout = LAYOUT[context];
  const isCompact = context === CONTEXTS.BYLINE || context === CONTEXTS.BANNER;

  // Byline e Banner mostrano prima solo un bottone "Apri chat"
  // e si espandono al click, per non occupare spazio inutile
  if (isCompact && !expanded) {
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontFamily: 'sans-serif' }}>
        <button
          onClick={() => setExpanded(true)}
          style={{
            padding: '4px 12px',
            backgroundColor: '#0052cc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 'bold',
          }}
        >
          🤖 Assistente AI
        </button>
      </div>
    );
  }

  return (
    <div style={{
      padding: layout.padding,
      fontFamily: 'sans-serif',
      maxWidth: layout.maxWidth,
      margin: context === CONTEXTS.FULL_PAGE ? '0 auto' : '0',
      boxSizing: 'border-box',
      width: '100%',
    }}>
      {/* Header con titolo e, per i contesti compatti, bottone per chiudere */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <h2 style={{ margin: 0, fontSize: layout.titleSize }}>🤖 Assistente AI</h2>
        {isCompact && (
          <button
            onClick={() => setExpanded(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: '#6b778c' }}
            title="Chiudi"
          >
            ✕
          </button>
        )}
      </div>

      {/* Area messaggi */}
      <div style={{
        border: '1px solid #dfe1e6',
        borderRadius: '8px',
        height: layout.chatHeight,
        overflowY: 'auto',
        padding: '10px',
        marginBottom: '10px',
        backgroundColor: '#fafbfc',
      }}>
        {messages.length === 0 && (
          <p style={{ textAlign: 'center', color: '#6b778c', marginTop: '80px', fontSize: '13px' }}>
            Fai una domanda al bot!
          </p>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '8px 0' }}>
            <span style={{
              background: m.role === 'user' ? '#0052cc' : '#ffffff',
              color: m.role === 'user' ? 'white' : '#172b4d',
              padding: '8px 12px',
              borderRadius: '12px',
              border: m.role === 'bot' ? '1px solid #dfe1e6' : 'none',
              maxWidth: '85%',
              fontSize: '13px',
              lineHeight: '1.4',
              wordBreak: 'break-word',
            }}>
              {m.text}
            </span>
            {m.role === 'bot' && m.sources && m.sources.length > 0 && (
              <div style={{ marginTop: '4px', maxWidth: '85%' }}>
                {m.sources.map((src, j) => (
                  <a
                    key={j}
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ display: 'inline-block', marginRight: '6px', fontSize: '11px', color: '#0052cc' }}
                  >
                    📄 {src.title || src.url}
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <p style={{ color: '#6b778c', fontStyle: 'italic', fontSize: '13px' }}>Il bot sta pensando...</p>
        )}
      </div>

      {/* Input + bottone invio */}
      <div style={{ display: 'flex', gap: '6px' }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
          placeholder="Scrivi un messaggio..."
          style={{
            flexGrow: 1,
            padding: layout.inputPadding,
            borderRadius: '4px',
            border: '2px solid #dfe1e6',
            fontSize: '13px',
            boxSizing: 'border-box',
          }}
        />
        <button
          onClick={sendMessage}
          style={{
            padding: layout.buttonPadding,
            backgroundColor: '#0052cc',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 'bold',
            fontSize: '13px',
            whiteSpace: 'nowrap',
          }}
        >
          Invia
        </button>
      </div>
    </div>
  );
}

export default App;
