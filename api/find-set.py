import os
import json
import re
import concurrent.futures
import httpx
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

REBRICKABLE_KEY = os.environ.get('REBRICKABLE_API_KEY', '')
ANTHROPIC_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')

STOP_WORDS = {'lego', 'the', 'a', 'an', 'of', 'for', 'in', 'and', 'or',
               'set', 'sets', 'my', 'i', 'is', 'are', 'with', 'by', 'to'}

# Use a longer timeout to handle cold-start DNS+TLS latency
_RB_TIMEOUT = 8.0

def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}

def _rb_get(path: str, params: dict) -> dict:
    """One-shot Rebrickable GET — no shared client to avoid threading issues."""
    resp = httpx.get(
        f'https://rebrickable.com/api/v3/lego/{path}',
        headers=_rb_headers(),
        params=params,
        timeout=_RB_TIMEOUT,
        follow_redirects=True,
    )
    return resp.json()


# ── Direct set-number lookup ─────────────────────────────────────────────────

def direct_set_lookup(query: str) -> list:
    m = re.match(r'^(\d{4,6})[-\s]?(\d?)$', query.strip())
    if not m:
        return []
    set_num = m.group(1) + '-' + (m.group(2) or '1')
    try:
        resp = httpx.get(
            f'https://rebrickable.com/api/v3/lego/sets/{set_num}/',
            headers=_rb_headers(),
            timeout=_RB_TIMEOUT,
        )
        if resp.status_code == 200:
            return [resp.json()]
    except Exception:
        pass
    return []


# ── Theme detection ──────────────────────────────────────────────────────────

def _lookup_theme(word: str):
    """Check if a word matches a theme name. Returns (id, name_words_set) or None."""
    try:
        data = _rb_get('themes/', {'search': word, 'page_size': 10})
        for theme in data.get('results', []):
            if word in theme['name'].lower():
                return (theme['id'], set(theme['name'].lower().split()))
    except Exception:
        pass
    return None


def find_theme_and_keywords(query: str):
    """
    Parallel word-by-word theme detection.
    Returns (theme_id, remaining_keywords) or (None, cleaned_query).
    """
    words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
    if not words:
        return None, query

    theme_results = {}
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(words), 4)) as ex:
            futures = {ex.submit(_lookup_theme, w): w for w in words}
            # Give each thread its full timeout + buffer
            done, _ = concurrent.futures.wait(futures, timeout=_RB_TIMEOUT + 2)
            for fut in done:
                w = futures[fut]
                try:
                    result = fut.result()
                    if result:
                        theme_results[w] = result
                except Exception:
                    pass
    except Exception:
        pass  # If threading fails, fall through to text search

    for word in words:
        if word in theme_results:
            theme_id, theme_name_words = theme_results[word]
            remaining = [w for w in words if w not in theme_name_words]
            return theme_id, ' '.join(remaining).strip()

    return None, ' '.join(words)


# ── Rebrickable set search ───────────────────────────────────────────────────

def search_sets(theme_id=None, keywords='', page_size=20) -> list:
    params: dict = {'page_size': page_size, 'ordering': '-year'}
    if theme_id:
        params['theme_id'] = theme_id
    if keywords:
        params['search'] = keywords
    try:
        data = _rb_get('sets/', params)
        return data.get('results', [])
    except Exception:
        return []


# ── Merged search ────────────────────────────────────────────────────────────

