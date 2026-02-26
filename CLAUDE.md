# Research Hub — HRI Paper Feed
## Project Overview
Research hub for a PhD candidate in Human-Robot Interaction.
Focuses on non-humanoid social robots in public spaces.
Theoretical basis: priming, emotional contagion, carry-over effect.
## File Structure
index.html         — HTML structure only. Boot script at bottom calls:
                     init(); renderKeywordChips(); renderActiveKeywordsBar();
css/style.css      — All styles (~1,895 lines). Dark mode, layout, components.
js/firebase.js     — Firebase auth + Firestore (keywords, actions, signals, learned keywords)
js/app.js          — All global state + constants. Core functions. init() lives here.
                     NOTE: init() is called from index.html, not from app.js itself.
js/api.js          — Semantic Scholar API calls + search input handling
js/citations.js    — APA and BibTeX formatting + citation modal
js/reading-list.js — Reading list logic and rendering
js/feed-filters.js — Filtering, sorting, filter panel UI, active filter tags
js/feed.js         — Paper card HTML, feed rendering, visibility tracking, card actions
js/ai-search.js    — AI Discovery mode (Claude-powered semantic search + re-ranking)
api/papers.js      — Vercel serverless: Semantic Scholar proxy (production)
api/claude.js      — Vercel serverless: Claude API proxy (production)
server.py          — Local dev server on http://127.0.0.1:8000
                     Proxies /api/papers (24h cache) and /api/claude
start.bat          — Windows launcher (requires ANTHROPIC_API_KEY env var)
tests.html         — 149 test suite at http://127.0.0.1:8000/tests.html
## Critical: Script Load Order
firebase.js → app.js → api.js → citations.js →
reading-list.js → feed-filters.js → feed.js → ai-search.js
Each file depends on globals from earlier files. Never reorder.
## Tech Stack
- Vanilla HTML + CSS + JavaScript. No frameworks, no bundler, no ES modules.
- Plain <script src> tags — globals shared across files via window scope.
- Firebase compat SDK v10 — auth + Firestore (optional, additive)
- Semantic Scholar API — free, no key needed
- Google Gemini API — AI search (needs GEMINI_API_KEY)
- Local: server.py | Production: Vercel
## Global State
All global state and constants live in js/app.js.
Other files read/write those globals directly — no import/export.
## Code Rules
- Simple and readable over clever
- Well commented for non-developers
- localStorage for persistence (Firebase sync is additive)
- Never hardcode keywords — always user-managed
- Clean academic UI, dark/light mode, mobile friendly