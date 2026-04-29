"""
Script di ingestion della Knowledge Base da Atlassian Confluence/Jira.
Scarica le pagine in formato Markdown e le salva in output/{spaceKey}/

Prerequisiti: Python 3.8+, nessuna dipendenza esterna (solo stdlib).

Variabili d'ambiente richieste (file .env oppure export):
  ATLASSIAN_SITE=tuo-sito.atlassian.net
  ATLASSIAN_EMAIL=tuo@email.com
  ATLASSIAN_TOKEN=your_api_token   (oppure crea api-token.txt)

Uso:
  python ingest-test.py                        # usa ATLASSIAN_EMAIL
  python ingest-test.py tua@email.com          # email esplicita (sovrascrive env)
  python ingest-test.py --one                  # solo la prima pagina (test rapido)
  python ingest-test.py tua@email.com --one
"""

import sys
import os
import re
import json
import time
import base64
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# ─── Configurazione ───────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent
args       = sys.argv[1:]

SITE = os.environ.get("ATLASSIAN_SITE")
if not SITE:
    sys.exit("[ERRORE] ATLASSIAN_SITE non impostata.\n  Esempio: export ATLASSIAN_SITE=tuo-sito.atlassian.net")

_email_arg = next((a for a in args if not a.startswith("--")), None)
EMAIL = _email_arg or os.environ.get("ATLASSIAN_EMAIL")
if not EMAIL:
    sys.exit("[ERRORE] ATLASSIAN_EMAIL non impostata.\n  Esempio: export ATLASSIAN_EMAIL=tuo@email.com")

ONE_PAGE = "--one" in args

_token_env = os.environ.get("ATLASSIAN_TOKEN")
if _token_env:
    API_TOKEN = _token_env
else:
    _token_file = SCRIPT_DIR / "api-token.txt"
    if not _token_file.exists():
        sys.exit("[ERRORE] ATLASSIAN_TOKEN non impostata e api-token.txt non trovato.")
    API_TOKEN = _token_file.read_text(encoding="utf-8").strip()

OUTPUT_DIR = SCRIPT_DIR / "output"

BASE_CONFLUENCE = f"https://{SITE}/wiki"
BASE_JIRA       = f"https://{SITE}"
AUTH_HEADER     = "Basic " + base64.b64encode(f"{EMAIL}:{API_TOKEN}".encode()).decode()

HEADERS = {
    "Authorization": AUTH_HEADER,
    "Accept": "application/json",
}

REQUEST_DELAY = 0.3  # secondi tra le chiamate

# ─── Helpers ──────────────────────────────────────────────────────────────────

def print_sep(title: str):
    print("\n" + "─" * 60)
    print(f"  {title}")
    print("─" * 60)


def api_fetch(url: str, label: str = "") -> dict:
    req = Request(url, headers=HEADERS)
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"HTTP {e.code} su {label or url}: {body}")
    except URLError as e:
        raise RuntimeError(f"Connessione fallita su {label or url}: {e.reason}")


def safe_name(title: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", title)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)[:80].rstrip("-")
    return s


def resolve_all_parents(raw_pages: list) -> dict:
    """
    Risolve tutti i parentId sconosciuti come folder Confluence.
    Ritorna dict id → {id, title, parentId} che include pagine e folder.
    """
    known = {p["id"]: {"id": p["id"], "title": p["title"], "parentId": p.get("parentId")}
             for p in raw_pages}

    to_resolve = {p["parentId"] for p in raw_pages
                  if p.get("parentId") and p["parentId"] not in known}

    while to_resolve:
        batch = list(to_resolve)
        to_resolve.clear()
        for fid in batch:
            if fid in known:
                continue
            try:
                data = api_fetch(f"{BASE_CONFLUENCE}/api/v2/folders/{fid}", f"folder {fid}")
                known[fid] = {"id": data["id"], "title": data["title"], "parentId": data.get("parentId")}
                if data.get("parentId") and data["parentId"] not in known:
                    to_resolve.add(data["parentId"])
            except Exception:
                known[fid] = {"id": fid, "title": None, "parentId": None}
            time.sleep(0.1)

    return known


def build_path_map(raw_pages: list, node_map: dict, root_page_id: str | None) -> dict:
    """
    Restituisce {pageId: [titolo_safe_antenato1, ...]} usando pagine + folder risolte.
    root_page_id è la home page dello space: non compare nel percorso dei file figli.
    """
    cache = {}

    def get_ancestors(pid):
        if pid in cache:
            return cache[pid]
        node = node_map.get(pid)
        if not node:
            cache[pid] = []
            return []
        parent_id = node.get("parentId")
        if not parent_id or parent_id not in node_map:
            cache[pid] = []
            return []
        parent = node_map[parent_id]
        # Ferma la risalita alla home page dello space o a nodi senza titolo
        if not parent.get("title") or (root_page_id and parent["id"] == root_page_id):
            cache[pid] = []
            return []
        parent_ancestors = get_ancestors(parent_id)
        path = parent_ancestors + [safe_name(parent["title"])]
        cache[pid] = path
        return path

    for p in raw_pages:
        get_ancestors(p["id"])
    return cache


def _strip_tags(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s)).strip()

