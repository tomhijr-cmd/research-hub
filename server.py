"""
Local server for Research Hub.
Serves index.html AND proxies Semantic Scholar API calls.

Why a proxy is needed:
- Corporate SSL inspection on this machine blocks direct browser-to-API HTTPS.
- Python's urllib bypasses this, so we proxy through localhost instead.

Caching:
- Results are cached in paper_cache.json for 24 hours per keyword.
- If the API is rate-limited or down, the cache is served as a fallback.
- This means the app still works offline after the first successful fetch.

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
import webbrowser

PORT       = 8000
API_URL    = 'https://api.semanticscholar.org/graph/v1/paper/search'
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'paper_cache.json')
CACHE_TTL  = 60 * 60 * 24  # 24 hours in seconds

os.chdir(os.path.dirname(os.path.abspath(__file__)))


# ── Cache helpers ──────────────────────────────────────────────────────────────

def load_cache():
    """Load the cache dict from disk, or return empty dict if missing/corrupt."""
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def save_cache(cache):
    """Write the cache dict to disk."""
    try:
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(cache, f)
    except Exception as e:
        print(f'Warning: could not save cache: {e}')

def cache_key(params_str):
    """Use the raw query string as the cache key."""
    return params_str

def get_cached(cache, key):
    """Return cached data if it exists and is still fresh, else None."""
    entry = cache.get(key)
    if entry and (time.time() - entry['ts']) < CACHE_TTL:
        return entry['data']
    return None

def get_stale(cache, key):
    """Return cached data even if expired (used as fallback when API fails)."""
    entry = cache.get(key)
    return entry['data'] if entry else None


# ── Request handler ────────────────────────────────────────────────────────────

class Handler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, format, *args):
        pass  # silence per-request logs

    def do_GET(self):
        if self.path.startswith('/api/papers'):
            self.proxy_api()
        else:
            super().do_GET()

    def proxy_api(self):
        """
        Forward the query string to Semantic Scholar and return the result.
        - Fresh cache (< 24h): serve immediately, no API call.
        - Stale cache: serve immediately from cache, then refresh in background.
        - No cache: fetch from API, cache on success.
        """
        parsed   = urllib.parse.urlparse(self.path)
        params   = parsed.query
        key      = cache_key(params)
        cache    = load_cache()

        # 1. Fresh cache — serve immediately
        fresh = get_cached(cache, key)
        if fresh:
            self._send_json(200, fresh)
            return

        # 2. Stale cache exists — serve it immediately so the browser doesn't wait,
        #    then kick off a background refresh so next load gets fresh data.
        stale = get_stale(cache, key)
        if stale:
            self._send_json(200, stale)
            # Refresh cache in background (best-effort, errors are silent)
            import threading
            threading.Thread(
                target=self._refresh_cache,
                args=(params, key),
                daemon=True
            ).start()
            return

        # 3. No cache at all — must fetch live (first run)
        self._fetch_and_respond(params, key)

    def _refresh_cache(self, params, key):
        """Background cache refresh — called after serving stale data."""
        try:
            self._fetch_to_cache(params, key)
        except Exception:
            pass  # silent — stale data already served

    def _fetch_and_respond(self, params, key):
        """Fetch from API, send response, and cache on success."""
        full_url = f'{API_URL}?{params}'
        try:
            req = urllib.request.Request(
                full_url,
                headers={'User-Agent': 'ResearchHub/1.0'}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw         = resp.read()
                status_code = resp.status

            data = json.loads(raw)

            if status_code == 200 and data.get('data') is not None:
                cache      = load_cache()
                cache[key] = {'ts': time.time(), 'data': raw.decode('utf-8')}
                save_cache(cache)
                self._send_json(200, raw.decode('utf-8'))
            else:
                # Rate limited or API error with no cache to fall back on
                self._send_json(status_code, raw.decode('utf-8'))

        except urllib.error.HTTPError as e:
            self._send_json(e.code, e.read().decode('utf-8'))

        except Exception as e:
            err = json.dumps({'message': str(e), 'data': None})
            self._send_json(502, err)

    def _fetch_to_cache(self, params, key):
        """Fetch from API and update cache only (no HTTP response)."""
        full_url = f'{API_URL}?{params}'
        req = urllib.request.Request(
            full_url,
            headers={'User-Agent': 'ResearchHub/1.0'}
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw  = resp.read()
            data = json.loads(raw)
        if data.get('data') is not None:
            cache      = load_cache()
            cache[key] = {'ts': time.time(), 'data': raw.decode('utf-8')}
            save_cache(cache)
            print(f'Background cache refreshed for: {params[:60]}')

    def _send_json(self, status, body_str):
        """Send a JSON response."""
        encoded = body_str.encode('utf-8') if isinstance(body_str, str) else body_str
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(encoded)


# ── Start server ───────────────────────────────────────────────────────────────

print(f'Research Hub running at http://localhost:{PORT}')
print(f'Cache file: {CACHE_FILE}')
print('Press Ctrl+C to stop.\n')
webbrowser.open(f'http://localhost:{PORT}')

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    httpd.serve_forever()
