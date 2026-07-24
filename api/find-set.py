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

# Shared httpx client (reuse connections)
_client = None

def _get_client():
    global _client
    if _client is None:
        _client = httpx.Client(timeout=httpx.Timeout(5.0), follow_redirects=True)
    return _client

def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}


# ── Direct set-number lookup ─────────────────────────────────────────────────

def direct_set_lookup(query: str) -> list:
    m = re.match(r'^(\d{4,6})[-\s]?(\d?)$', query.strip())
    if not m:
        return []
    set_num = m.group(1) + '-' + (m.group(2) or '1')
    try:
        resp = _get_client().get(
            f'https://rebrickable.com/api/v3/lego/sets/{set_num}/',
            headers=_rb_headers(),
        )
        if resp.status_code == 200:
            return [resp.json()]
    except Exception:
        pass
    return []


# ── Theme detection ──────────────────────────────────────────────────────────

def _lookup_theme(word: str):
    """Check if a single word matches a Rebrickable theme. Returns (id, name_words) or None."""
    try:
        resp = _get_client().get(
            'https://rebrickable.com/api/v3/lego/themes/',
            headers=_rb_headers(),
            params={'search': word, 'page_size': 10},
        )
        for theme in resp.json().get('results', []):
            if word in theme['name'].lower():
                return (theme['id'], set(theme['name'].lower().split()))
    except Exception:
        pass
    return None


def find_theme_and_keywords(query: str):
    """
    Parallel word-by-word theme detection.
    Removes ALL words in the matched theme name from keywords.

      "lego friends cafe"         → (friends_id, "cafe")
      "harry potter diagon alley" → (hp_id, "diagon alley")
      "star wars at-at"           → (sw_id, "at-at")
      "hogwarts castle"           → (None, "hogwarts castle")
    """
    words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
    if not words:
        return None, query

    # Check all words for theme matches IN PARALLEL
    theme_results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(words), 4)) as ex:
        futures = {ex.submit(_lookup_theme, w): w for w in words}
        for fut in concurrent.futures.as_completed(futures, timeout=6):
            w = futures[fut]
            try:
                result = fut.result()
                if result:
                    theme_results[w] = result
            except Exception:
                pass

    # Use the FIRST word (in original order) that matched a theme
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
        resp = _get_client().get(
            'https://rebrickable.com/api/v3/lego/sets/',
            headers=_rb_headers(),
            params=params,
        )
        return resp.json().get('results', [])
    except Exception:
        return []


# ── Merged search ────────────────────────────────────────────────────────────

def merged_search(query: str) -> list:
    seen: set  = set()
    results: list = []

    def add(sets: list):
        for s in sets:
            if s['set_num'] not in seen:
                results.append(s)
                seen.add(s['set_num'])

    # 1. Direct set-number lookup
    add(direct_set_lookup(query))
    if results:
        return results

    # 2. Theme detection (parallel word-by-word)
    theme_id, keywords = find_theme_and_keywords(query)

    # 3. Build all searches to run in parallel
    search_tasks = []
    if theme_id:
        if keywords:
            search_tasks.append((theme_id, keywords, 20))   # themed + keyword
        search_tasks.append((theme_id, '', 20))              # broad theme
    # Always include text searches
    search_tasks.append((None, query, 15))                   # full query text
    if keywords and keywords != query and keywords != ' '.join(
        w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2
    ):
        search_tasks.append((None, keywords, 10))            # keywords only

    # 4. Run all searches in PARALLEL
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(search_tasks)) as ex:
        futures = [ex.submit(search_sets, *task) for task in search_tasks]
        # Collect in submission order (maintain priority)
        for fut in futures:
            try:
                add(fut.result(timeout=10))
            except Exception:
                pass

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
        f'A LEGO fan is searching for: "{query}"\n\n'
        f'Rebrickable results:\n{set_lines}\n\n'
        'Return ONLY a JSON array of the 8 most relevant set numbers in relevance order. '
        'Prefer exact matches. Example: ["75969-1","71043-1"]. No explanation, no markdown.'
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

        if not query:
            self._json(400, {'error': 'query required'})
            return

        sets   = merged_search(query)
        ranked = rank_with_claude(query, sets)

        self._json(200, {
            'results':       [format_set(s) for s in ranked],
            'claude_ranked': bool(ANTHROPIC_KEY),
            'total_found':   len(sets),
        })

    def _json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass
