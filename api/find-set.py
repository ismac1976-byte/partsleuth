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

def _lookup_all_themes(word: str) -> list:
    """Returns ALL themes whose names contain this word: [(id, name_words_set), ...]"""
    try:
        data = _rb_get('themes/', {'search': word, 'page_size': 10})
        return [
            (t['id'], set(t['name'].lower().split()))
            for t in data.get('results', [])
            if word in t['name'].lower()
        ]
    except Exception:
        pass
    return []


def find_theme_and_keywords(query: str):
    """
    Parallel word-by-word theme detection.
    Picks the theme whose name contains the MOST query words
    (e.g. "Speed Champions" beats "Speed" for query "speed champions ferrari").
    Returns (theme_id, remaining_keywords) or (None, cleaned_query).
    """
    words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
    if not words:
        return None, query

    # Collect all candidate themes from all words in parallel
    all_candidates: list = []   # list of (id, name_words_set)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(words), 4)) as ex:
            futures = {ex.submit(_lookup_all_themes, w): w for w in words}
            done, _ = concurrent.futures.wait(futures, timeout=_RB_TIMEOUT + 2)
            for fut in done:
                try:
                    themes = fut.result()
                    all_candidates.extend(themes)
                except Exception:
                    pass
    except Exception:
        pass

    if not all_candidates:
        return None, ' '.join(words)

    # Deduplicate by theme_id, keeping unique entries
    seen_ids: set = set()
    unique_candidates = []
    for tid, twords in all_candidates:
        if tid not in seen_ids:
            seen_ids.add(tid)
            unique_candidates.append((tid, twords))

    # Pick the theme whose name shares the MOST words with the query
    # (tie-break: prefer the one that covers the most query words)
    def score(candidate):
        _, twords = candidate
        return sum(1 for w in words if w in twords)

    best_theme_id, best_theme_words = max(unique_candidates, key=score)
    best_score = score((best_theme_id, best_theme_words))

    if best_score == 0:
        return None, ' '.join(words)

    remaining = [w for w in words if w not in best_theme_words]
    return best_theme_id, ' '.join(remaining).strip()


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

    # 5. Fallback: always run phrase searches when we have < 8 good results
    #    (handles wrong/small theme match like "speed" → theme 17 instead of Speed Champions)
    if len(results) < 8:
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
