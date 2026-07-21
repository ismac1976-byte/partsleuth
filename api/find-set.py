import os
import json
import httpx
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

REBRICKABLE_KEY = os.environ.get('REBRICKABLE_API_KEY', '')
ANTHROPIC_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')


def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}


def find_theme_ids(query: str) -> list:
    """
    Search Rebrickable themes by name and return matching IDs.
    e.g. "friends" → Lego Friends theme_id(s)
    """
    try:
        resp = httpx.get(
            'https://rebrickable.com/api/v3/lego/themes/',
            headers=_rb_headers(),
            params={'search': query, 'page_size': 5},
            timeout=8,
        )
        return [t['id'] for t in resp.json().get('results', [])]
    except Exception:
        return []


def search_by_text(query: str) -> list:
    try:
        resp = httpx.get(
            'https://rebrickable.com/api/v3/lego/sets/',
            headers=_rb_headers(),
            params={'search': query, 'page_size': 20, 'ordering': '-year'},
            timeout=10,
        )
        return resp.json().get('results', [])
    except Exception:
        return []


def search_by_theme(theme_id: int) -> list:
    try:
        resp = httpx.get(
            'https://rebrickable.com/api/v3/lego/sets/',
            headers=_rb_headers(),
            params={'theme_id': theme_id, 'page_size': 20, 'ordering': '-year'},
            timeout=10,
        )
        return resp.json().get('results', [])
    except Exception:
        return []


def merged_search(query: str) -> list:
    """
    Combine text search + theme search (deduped by set_num).
    Theme search kicks in when the query matches a Rebrickable theme name,
    ensuring searches like "Friends" or "City" surface the right sets.
    """
    seen: set = set()
    results: list = []

    def add(sets: list):
        for s in sets:
            if s['set_num'] not in seen:
                results.append(s)
                seen.add(s['set_num'])

    # 1. Text search
    add(search_by_text(query))

    # 2. Theme search — enriches when query names a Lego theme
    for tid in find_theme_ids(query)[:2]:
        add(search_by_theme(tid))

    return results


def rank_with_claude(query: str, sets: list) -> list:
    """Ask Claude to rank the Rebrickable results by relevance to the query."""
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
        text = resp.json()['content'][0]['text'].strip()
        ranked_nums = json.loads(text)
        set_map = {s['set_num']: s for s in sets}
        ranked = [set_map[n] for n in ranked_nums if n in set_map]
        # Append any that Claude missed
        seen = set(ranked_nums)
        for s in sets:
            if s['set_num'] not in seen:
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
