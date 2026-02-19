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
