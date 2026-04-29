# Assistente AI su Confluence - Forge App

App Atlassian Forge che integra un chatbot AI direttamente in Confluence in **5 modalità di accesso** diverse, con una pipeline di ingestion per estrarre e preparare il contenuto da indicizzare.

---

## Indice

1. [Tecnologie](#tecnologie)
2. [Struttura del Progetto](#struttura-del-progetto)
3. [Le 5 Modalità di Accesso](#le-5-modalità-di-accesso)
4. [Architettura](#architettura)
5. [Approccio Alternativo: Rovo Agent](#approccio-alternativo-rovo-agent)
6. [Setup e Deploy](#setup-e-deploy)
7. [Pipeline di Ingestion da Confluence/Jira](#pipeline-di-ingestion-da-confluencejira)
8. [Script di Ingestion](#script-di-ingestion)

---

## Tecnologie

| Layer | Tecnologia |
|-------|-----------|
| Piattaforma | Atlassian Forge (CLI v12+) |
| Runtime | Node.js 24, architettura ARM64 |
| Frontend | Custom UI con React 16 + `@forge/bridge` |
| Backend | `@forge/resolver` — pronto per il collegamento a un backend esterno |
| Ingestion | Script Node.js e Python standalone (nessuna dipendenza esterna) |

Tutte le 5 modalità di accesso condividono **la stessa build React** (`static/hello-world/build`). Il contesto di rendering viene rilevato a runtime tramite `view.getContext()` e il layout si adatta di conseguenza.

---

## Struttura del Progetto

```
forge-dev/                           ← root del progetto (git repo)
├── manifest.yml                     ← 5 moduli Forge + permessi egress
├── package.json
├── src/
│   └── index.js                     ← Resolver: bridge verso il backend esterno
├── static/hello-world/
│   ├── src/
│   │   └── App.js                   ← UI React adattiva (tutti i contesti)
│   └── build/                       ← build produzione (generato da npm run build)
├── ingest-test.mjs                  ← script ingestion Node.js
├── ingest-test.py                   ← script ingestion Python
├── .env.example                     ← template variabili d'ambiente
├── api-token.txt                    ← token Atlassian (NON in git — vedere .gitignore)
└── output/                          ← file .md generati dall'ingestion (NON in git)
    └── KB/
        └── ...
```

---

## Le 5 Modalità di Accesso

L'app espone lo stesso chatbot in 5 punti di Confluence. Ogni modalità usa un modulo Forge diverso e adatta automaticamente il layout.

### 1. Dashboard a Tutta Pagina — `confluence:globalPage`

| Proprietà | Valore |
|-----------|--------|
| Modulo | `confluence:globalPage` |
| Dove appare | Menu app globale (griglia 3×3 in alto a sinistra) |
| UX | Pagina dedicata a tutta larghezza, chatbot centrato (max-width 800px) |

**Come aprirla:** clicca sull'icona delle app → seleziona "Assistente AI (Full Page)".

**Caso d'uso:** sessioni di ricerca prolungate dove l'utente vuole la massima area disponibile. Equivalente a una web app stand-alone.

---

### 2. Popup Modale — `confluence:contentAction`

| Proprietà | Valore |
|-----------|--------|
| Modulo | `confluence:contentAction` |
| Viewport | `large` |
| Dove appare | Menu "..." (tre puntini) su qualsiasi pagina Confluence |
| UX | Modale grande sovrapposta alla pagina corrente |

**Come aprirla:** apri una pagina → clicca "..." in alto a destra → "Chiedi all'Assistente AI (Popup)".

**Caso d'uso:** consultazione rapida mentre si legge una pagina specifica. Il contenuto resta visibile dietro la modale.

---

### 3. Pagina dello Space — `confluence:spacePage`

| Proprietà | Valore |
|-----------|--------|
| Modulo | `confluence:spacePage` |
| Route | `rag-space-panel` |
| Dove appare | Sidebar sinistra di ogni Confluence Space |
| UX | Pagina completa all'interno dello space, layout compatto (`65vh`) |

**Come aprirla:** entra in uno Space → cerca "Assistente AI" nella sidebar sinistra.

**Caso d'uso:** team che lavora su uno Space specifico e vuole il chatbot sempre raggiungibile con un click dalla sidebar.

---

### 4. Byline Item — `confluence:contentBylineItem`

| Proprietà | Valore |
|-----------|--------|
| Modulo | `confluence:contentBylineItem` |
| Dove appare | Riga byline sotto il titolo (accanto a "Creato da..." e "Ultima modifica") |
| UX | Bottone "🤖 Assistente AI" → click espande la chat inline (340px) |

**Come aprirla:** apri qualsiasi pagina → clicca "🤖 Assistente AI" nella riga delle metadata.

**Caso d'uso:** entry point sempre visibile su ogni pagina. La chat si apre nel contesto della pagina che si sta leggendo. Chiudibile con "✕".

---

### 5. Banner di Pagina — `confluence:pageBanner`

| Proprietà | Valore |
|-----------|--------|
| Modulo | `confluence:pageBanner` |
| Dove appare | Banner in cima ad ogni pagina Confluence (sopra il titolo) |
| UX | Bottone "🤖 Assistente AI" → click espande la chat nel banner (300px) |

**Come aprirla:** apri qualsiasi pagina → il banner è in cima → clicca "🤖 Assistente AI".

**Caso d'uso:** massima visibilità — è il primo elemento che l'utente vede. Ottimo per spingere l'adozione del chatbot in un team che non conosce ancora il tool.

---

## Architettura

```
Confluence / Jira (REST API)
         │
         ▼
  [Script di Ingestion]              ← ingest-test.mjs / ingest-test.py
  autenticazione: Personal API Token
  paginazione automatica (cursor-based)
  strip XML → file .md in output/
         │
         ▼
  [output/{spaceKey}/*.md]           ← file pronti per embedding + vector DB

  ─────────────────────────────────────────────────────
  [Forge Resolver — src/index.js]    ← implementato, attende backend
         │  POST RAG_BACKEND_URL/query
         ▼
  [Backend esterno]                  ← da implementare
         │
         ▼
  [Frontend React in Confluence]
  5 modalità di accesso
```

### Forge Resolver (`src/index.js`)

Il resolver è il punto di connessione tra l'UI Confluence e il backend esterno. È già implementato: riceve la domanda dal frontend tramite `@forge/bridge`, chiama `RAG_BACKEND_URL/query` e restituisce risposta + fonti.

Per attivarlo basta impostare le variabili d'ambiente:

```bash
forge variables set RAG_BACKEND_URL "https://tuo-backend.com" --environment development
forge variables set RAG_API_KEY     "tua-chiave"               --environment development
```

E aggiornare il permesso di egress nel `manifest.yml`:

```yaml
permissions:
  external:
    fetch:
      backend:
        - 'https://tuo-backend.com'   # sostituisce il wildcard '*' attuale
```

**Gestione errori:** se `RAG_BACKEND_URL` non è impostata, il resolver restituisce un messaggio di configurazione invece di crashare.

### Frontend React (`static/hello-world/src/App.js`)

Il componente `App` rileva il contesto di rendering all'avvio tramite `view.getContext()` e applica automaticamente il layout corretto:

| Contesto | Chat height | Padding | Max width |
|----------|-------------|---------|-----------|
| Full Page | 500px | 24px | 800px |
| Modal | 460px | 20px | 100% |
| Space Page | 65vh | 12px | 100% |
| Byline | 340px | 8px | 100% |
| Banner | 300px | 10px | 100% |

I contesti `byline` e `banner` usano un pattern **espandi/comprimi**: mostrano un bottone compatto e aprono la chat solo al click. Il frontend mostra i link alle fonti (`sources[]`) direttamente sotto ogni risposta del bot.

---

## Approccio Alternativo: Rovo Agent

Il **Rovo Agent** è il sistema AI nativo di Atlassian. Invece di costruire un'interfaccia chat custom, si definisce un agente conversazionale tramite un `prompt` di sistema e una serie di `rovo:action` (funzioni Forge che l'LLM può invocare autonomamente).

### Dove appare nell'UI

- Pannello laterale destro con floating button in basso a destra di ogni pagina Confluence e Jira
- Sidebar chat → tab "My Agents"
- Command palette digitando `/rovo` nell'editor Confluence

### Esempio di configurazione manifest

```yaml
modules:
  rovo:agent:
    - key: assistente-ai
      name: Assistente AI
      description: Risponde a domande sul contenuto aziendale
      prompt: |
        Sei un assistente AI specializzato sul contenuto Confluence.
        Rispondi sempre in italiano, in modo chiaro e conciso.
      conversationStarters:
        - Cosa dice questa pagina riguardo a...?
        - Riassumi i punti chiave
      actions:
        - fetch-page-content
        - call-ai-backend

  action:
    - key: call-ai-backend
      function: callBackend
      actionVerb: GET
      description: Chiama il backend AI esterno con la domanda dell'utente
      inputs:
        question:
          type: string
          required: true
```

### Confronto Custom UI vs Rovo Agent

| Aspetto | Custom UI (5 modalità) | Rovo Agent |
|---------|----------------------|------------|
| UI personalizzabile | ✅ Totale (React) | ❌ UI Rovo fissa |
| Scelta dell'LLM | ✅ (OpenAI, Claude, ecc.) | ❌ Atlassian decide |
| Controllo RAG/embeddings | ✅ Totale | ❌ Black box |
| Vector DB proprio | ✅ Direttamente nel resolver | ⚠️ Solo via action wrapper |
| Logica multi-step | ✅ Illimitata | ⚠️ Limitata |
| Richiede licenza Rovo | ❌ No | ✅ Sì |
| Disponibilità | Solo dove installata l'app | Nativamente in Confluence + Jira |

### Limiti tecnici delle action Rovo

| Vincolo | Limite |
|---------|--------|
| Dimensione risposta action | 5 MB massimo |
| Context window totale | 128k token |
| Bulk Jira actions | Max 20 item |
| Query JQL | Max 50 issue |
| Se triggerata da Automation | L'agent NON può invocare le sue action |

---

## Setup e Deploy

### Prerequisiti

- [Forge CLI](https://developer.atlassian.com/platform/forge/set-up-forge/) installata (`npm install -g @forge/cli`)
- Account Atlassian con accesso al sito target
- Node.js 18+

### Prima installazione

```bash
# 1. Installa dipendenze root
npm install

# 2. Installa dipendenze frontend
cd static/hello-world && npm install && cd ../..

# 3. Build del frontend
cd static/hello-world && npm run build && cd ../..

# 4. Valida il manifest
forge lint

# 5. Deploy sull'ambiente development
forge deploy --non-interactive --environment development

# 6. Installa sul sito Confluence
forge install --non-interactive \
  --site tuo-sito.atlassian.net \
  --product confluence \
  --environment development
```

### Aggiornamenti successivi

```bash
# Solo modifiche al codice (non al manifest)
cd static/hello-world && npm run build && cd ../..
forge deploy --non-interactive --environment development

# Se hai cambiato scopes o permessi nel manifest.yml — serve anche upgrade
forge install --non-interactive --upgrade \
  --site tuo-sito.atlassian.net \
  --product confluence \
  --environment development
```

### Debug

```bash
# Log degli ultimi 15 minuti
forge logs --environment development

# Log delle ultime 2 ore
forge logs --environment development --since 2h

# Tunnelling (hot reload per modifiche al codice)
forge tunnel
# NOTA: dopo modifiche al manifest.yml occorre rideploy e riavvio del tunnel
```

---

## Pipeline di Ingestion da Confluence/Jira

L'ingestion è un processo **offline e schedulabile**, completamente indipendente dall'app Forge. Estrae il contenuto da Confluence (e opzionalmente Jira) e lo converte in file Markdown pronti per un pipeline di embedding.

### Autenticazione

Serve un **Personal API Token** (non l'Organization API Key):

| | Organization API Key | Personal API Token |
|---|---|---|
| Scopo | Gestione org: utenti, licenze | Accesso prodotto: leggere/scrivere Confluence e Jira |
| Necessario per l'ingestion | ❌ | ✅ |

Generazione: `https://id.atlassian.com/manage-profile/security/api-tokens` → "Create API token".

Salvare il token in `api-token.txt` nella cartella padre (già escluso dal `.gitignore`).

### Cosa si estrae

**Da Confluence:**

| Campo | Disponibile | Note |
|-------|-------------|------|
| Titolo, corpo completo | ✅ | Body in XML storage format, da strippare |
| URL, data modifica, autore | ✅ | |
| Struttura gerarchica parent/child | ✅ | Campo `parentId` |
| Labels, commenti, allegati (metadati) | ✅ | Richiedono chiamate aggiuntive |

**Da Jira** (se installato):

| Campo | Disponibile | Note |
|-------|-------------|------|
| Summary, description, commenti | ✅ | Description in formato ADF (JSON) |
| Status, priority, labels, assignee | ✅ | |
| Sprint, epic, storico modifiche | ✅ | Campi custom, richiedono mappatura |

### Limiti API

**Confluence REST API v2:**

| Parametro | Valore |
|-----------|--------|
| Risultati per richiesta | max 250 pagine |
| Tipo paginazione | cursor-based (`_links.next`) |
| Rate limit sostenibile | ~10-20 req/s (con 300ms delay consigliato) |

**Jira REST API v3:**

| Parametro | Valore |
|-----------|--------|
| Risultati per richiesta | max 100 issue |
| Tipo paginazione | offset-based (`startAt` + `maxResults`) |

---

## Script di Ingestion

Sono disponibili due versioni equivalenti:

| Script | Linguaggio | Prerequisiti |
|--------|-----------|-------------|
| `ingest-test.mjs` | Node.js | Node.js 18+, nessuna dipendenza npm |
| `ingest-test.py` | Python | Python 3.8+, nessuna dipendenza esterna |

Entrambi si trovano nella **cartella padre** (non nella root dell'app Forge).

### Cosa fa ogni script

1. **Auth check** — verifica le credenziali, mostra nome e email dell'account
2. **Lista spaces** — elenca tutti gli space Confluence accessibili
3. **Download pagine** — paginazione cursor-based automatica (batch da 250)
4. **Conversione Markdown** — da Confluence Storage XML a `.md` (headings, bold, codice, link, tabelle, liste)
5. **Salvataggio file** — ogni pagina salvata come `{pageId}-{titolo}.md` in `output/{spaceKey}/`
6. **Report** — parole totali, media per pagina, chunk simulati
7. **Jira** — attivo automaticamente solo se Jira è installato sul sito

### Avvio Node.js

```bash
# Dalla cartella padre
node ingest-test.mjs --one             # test rapido: solo la prima pagina
node ingest-test.mjs                   # ingestion completa
node ingest-test.mjs tua@email.com     # con email esplicita
```

### Avvio Python

```bash
python ingest-test.py --one            # test rapido
python ingest-test.py                  # ingestion completa
python ingest-test.py tua@email.com    # con email esplicita
```

### Output generato

```
output/
└── {SPACE_KEY}/
    ├── {pageId}-{titolo}.md
    └── ...
```

Ogni file `.md` ha questa struttura:

```markdown
# Titolo della pagina

> Fonte: https://tuo-sito.atlassian.net/wiki

---

## Sezione

Testo convertito in Markdown, con blocchi di codice, liste e link preservati.
```

### Aggiornamenti incrementali

Per non reingestire tutto ad ogni run, filtrare le pagine per data di modifica:

```js
const sinceDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // ultime 24h
const nuovePagine = pages.filter(p =>
  new Date(p.version.createdAt) > sinceDate
);
```

Schedulazione consigliata: **job notturno** che reingestisce solo le pagine modificate nell'ultima giornata.
