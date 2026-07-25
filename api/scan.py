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

import os, json, re, base64
import concurrent.futures
from http.server import BaseHTTPRequestHandler

import httpx

ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')

# ── Brickognize: specialised brick recogniser for exact part numbers ─────────
# Free public API, ~0.2-1s per image. Runs in PARALLEL with the Claude call,
# so it adds no latency. Claude still provides colour (Brickognize doesn't)
# and remains the fallback when Brickognize is unsure.

def _brickognize(crop_b64: str) -> list[tuple[str, float]]:
    """Returns ranked [(part_id, score), ...] — empty list on any failure."""
    try:
        r = httpx.post(
            'https://api.brickognize.com/predict/',
            files={'query_image': ('crop.jpg', base64.b64decode(crop_b64), 'image/jpeg')},
            timeout=15.0,
        )
        if r.status_code != 200:
            return []
        return [(str(it.get('id')), float(it.get('score', 0)))
                for it in r.json().get('items', [])
                if it.get('type') == 'part' and it.get('id')]
    except Exception:
        return []


def _strip_variant(p: str) -> str:
    return re.sub(r'[a-z]+[0-9]*$', '', p, flags=re.I)


def _catalog_part_ids(catalog: list[str] | None) -> set[str]:
    ids: set[str] = set()
    for line in catalog or []:
        pid = line.split('|')[0].strip()
        if pid:
            ids.add(pid)
            ids.add(_strip_variant(pid))
    return ids

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
def _group_catalog(catalog: list[str]) -> str:
    """Group 'part | name | colour' lines under colour headers, so the
    colour-shortlist step in the procedure becomes mechanical."""
    groups: dict[str, list[str]] = {}
    for line in catalog:
        bits = [b.strip() for b in line.split('|')]
        if len(bits) == 3:
            groups.setdefault(bits[2], []).append(f'  {bits[0]} — {bits[1]}')
        else:
            groups.setdefault('Other', []).append(f'  {line}')
    out = []
    for colour in sorted(groups):
        out.append(f'{colour}:')
        out.extend(groups[colour])
    return '\n'.join(out)


def _prompt_crops(catalog: list[str] | None) -> str:
    if catalog:
        cat = _group_catalog(catalog[:120])
        return (
            'LEGO expert. Each numbered image is a close-up of ONE LEGO piece '
            'on a white background.\n'
            'CANDIDATES — the complete inventory of this set, grouped by colour:\n'
            f'{cat}\n\n'
            'Colour tips: judge colour from the piece\'s LIT TOP surface, not '
            'shadows. A piece that almost vanishes into the white background '
            'is White. Medium Azure is bright sky-blue; Blue is strong primary '
            'blue. Dark Bluish Gray is grey, not blue.\n'
            'For each image follow this procedure:\n'
            '1) Decide the colour you actually see.\n'
            '2) Shortlist ONLY the candidates in that colour.\n'
            '3) From that shortlist pick the closest shape+size — count studs, '
            'look for slopes, curved tops, brackets (L-profile), side holes, '
            'clips, bars. Copy its part# and colour EXACTLY as written.\n'
            '4) Only if NOTHING in that colour is plausible, give your own '
            'BrickLink part# and colour with cf "l".\n'
            'If unclear or multiple pieces, identify the central piece.\n'
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
    """Preferred path: one close-up crop per piece. No localisation asked.

    Two recognisers run IN PARALLEL:
      - Brickognize (specialised) → exact part numbers
      - Claude Vision            → colour + fallback part numbers
    Total latency = the slower of the two ≈ the Claude call alone.

    The instruction prompt goes BEFORE the image stream: with many images,
    a trailing prompt causes image-index drift (answers shifted by one).
    """
    # Kick off all Brickognize lookups in the background first
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=12)
    bk_futures = [pool.submit(_brickognize, c) for c in crops]

    content: list = [{'type': 'text', 'text': _prompt_crops(catalog)}]
    for idx, crop in enumerate(crops, start=1):
        content.append({'type': 'text', 'text': f'Image {idx}:'})
        content.append(_img(crop))
    content.append({'type': 'text', 'text':
        f'That was all {len(crops)} images. Return the JSON now — one entry '
        f'per image, i from 1 to {len(crops)}. Remember the procedure: colour '
        f'seen → shortlist that colour → closest shape from the shortlist. '
        f'Prefer a same-colour candidate with an imperfect shape over a '
        f'different-colour candidate with a perfect shape.'})

    raw = _call_claude(content, max_tokens=60 + 30 * len(crops))

    claude_by_i: dict[int, dict] = {}
    for rp in raw:
        try:
            i = int(rp.get('i', 0))
        except (TypeError, ValueError):
            continue
        if 1 <= i <= len(crops):
            claude_by_i[i] = rp

    cat_ids = _catalog_part_ids(catalog)

    pieces = []
    for i in range(1, len(crops) + 1):
        cl = claude_by_i.get(i, {})
        part  = cl.get('p')
        color = cl.get('c')
        cf    = _CF_EXPAND.get(cl.get('cf', 'n'), 'none')
        source = 'claude'

        try:
            bk = bk_futures[i - 1].result(timeout=20)
        except Exception:
            bk = []

        if bk:
            top = bk[0]
            bk_cat = next((b for b in bk
                           if b[0] in cat_ids or _strip_variant(b[0]) in cat_ids), None)
            if top[1] >= 0.6:
                # Strong visual match — trust it even if it's not in the set
                # (keeps "not in set" honest)
                part, cf, source = top[0], 'high', 'brickognize'
            elif bk_cat and bk_cat[1] >= 0.2:
                # Decent match that's also in the set's inventory
                part, source = bk_cat[0], 'brickognize'
                cf = 'high' if bk_cat[1] >= 0.4 else 'medium'

        pieces.append({
            'i':          i,
            'part_num':   part,
            'color':      color,
            'confidence': cf,
            'source':     source,
        })

    pool.shutdown(wait=False)
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
            # Single-brick live mode: Brickognize only, no Claude → ~0.5s.
            # Colour is resolved on-device from pixels vs checklist RGB.
            single = body.get('crop')
            if isinstance(single, str) and single:
                items = _brickognize(single)
                self._json(200, {'candidates': [
                    {'part_num': pid, 'score': round(score, 3)}
                    for pid, score in items[:6]
                ]})
                return

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