def merged_search(query: str, _debug: list = None) -> list:
    seen: set  = set()
    results: list = []

    def add(sets: list, label: str = ''):
        added = 0
        for s in sets:
            if s['set_num'] not in seen:
                results.append(s)
                seen.add(s['set_num'])
                added += 1
        if _debug is not None:
            _debug.append(f'{label}: +{added} (total {len(results)})')

    # 1. Direct set-number lookup
    add(direct_set_lookup(query), 'direct_lookup')
    if results:
        return results

    # 2. Parallel theme detection
    theme_id, keywords = find_theme_and_keywords(query)
    if _debug is not None:
        _debug.append(f'theme_id={theme_id}, keywords="{keywords}"')

    # 3. Build parallel search tasks
    search_tasks: list = []
    if theme_id:
        if keywords:
            search_tasks.append((theme_id, keywords, 20, f'theme+kw'))
        search_tasks.append((theme_id, '', 20, 'broad_theme'))
    # Always text-search the full query
    search_tasks.append((None, query, 15, 'full_text'))
    # And keywords alone if they differ from the full query
    if keywords and keywords not in (query, ' '.join(
        w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2
    )):
        search_tasks.append((None, keywords, 10, 'kw_only'))

    # 4. Run all in parallel
    def run_search(args):
        tid, kw, ps, lbl = args
        return search_sets(tid, kw, ps), lbl

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(len(search_tasks), 1)) as ex:
            futures = [ex.submit(run_search, t) for t in search_tasks]
            done, _ = concurrent.futures.wait(futures, timeout=12)
            for fut in done:
                try:
                    sets, label = fut.result()
                    add(sets, label)
                except Exception:
                    pass
    except Exception:
        pass

    # 5. Fallback: progressively shorter phrase searches, then single words
    if not results:
        words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
        tried: list = []

        # n-word phrases from longest to shortest (skip the full query — already tried above)
        for n in range(len(words) - 1, 0, -1):
            for i in range(len(words) - n + 1):
                phrase = ' '.join(words[i:i + n])
                if phrase not in tried:
                    tried.append(phrase)
                    add(search_sets(None, phrase, 15), f'phrase_{phrase}')

        # Individual words (longer ones first) as last resort
        for word in sorted(words, key=len, reverse=True):
            if len(word) > 4 and word not in tried:
                tried.append(word)
                add(search_sets(None, word, 10), f'word_{word}')

        if _debug is not None:
            _debug.append(f'fallback: tried {tried}')

    return results


# ── Claude ranking ───────────────────────────────────────────────────────────

def rank_with_claude(query: str, sets: list) -> list:
    if not ANTHROPIC_KEY or not sets:
        return sets[:8]

    set_lines = '\n'.join(
        f"{s['set_num']}: {s['name']} ({s['year']}, {s['num_parts']} pieces)"
        for s in sets[:25]
    )
    prompt = (
        f'A LEGO fan searched for: "{query}"\n\n'
        f'Candidate sets from Rebrickable:\n{set_lines}\n\n'
        'Task: rank these sets by relevance to the search query.\n'
        'Rules:\n'
        '- Sets whose names contain ALL the key search words rank highest\n'
        '- Sets whose names contain MOST of the key search words rank next\n'
        '- Prefer newer sets (higher year) when names are equally relevant\n'
        '- Ignore sets with names that share only a single common word\n'
        'Return ONLY a JSON array of up to 8 set_nums in ranked order.\n'
        'Example: ["75969-1","71043-1"]. No explanation, no markdown.'
    )

    try:
        resp = httpx.post(
            'https://api.anthropic.com/v1/messages',
            headers={
                'x-api-key': ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
            },
            json={
                'model': 'claude-haiku-4-5-20251001',
                'max_tokens': 300,
                'messages': [{'role': 'user', 'content': prompt}],
            },
            timeout=10,
        )
        text = resp.json()['content'][0]['text'].strip()
        ranked_nums = json.loads(text)
        set_map = {s['set_num']: s for s in sets}
        ranked = [set_map[n] for n in ranked_nums if n in set_map]
        seen_r = {s['set_num'] for s in ranked}
        for s in sets:
            if s['set_num'] not in seen_r:
                ranked.append(s)
        return ranked[:8]
    except Exception:
        return sets[:8]


# ── Format ───────────────────────────────────────────────────────────────────

def format_set(s: dict) -> dict:
    return {
        'set_num':     s['set_num'],
        'name':        s['name'],
        'year':        s['year'],
        'num_parts':   s['num_parts'],
        'set_img_url': s.get('set_img_url'),
    }


# ── HTTP handler ─────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        query  = params.get('q', [''])[0].strip()
        debug  = 'debug' in params

        if not query:
            self._json(400, {'error': 'query required'})
            return

        _debug_log: list = [] if debug else None
        sets   = merged_search(query, _debug_log)
        ranked = rank_with_claude(query, sets)

        resp = {
            'results':       [format_set(s) for s in ranked],
            'claude_ranked': bool(ANTHROPIC_KEY),
            'total_found':   len(sets),
        }
        if debug:
            resp['debug'] = _debug_log
        self._json(200, resp)

    def _json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass
