"""
Local server for Research Hub.
Serves index.html AND proxies Semantic Scholar API calls.

Why a proxy is needed:
- Corporate SSL inspection on this machine blocks direct browser-to-API HTTPS.
- Python's urllib bypasses this, so we proxy through localhost instead.

Caching:
- Results are cached in paper_cache.json for 24 hours per keyword.
- Fresh cache  → served instantly, no API call made.
- Stale cache  → served instantly, then refreshed in background thread.
- No cache     → fetched live (first run only), with 5s timeout.
- If API fails → stale cache served as fallback; if no cache, returns error JSON.

Usage:
    python server.py
Then open: http://localhost:8000
"""
import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import json
import os
import time
import threading
import webbrowser

PORT       = 8000
HOST       = '127.0.0.1'     # bind to IPv4 explicitly — avoids 2s Windows IPv6 timeout
API_URL    = 'https://api.semanticscholar.org/graph/v1/paper/search'
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'paper_cache.json')
CACHE_TTL  = 60 * 60 * 24   # 24 hours in seconds
API_TIMEOUT = 5              # seconds — short so a hung fetch never blocks the server

CLAUDE_API_URL    = 'https://api.anthropic.com/v1/messages'
CLAUDE_MODEL      = 'claude-sonnet-4-5'
CLAUDE_TIMEOUT    = 35                                    # seconds — ranking 20 papers can take a moment
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')  # set before running: set ANTHROPIC_API_KEY=sk-ant-...

os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Lock so concurrent threads don't corrupt the cache file
_cache_lock = threading.Lock()


# ── Cache helpers ──────────────────────────────────────────────────────────────

def load_cache():
    """Load the cache dict from disk, or return empty dict if missing/corrupt."""
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def save_cache(cache):
    """Write the cache dict to disk (call with _cache_lock held)."""
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
    except Exception as e:
        print(f'Warning: could not save cache: {e}')

def get_cached(cache, key):
    """Return data string if cache entry exists AND is still fresh, else None."""
    entry = cache.get(key)
    if entry and (time.time() - entry['ts']) < CACHE_TTL:
        return entry['data']
    return None

def get_stale(cache, key):
    """Return data string from cache even if expired — used as fallback."""
    entry = cache.get(key)
    return entry['data'] if entry else None


