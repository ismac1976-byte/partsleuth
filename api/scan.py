"""
PartSleuth — /api/scan  (v3: token-optimised Claude Vision)

Design: maximum accuracy, minimum token usage, fastest response.

vs v2:
  - Prompt:     ~600 input tokens  →  ~130  (compact field names)
  - Response:   ~40 tok/piece      →  ~15   (single-char keys p/c/b/cf)
  - max_tokens: 2048               →  1000  (enough for 50 pieces; faster)
  - Image:      1200px, q85        →  800px, q75  (56% fewer pixels → fewer vision tokens)
  - JPEG out:   q85                →  q80
  - name field: Claude-generated   →  local dict lookup (no extra API call)
  - Cache:      none               →  in-process SHA-1 keyed dict (free on warm lambda)

POST  image_b64, checklist[]
→     annotated_image_b64, detections[], summary{}
"""

import os, json, base64, re, hashlib
from http.server import BaseHTTPRequestHandler

import httpx, numpy as np, cv2

ANTHROPIC_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')
REBRICKABLE_KEY = os.environ.get('REBRICKABLE_API_KEY', '')

# ── Status colours (BGR) ─────────────────────────────────────────────────────
_STATUS_BGR = {
    'needed':      ( 94, 197,  34),
    'have_enough': (  8, 179, 234),
    'wrong_color': (  0, 127, 255),
    'not_in_set':  (175, 163, 156),
    'unknown':     (  0,   0, 220),
}
ALL_STATUSES = ('needed', 'have_enough', 'wrong_color', 'not_in_set', 'unknown')

# ── Local part-name lookup — avoids Rebrickable round-trip in hot path ───────
_PART_NAMES: dict[str, str] = {
    '3001':'Brick 2x4',    '3002':'Brick 2x3',    '3003':'Brick 2x2',
    '3004':'Brick 1x2',    '3005':'Brick 1x1',    '3009':'Brick 1x6',
    '3010':'Brick 1x4',    '3007':'Brick 2x8',    '3008':'Brick 1x8',
    '2456':'Brick 2x6',    '3006':'Brick 2x10',
    '3020':'Plate 2x4',    '3021':'Plate 2x3',    '3022':'Plate 2x2',
    '3023':'Plate 1x2',    '3024':'Plate 1x1',    '3034':'Plate 2x8',
    '3460':'Plate 1x8',    '3710':'Plate 1x4',    '3832':'Plate 2x10',
    '3958':'Plate 6x6',    '2420':'Plate Corner 2x2',
    '3068b':'Tile 2x2',    '3069b':'Tile 1x2',    '3070b':'Tile 1x1',
    '6636':'Tile 1x6',     '4162':'Tile 1x8',     '2412b':'Tile 1x2 Grooved',
    '4150':'Tile 2x2 Round','98138':'Tile 1x1 Round',
    '3040b':'Slope 45 2x1','3039':'Slope 45 2x2', '3665':'Slope Inv 45 2x1',
    '3660':'Slope Inv 45 2x2',
    '11477':'Slope Curved 2x1','61678':'Slope Curved 4x1',
    '3062b':'Brick 1x1 Round','3941':'Brick 2x2 Round',
    '32523':'Technic Beam 3','32316':'Technic Beam 5','32524':'Technic Beam 7',
    '40490':'Technic Beam 9','32525':'Technic Beam 11','32278':'Technic Beam 15',
    '3176':'Plate 3x2 w/Bow','32028':'Plate 1x2 w/Handle',
    '30363':'Shield 2x3',  '41855':'Bar 4x2 Curved',
}

# ── Compact ↔ full key maps ──────────────────────────────────────────────────
_CF_EXPAND = {'h': 'high', 'm': 'medium', 'l': 'low', 'n': 'none'}
_CF_BADGE  = {'high': '', 'medium': '~', 'low': '?', 'none': '??'}

# ── Colour normalisation ─────────────────────────────────────────────────────
_COLOUR_ALIASES: dict[str, str] = {
    'light gray':'light bluish gray',   'light grey':'light bluish gray',
    'light bluish grey':'light bluish gray',
    'dark gray':'dark bluish gray',     'dark grey':'dark bluish gray',
    'dark bluish grey':'dark bluish gray',
    'gray':'light bluish gray',         'grey':'light bluish gray',
    'azure':'medium azure',             'medium blue':'blue',
    'bright blue':'blue',               'bright red':'red',
    'bright yellow':'yellow',           'bright green':'green',
    'transparent':'trans-clear',        'clear':'trans-clear',
    'brown':'reddish brown',            'dark brown':'reddish brown',
    'lime green':'lime',                'light green':'lime',
}
def _nc(c: str | None) -> str:
    if not c: return ''
    return _COLOUR_ALIASES.get(c.lower().strip(), c.lower().strip())


