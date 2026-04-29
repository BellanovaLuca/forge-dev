/**
 * Script di ingestion della Knowledge Base da Atlassian Confluence/Jira.
 * Scarica le pagine in formato Markdown e le salva in output/{spaceKey}/
 *
 * Prerequisiti: Node.js 18+, nessuna dipendenza npm.
 *
 * Variabili d'ambiente richieste (file .env oppure export):
 *   ATLASSIAN_SITE=tuo-sito.atlassian.net
 *   ATLASSIAN_EMAIL=tuo@email.com
 *   ATLASSIAN_TOKEN=your_api_token   (oppure crea api-token.txt)
 *
 * Uso:
 *   node ingest-test.mjs                          # usa ATLASSIAN_EMAIL
 *   node ingest-test.mjs tua@email.com            # email esplicita (sovrascrive env)
 *   node ingest-test.mjs --one                    # scarica solo la prima pagina (test)
 *   node ingest-test.mjs tua@email.com --one
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ─── Configurazione ───────────────────────────────────────────────────────────

const SITE = process.env.ATLASSIAN_SITE;
if (!SITE) {
  console.error('[ERRORE] ATLASSIAN_SITE non impostata.\n  Esempio: export ATLASSIAN_SITE=tuo-sito.atlassian.net');
  process.exit(1);
}

const _emailArg = process.argv[2]?.startsWith('--') ? null : process.argv[2];
const EMAIL = _emailArg ?? process.env.ATLASSIAN_EMAIL;
if (!EMAIL) {
  console.error('[ERRORE] ATLASSIAN_EMAIL non impostata.\n  Esempio: export ATLASSIAN_EMAIL=tuo@email.com');
  process.exit(1);
}

const ONE_PAGE = process.argv.includes('--one');

let API_TOKEN;
if (process.env.ATLASSIAN_TOKEN) {
  API_TOKEN = process.env.ATLASSIAN_TOKEN;
} else {
  try {
    API_TOKEN = readFileSync(join(__dir, 'api-token.txt'), 'utf8').trim();
  } catch {
    console.error('[ERRORE] ATLASSIAN_TOKEN non impostata e api-token.txt non trovato.');
    process.exit(1);
  }
}

const OUTPUT_DIR = join(__dir, 'output');

const BASE_CONFLUENCE = `https://${SITE}/wiki`;
const BASE_JIRA       = `https://${SITE}`;
const AUTH            = Buffer.from(`${EMAIL}:${API_TOKEN}`).toString('base64');

const HEADERS = {
  'Authorization': `Basic ${AUTH}`,
  'Accept': 'application/json',
};

const REQUEST_DELAY_MS = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function printSeparator(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

async function apiFetch(url, label = '') {
  const resp = await fetch(url, { headers: HEADERS });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} su ${label || url}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

/** Crea un nome sicuro dal titolo (usato sia per file che per cartelle) */
function safeName(title) {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/[-]+$/, '');
}

/**
 * Risolve tutti i parentId sconosciuti (folder Confluence) tramite API.
 * In Confluence Cloud le cartelle sono entità separate dalle pagine.
 * Ritorna una Map id → { id, title, parentId } che include sia pagine che folder.
 */
async function resolveAllParents(rawPages) {
  const known = new Map(rawPages.map(p => [p.id, { id: p.id, title: p.title, parentId: p.parentId }]));
  const toResolve = new Set();

  // Raccogli tutti i parentId non ancora in known
  for (const p of rawPages) {
    if (p.parentId && !known.has(p.parentId)) toResolve.add(p.parentId);
  }

  // Risolvi iterativamente finché non ci sono più ID sconosciuti
  while (toResolve.size > 0) {
    const batch = [...toResolve];
    toResolve.clear();

    for (const id of batch) {
      if (known.has(id)) continue;
      try {
        const data = await apiFetch(`${BASE_CONFLUENCE}/api/v2/folders/${id}`, `folder ${id}`);
        known.set(id, { id: data.id, title: data.title, parentId: data.parentId });
        // Se anche il parent di questa folder è sconosciuto, accodalo
        if (data.parentId && !known.has(data.parentId)) toResolve.add(data.parentId);
      } catch {
        // ID non risolvibile (es. root space) — ignora
        known.set(id, { id, title: null, parentId: null });
      }
      await sleep(100);
    }
  }

  return known;
}

/**
 * Costruisce la mappa pageId → percorso cartelle (array di titoli-safe degli antenati).
 * rootPageId è la home page dello space: non compare nel percorso dei file figli.
 */
