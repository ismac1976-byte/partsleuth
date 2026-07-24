import os
import json
import re
import httpx
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

REBRICKABLE_KEY = os.environ.get('REBRICKABLE_API_KEY', '')
ANTHROPIC_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')

# Words to ignore when searching for theme names
STOP_WORDS = {'lego', 'the', 'a', 'an', 'of', 'for', 'in', 'and', 'or',
               'set', 'sets', 'my', 'i', 'is', 'are'}


def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}


# ── Direct set-number lookup ─────────────────────────────────────────────────

def direct_set_lookup(query: str) -> list:
    """If query is a bare set number (e.g. "75969" or "75969-1"), fetch it directly."""
    m = re.match(r'^(\d{4,6})[-\s]?(\d?)$', query.strip())
    if not m:
        return []
    set_num = m.group(1) + '-' + (m.group(2) or '1')
    try:
        resp = httpx.get(
            f'https://rebrickable.com/api/v3/lego/sets/{set_num}/',
            headers=_rb_headers(),
            timeout=8,
        )
        if resp.status_code == 200:
            return [resp.json()]
    except Exception:
        pass
    return []


# ── Theme detection (word-by-word) ───────────────────────────────────────────

def find_theme_and_keywords(query: str) -> tuple:
    """
    Check each non-stop word against the Rebrickable themes endpoint.
    Returns (theme_id, remaining_keywords) or (None, cleaned_query).

    Example: "lego friends cafe"  → theme_id=246, keywords="cafe"
             "city fire station"  → theme_id=52,  keywords="fire station"
             "hogwarts castle"    → None,          keywords="hogwarts castle"
    """
    words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]

    for word in words:
        try:
            resp = httpx.get(
                'https://rebrickable.com/api/v3/lego/themes/',
                headers=_rb_headers(),
                params={'search': word, 'page_size': 10},
                timeout=6,
            )
            themes = resp.json().get('results', [])
            for theme in themes:
                if word in theme['name'].lower():
                    remaining = [w for w in words if w != word]
                    return theme['id'], ' '.join(remaining).strip()
        except Exception:
            pass

    return None, ' '.join(words)


# ── Rebrickable set search ───────────────────────────────────────────────────

def search_sets(theme_id=None, keywords='', page_size=20) -> list:
    params: dict = {'page_size': page_size, 'ordering': '-year'}
    if theme_id:
        params['theme_id'] = theme_id
    if keywords:
        params['search'] = keywords
    try:
        resp = httpx.get(
            'https://rebrickable.com/api/v3/lego/sets/',
            headers=_rb_headers(),
            params=params,
            timeout=10,
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

    # 1. Direct set-number lookup (fastest, most precise)
    add(direct_set_lookup(query))
    if results:
        return results

    # 2. Word-by-word theme detection
    theme_id, keywords = find_theme_and_keywords(query)

    if theme_id:
        # Targeted: within-theme keyword search
        if keywords:
            add(search_sets(theme_id, keywords, page_size=20))
        # Broader: most recent sets in that theme
        add(search_sets(theme_id, '', page_size=20))
        # Fallback: plain text search in case theme search missed relevant sets
        if len(results) < 6:
            add(search_sets(None, query, page_size=10))
    else:
        # No theme matched — plain text search
        add(search_sets(None, query, page_size=20))

    return results


# ── Claude ranking ───────────────────────────────────────────────────────────

def rank_with_claude(query: str, sets: list) -> list:
    """Use Claude Haiku to reorder results by relevance to the user's query."""
    if not ANTHROPIC_KEY or not sets:
        return sets[:8]

    set_lines = '\n'.join(
        f"{s['set_num']}: {s['name']} ({s['year']}, {s['num_parts']} pieces)"
        for s in sets[:20]
    )
    prompt = (
        f'A LEGO fan is searching for: "{query}"\n\n'
        f'Rebrickable results:\n{set_lines}\n\n'
        'Return ONLY a JSON array of the 8 most relevant set numbers in order, '
        'e.g. ["75969-1","71043-1"]. No explanation, no markdown.'
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
            timeout=15,
        )
        text = resp.json()['content'][0]['text'].strip()
        ranked_nums = json.loads(text)
        set_map = {s['set_num']: s for s in sets}
        ranked = [set_map[n] for n in ranked_nums if n in set_map]
        # Append any that Claude didn't mention
        seen_ranked = {s['set_num'] for s in ranked}
        for s in sets:
            if s['set_num'] not in seen_ranked:
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
