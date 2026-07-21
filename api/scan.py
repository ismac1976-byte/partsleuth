"""
PartSleuth — /api/scan
Accepts a base64-encoded photo of bricks spread on a table.
1. OpenCV detects individual brick regions (bounding boxes).
2. Each crop is sent to Brickognize in parallel for part identification.
3. Results are matched against the caller-supplied checklist.
4. Returns annotated image (base64) + structured detection data.

POST body (JSON):
{
  "image_b64": "<base64 jpeg/png>",
  "checklist": [
    {
      "line_id": "3010_0",
      "part_num": "3010",
      "bricklink_ids": ["3010"],
      "color_id": 0,
      "color_name": "Black",
      "quantity_needed": 4,
      "quantity_found": 0
    }, ...
  ]
}

Response (JSON):
{
  "annotated_image_b64": "<base64 jpeg>",
  "detections": [
    {
      "box": [x1, y1, x2, y2],
      "status": "needed" | "have_enough" | "not_in_set" | "unknown",
      "top_candidate": { "id": "3010", "name": "Brick 1x4", "score": 0.82 },
      "candidates": [...top 3...],
      "checklist_matches": [...]
    }, ...
  ],
  "summary": {
    "total_detected": 12,
    "needed": 8,
    "have_enough": 2,
    "not_in_set": 2
  }
}
"""

import json
import base64
import os
import concurrent.futures
from http.server import BaseHTTPRequestHandler

import numpy as np
import cv2
import httpx

BRICKOGNIZE_URL = "https://api.brickognize.com/predict/"


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def detect_bricks(img: np.ndarray) -> list[tuple[int, int, int, int]]:
    """
    Return bounding boxes (x1, y1, x2, y2) for each brick found in img.
    Works best on a plain, contrasting surface (white cloth / light table).
    """
    h, w = img.shape[:2]

    # Convert to LAB; use L channel for lighting-robust edge detection
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l_chan = lab[:, :, 0]

    # Blur → Canny edges
    blurred = cv2.GaussianBlur(l_chan, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 100)

    # Dilate to close small gaps between brick edges
    kernel = np.ones((7, 7), np.uint8)
    dilated = cv2.dilate(edges, kernel, iterations=3)

    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area = (w * h) * 0.002   # 0.2% of image — filters out dust/noise
    max_area = (w * h) * 0.25    # 25% — filters out the whole table surface

    boxes = []
    for c in contours:
        area = cv2.contourArea(c)
        if min_area < area < max_area:
            x, y, bw, bh = cv2.boundingRect(c)
            pad = 12
            x1 = max(0, x - pad)
            y1 = max(0, y - pad)
            x2 = min(w, x + bw + pad)
            y2 = min(h, y + bh + pad)
            # Skip boxes that are obviously not brick-shaped (too thin/wide)
            aspect = (x2 - x1) / max(1, (y2 - y1))
            if 0.2 < aspect < 8.0:
                boxes.append((x1, y1, x2, y2))

    return _nms(boxes, iou_threshold=0.3)