function buildPathMap(rawPages, nodeMap, rootPageId) {
  const cache = new Map();

  function getAncestors(id) {
    if (cache.has(id)) return cache.get(id);
    const node = nodeMap.get(id);
    if (!node) { cache.set(id, []); return []; }

    const parentId = node.parentId;
    if (!parentId || !nodeMap.has(parentId)) {
      cache.set(id, []);
      return [];
    }
    const parent = nodeMap.get(parentId);
    // Ferma la risalita quando raggiunge la home page dello space o un nodo senza titolo
    if (!parent.title || (rootPageId && parent.id === rootPageId)) {
      cache.set(id, []);
      return [];
    }
    const parentAncestors = getAncestors(parentId);
    const path = [...parentAncestors, safeName(parent.title)];
    cache.set(id, path);
    return path;
  }

  for (const p of rawPages) getAncestors(p.id);
  return cache;
}

// ─── Conversione Storage XML → Markdown ───────────────────────────────────────

/**
 * Converte il Confluence Storage Format (XML) in Markdown.
 * Gestisce: headings, bold/italic, code inline/block, link, liste, tabelle, br.
 * I tag Confluence-specifici (ac:*, ri:*) vengono estratti o rimossi.
 */
function storageToMarkdown(xml = '', title = '') {
  let md = xml;

  // 1. Blocchi di codice Confluence (CDATA) → fenced code block
  md = md.replace(
    /<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (_, inner) => {
      const lang  = (inner.match(/<ac:parameter[^>]*ac:name="language"[^>]*>([\s\S]*?)<\/ac:parameter>/) || [])[1] ?? '';
      const code  = (inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/) || [])[1]
                 ?? (inner.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/) || [])[1]
                 ?? '';
      return `\n\`\`\`${lang.trim()}\n${code.trim()}\n\`\`\`\n`;
    }
  );

  // 2. Macro info/warning/tip Confluence → blockquote
  md = md.replace(
    /<ac:structured-macro[^>]*ac:name="(info|warning|tip|note)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (_, type, inner) => {
      const body = inner.replace(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/, '$1').trim();
      return `\n> **${type.toUpperCase()}:** ${body}\n`;
    }
  );

  // 3. Rimuovi tutte le altre macro e tag Confluence/Atlassian
  md = md.replace(/<ac:structured-macro[\s\S]*?<\/ac:structured-macro>/g, '');
  md = md.replace(/<ac:[a-z-]+[^>]*\/>/g, '');
  md = md.replace(/<ac:[a-z-]+[^>]*>[\s\S]*?<\/ac:[a-z-]+>/g, '');
  md = md.replace(/<ri:[a-z-]+[^>]*\/?>/g, '');

  // 4. Layout Confluence (colonne) → rimuovi wrapper, tieni contenuto
  md = md.replace(/<ac:layout[^>]*>/g, '').replace(/<\/ac:layout>/g, '');
  md = md.replace(/<ac:layout-section[^>]*>/g, '').replace(/<\/ac:layout-section>/g, '');
  md = md.replace(/<ac:layout-cell[^>]*>/g, '').replace(/<\/ac:layout-cell>/g, '');

  // 5. Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n# ${_strip(t)}\n`);
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n## ${_strip(t)}\n`);
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t) => `\n### ${_strip(t)}\n`);
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, t) => `\n#### ${_strip(t)}\n`);
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, t) => `\n##### ${_strip(t)}\n`);
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, t) => `\n###### ${_strip(t)}\n`);

  // 6. Inline: bold, italic, code
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi,           '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi,         '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi,           '*$1*');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi,     '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi,       '\n```\n$1\n```\n');

  // 7. Link
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = _strip(text).trim();
    return t ? `[${t}](${href})` : href;
  });

  // 8. Tabelle → Markdown table
  md = md.replace(/<table[^>]*>/gi, '\n');
  md = md.replace(/<\/table>/gi,    '\n');
  md = md.replace(/<thead[^>]*>|<\/thead>|<tbody[^>]*>|<\/tbody>|<tfoot[^>]*>|<\/tfoot>/gi, '');
  md = md.replace(/<th[^>]*>([\s\S]*?)<\/th>/gi, (_, c) => `| **${_strip(c).trim()}** `);
  md = md.replace(/<td[^>]*>([\s\S]*?)<\/td>/gi, (_, c) => `| ${_strip(c).trim()} `);
  md = md.replace(/<tr[^>]*>/gi,  '');
  md = md.replace(/<\/tr>/gi,     '|\n');

  // 9. Liste
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${_strip(c).trim()}`);
  md = md.replace(/<[ou]l[^>]*>/gi, '').replace(/<\/[ou]l>/gi, '\n');

  // 10. Paragrafi e line break
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n${c}\n`);
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');

  // 11. Strip tag rimanenti
  md = md.replace(/<[^>]+>/g, '');

  // 12. Decodifica entità HTML
  md = md
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

  // 13. Normalizza spazi e righe vuote
  md = md.replace(/[ \t]+$/gm, '');
  md = md.replace(/\n{3,}/g, '\n\n');

  return `# ${title}\n\n${md.trim()}\n`;
}