# ─── Conversione Storage XML → Markdown ───────────────────────────────────────

def storage_to_markdown(xml: str, title: str = "") -> str:
    md = xml

    # 1. Blocchi di codice Confluence (CDATA)
    def replace_code_block(m):
        inner = m.group(1)
        lang_m = re.search(r'<ac:parameter[^>]*ac:name="language"[^>]*>(.*?)</ac:parameter>', inner)
        lang   = lang_m.group(1).strip() if lang_m else ""
        cdata  = re.search(r'<!\[CDATA\[([\s\S]*?)\]\]>', inner)
        plain  = re.search(r'<ac:plain-text-body>([\s\S]*?)</ac:plain-text-body>', inner)
        code   = (cdata or plain)
        code   = code.group(1).strip() if code else ""
        return f"\n```{lang}\n{code}\n```\n"

    md = re.sub(
        r'<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)</ac:structured-macro>',
        replace_code_block, md
    )

    # 2. Macro info/warning/tip → blockquote
    def replace_info_macro(m):
        mtype = m.group(1)
        inner = m.group(2)
        body  = re.sub(r'<ac:rich-text-body>([\s\S]*?)</ac:rich-text-body>', r'\1', inner).strip()
        return f"\n> **{mtype.upper()}:** {body}\n"

    md = re.sub(
        r'<ac:structured-macro[^>]*ac:name="(info|warning|tip|note)"[^>]*>([\s\S]*?)</ac:structured-macro>',
        replace_info_macro, md
    )

    # 3. Rimuovi macro e tag Confluence rimanenti
    md = re.sub(r'<ac:structured-macro[\s\S]*?</ac:structured-macro>', '', md)
    md = re.sub(r'<ac:[a-z-]+[^>]*/>', '', md)
    md = re.sub(r'<ac:[a-z-]+[^>]*>[\s\S]*?</ac:[a-z-]+>', '', md)
    md = re.sub(r'<ri:[a-z-]+[^>]*/?>', '', md)
    for tag in ['ac:layout', 'ac:layout-section', 'ac:layout-cell']:
        md = re.sub(rf'<{tag}[^>]*>', '', md)
        md = re.sub(rf'</{tag}>', '', md)

    # 4. Headings
    for level in range(1, 7):
        hashes = '#' * level
        md = re.sub(rf'<h{level}[^>]*>([\s\S]*?)</h{level}>',
                    lambda m, h=hashes: f"\n{h} {_strip_tags(m.group(1))}\n", md, flags=re.IGNORECASE)

    # 5. Bold, italic, code inline
    md = re.sub(r'<strong[^>]*>([\s\S]*?)</strong>', r'**\1**', md, flags=re.IGNORECASE)
    md = re.sub(r'<b[^>]*>([\s\S]*?)</b>',           r'**\1**', md, flags=re.IGNORECASE)
    md = re.sub(r'<em[^>]*>([\s\S]*?)</em>',          r'*\1*',   md, flags=re.IGNORECASE)
    md = re.sub(r'<i[^>]*>([\s\S]*?)</i>',            r'*\1*',   md, flags=re.IGNORECASE)
    md = re.sub(r'<code[^>]*>([\s\S]*?)</code>',       r'`\1`',   md, flags=re.IGNORECASE)
    md = re.sub(r'<pre[^>]*>([\s\S]*?)</pre>',         r'\n```\n\1\n```\n', md, flags=re.IGNORECASE)

    # 6. Link
    def replace_link(m):
        href = m.group(1)
        text = _strip_tags(m.group(2)).strip()
        return f"[{text}]({href})" if text else href

    md = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>', replace_link, md, flags=re.IGNORECASE)

    # 7. Tabelle
    md = re.sub(r'<table[^>]*>', '\n', md, flags=re.IGNORECASE)
    md = re.sub(r'</table>', '\n', md, flags=re.IGNORECASE)
    md = re.sub(r'<t(head|body|foot)[^>]*>|</t(head|body|foot)>', '', md, flags=re.IGNORECASE)
    md = re.sub(r'<th[^>]*>([\s\S]*?)</th>', lambda m: f"| **{_strip_tags(m.group(1)).strip()}** ", md, flags=re.IGNORECASE)
    md = re.sub(r'<td[^>]*>([\s\S]*?)</td>', lambda m: f"| {_strip_tags(m.group(1)).strip()} ",    md, flags=re.IGNORECASE)
    md = re.sub(r'<tr[^>]*>', '', md, flags=re.IGNORECASE)
    md = re.sub(r'</tr>', '|\n', md, flags=re.IGNORECASE)

    # 8. Liste
    md = re.sub(r'<li[^>]*>([\s\S]*?)</li>', lambda m: f"\n- {_strip_tags(m.group(1)).strip()}", md, flags=re.IGNORECASE)
    md = re.sub(r'<[ou]l[^>]*>', '', md, flags=re.IGNORECASE)
    md = re.sub(r'</[ou]l>', '\n', md, flags=re.IGNORECASE)

    # 9. Paragrafi e line break
    md = re.sub(r'<br\s*/?>', '\n', md, flags=re.IGNORECASE)
    md = re.sub(r'<p[^>]*>([\s\S]*?)</p>', r'\n\1\n', md, flags=re.IGNORECASE)
    md = re.sub(r'<hr\s*/?>', '\n---\n', md, flags=re.IGNORECASE)

    # 10. Strip tag rimanenti
    md = re.sub(r'<[^>]+>', '', md)

    # 11. Entità HTML
    entities = {
        '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&quot;': '"', '&#39;': "'",
    }
    for ent, char in entities.items():
        md = md.replace(ent, char)
    md = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))), md)

    # 12. Normalizza spazi
    md = re.sub(r'[ \t]+$', '', md, flags=re.MULTILINE)
    md = re.sub(r'\n{3,}', '\n\n', md)

    return f"# {title}\n\n{md.strip()}\n"

