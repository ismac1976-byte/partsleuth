"""
PartSleuth — /api/instructions

GET ?set=76396&setNum=76396-1  → finds official LEGO building-instruction PDFs
                                  for the set on lego.com.
  - one PDF   → 302 redirect straight to it (opens in the browser viewer)
  - several   → minimal HTML page listing each book (with back link to app)
  - none      → redirect to LEGO's instructions search page
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
    seen: dict[str, None] = {}
    for m in _PDF_RE.finditer(resp.text):
        seen[m.group(0)] = None
    pdfs = list(seen)
    _CACHE[set_num] = pdfs
    return pdfs


class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        try:
            qs      = parse_qs(urlparse(self.path).query)
            set_num = (qs.get('set') or [''])[0].split('-')[0].strip()
            # Full set number (e.g. "76396-1") for the back link — fall back to numeric only
            set_full = (qs.get('setNum') or [''])[0].strip() or set_num

            if not set_num.isdigit():
                self._json(400, {'error': 'set parameter required, e.g. ?set=76396'})
                return

            pdfs = find_pdfs(set_num)

            if len(pdfs) == 1:
                self._redirect(pdfs[0])
            elif pdfs:
                back_url = f'/sets/{set_full}'
                back_btn = (
                    f'<a href="{back_url}" style="display:inline-flex;align-items:center;gap:6px;'
                    f'color:#1A1A2E;font-weight:600;font-size:15px;text-decoration:none;'
                    f'background:rgba(0,0,0,0.06);padding:10px 16px;border-radius:99px;'
                    f'margin-bottom:20px">&#8592; Back to set</a>'
                )
                items = ''.join(
                    f'<a href="{u}" style="display:block;background:#E3000B;color:#fff;'
                    f'text-decoration:none;font-weight:700;padding:16px;border-radius:16px;'
                    f'margin:10px 0;text-align:center">📖 Instruction book {i+1}</a>'
                    for i, u in enumerate(pdfs))
                html = (
                    f'<!doctype html>'
                    f'<meta name="viewport" content="width=device-width,initial-scale=1">'
                    f'<title>Instructions — Set {set_num}</title>'
                    f'<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;'
                    f'background:#F5F3EE;padding:24px;max-width:480px;margin:0 auto">'
                    f'{back_btn}'
                    f'<h2 style="color:#1A1A2E;margin:0 0 4px">Set {set_num}</h2>'
                    f'<p style="color:#888;font-size:14px;margin:0 0 16px">'
                    f'{len(pdfs)} instruction book{"s" if len(pdfs) != 1 else ""}</p>'
                    f'{items}</body>'
                )
                self._html(200, html)
            else:
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
