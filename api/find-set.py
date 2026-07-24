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

_RB_TIMEOUT = 8.0

def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}

def _rb_get(path: str, params: dict) -> dict:
    resp = httpx.get(
        f'https://rebrickable.com/api/v3/lego/{path}',
        headers=_rb_headers(),
        params=params,
        timeout=_RB_TIMEOUT,
        follow_redirects=True,
    )
    return resp.json()


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


def _lookup_all_themes(word: str) -> list:
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


def find_theme_and_keywords(query: str, _log: list = None):
    """
    Theme detection with bigram search.
    Only uses a theme if ALL meaningful words in the theme name appear in the query
    (prevents "speed" matching "Speed Slammers" for "speed champions ferrari").
    """
    words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
    if not words:
        return None, query

    search_phrases: list = list(words)
    for i in range(len(words) - 1):
        search_phrases.append(f'{words[i]} {words[i+1]}')

    all_candidates: list = []
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(search_phrases), 6)) as ex:
            futures = {ex.submit(_lookup_all_themes, p): p for p in search_phrases}
            done, _ = concurrent.futures.wait(futures, timeout=_RB_TIMEOUT + 2)
            for fut in done:
                try:
                    themes = fut.result()
                    all_candidates.extend(themes)
                except Exception:
                    pass
    except Exception:
        pass

    if _log is not None:
        _log.append(f'theme_candidates: {[(tid, sorted(tw)) for tid, tw in all_candidates[:6]]}')

    if not all_candidates:
        return None, ' '.join(words)

    seen_ids: set = set()
    unique: list = []
    for tid, twords in all_candidates:
        if tid not in seen_ids:
            seen_ids.add(tid)
            unique.append((tid, twords))

    def score(c):
        return sum(1 for w in words if w in c[1])

    # Only accept themes where every meaningful word in the theme name
    # also appears in the query. Prevents "speed" -> "Speed Slammers".
    query_word_set = set(words)
    def all_meaningful_in_query(c):
        meaningful = {w for w in c[1] if w not in STOP_WORDS and len(w) > 2}
        return all(w in query_word_set for w in meaningful)

    valid = [c for c in unique if score(c) > 0 and all_meaningful_in_query(c)]
    if not valid:
        return None, ' '.join(words)

    best_id, best_words = max(valid, key=score)
    remaining = [w for w in words if w not in best_words]
    return best_id, ' '.join(remaining).strip()


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

    add(direct_set_lookup(query), 'direct_lookup')
    if results:
        return results

    theme_id, keywords = find_theme_and_keywords(query, _log=_debug)
    if _debug is not None:
        _debug.append(f'theme_id={theme_id}, keywords="{keywords}"')

    search_tasks: list = []
    if theme_id:
        if keywords:
            search_tasks.append((theme_id, keywords, 20, 'theme+kw'))
        search_tasks.append((theme_id, '', 20, 'broad_theme'))
    else:
        # No theme found: search each meaningful query word individually in parallel.
        # Ensures brand/model words like "ferrari" are searched even when the
        # full-text query returns only fuzzy unrelated matches.
        extra_words = [w for w in query.lower().split()
                       if w not in STOP_WORDS and len(w) > 4]
        for word in extra_words:
            search_tasks.append((None, word, 10, f'word_{word}'))
    # Always text-search the full query
    search_tasks.append((None, query, 15, 'full_text'))
    # And keywords alone if they differ from the full query
    if keywords and keywords not in (query, ' '.join(
        w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2
    )):
        search_tasks.append((None, keywords, 10, 'kw_only'))

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

    # Fallback: n-gram phrase searches when < 8 results
    if len(results) < 8:
        words = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
        tried: list = []

        for n in range(len(words) - 1, 0, -1):
            for i in range(len(words) - n + 1):
                phrase = ' '.join(words[i:i + n])
                if phrase not in tried:
                    tried.append(phrase)
                    add(search_sets(None, phrase, 15), f'phrase_{phrase}')

        for word in sorted(words, key=len, reverse=True):
            if len(word) > 4 and word not in tried:
                tried.append(word)
                add(search_sets(None, word, 10), f'word_{word}')

        if _debug is not None:
            _debug.append(f'fallback: tried {tried}')

    return results


def _pre_sort(sets: list, query: str) -> list:
    qwords = [w for w in query.lower().split() if w not in STOP_WORDS and len(w) > 2]
    def sort_key(s):
        name = s['name'].lower()
        matches = sum(1 for w in qwords if w in name)
        return (matches, s.get('year', 0))
    return sorted(sets, key=sort_key, reverse=True)


def rank_with_claude(query: str, sets: list) -> list:
    if not ANTHROPIC_KEY or not sets:
        return _pre_sort(sets, query)[:8]

    pre_sorted = _pre_sort(sets, query)

    set_lines = '\n'.join(
        f"{s['set_num']}: {s['name']} ({s['year']}, {s['num_parts']} pieces)"
        for s in pre_sorted[:25]
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
        for s in pre_sorted:
            if s['set_num'] not in seen_r:
                ranked.append(s)
        return ranked[:8]
    except Exception:
        return pre_sorted[:8]


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
        debug  = 'debug' in params

        if not query:
            self._json(400, {'error': 'query required'})
            return

        _debug_log: list = [] if debug else None
        sets = merged_search(query, _debug_log)
        sets = [s for s in sets if s.get('num_parts', 0) >= 10]
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