# ── Image compression ─────────────────────────────────────────────────────────

def compress_image(image_bytes: bytes, max_dim: int = 800, quality: int = 75
                   ) -> tuple[bytes, np.ndarray]:
    """
    800px / q75: ~56% fewer pixels than 1200px → fewer vision tokens + faster upload.
    Adequate resolution for LEGO part identification.
    """
    arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('Cannot decode image — must be JPEG or PNG')
    h, w = img.shape[:2]
    scale = min(1.0, max_dim / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)),
                         interpolation=cv2.INTER_AREA)
    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes(), img


# ── Claude Vision — compact prompt ───────────────────────────────────────────

# ~130 input tokens (was ~600).  Compact single-char keys cut output ~60%.
_PROMPT = (
    'LEGO expert. List every piece visible — include unidentifiable ones.\n'
    'Each entry: {"p":"part#","c":"color","b":[x1,y1,x2,y2],"cf":"X"}\n'
    'p = BrickLink# (e.g. "3001"=Brick2x4 "3010"=Brick1x4 "3004"=Brick1x2 '
    '"3003"=Brick2x2 "3005"=Brick1x1 "3020"=Plate2x4 "3023"=Plate1x2 '
    '"3022"=Plate2x2 "3024"=Plate1x1 "3068b"=Tile2x2 "3069b"=Tile1x2) or null\n'
    'c = LEGO colour (Red Blue Yellow Black White "Light Bluish Gray" '
    '"Dark Bluish Gray" Tan Green "Dark Green" Orange "Medium Azure" '
    '"Reddish Brown" Lime "Trans-Clear") or null\n'
    'b = [x1,y1,x2,y2] 0-1 image fractions\n'
    'cf = h(high) m(medium) l(low) n(unidentifiable)\n'
    'Rules: separate touching pieces; no duplicates.\n'
    'Return ONLY valid JSON:\n'
    '{"pieces":[{"p":"3001","c":"Red","b":[0.1,0.2,0.3,0.4],"cf":"h"}]}'
)

# In-process result cache — avoids re-calling Claude for the same image bytes
# (warm Vercel lambda reuse; especially useful during testing)
_CACHE: dict[str, list] = {}


def identify_pieces_claude(image_b64: str) -> list[dict]:
    """
    Single compact Claude Vision call identifies all pieces.
    max_tokens=1000 handles 50+ pieces and signals faster than 2048.
    """
    if not ANTHROPIC_KEY:
        return []

    cache_key = hashlib.sha1(image_b64.encode()).hexdigest()
    if cache_key in _CACHE:
        return _CACHE[cache_key]

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
                'max_tokens': 1000,
                'messages': [{
                    'role': 'user',
                    'content': [
                        {
                            'type': 'image',
                            'source': {
                                'type': 'base64',
                                'media_type': 'image/jpeg',
                                'data': image_b64,
                            },
                        },
                        {'type': 'text', 'text': _PROMPT},
                    ],
                }],
            },
            timeout=25.0,
        )
        text = resp.json()['content'][0]['text'].strip()
        # Strip markdown code fences if model adds them despite instructions
        text = re.sub(r'^```[a-z]*\s*', '', text, flags=re.MULTILINE)
        text = re.sub(r'\s*```$',       '', text, flags=re.MULTILINE)

        raw = json.loads(text).get('pieces', [])

        # Expand compact keys → full schema; add local name lookup
        pieces = []
        for rp in raw:
            bbox = rp.get('b', [])
            bbox = ([max(0.0, min(1.0, float(v))) for v in bbox]
                    if len(bbox) == 4 else [0.0, 0.0, 1.0, 1.0])
            pn   = rp.get('p')
            cf   = _CF_EXPAND.get(rp.get('cf', 'n'), 'none')
            pieces.append({
                'part_num':   pn,
                'color':      rp.get('c'),
                'name':       _PART_NAMES.get(pn) if pn else None,
                'confidence': cf,
                'bbox_pct':   bbox,
            })

        _CACHE[cache_key] = pieces
        return pieces

    except Exception:
        return []


# ── Checklist matching ────────────────────────────────────────────────────────