# ─── Auth ─────────────────────────────────────────────────────────────────────

def check_auth():
    print_sep("AUTH CHECK")
    print(f"  Sito:   {SITE}")
    print(f"  Email:  {EMAIL}")
    print(f"  Token:  {API_TOKEN[:10]}...{API_TOKEN[-6:]}\n")

    req = Request(f"https://{SITE}/wiki/rest/api/user/current", headers=HEADERS)
    try:
        with urlopen(req, timeout=15) as resp:
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" not in content_type:
                print("  [ERRORE] Risposta non JSON — redirect al login.")
                sys.exit(1)
            me = json.loads(resp.read().decode())
            name  = me.get("displayName", "?")
            email = me.get("email", me.get("accountId", "?"))
            print(f"  Autenticato come: {name} ({email})")
            mode = "TEST (solo 1 pagina)" if ONE_PAGE else "COMPLETA (tutte le pagine)"
            print(f"  Modalità: {mode}")
            print("  Auth OK ✓")
    except HTTPError as e:
        if e.code == 401:
            print("  [ERRORE 401] Credenziali non valide.")
            print("  Verifica ATLASSIAN_EMAIL e ATLASSIAN_TOKEN (o api-token.txt)")
        elif e.code == 403:
            print("  [ERRORE 403] Token privo di permessi Confluence.")
        else:
            print(f"  [ERRORE {e.code}]")
        sys.exit(1)

# ─── Confluence ───────────────────────────────────────────────────────────────

def get_confluence_spaces() -> list:
    print_sep("CONFLUENCE — Lista spaces")
    data = api_fetch(f"{BASE_CONFLUENCE}/api/v2/spaces?limit=50&type=global", "spaces")
    spaces = data.get("results", [])
    print(f"Trovati {len(spaces)} space(s):\n")
    for s in spaces:
        print(f"  [{s['key']}]  {s['name']}  (id: {s['id']})")
    return spaces


def get_all_pages_from_space(space_id: str, space_key: str, space_name: str):
    print_sep(f'CONFLUENCE — Ingestion space "{space_name}" [{space_key}]')

    pages     = []
    raw_pages = []
    limit     = 1 if ONE_PAGE else 250
    url       = f"{BASE_CONFLUENCE}/api/v2/spaces/{space_id}/pages?limit={limit}&body-format=storage"
    batch_num = 1

    while url:
        print(f"  Batch #{batch_num} → {url.split('?')[0]}...")
        data = api_fetch(url, f"pages batch {batch_num}")

        for page in data.get("results", []):
            xml   = page.get("body", {}).get("storage", {}).get("value", "")
            text  = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", xml)).strip()
            words = len([w for w in text.split() if w])
            page_url = f"{BASE_CONFLUENCE}/spaces/{space_key}/pages/{page['id']}"

            raw_pages.append(page)
            pages.append({
                "id": page["id"], "title": page["title"],
                "url": page_url, "text": text, "word_count": words,
            })

        if ONE_PAGE:
            break

        next_rel = data.get("_links", {}).get("next")
        url = f"{BASE_CONFLUENCE}{next_rel}" if next_rel else None
        batch_num += 1
        if url:
            time.sleep(REQUEST_DELAY)

    print(f"\n  Pagine scaricate: {len(pages)}")

    # Identifica la home page dello space: è la pagina il cui parentId non è
    # tra le pagine scaricate (cioè punta al nodo radice dello space).
    page_ids = {p["id"] for p in raw_pages}
    root_page = next(
        (p for p in raw_pages if p.get("parentId") and p["parentId"] not in page_ids),
        None
    )
    root_page_id = root_page["id"] if root_page else None

    return pages, raw_pages, root_page_id