def _iou(a, b) -> float:
    x1 = max(a[0], b[0]); y1 = max(a[1], b[1])
    x2 = min(a[2], b[2]); y2 = min(a[3], b[3])
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def _nms(boxes, iou_threshold=0.3) -> list:
    """Non-maximum suppression: remove overlapping boxes, keep largest."""
    if not boxes:
        return []
    ranked = sorted(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
    kept = []
    while ranked:
        best = ranked.pop(0)
        kept.append(best)
        ranked = [b for b in ranked if _iou(best, b) < iou_threshold]
    return kept


# ---------------------------------------------------------------------------
# Brickognize
# ---------------------------------------------------------------------------

def _call_brickognize(crop_bytes: bytes) -> list[dict]:
    """Call Brickognize with a single cropped brick image. Returns top 3."""
    try:
        resp = httpx.post(
            BRICKOGNIZE_URL,
            files={"query_image": ("brick.jpg", crop_bytes, "image/jpeg")},
            timeout=15.0,
        )
        resp.raise_for_status()
        return resp.json().get("items", [])[:3]
    except Exception:
        return []


def identify_crops(crops: list[bytes]) -> list[list[dict]]:
    """Call Brickognize for every crop in parallel (max 10 concurrent)."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        futures = [ex.submit(_call_brickognize, c) for c in crops]
        return [f.result() for f in futures]


# ---------------------------------------------------------------------------
# Checklist matching
# ---------------------------------------------------------------------------

def build_lookup(checklist: list[dict]) -> dict[str, list[dict]]:
    """Index checklist rows by every BrickLink ID they carry."""
    lookup: dict[str, list[dict]] = {}
    for item in checklist:
        for bl_id in item.get("bricklink_ids", []):
            lookup.setdefault(bl_id, []).append(item)
    return lookup


def match_status(candidate_id: str | None, lookup: dict) -> tuple[str, list]:
    """Return (status, matching_checklist_rows)."""
    if not candidate_id or candidate_id not in lookup:
        return ("not_in_set" if candidate_id else "unknown"), []
    rows = lookup[candidate_id]
    still_needed = [r for r in rows if r["quantity_found"] < r["quantity_needed"]]
    status = "needed" if still_needed else "have_enough"
    return status, rows


# ---------------------------------------------------------------------------
# Annotation
# ---------------------------------------------------------------------------

STATUS_COLOURS = {
    "needed":      (34, 197, 94),    # green  (RGB)
    "have_enough": (234, 179, 8),    # yellow
    "not_in_set":  (156, 163, 175),  # grey
    "unknown":     (209, 213, 219),  # light grey
}

def annotate(img: np.ndarray, boxes, detections: list[dict]) -> np.ndarray:
    out = img.copy()
    for box, det in zip(boxes, detections):
        x1, y1, x2, y2 = box
        r, g, b = STATUS_COLOURS[det["status"]]
        colour_bgr = (b, g, r)
        cv2.rectangle(out, (x1, y1), (x2, y2), colour_bgr, 3)
        if det.get("top_candidate"):
            label = det["top_candidate"]["id"]
            cv2.putText(out, label, (x1 + 4, y1 - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, colour_bgr, 2,
                        cv2.LINE_AA)
    return out


# ---------------------------------------------------------------------------
# Vercel handler
# ---------------------------------------------------------------------------

class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length))

            image_bytes = base64.b64decode(body["image_b64"])
            checklist = body.get("checklist", [])

            # Decode image
            arr = np.frombuffer(image_bytes, np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                self._error(400, "Could not decode image")
                return

            # 1. Detect brick regions
            boxes = detect_bricks(img)

            # 2. Crop each region
            crops = []
            for (x1, y1, x2, y2) in boxes:
                crop = img[y1:y2, x1:x2]
                _, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
                crops.append(buf.tobytes())

            # 3. Identify each crop via Brickognize
            all_candidates = identify_crops(crops)

            # 4. Match against checklist
            lookup = build_lookup(checklist)
            detections = []
            counts = {"needed": 0, "have_enough": 0, "not_in_set": 0, "unknown": 0}

            for candidates in all_candidates:
                top = candidates[0] if candidates else None
                top_id = top["id"] if top else None
                status, matches = match_status(top_id, lookup)
                counts[status] += 1
                detections.append({
                    "status": status,
                    "top_candidate": {
                        "id": top["id"],
                        "name": top["name"],
                        "score": round(top["score"], 3),
                    } if top else None,
                    "candidates": [
                        {"id": c["id"], "name": c["name"], "score": round(c["score"], 3)}
                        for c in candidates
                    ],
                    "checklist_matches": [
                        {
                            "line_id": m["line_id"],
                            "color_name": m["color_name"],
                            "quantity_needed": m["quantity_needed"],
                            "quantity_found": m["quantity_found"],
                        }
                        for m in matches
                    ],
                })

            # 5. Annotate image
            annotated = annotate(img, boxes, detections)
            _, out_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
            annotated_b64 = base64.b64encode(out_buf.tobytes()).decode()

            # Add box coords to detections for client overlay
            for det, box in zip(detections, boxes):
                det["box"] = list(box)

            response = {
                "annotated_image_b64": annotated_b64,
                "detections": detections,
                "summary": {
                    "total_detected": len(boxes),
                    **counts,
                },
            }
            self._json(200, response)

        except Exception as e:
            self._error(500, str(e))

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code: int, msg: str):
        self._json(code, {"error": msg})

    def log_message(self, *_):
        pass  # silence Vercel logs
