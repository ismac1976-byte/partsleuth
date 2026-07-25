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

# Use a longer timeout to handle cold-start DNS+TLS latency
_RB_TIMEOUT = 8.0

def _rb_headers() -> dict:
    return {'Authorization': f'key {REBRICKABLE_KEY}'}

def _rb_get(path: str, params: dict) -> dict:
    """One-shot Rebrickable GET — cno shared client to avoid threading issues."""
    resp = httpx.get(
        f'https://rebrickable.com/api/v3/lego/{path}',
        headers=_rb_headers(),
        params=params,
        timeout=_RB_TIMEOUT,
        follow_redirects=True,
    )
    return resp.json()