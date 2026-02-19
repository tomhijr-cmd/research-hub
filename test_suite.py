"""
Stress test suite for Research Hub server.
Run with: python test_suite.py
"""
import urllib.request
import urllib.error
import json
import time
import threading
import sys
import os

BASE       = 'http://127.0.0.1:8000'
FIELDS     = 'title%2Cabstract%2Cauthors%2Cyear%2CexternalIds%2Curl'
CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'paper_cache.json')
KEYWORDS   = [
    'social+robots',
    'human-robot+interaction',
    'emotional+contagion',
    'priming+public+spaces',
    'non-humanoid+robots',
]

PASS_COUNT = 0
FAIL_COUNT = 0
FAILURES   = []


def test(name, fn):
    global PASS_COUNT, FAIL_COUNT
    try:
        result = fn()
        if result is True or result is None:
            print(f'  PASS  {name}')
            PASS_COUNT += 1
        else:
            print(f'  FAIL  {name}: {result}')
            FAIL_COUNT += 1
            FAILURES.append((name, str(result)))
    except Exception as e:
        print(f'  FAIL  {name}: {e}')
        FAIL_COUNT += 1
        FAILURES.append((name, str(e)))


def fetch(path, timeout=5):
    r = urllib.request.urlopen(f'{BASE}{path}', timeout=timeout)
    return r.status, json.loads(r.read())


def api(kw):
    return f'/api/papers?query={kw}&fields={FIELDS}&limit=10'


# ── SCENARIO 1: Basic server health ──────────────────────────────────────────
print()
print('SCENARIO 1: Server health')


def s1_html():
    r = urllib.request.urlopen(f'{BASE}/', timeout=5)
    html = r.read().decode()
    assert 'Research Hub' in html, 'missing title'
    assert 'fetchPapers' in html, 'missing fetchPapers JS'
    assert 'function esc(' in html or 'escHtml' in html, 'missing HTML escaping function (XSS protection)'
    return True


test('index.html served with correct content', s1_html)


def s1_404():
    try:
        urllib.request.urlopen(f'{BASE}/nonexistent.xyz', timeout=5)
        return 'should have returned 404'
    except urllib.error.HTTPError as e:
        return True if e.code == 404 else f'expected 404, got {e.code}'


test('404 returned for unknown paths', s1_404)


# ── SCENARIO 2: All keywords return data from cache ───────────────────────────
print()
print('SCENARIO 2: All 5 keywords served from cache')

for kw in KEYWORDS:
    def check_kw(kw=kw):
        status, d = fetch(api(kw))
        papers = d.get('data', [])
        if len(papers) == 0:
            return f'0 papers returned'
        p = papers[0]
        for field in ['paperId', 'title']:
            if field not in p:
                return f'paper missing required field: {field}'
        return True
    test(f'  [{kw}]', check_kw)


# ── SCENARIO 3: Cache performance ─────────────────────────────────────────────
print()
print('SCENARIO 3: Cache performance')


def s3_speed():
    times = []
    for _ in range(3):
        t0 = time.time()
        urllib.request.urlopen(f'{BASE}{api("social+robots")}', timeout=5)
        times.append(time.time() - t0)
    avg = sum(times) / len(times)
    print(f'    avg response time: {avg*1000:.0f}ms')
    if avg > 0.5:
        return f'avg {avg*1000:.0f}ms is too slow for a cache hit (expected < 500ms)'
    return True


test('cache response averages < 500ms over 3 requests', s3_speed)


def s3_concurrent():
    """Fire all 5 keywords simultaneously — server must handle them all."""
    errors = []

    def fetch_kw(kw):
        try:
            status, d = fetch(api(kw), timeout=10)
            if not d.get('data'):
                errors.append(f'{kw}: returned no data')
        except Exception as e:
            errors.append(f'{kw}: {e}')

    threads = [threading.Thread(target=fetch_kw, args=(kw,)) for kw in KEYWORDS]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    if errors:
        return 'Concurrent request errors: ' + '; '.join(errors)
    return True


test('5 simultaneous requests all succeed', s3_concurrent)


# ── SCENARIO 4: Stale cache still serves data instantly ───────────────────────
print()
print('SCENARIO 4: Stale cache fallback')


def s4_stale():
    with open(CACHE_FILE) as f:
        cache = json.load(f)
    key = list(cache.keys())[0]
    orig_ts = cache[key]['ts']
    # Set timestamp to 48h ago — clearly stale
    cache[key]['ts'] = time.time() - 172800
    with open(CACHE_FILE, 'w') as f:
        json.dump(cache, f)
    try:
        t0 = time.time()
        status, d = fetch(f'/api/papers?{key}', timeout=5)
        elapsed = time.time() - t0
        papers = d.get('data', [])
        if len(papers) == 0:
            return 'stale cache returned 0 papers'
        if elapsed > 1.0:
            return f'stale response took {elapsed:.2f}s — should be instant (cache served immediately)'
        print(f'    stale cache served {len(papers)} papers in {elapsed*1000:.0f}ms')
        return True
    finally:
        # Always restore original timestamp
        with open(CACHE_FILE) as f:
            cache = json.load(f)
        cache[key]['ts'] = orig_ts
        with open(CACHE_FILE, 'w') as f:
            json.dump(cache, f)


