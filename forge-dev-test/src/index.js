import Resolver from '@forge/resolver';

const resolver = new Resolver();

resolver.define('askChatbot', async (req) => {
  const { question } = req.payload;

  const backendUrl = process.env.RAG_BACKEND_URL;
  const apiKey = process.env.RAG_API_KEY;

  if (!backendUrl) {
    return { answer: '[CONFIG] RAG_BACKEND_URL non impostata. Esegui: forge variables set RAG_BACKEND_URL "https://..." --environment development', sources: [] };
  }

  let response;
  try {
    response = await fetch(`${backendUrl}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { 'Authorization': `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({ query: question }),
    });
  } catch (err) {
    return { answer: `[RETE] Impossibile contattare il backend: ${err.message}`, sources: [] };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return { answer: `[BACKEND] Errore HTTP ${response.status}: ${body.slice(0, 200)}`, sources: [] };
  }

  const data = await response.json();

  return {
    answer: data.answer ?? data.message ?? JSON.stringify(data),
    sources: Array.isArray(data.sources) ? data.sources : [],
  };
});

export const handler = resolver.getDefinitions();