# ── Request handler ────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # suppress per-request noise in the terminal

    def do_GET(self):
        if self.path.startswith('/api/papers'):
            self.proxy_api()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/claude'):
            self.proxy_claude()
        else:
            self.send_response(405)
            self.end_headers()

    def do_OPTIONS(self):
        """Handle CORS preflight requests from the browser."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def proxy_api(self):
        """
        Serve Semantic Scholar data for a keyword query.

        Priority order:
          1. Fresh cache  → instant response
          2. Stale cache  → instant response + background refresh
          3. No cache     → live fetch (5s timeout); on failure return error JSON
        """
        params = urllib.parse.urlparse(self.path).query
        key    = params   # use the full query string as the cache key

        with _cache_lock:
            cache = load_cache()

        # 1. Fresh cache — serve immediately, no API call needed
        fresh = get_cached(cache, key)
        if fresh:
            self._send_json(200, fresh)
            return

        # 2. Stale cache — serve immediately so browser never waits, then
        #    kick off a background refresh for next time
        stale = get_stale(cache, key)
        if stale:
            self._send_json(200, stale)
            threading.Thread(
                target=self._bg_refresh,
                args=(params, key),
                daemon=True
            ).start()
            return

        # 3. No cache — must fetch live (only happens on very first run)
        self._fetch_and_respond(params, key)

    # ── internal helpers ───────────────────────────────────────────────────────

    def _bg_refresh(self, params, key):
        """Background cache refresh — silent on any error."""
        try:
            raw, data = self._fetch_api(params)
            if data.get('data') is not None:
                with _cache_lock:
                    cache = load_cache()
                    cache[key] = {'ts': time.time(), 'data': raw}
                    save_cache(cache)
                print(f'Cache refreshed: {params[:70]}')
        except Exception as e:
            print(f'Background refresh failed (non-fatal): {e}')

    def _fetch_and_respond(self, params, key):
        """Live fetch → respond → cache. Used only when there is no cache at all."""
        try:
            raw, data = self._fetch_api(params)
            papers = data.get('data')
            if papers is not None:
                # Valid response (even if empty list) — cache it
                with _cache_lock:
                    cache = load_cache()
                    cache[key] = {'ts': time.time(), 'data': raw}
                    save_cache(cache)
                self._send_json(200, raw)
            elif 'message' in data:
                # Semantic Scholar rate limit message: {"message": "..."}
                self._send_json(429, raw)
            else:
                # Unknown response shape — pass through as-is
                self._send_json(200, raw)
        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            self._send_json(e.code, body)
        except Exception as e:
            err = json.dumps({'message': str(e), 'data': None})
            self._send_json(502, err)

    def _fetch_api(self, params):
        """
        Make one HTTPS request to Semantic Scholar.
        Returns (raw_str, parsed_dict).
        Raises on any network/HTTP error.
        """
        url = f'{API_URL}?{params}'
        req = urllib.request.Request(url, headers={'User-Agent': 'ResearchHub/1.0'})
        with urllib.request.urlopen(req, timeout=API_TIMEOUT) as resp:
            raw = resp.read().decode('utf-8', errors='replace')
        return raw, json.loads(raw)

    def _send_json(self, status, body_str):
        """Send an HTTP JSON response."""
        encoded = body_str.encode('utf-8') if isinstance(body_str, str) else body_str
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(encoded)

    def proxy_claude(self):
        """
        Proxy POST /api/claude → Anthropic Claude API.

        Mirrors api/claude.js (the Vercel serverless function) so the same
        index.html works locally without Vercel dev tools.

        Request body: { type: 'expand'|'rank', query, keywords?, papers? }
        Response: JSON from Claude (searchTerms/interpretation/suggestions OR ranked array)
        """
        import re

        if not ANTHROPIC_API_KEY:
            self._send_json(500, json.dumps({
                'error': 'ANTHROPIC_API_KEY not set. Run: set ANTHROPIC_API_KEY=sk-ant-... before starting server.'
            }))
            return

        # Read request body
        content_length = int(self.headers.get('Content-Length', 0))
        body_bytes = self.rfile.read(content_length)
        try:
            body_data = json.loads(body_bytes)
        except Exception:
            self._send_json(400, json.dumps({'error': 'Invalid JSON body'}))
            return

        req_type = body_data.get('type')
        query    = body_data.get('query', '')
        keywords = body_data.get('keywords', [])
        papers   = body_data.get('papers', [])

        # ── Build system prompt + user message (mirrors api/claude.js exactly) ──

        if req_type == 'expand':
            system_prompt = '\n'.join([
                'You are an academic research assistant specialising in Human-Robot Interaction (HRI)',
                'and social psychology — specifically priming, emotional contagion, and carry-over effects.',
                'Given a researcher\'s question and their keyword profile, your job is to extract',
                'optimised Semantic Scholar search terms that will surface the most relevant academic papers.',
                '',
                'Return ONLY valid JSON with this exact shape (no markdown, no explanation outside the JSON):',
                '{',
                '  "searchTerms": string[],   // 6-8 academic search terms, short phrases work best on S2',
                '  "interpretation": string,  // 1-2 sentence plain-language summary of what you understood',
                '  "suggestions": string[]    // 3 alternative/broader queries if the original may be too narrow',
                '}',
            ])
            user_message = (
                f'Research question: "{query}"\n\n'
                f'User\'s active keyword profile: {", ".join(keywords) if keywords else "none set"}'
            )

        elif req_type == 'rank':
            system_prompt = '\n'.join([
                'You are an academic research assistant. Given a researcher\'s question and a list of papers,',
                'score each paper\'s relevance to the question on a scale of 1-10 and write a concise',
                '2-3 sentence explanation of WHY it is or is not relevant.',
                '',
                'Scoring guide:',
                '  9-10 = Directly addresses the question, highly relevant',
                '   7-8 = Clearly related, provides useful context or methodology',
                '   4-6 = Partially relevant, tangentially related',
                '   1-3 = Weak connection, unlikely to be useful for this question',
                '',
                'Return ONLY a valid JSON array with this exact shape (no markdown, no explanation outside the JSON):',
                '[{ "paperId": string, "score": number, "explanation": string }]',
                '',
                'Include ALL papers from the input list in your response, even low-scoring ones.',
                'Keep each explanation to 2-3 sentences maximum.',
            ])
            user_message = (
                f'Research question: "{query}"\n\n'
                f'Papers to rank:\n{json.dumps(papers)}'
            )

        else:
            self._send_json(400, json.dumps({
                'error': f'Unknown type: "{req_type}". Must be "expand" or "rank".'
            }))
            return

        # ── Call Claude API ──────────────────────────────────────────────────────

        claude_payload = json.dumps({
            'model':      CLAUDE_MODEL,
            'max_tokens': 2048,
            'system':     system_prompt,
            'messages':   [{'role': 'user', 'content': user_message}],
        }).encode('utf-8')

        try:
            claude_req = urllib.request.Request(
                CLAUDE_API_URL,
                data=claude_payload,
                headers={
                    'Content-Type':      'application/json',
                    'x-api-key':         ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                },
                method='POST',
            )
            with urllib.request.urlopen(claude_req, timeout=CLAUDE_TIMEOUT) as resp:
                raw = resp.read().decode('utf-8', errors='replace')

            response_data = json.loads(raw)
            text = response_data.get('content', [{}])[0].get('text', '')

            # Extract JSON — Claude sometimes wraps it in markdown code fences
            json_match = re.search(r'\[[\s\S]*?\]|\{[\s\S]*?\}', text)
            if not json_match:
                print(f'[claude] No JSON in response. Raw text: {text[:300]}')
                self._send_json(500, json.dumps({'error': 'Claude returned unexpected format'}))
                return

            self._send_json(200, json_match.group(0))

        except urllib.error.HTTPError as e:
            body = e.read().decode('utf-8', errors='replace')
            print(f'[claude] HTTPError {e.code}: {body[:200]}')
            self._send_json(e.code, body)
        except Exception as e:
            print(f'[claude] Error: {e}')
            self._send_json(502, json.dumps({'error': str(e)}))


# ── Start server ───────────────────────────────────────────────────────────────

class ThreadedServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """
    Threaded TCP server.
    - allow_reuse_address: lets the server restart immediately after a kill
      without waiting for the OS TIME_WAIT to expire.
    - ThreadingMixIn: each request is handled in its own thread, so a slow
      or hung API fetch never blocks other requests.
    - daemon_threads: background threads don't prevent clean shutdown.
    """
    allow_reuse_address = True
    daemon_threads      = True

URL = f'http://{HOST}:{PORT}'
print(f'Research Hub running at {URL}')
print(f'Cache file: {CACHE_FILE}')
print('Press Ctrl+C to stop.\n')
webbrowser.open(URL)

with ThreadedServer((HOST, PORT), Handler) as httpd:
    httpd.serve_forever()