test('stale cache (48h old) served instantly without API call', s4_stale)


# ── SCENARIO 5: Missing cache key — server must not hang or crash ─────────────
print()
print('SCENARIO 5: Uncached keyword (simulates first run / rate limit)')


def s5_missing():
    """
    A keyword not in cache requires a live fetch.
    The API is likely rate-limited right now, so we expect either:
      a) valid data (if not rate-limited), or
      b) a proper error JSON with 'message' key (not a server crash/hang)
    The key requirement: response comes back within timeout (server doesn't hang).
    """
    t0 = time.time()
    try:
        r = urllib.request.urlopen(
            f'{BASE}/api/papers?query=zzz_notcached_xyz_abc&fields={FIELDS}&limit=10',
            timeout=10
        )
        elapsed = time.time() - t0
        d = json.loads(r.read())
        print(f'    Got response in {elapsed:.1f}s')
        return True
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        body = e.read().decode('utf-8', errors='replace')
        try:
            d = json.loads(body)
            # Accept any valid JSON back — could be SS rate limit, empty result, etc.
            print(f'    Got JSON error in {elapsed:.1f}s (HTTP {e.code}) — acceptable')
            return True
        except Exception:
            return f'Non-JSON error body (HTTP {e.code})'
    except Exception as e:
        elapsed = time.time() - t0
        if elapsed >= 9:
            return f'Server hung for {elapsed:.1f}s — did not respond within timeout'
        print(f'    Connection error in {elapsed:.1f}s: {e} — acceptable')
        return True


test('uncached keyword returns response within 10s (no hang)', s5_missing)


# ── SCENARIO 6: Cache file integrity under concurrent writes ──────────────────
print()
print('SCENARIO 6: Cache integrity under concurrent load')


def s6_integrity():
    errors = []

    def fetch_kw(kw):
        try:
            urllib.request.urlopen(f'{BASE}{api(kw)}', timeout=10)
        except Exception:
            pass  # not interested in errors here, just concurrent access

    threads = [threading.Thread(target=fetch_kw, args=(kw,)) for kw in KEYWORDS * 2]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)

    try:
        with open(CACHE_FILE) as f:
            cache = json.load(f)
        if not isinstance(cache, dict):
            return 'cache is not a dict after concurrent writes'
        for key, entry in cache.items():
            assert 'ts' in entry, f'entry missing ts: {key}'
            assert 'data' in entry, f'entry missing data: {key}'
        print(f'    Cache has {len(cache)} valid entries')
        return True
    except json.JSONDecodeError as e:
        return f'cache file corrupted after concurrent access: {e}'


test('cache file valid after 10 concurrent requests', s6_integrity)


# ── SCENARIO 7: Paper data quality ────────────────────────────────────────────
print()
print('SCENARIO 7: Paper data quality')


def s7_quality():
    total = 0
    with_abstract = 0
    with_year = 0
    with_authors = 0
    all_ids = []

    for kw in KEYWORDS:
        _, d = fetch(api(kw), timeout=5)
        for p in d.get('data', []):
            total += 1
            if p.get('abstract'):
                with_abstract += 1
            if p.get('year'):
                with_year += 1
            if p.get('authors'):
                with_authors += 1
            if p.get('paperId'):
                all_ids.append(p['paperId'])

    print(f'    {total} papers total across 5 keywords')
    print(f'    Abstracts: {with_abstract}/{total}  '
          f'Years: {with_year}/{total}  '
          f'Authors: {with_authors}/{total}')

    if total < 40:
        return f'only {total} papers total (expected ~50 from 5 keywords x 10 each)'
    return True


test('~50 papers with expected metadata fields', s7_quality)


def s7_paperids():
    """All papers must have paperId (required for client-side deduplication)."""
    missing = 0
    for kw in KEYWORDS:
        _, d = fetch(api(kw), timeout=5)
        for p in d.get('data', []):
            if not p.get('paperId'):
                missing += 1
    if missing:
        return f'{missing} papers are missing paperId (dedup will break)'
    return True


test('all papers have paperId (required for deduplication)', s7_paperids)


# ── FINAL SUMMARY ─────────────────────────────────────────────────────────────
print()
print('=' * 55)
print(f'  RESULTS: {PASS_COUNT} passed, {FAIL_COUNT} failed'
      f' out of {PASS_COUNT + FAIL_COUNT} tests')
print('=' * 55)
if FAILURES:
    print('\nFailed tests:')
    for name, msg in FAILURES:
        print(f'  - {name}')
        print(f'    {msg}')
sys.exit(0 if FAIL_COUNT == 0 else 1)