def build_lookup(checklist: list[dict]) -> dict:
    by_pc: dict[tuple, list] = {}
    by_p:  dict[str, list]   = {}
    for item in checklist:
        ids: list[str] = list(item.get('bricklink_ids') or [])
        if item.get('part_num'):
            ids.append(str(item['part_num']))
        ck = _nc(item.get('color_name'))
        for pid in ids:
            if pid:
                by_pc.setdefault((pid, ck), []).append(item)
                by_p.setdefault(pid, []).append(item)
    return {'by_pc': by_pc, 'by_p': by_p}


def match_piece(piece: dict, lookup: dict, scan_counts: dict) -> tuple[str, list]:
    pn = piece.get('part_num')
    if not pn:
        return 'unknown', []
    ck    = _nc(piece.get('color'))
    by_pc = lookup['by_pc']
    by_p  = lookup['by_p']

    rows = by_pc.get((pn, ck), [])
    if rows:
        needed = [r for r in rows
                  if (scan_counts.get(r['line_id'], 0) + r.get('quantity_found', 0))
                     < r.get('quantity_needed', 0)]
        if needed:
            lid = needed[0]['line_id']
            scan_counts[lid] = scan_counts.get(lid, 0) + 1
            return 'needed', needed
        return 'have_enough', rows

    part_rows = by_p.get(pn, [])
    if part_rows:
        return 'wrong_color', part_rows

    return 'not_in_set', []


# ── Annotation ────────────────────────────────────────────────────────────────

_FONT = cv2.FONT_HERSHEY_SIMPLEX

def annotate(img: np.ndarray, detections: list[dict]) -> str:
    h, w = img.shape[:2]
    out  = img.copy()
    for det in detections:
        bbox = det.get('bbox_pct', [])
        if len(bbox) != 4:
            continue
        x1 = max(0, int(bbox[0]*w));  y1 = max(0, int(bbox[1]*h))
        x2 = min(w, int(bbox[2]*w));  y2 = min(h, int(bbox[3]*h))
        if x2 <= x1 or y2 <= y1:
            continue
        status = det.get('status', 'unknown')
        col    = _STATUS_BGR.get(status, (128, 128, 128))
        bord   = 4 if status in ('needed', 'unknown') else 3
        cv2.rectangle(out, (x1, y1), (x2, y2), col, bord)

        badge = _CF_BADGE.get(det.get('confidence', 'none'), '??')
        label = f'{badge}{det.get("part_num") or "?"}'
        (tw, th), bl = cv2.getTextSize(label, _FONT, 0.44, 1)
        pad = 3
        ly  = max(y1, th + bl + pad * 2)
        cv2.rectangle(out, (x1, ly-th-bl-pad*2), (x1+tw+pad*2, ly), col, -1)
        cv2.putText(out, label, (x1+pad, ly-bl-pad),
                    _FONT, 0.44, (255,255,255), 1, cv2.LINE_AA)

    _, buf = cv2.imencode('.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return base64.b64encode(buf.tobytes()).decode()


# ── Handler ───────────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length    = int(self.headers.get('content-length', 0))
            body      = json.loads(self.rfile.read(length))
            img_bytes = base64.b64decode(body['image_b64'])
            checklist = body.get('checklist', [])

            comp_bytes, img_arr = compress_image(img_bytes)
            comp_b64 = base64.b64encode(comp_bytes).decode()

            pieces = identify_pieces_claude(comp_b64)

            lookup      = build_lookup(checklist)
            scan_counts: dict = {}
            counts      = {s: 0 for s in ALL_STATUSES}
            detections  = []

            for piece in pieces:
                status, matches = match_piece(piece, lookup, scan_counts)
                counts[status] += 1
                detections.append({
                    **piece,
                    'status': status,
                    'checklist_matches': [
                        {'line_id':         m['line_id'],
                         'color_name':      m.get('color_name',''),
                         'quantity_needed': m.get('quantity_needed',0),
                         'quantity_found':  m.get('quantity_found',0)}
                        for m in matches
                    ],
                })

            self._json(200, {
                'annotated_image_b64': annotate(img_arr, detections),
                'detections':          detections,
                'summary': {'total_detected': len(detections), **counts},
            })

        except Exception as e:
            self._error(500, str(e))

    def do_OPTIONS(self):
        self.send_response(200); self._cors(); self.end_headers()

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code); self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def _error(self, code: int, msg: str):
        self._json(code, {'error': msg})

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def log_message(self, *_):
        pass
