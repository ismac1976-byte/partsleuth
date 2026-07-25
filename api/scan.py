"""
PartSleuth — /api/scan  (v2: Claude Vision)

Five expert refinements over v1 (OpenCV + Brickognize):

  R1 — Claude Vision replaces Brickognize
       One API call identifies every piece holistically: handles overlapping
       bricks, returns part_num + color + name + confidence + bbox for each piece.
       No per-crop API waterfall; no OpenCV pre-detection failure modes.

  R2 — Color-aware matching with 'wrong_color' status
       Checklist lookup is indexed by (part_num, normalized_color).
       Right shape / wrong color → 'wrong_color' (orange) rather than silently
       appearing as 'not_in_set'. Users know they have the right brick shape.

  R3 — Intra-scan quantity tracking
       scan_counts[line_id] tallies finds within this single scan so the
       5th red 2×4 found when only 4 are needed correctly shows 'have_enough'
       rather than 'needed'. Firestore quantity_found is unchanged here.

  R4 — Image compression before Claude
       Resize to max 1200 px on longest side before base64 encoding.
       Smaller payload → faster API round-trip; Claude still resolves all part
       detail at that resolution.

  R5 — Richer annotation + explicit unknown highlighting
       Colour-coded boxes: green=needed, yellow=have_enough, orange=wrong_color,
       grey=not_in_set, RED=unknown. Labels carry confidence badge (~ = medium,
       ? = low, ?? = none). Unknown pieces are always RED — users know exactly
       which bricks the app couldn't identify.

POST body:
  image_b64  : base64 JPEG/PNG
  checklist  : [{line_id, part_num, bricklink_ids, color_id, color_name,
                  quantity_needed, quantity_found}, ...]

Response:
  annotated_image_b64  : base64 JPEG with coloured boxes
  detections           : [{part_num, color, name, confidence, bbox_pct,
                            status, checklist_matches}, ...]
  summary              : {total_detected, needed, have_enough, wrong_color,
                           not_in_set, unknown}
"""

import os
import json
import base64
import re
from http.server import BaseHTTPRequestHandler

import httpx
import numpy as np
import cv2

ANTHROPIC_KEY   = os.environ.get('ANTHROPIC_API_KEY', '')
REBRICKABLE_KEY = os.environ.get('REBRICKABLE_API_KEY', '')

# BGR colours for OpenCV annotation (OpenCV uses BGR not RGB)
_STATUS_BGR = {
    'needed':      ( 94, 197,  34),   # green
    'have_enough': (  8, 179, 234),   # yellow
    'wrong_color': (  0, 127, 255),   # orange
    'not_in_set':  (175, 163, 156),   # grey
    'unknown':     (  0,   0, 220),   # red
}

ALL_STATUSES = ('needed', 'have_enough', 'wrong_color', 'not_in_set', 'unknown')


# ── R4: Image compression ────────────────────────────────────────────────────

def compress_image(image_bytes: bytes, max_dim: int = 1200, quality: int = 85
                   ) -> tuple[bytes, np.ndarray]:
    """
    Resize to max_dim on longest side using INTER_AREA (best for downscaling).
    Returns (compressed_bytes, decoded_ndarray_for_annotation).
    """
    arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('Could not decode image — must be JPEG or PNG')

    h, w = img.shape[:2]
    scale = min(1.0, max_dim / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (int(w * scale), int(h * scale)),
                         interpolation=cv2.INTER_AREA)

    _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes(), img


# ── R1: Claude Vision identification ────────────────────────────────────────

_VISION_PROMPT = """You are a LEGO parts identification expert with encyclopedic knowledge of BrickLink part numbers.

Examine this photo of LEGO pieces laid out on a surface.

For EVERY distinct piece you can see — even if you cannot identify it — return one entry.

Required fields per piece:
- part_num: BrickLink part number string. Common examples:
    "3001"=Brick 2x4, "3003"=Brick 2x2, "3004"=Brick 1x2, "3005"=Brick 1x1,
    "3010"=Brick 1x4, "3020"=Plate 2x4, "3021"=Plate 2x3, "3022"=Plate 2x2,
    "3023"=Plate 1x2, "3024"=Plate 1x1, "3034"=Plate 2x8, "3460"=Plate 1x8,
    "3068b"=Tile 2x2, "3069b"=Tile 2x2, "6636"=Tile 1x6, "4162"=Tile 1x8,
    "3176"=Plate with Bow 3x2, "3040b"=Slope 45 2x1.
    Use null if you genuinely cannot determine the part number.
- color: Standard LEGO color name. Use one of: Red, Blue, Yellow, Black, White,
    Light Bluish Gray, Dark Bluish Gray, Tan, Green, Dark Green, Orange,
    Medium Azure, Reddish Brown, Dark Tan, Sand Green, Trans-Clear, Trans-Red,
    Trans-Blue, Trans-Yellow, Lime, Pink, Purple, Magenta, Dark Orange.
    Use null if the color is ambiguous.
- name: Short human-readable name e.g. "Brick 2x4". null if unknown.
- confidence: "high" = very certain | "medium" = fairly sure | "low" = guessing | "none" = cannot identify at all
- bbox_pct: [x1, y1, x2, y2] — each a fraction 0.0–1.0 of the image's width/height.
    x1,y1 = top-left corner; x2,y2 = bottom-right corner.

Critical rules:
- Include EVERY piece, even unidentifiable ones (use confidence "none" + null fields + your best bbox_pct estimate).
- Distinguish dimensions carefully: 1×2 ≠ 1×4 ≠ 2×4.
- If two pieces are touching, list them as separate entries with separate bboxes.
- Do NOT include duplicate entries for the same physical piece.

Return ONLY valid JSON — i�] explanation, no markdown fences:
{"pieces": [{"part_num": "3001", "color": "Red", "name": "Brick 2x4", "confidence": "high", "bbox_pct": [0.05, 0.10, 0.30, 0.45]}, ...]}"""