import os
import json
import httpx
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

REBRICKABLE_KEY = os.environ.get('REBRICKABLE_API_KEY', '')
ANTHROPIC_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')

# Words to ignore when splitting a query into candidate theme words
STOP_WORDS = {'lego', 'the', 'a', 'an', 'of', 'for', 'in', 'and', 'or', 'set', 'sets', 'my'}


def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}


def find_theme_and_keywords(query: str) -> tuple:
    """
    Split the query word-by-word, searching Rebrickable themes for each
    significant word until we find a matching theme.

    Returns (theme_id_or_None, keyword_string).

    Example: "lego friends cafe" → (494, "cafe")
             "hogwarts castle"   → (None, "hogwarts castle")
    """
    words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]

    for word in words:
        try:
            resp = httpx.get(
                'https://rebrickable.com/api/v3/lego/themes/',
                headers=_rb_headers(),
                params={'search': word, 'page_size': 5},
                timeout=6,
            )
            themes = resp.json().get('results', [])
            # Only accept if the word genuinely appears in the theme name
            for theme in themes:
                if word in theme['name'].lower():
                    # Keywords = everything except the matched word (and "lego")
                    keywords = ' '.join(
                        w for w in words if w != word
                    ).strip()
                    return theme['id'], keywords or query
        except Exception:
            pass

    return None, query


def search_sets(theme_id, keywords: str, page_size: int = 20) -> list:
    """Search Rebrickable sets, optionally scoped to a theme."""
    params = {'page_size': page_size, 'ordering': '-year'}
    if keywords:
        params['search'] = keywords
    if theme_id:
        params['theme_id'] = theme_id
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


def merged_search(query: str) -> list:
    """
    1. Detect a Lego theme in the query (word-by-word).
    2. If found: search WITHIN that theme using the remaining keywords.
       This ensures "lego friends cafe" hits Friends sets, not Speed Champions.
    3. Always fall back to a broad text search too, so non-theme queries still work.
    """
    seen: set = set()
    results: list = []

    def add(sets: list):
        for s in sets:
            if s['set_num'] not in seen:
                results.append(s)
                seen.add(s['set_num'])

    theme_id, keywords = find_theme_and_keywords(query)

    if theme_id:
        # Targeted: within-theme keyword search  (e.g. Friends + "cafe")
        add(search_sets(theme_id, keywords))
        # Broader: recent sets from that theme (catches any that don't match text)
        add(search_sets(theme_id, ''))
    else:
        # No theme detected — plain text search
        add(search_sets(None, query))

    # Safety net: if still thin, add a plain text search on the keywords
    if len(results) < 6:
        add(search_sets(None, keywords if theme_id else query))

    return results


def rank_with_claude(query: str, sets: list) -> list:
    """Ask Claude Haiku to pick and order the 6 most relevant results."""
    if not ANTHROPIC_KEY or not sets:
        return sets[:6]

    set_lines = '\n'.join(
        f"{s['set_num']}: {s['name']} ({s['year']}, {s['num_parts']} pieces)"
        for s in sets
    )
    prompt = (
        f'A LEGO fan is searching for: "{query}"\n\n'
        f'Rebrickable results:\n{set_lines}\n\n'
        'Return ONLY a JSON array of the 6 most relevant set numbers in order, '
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
                'max_tokens': 200,
                'messages': [{'role': 'user', 'content': prompt}],
            },
            timeout=15,
        )
        ranked_nums = json.loads(resp.json()['content'][0]['text'].strip())
        set_map = {s['set_num']: s for s in sets}
        ranked = [set_map[n] for n in ranked_nums if n in set_map]
        seen_set = set(ranked_nums)
        for s in sets:
            if s['set_num'] not in seen_set:
                ranked.append(s)
        return ranked[:6]
    except Exception:
        return sets[:6]


def format_set(s: dict) -> dict:
    return {
        'set_num':     s['set_num'],
        'name':        s['name'],
        'year':        s['year'],
        'num_parts':   s['num_parts'],
        'set_img_url': s.get('set_img_url'),
    }


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
