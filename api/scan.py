"""
PartSleuth — /api/scan  (v4: thin Claude Vision proxy)

v3 → v4 architecture change (why this is dramatically faster):
  - Image resizing moved to the CLIENT (phone downscales to 800px before
    upload: ~80 KB instead of 4-8 MB over mobile).
  - Checklist matching moved to the CLIENT (lib/matching.ts) — the phone
    already holds the checklist from Firestore, so it no longer re-uploads
    hundreds of lines with every scan.
  - Annotation moved to the CLIENT (percentage-positioned overlay divs) —
    no annotated JPEG round-trip, and boxes are aligned by construction.
  - Result: opencv-python + numpy + Pillow (~90 MB) removed from the
    function bundle → cold starts drop from many seconds to well under one.

POST  { image_b64 }              (JPEG, already ≤800px, base64)
→     { pieces: [ { part_num, color, confidence, bbox_pct } ] }
"""

import os, json, re
from http.server import BaseHTTPRequestHandler

import httpx

ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# ~130 input tokens. Compact single-char keys cut output tokens ~60%.
_PROMPT = (
    'LEGO expert. List every piece visible — include unidentifiable ones.\n'
    'Each entry: {"p":"part#","c":"color","b":[x1,y1,x2,y2],"cf":"X"}\n'
    'p = BrickLink# (e.g. "3001"=Brick2x4 "3010"=Brick1x4 "3004"=Brick1x2 '
    '"3003"=Brick2x2 "3005"=Brick1x1 "3020"=Plate2x4 "3023"=Plate1x2 '
    '"3022"=Plate2x2 "3024"=Plate1x1 "3068b"=Tile2x2 "3069b"=Tile1x2) or null\n'
    'c = LEGO colour (Red Blue Yellow Black White "Light Bluish Gray" '
    '"Dark Bluish Gray" Tan Green "Dark Green" Orange "Medium Azure" '
    '"Reddish Brown" Lime "Trans-Clear") or null\n'
    'b = [x1,y1,x2,y2] 0-1 image fractions, TIGHT around the piece\n'
    'cf = h(high) m(medium) l(low) n(unidentifiable)\n'
    'Rules: separate touching pieces; no duplicates.\n'
    'Return ONLY valid JSON:\n'
    '{"pieces":[{"p":"3001","c":"Red","b":[0.1,0.2,0.3,0.4],"cf":"h"}]}'
)

_CF_EXPAND = {'h': 'high', 'm': 'medium', 'l': 'low', 'n': 'none'}


def identify_pieces(image_b64: str) -> list[dict]:
    if not ANTHROPIC_KEY:
        raise RuntimeError('ANTHROPIC_API_KEY is not set in environment')

    resp = httpx.post(
        'https://api.anthropic.com/v1/messages',
        headers={
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        json={
            'model': 'claude-haiku-4-5-20251001',
            'max_tokens': 1000,
            'messages': [{
                'role': 'user',
                'content': [
                    {'type': 'image',
                     'source': {'type': 'base64',
                                'media_type': 'image/jpeg',
                                'data': image_b64}},
                    {'type': 'text', 'text': _PROMPT},
                ],
            }],
        },
        timeout=50.0,
    )

    if resp.status_code != 200:
        raise RuntimeError(f'Anthropic API error {resp.status_code}: {resp.text[:400]}')

    text = resp.json()['content'][0]['text'].strip()
    text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*```$',       '', text, flags=re.MULTILINE)

    raw = json.loads(text).get('pieces', [])

    pieces = []
    for rp in raw:
        bbox = rp.get('b', [])
        bbox = ([max(0.0, min(1.0, float(v))) for v in bbox]
                if isinstance(bbox, list) and len(bbox) == 4
                else [0.0, 0.0, 1.0, 1.0])
        pieces.append({
            'part_num':   rp.get('p'),
            'color':      rp.get('c'),
            'confidence': _CF_EXPAND.get(rp.get('cf', 'n'), 'none'),
            'bbox_pct':   bbox,
        })
    return pieces


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length = int(self.headers.get('content-length', 0))
            body   = json.loads(self.rfile.read(length))
            image_b64 = body.get('image_b64')
            if not image_b64:
                self._json(400, {'error': 'image_b64 is required'})
                return
            self._json(200, {'pieces': identify_pieces(image_b64)})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.end_headers()

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code); self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, *_):
        pass