/** Strip veloce dei tag per uso interno nella conversione */
function _strip(s = '') {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Salvataggio su disco ──────────────────────────────────────────────────────

async function savePagesAsMarkdown(rawPages, spaceKey, rootPageId) {
  printSeparator(`SALVATAGGIO — output/${spaceKey}/ (struttura gerarchica)`);

  console.log('  Risoluzione folder Confluence...');
  const nodeMap = await resolveAllParents(rawPages);
  console.log(`  Nodi totali risolti (pagine + folder): ${nodeMap.size}\n`);

  const pathMap = buildPathMap(rawPages, nodeMap, rootPageId);
  let saved = 0;

  for (const raw of rawPages) {
    const xml = raw.body?.storage?.value ?? '';
    if (!xml) continue;

    const ancestors = pathMap.get(raw.id) ?? [];
    const dir       = join(OUTPUT_DIR, spaceKey, ...ancestors);
    mkdirSync(dir, { recursive: true });

    const md       = storageToMarkdown(xml, raw.title);
    const filename = safeName(raw.title) + '.md';
    writeFileSync(join(dir, filename), md, 'utf8');
    saved++;

    const displayPath = [...ancestors, filename].join('/');
    if (saved <= 5 || saved === rawPages.length) {
      console.log(`  ✓ ${displayPath}`);
    } else if (saved === 6) {
      console.log(`  ... (${rawPages.length - 5} file rimanenti)`);
    }
  }

  console.log(`\n  Salvati: ${saved} file in output/${spaceKey}/`);
  return join(OUTPUT_DIR, spaceKey);
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function checkAuth() {
  printSeparator('AUTH CHECK');
  console.log(`  Sito:   ${SITE}`);
  console.log(`  Email:  ${EMAIL}`);
  console.log(`  Token:  ${API_TOKEN.slice(0, 10)}...${API_TOKEN.slice(-6)}\n`);

  const resp = await fetch(`https://${SITE}/wiki/rest/api/user/current`, { headers: HEADERS });
  const isJson = (resp.headers.get('content-type') ?? '').includes('application/json');

  if (resp.status === 401 || !isJson) {
    console.error('  [ERRORE 401] Credenziali non valide.');
    console.error('  Verifica ATLASSIAN_EMAIL e ATLASSIAN_TOKEN (o api-token.txt)\n');
    process.exit(1);
  }
  if (resp.status === 403) {
    console.error('  [ERRORE 403] Token privo di permessi Confluence.');
    process.exit(1);
  }

  const me = await resp.json();
  console.log(`  Autenticato come: ${me.displayName} (${me.email ?? me.accountId})`);
  console.log(`  Modalità: ${ONE_PAGE ? 'TEST (solo 1 pagina)' : 'COMPLETA (tutte le pagine)'}`);
  console.log('  Auth OK ✓');
}

// ─── Confluence ───────────────────────────────────────────────────────────────

async function getConfluenceSpaces() {
  printSeparator('CONFLUENCE — Lista spaces');
  const data = await apiFetch(`${BASE_CONFLUENCE}/api/v2/spaces?limit=50&type=global`, 'spaces');
  console.log(`Trovati ${data.results.length} space(s):\n`);
  for (const s of data.results) console.log(`  [${s.key}]  ${s.name}  (id: ${s.id})`);
  return data.results;
}

async function getAllPagesFromSpace(spaceId, spaceKey, spaceName) {
  printSeparator(`CONFLUENCE — Ingestion space "${spaceName}" [${spaceKey}]`);

  const pages    = [];
  const rawPages = [];
  let url = `${BASE_CONFLUENCE}/api/v2/spaces/${spaceId}/pages?limit=${ONE_PAGE ? 1 : 250}&body-format=storage`;
  let pageNum = 1;

  while (url) {
    console.log(`  Batch #${pageNum} → ${url.split('?')[0]}...`);
    const data = await apiFetch(url, `pages batch ${pageNum}`);

    for (const page of data.results) {
      const xml   = page.body?.storage?.value ?? '';
      const text  = _strip(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
      const words = text.split(/\s+/).filter(Boolean).length;
      const pageUrl = `${BASE_CONFLUENCE}/spaces/${spaceKey}/pages/${page.id}`;

      rawPages.push(page);
      pages.push({ id: page.id, title: page.title, url: pageUrl, text, wordCount: words, raw: xml });
    }

    if (ONE_PAGE) break;
    const nextRel = data._links?.next;
    url = nextRel ? `${BASE_CONFLUENCE}${nextRel}` : null;
    pageNum++;
    if (url) await sleep(REQUEST_DELAY_MS);
  }

  console.log(`\n  Pagine scaricate: ${pages.length}`);

  // Identifica la home page dello space: è la pagina il cui parentId non è
  // tra le pagine scaricate (cioè punta al nodo radice dello space).
  const pageIds = new Set(rawPages.map(p => p.id));
  const rootPageId = rawPages.find(p => p.parentId && !pageIds.has(p.parentId))?.id ?? null;

  return { pages, rawPages, rootPageId };
}

function reportPages(pages) {
  const totalWords = pages.reduce((acc, p) => acc + p.wordCount, 0);
  console.log(`\n  Parole totali: ${totalWords.toLocaleString()}`);
  console.log(`  Media parole/pagina: ${Math.round(totalWords / (pages.length || 1))}\n`);
  console.log('  Titolo                                    | Parole | URL');
  console.log('  ' + '-'.repeat(80));
  for (const p of pages.slice(0, 20)) {
    console.log(`  ${p.title.padEnd(40).slice(0, 40)}  ${String(p.wordCount).padStart(6)}   ${p.url}`);
  }
  if (pages.length > 20) console.log(`  ... e altre ${pages.length - 20} pagine`);
}

function simulateChunking(pages, chunkSize = 500, overlap = 50) {
  printSeparator('CHUNKING — Simulazione');
  const chunks = [];
  for (const page of pages) {
    const words = page.text.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      chunks.push({ pageId: page.id, title: page.title, url: page.url, text: words.slice(i, i + chunkSize).join(' ') });
    }
  }
  console.log(`  Pagine: ${pages.length}  →  Chunk: ${chunks.length}  (media: ${(chunks.length / (pages.length || 1)).toFixed(1)}/pag)`);
  return chunks;
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

function extractJiraText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) return node.content.map(extractJiraText).join(' ');
  return '';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║        ATLASSIAN INGESTION — Confluence → Markdown        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  try {
    await checkAuth();

    // ── Confluence ────────────────────────────────────────────────────────────
    const spaces = await getConfluenceSpaces();

    if (spaces.length === 0) {
      console.log('\n  Nessuno space trovato.');
      return;
    }

    const targetSpace = spaces[0];
    console.log(`\n  → Space selezionato: "${targetSpace.name}" [${targetSpace.key}]`);

    const { pages, rawPages, rootPageId } = await getAllPagesFromSpace(
      targetSpace.id, targetSpace.key, targetSpace.name
    );

    if (pages.length === 0) {
      console.log('  Space vuoto o senza permessi.');
      return;
    }

    reportPages(pages);
    simulateChunking(pages);

    // Salva le pagine come file .md
    const outputDir = await savePagesAsMarkdown(rawPages, targetSpace.key, rootPageId);

    // Mostra anteprima del primo file salvato con contenuto
    const firstWithContent = rawPages.find(p => (p.body?.storage?.value ?? '').length > 100);
    if (firstWithContent) {
      printSeparator('ANTEPRIMA — Primo file .md con contenuto');
      const firstMd = storageToMarkdown(firstWithContent.body.storage.value, firstWithContent.title);
      console.log(firstMd.slice(0, 600) + (firstMd.length > 600 ? '\n  ...' : ''));
    }

    // ── Jira ──────────────────────────────────────────────────────────────────
    const jiraCheck = await fetch(`${BASE_JIRA}/rest/api/3/myself`, { headers: HEADERS });
    if (jiraCheck.status === 404) {
      console.log('\n  [INFO] Jira non installato su questo sito — sezione saltata.');
    }

    printSeparator('COMPLETATO');
    console.log(`  File .md salvati in: output/${targetSpace.key}/`);
    console.log(`  Prossimo passo: embedding dei chunk e caricamento nel vector DB.\n`);

  } catch (err) {
    console.error('\n[ERRORE]', err.message);
    process.exit(1);
  }
}

main();
