"""
PartSleuth — /api/instructions

GET ?set=76396  → finds the official LEGO building-instructions PDF(s)
                  for the set on lego.com.
  - one PDF   → 302 redirect straight to it (opens in the browser viewer,
                downloadable from there)
  - several   → minimal HTML page listing each book
  - none      → redirect to the LEGO instructions search page
"""

import json, re
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

import httpx

_PDF_RE = re.compile(r'https://www\.lego\.com/cdn/product-assets/product\.bi\.core\.pdf/(\d+)\.pdf')
_UA = ('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
       'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile Safari/604.1')

_CACHE: dict[str, list[str]] = {}


def find_pdfs(set_num: str) -> list[str]:
    if set_num in _CACHE:
        return _CACHE[set_num]
    resp = httpx.get(
        f'https://www.lego.com/en-us/service/building-instructions/{set_num}',
        headers={'User-Agent': _UA},
        follow_redirects=True,
        timeout=15.0,
    )
    # Preserve order, drop duplicates
    seen: dict[str, None] = {}
    for m in _PDF_RE.finditer(resp.text):
        seen[m.group(0)] = None
    pdfs = list(seen)
    _CACHE[set_num] = pdfs
    return pdfs


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            qs = parse_qs(urlparse(self.path).query)
            set_num = (qs.get('set') or [''])[0].split('-')[0].strip()
            if not set_num.isdigit():
                self._json(400, {'error': 'set parameter required, e.g. ?set=76396'})
                return

            pdfs = find_pdfs(set_num)

            if len(pdfs) == 1:
                self._redirect(pdfs[0])
            elif pdfs:
                items = ''.join(
                    f'<a href="{u}" style="display:block;background:#E3000B;color:#fff;'
                    f'text-decoration:none;font-weight:700;padding:16px;border-radius:16px;'
                    f'margin:10px 0;text-align:center">📖 Instruction book {i+1}</a>'
                    for i, u in enumerate(pdfs))
                html = (f'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
                        f'<title>Instructions {set_num}</title>'
                        f'<body style="font-family:-apple-system,sans-serif;background:#F5F3EE;'
                        f'padding:24px;max-width:480px;margin:0 auto">'
                        f'<h2 style="color:#1A1A2E">Set {set_num} — {len(pdfs)} books</h2>{items}</body>')
                self._html(200, html)
            else:
                # Nothing found — fall back to LEGO's search page
                self._redirect(f'https://www.lego.com/en-us/service/building-instructions/{set_num}')

        except Exception as e:
            self._json(500, {'error': str(e)})

    def _redirect(self, url: str):
        self.send_response(302)
        self.send_header('Location', url)
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()

    def _html(self, code: int, html: str):
        body = html.encode()
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def log_message(self, *_):
        pass