def report_pages(pages: list):
    total_words = sum(p["word_count"] for p in pages)
    avg = total_words // len(pages) if pages else 0
    print(f"\n  Parole totali: {total_words:,}")
    print(f"  Media parole/pagina: {avg}\n")
    print("  Titolo                                    | Parole | URL")
    print("  " + "-" * 80)
    for p in pages[:20]:
        print(f"  {p['title'][:40]:<40}  {p['word_count']:>6}   {p['url']}")
    if len(pages) > 20:
        print(f"  ... e altre {len(pages) - 20} pagine")


def simulate_chunking(pages: list, chunk_size: int = 500, overlap: int = 50) -> list:
    print_sep("CHUNKING — Simulazione")
    chunks = []
    for page in pages:
        words = page["text"].split()
        i = 0
        while i < len(words):
            chunks.append({
                "page_id": page["id"], "title": page["title"],
                "url": page["url"], "text": " ".join(words[i:i + chunk_size]),
            })
            i += chunk_size - overlap
    avg = len(chunks) / len(pages) if pages else 0
    print(f"  Pagine: {len(pages)}  →  Chunk: {len(chunks)}  (media: {avg:.1f}/pag)")
    return chunks


def save_pages_as_markdown(raw_pages: list, space_key: str, root_page_id: str | None) -> Path:
    print_sep(f"SALVATAGGIO — output/{space_key}/ (struttura gerarchica)")

    print("  Risoluzione folder Confluence...")
    node_map = resolve_all_parents(raw_pages)
    print(f"  Nodi totali risolti (pagine + folder): {len(node_map)}\n")

    path_map = build_path_map(raw_pages, node_map, root_page_id)
    base     = OUTPUT_DIR / space_key
    saved    = 0

    for page in raw_pages:
        xml = page.get("body", {}).get("storage", {}).get("value", "")
        if not xml:
            continue

        ancestors = path_map.get(page["id"], [])
        out_dir   = base.joinpath(*ancestors) if ancestors else base
        out_dir.mkdir(parents=True, exist_ok=True)

        md       = storage_to_markdown(xml, page["title"])
        filename = safe_name(page["title"]) + ".md"
        (out_dir / filename).write_text(md, encoding="utf-8")
        saved += 1

        display = "/".join(ancestors + [filename])
        if saved <= 5 or saved == len(raw_pages):
            print(f"  ✓ {display}")
        elif saved == 6:
            print(f"  ... ({len(raw_pages) - 5} file rimanenti)")

    print(f"\n  Salvati: {saved} file in output/{space_key}/")
    return base

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("╔══════════════════════════════════════════════════════════╗")
    print("║        ATLASSIAN INGESTION — Confluence → Markdown        ║")
    print("╚══════════════════════════════════════════════════════════╝")

    try:
        check_auth()

        spaces = get_confluence_spaces()
        if not spaces:
            print("\n  Nessuno space trovato.")
            return

        target = spaces[0]
        print(f'\n  → Space selezionato: "{target["name"]}" [{target["key"]}]')

        pages, raw_pages, root_page_id = get_all_pages_from_space(
            target["id"], target["key"], target["name"]
        )

        if not pages:
            print("  Space vuoto o senza permessi.")
            return

        report_pages(pages)
        simulate_chunking(pages)

        save_pages_as_markdown(raw_pages, target["key"], root_page_id)

        # Anteprima del primo file con contenuto
        first = next((p for p in raw_pages
                      if len(p.get("body", {}).get("storage", {}).get("value", "")) > 100), None)
        if first:
            print_sep("ANTEPRIMA — Primo file .md con contenuto")
            first_md = storage_to_markdown(first["body"]["storage"]["value"], first["title"])
            print(first_md[:600] + ("\n  ..." if len(first_md) > 600 else ""))

        print_sep("COMPLETATO")
        print(f"  File .md salvati in: output/{target['key']}/")
        print("  Prossimo passo: embedding dei chunk e caricamento nel vector DB.\n")

    except RuntimeError as e:
        print(f"\n[ERRORE] {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n  Interrotto dall'utente.")


if __name__ == "__main__":
    main()
