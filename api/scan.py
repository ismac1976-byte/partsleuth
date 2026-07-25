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

POST  { crops: [b64, ...] }      (preferred: one close-up crop per piece,
                                  detected on-device — exact boxes stay client-side)
→     { pieces: [ { i, part_num, color, confidence } ] }        (i is 1-based)

POST  { image_b64 }              (fallback: whole image, Claude estimates boxes)
→     { pieces: [ { part_num, color, confidence, bbox_pct } ] }
"""

import os, json, re
from http.server import BaseHTTPRequestHandler

import httpx

ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

_PART_VOCAB = (
    'p = BrickLink# (e.g. "3001"=Brick2x4 "3010"=Brick1x4 "3004"=Brick1x2 '
    '"3003"=Brick2x2 "3005"=Brick1x1 "3020"=Plate2x4 "3023"=Plate1x2 '
    '"3022"=Plate2x2 "3024"=Plate1x1 "3068b"=Tile2x2 "3069b"=Tile1x2 '
    '"3040b"=Slope45-2x1 "11477"=SlopeCurved2x1 "3062b"=RoundBrick1x1 '
    '"6141"=RoundPlate1x1 "98138"=RoundTile1x1) or null\n'
    'c = LEGO colour (Red "Dark Red" Blue "Dark Blue" Yellow Black White '
    '"Light Bluish Gray" "Dark Bluish Gray" Tan "Dark Tan" Green "Dark Green" '
    'Orange "Dark Orange" "Bright Light Orange" "Medium Azure" "Reddish Brown" '
    '"Dark Brown" Lime "Dark Purple" "Pearl Gold" "Medium Nougat" '
    '"Trans-Clear" "Trans-Light Blue") or null\n'
    'cf = h(high) m(medium) l(low) n(unidentifiable)\n'
)

# Whole-image fallback prompt (Claude estimates boxes — approximate)
_PROMPT_FULL = (
    'LEGO expert. List every piece visible — include unidentifiable ones.\n'
    'Each entry: {"p":"part#","c":"color","b":[x1,y1,x2,y2],"cf":"X"}\n'
    + _PART_VOCAB +
    'b = [x1,y1,x2,y2] 0-1 image fractions, TIGHT around the piece\n'
    'Rules: separate touching pieces; no duplicates.\n'
    'Return ONLY valid JSON:\n'
    '{"pieces":[{"p":"3001","c":"Red","b":[0.1,0.2,0.3,0.4],"cf":"h"}]}'
)

# Per-crop prompt (preferred: identification only, no localisation).
# When the client supplies the set's own parts catalog, identification becomes
# multiple-choice against the real inventory — far more accurate than
# open-vocabulary guessing, and part#/colour match the checklist exactly.
def _prompt_crops(catalog: list[str] | None) -> str:
    if catalog:
        cat = '\n'.join(catalog[:120])
        return (
            'LEGO expert. Each numbered image is a close-up of ONE LEGO piece '
            'on white paper.\n'
            'CANDIDATES — the parts expected in this set (part# | name | colour):\n'
            f'{cat}\n\n'
            'For each image: 1) decide the colour you actually see, 2) COUNT THE '
            'STUDS and estimate the size (1x1, 1x2, 2x2, 1x4...), 3) pick the '
            'candidate whose colour AND shape AND size all match, copying its '
            'part# and colour EXACTLY as written above. Never pick a candidate '
            'whose colour or size differs from what you see. Look for: brackets '
            '(L-shaped side plates), slopes, curved tops, side holes, clips. '
            'If no candidate matches, give your own BrickLink part# and colour, '
            'cf "l". If unclear or multiple pieces, identify the central piece.\n'
            'Entry: {"i":<image number>,"p":"part#","c":"colour","cf":"X"}\n'
            'cf = h(high) m(medium) l(low) n(unidentifiable)\n'
            'Include EVERY image number exactly once, in order.\n'
            'Return ONLY valid JSON:\n'
            '{"pieces":[{"i":1,"p":"3005","c":"Dark Red","cf":"h"}]}'
        )
    return (
        'LEGO expert. Each numbered image is a close-up of ONE LEGO piece. '
        'Identify the piece in every image.\n'
        'Each entry: {"i":<image number>,"p":"part#","c":"color","cf":"X"}\n'
        + _PART_VOCAB +
        'HONESTY RULE: only give a part# you are CERTAIN of. If unsure of the '
        'exact number, set "p":null but still give the colour and cf. A null '
        'is far more useful than a plausible-looking wrong number.\n'
        'Include EVERY image number exactly once, in order.\n'
        'Return ONLY valid JSON:\n'
        '{"pieces":[{"i":1,"p":"3001","c":"Red","cf":"h"}]}'
    )

_CF_EXPAND = {'h': 'high', 'm': 'medium', 'l': 'low', 'n': 'none'}


def _call_claude(content: list, max_tokens: int) -> list[dict]:
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
            'max_tokens': max_tokens,
            'temperature': 0,        # deterministic IDs — same photo, same answer
            'messages': [{'role': 'user', 'content': content}],
        },
        timeout=50.0,
    )

    if resp.status_code != 200:
        raise RuntimeError(f'Anthropic API error {resp.status_code}: {resp.text[:400]}')

    text = resp.json()['content'][0]['text'].strip()
    text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'\s*```$',       '', text, flags=re.MULTILINE)
    return json.loads(text).get('pieces', [])


def _img(b64: str) -> dict:
    return {'type': 'image',
            'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': b64}}


def identify_crops(crops: list[str], catalog: list[str] | None = None) -> list[dict]:
    """Preferred path: one close-up crop per piece. No localisation asked."""
    content: list = []
    for idx, crop in enumerate(crops, start=1):
        content.append({'type': 'text', 'text': f'Image {idx}:'})
        content.append(_img(crop))
    content.append({'type': 'text', 'text': _prompt_crops(catalog)})

    raw = _call_claude(content, max_tokens=60 + 30 * len(crops))

    pieces = []
    for rp in raw:
        try:
            i = int(rp.get('i', 0))
        except (TypeError, ValueError):
            continue
        if not (1 <= i <= len(crops)):
            continue
        pieces.append({
            'i':          i,
            'part_num':   rp.get('p'),
            'color':      rp.get('c'),
            'confidence': _CF_EXPAND.get(rp.get('cf', 'n'), 'none'),
        })
    return pieces


def identify_full(image_b64: str) -> list[dict]:
    """Fallback path: whole image, Claude estimates boxes (approximate)."""
    raw = _call_claude([_img(image_b64), {'type': 'text', 'text': _PROMPT_FULL}],
                       max_tokens=1000)
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
            crops  = body.get('crops')
            if isinstance(crops, list) and crops:
                catalog = body.get('catalog')
                if not (isinstance(catalog, list) and all(isinstance(x, str) for x in catalog)):
                    catalog = None
                self._json(200, {'pieces': identify_crops(crops[:40], catalog)})
                return
            image_b64 = body.get('image_b64')
            if not image_b64:
                self._json(400, {'error': 'crops or image_b64 is required'})
                return
            self._json(200, {'pieces': identify_full(image_b64)})
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
