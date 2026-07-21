"""
PartSleuth — /api/rebrickable
Server-side proxy for the Rebrickable API.
Keeps the API key off the client.

Supported routes (via ?action= query param):

  GET ?action=set&set_num=60197-1
      Returns set metadata (name, year, totalParts, imageUrl)

  GET ?action=parts&set_num=60197-1&page=1&page_size=500
      Returns paginated parts list for a set, formatted for Firestore checklist.
      Each item includes bricklink_ids so the scan API can match against it.

  GET ?action=search&q=passenger+train
      Searches for sets by name.
"""

import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import httpx

REBRICKABLE_KEY = os.environ.get("REBRICKABLE_API_KEY", "")
BASE = "https://rebrickable.com/api/v3/lego"
HEADERS = {"Authorization": f"key {REBRICKABLE_KEY}"}


def rb_get(path: str, params: dict = {}) -> dict:
    url = f"{BASE}{path}"
    resp = httpx.get(url, headers=HEADERS, params=params, timeout=15.0)
    resp.raise_for_status()
    return resp.json()


def format_part(item: dict) -> dict:
    """Normalise a Rebrickable parts-list item for our checklist schema."""
    part = item["part"]
    color = item["color"]
    bl_ids = part.get("external_ids", {}).get("BrickLink", [])
    return {
        "line_id": f"{part['part_num']}_{color['id']}",
        "part_num": part["part_num"],
        "part_name": part["name"],
        "part_img_url": part.get("part_img_url", ""),
        "bricklink_ids": bl_ids,
        "color_id": color["id"],
        "color_name": color["name"],
        "color_rgb": color.get("rgb", ""),
        "quantity_needed": item["quantity"],
        "quantity_found": 0,
        "is_spare": item.get("is_spare", False),
        "element_id": item.get("element_id", ""),
    }


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        action = qs.get("action", [""])[0]

        try:
            if action == "set":
                set_num = qs["set_num"][0]
                data = rb_get(f"/sets/{set_num}/")
                self._json(200, {
                    "set_num": data["set_num"],
                    "name": data["name"],
                    "year": data.get("year", 0),
                    "total_parts": data.get("num_parts", 0),
                    "image_url": data.get("set_img_url", ""),
                    "theme_id": data.get("theme_id", 0),
                })

            elif action == "parts":
                set_num = qs["set_num"][0]
                page = int(qs.get("page", ["1"])[0])
                page_size = int(qs.get("page_size", ["500"])[0])
                data = rb_get(f"/sets/{set_num}/parts/",
                              {"page": page, "page_size": page_size})
                self._json(200, {
                    "count": data["count"],
                    "next": data.get("next"),
                    "results": [format_part(r) for r in data["results"]],
                })

            elif action == "search":
                q = qs.get("q", [""])[0]
                data = rb_get("/sets/", {"search": q, "page_size": 10,
                                         "ordering": "-year"})
                self._json(200, {
                    "results": [
                        {
                            "set_num": s["set_num"],
                            "name": s["name"],
                            "year": s.get("year", 0),
                            "total_parts": s.get("num_parts", 0),
                            "image_url": s.get("set_img_url", ""),
                        }
                        for s in data.get("results", [])
                    ]
                })

            else:
                self._json(400, {"error": f"Unknown action: {action}"})

        except httpx.HTTPStatusError as e:
            self._json(e.response.status_code, {"error": str(e)})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass
