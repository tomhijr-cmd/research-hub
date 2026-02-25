# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Research Hub — HRI Paper Feed

## Project Overview

This is a research hub for a PhD candidate in Human-Robot Interaction, focusing on non-humanoid social robots embedded in public spaces. Built on social psychology theories: priming, emotional contagion, and carry-over effect.

## What This App Does

- Fetches daily academic papers from Semantic Scholar API (free, no key needed)
- Displays papers as a clean feed with title, abstract, authors, date
- Shows a relevance score (1-5) based on user-defined keywords
- Keywords are managed by the user in a settings panel — never hardcoded
- All keywords and settings saved in localStorage (and optionally synced to Firebase)
- AI Discovery mode: Claude-powered semantic search — describe a research question in plain language, Claude expands it into search terms, fetches papers, then re-ranks and explains the results

## File Structure

```
research-hub/
  index.html           — HTML structure only (334 lines). Loads CSS and JS files.
                         Contains a boot <script> at the bottom: init(); renderKeywordChips(); renderActiveKeywordsBar();
  css/
    style.css          — All CSS (~1,895 lines). Custom properties, dark mode, layout,
                         buttons, panels, feed, paper cards, citation modal, AI search styles.
  js/
    firebase.js        — Firebase config, SDK init, auth + Firestore operations:
                         userDocRef, loadKeywordsFromFirestore, saveKeywordsToFirestore,
                         userActionsRef, loadUserActions, saveUserAction,
                         userSignalsRef, loadUserSignals, recordSignal, computeSignalScore,
                         loadLearnedKeywords, saveLearnedKeywords,
                         auth.onAuthStateChanged handler.
    app.js             — All constants and global state (let/const declarations).
                         Core app functions: init(), renderAuthUI(), signIn(), signOut(),
                         loadKeywords(), saveKeywords(), loadTheme(), applyTheme(),
                         keyword management (add/remove/toggle/activeKeywords),
                         learned keyword scoring, signal-based rescoring,
                         UI helpers (showToast, openPanel, setStatus, showSkeletons),
                         paper action handling, bindEvents() — all event listener wiring.
                         NOTE: init() is NOT called here — it is called from index.html
                         after all script files have loaded.
    api.js             — Semantic Scholar API calls:
                         fetchOneKeyword(keyword), fetchPapers(),
                         handleSearchInput(), clearSearch().
    citations.js       — Citation formatting and modal:
                         buildApa(paper), buildBibtex(paper), showCiteModal(paperId).
    reading-list.js    — Reading list logic and rendering:
                         loadReadingList(), saveReadingList(), updateReadingListBadge(),
                         addToReadingList(), removeFromReadingList(),
                         openReadingListView(), closeReadingListView(),
                         migrateOldLikesToReadingList(),
                         buildRlCardHtml(), renderReadingList().
    feed-filters.js    — Feed filtering, sorting, and filter panel UI:
                         applyAndRender(), applyFiltersAndSort(),
                         all applyXxx() filter functions (~12),
                         citationVelocity(), velocityLabel(),
                         getMatchedKeywords(), highlightSearchTerms(),
                         renderFilterPanel() and all renderXxxFilterGroup() sub-renderers,
                         buildActiveFilterTags(), renderActiveFilterTags(), clearAllFilters().
    feed.js            — Feed rendering and paper card HTML:
                         buildPaperCardHtml(paper), renderPapers(), renderFeedHeader(),
                         renderEmptyState(), maybeShowScoreExplainer(),
                         startVisibilityTracking(), bindCardActions(), loadMorePapers().
    ai-search.js       — AI Discovery mode (Claude-powered semantic search):
                         initModeToggle(), switchMode(mode),
                         initAiQueryPanel(), renderRecentSearches(),
                         saveRecentSearch(), removeRecentSearch(), renderKeywordContextHint(),
                         runAiSearch(query), cancelAiSearch(), clearAiResults(), setPipelineStep(),
                         renderMixedFeed(), showSummaryBar(), toggleSummaryBar(), toggleEditTerms(),
                         renderEditChips(), rerunWithEditedTerms(), saveAiTermsAsKeywords(),
                         showAiEmptyState().
  server.py            — Local Python dev server (http://127.0.0.1:8000).
                         Serves static files + proxies two APIs:
                         GET /api/papers → Semantic Scholar (with 24h cache in paper_cache.json)
                         POST /api/claude → Anthropic Claude API (requires ANTHROPIC_API_KEY env var)
  start.bat            — Windows launcher: checks for ANTHROPIC_API_KEY, starts server.py.
  api/
    papers.js          — Vercel serverless function: proxies Semantic Scholar (production).
    claude.js          — Vercel serverless function: proxies Claude API (production).
  tests.html           — Test suite (149 tests). Run at http://127.0.0.1:8000/tests.html.
  paper_cache.json     — Auto-generated 24h cache for Semantic Scholar results.
  vercel.json          — Vercel routing config (production deployment).
```

## Script Load Order (Critical)

Scripts in `index.html` must load in this exact order — each file depends on globals declared by earlier files:

```html
<!-- Firebase SDK (CDN — must be first) -->
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>

<!-- App scripts -->
<script src="js/firebase.js"></script>       <!-- auth, db, Firestore fns -->
<script src="js/app.js"></script>            <!-- ALL constants + state, core fns -->
<script src="js/api.js"></script>            <!-- fetchPapers, fetchOneKeyword -->
<script src="js/citations.js"></script>      <!-- buildApa, buildBibtex, showCiteModal -->
<script src="js/reading-list.js"></script>   <!-- reading list logic -->
<script src="js/feed-filters.js"></script>   <!-- filters, sorting, filter panel -->
<script src="js/feed.js"></script>           <!-- buildPaperCardHtml, renderPapers -->
<script src="js/ai-search.js"></script>      <!-- AI Discovery mode -->

<!-- Boot: all files loaded, safe to call init() -->
<script>init(); renderKeywordChips(); renderActiveKeywordsBar();</script>
```

## Tech Stack

- HTML + CSS + vanilla JavaScript — no frameworks, no bundler, no ES modules
- Plain `<script src>` tags — globals declared in earlier files are available to later files
- Firebase (compat SDK v10) — optional auth + Firestore sync for keywords and user actions
- Semantic Scholar Academic Graph API — free academic paper search
- Anthropic Claude API — AI semantic search (requires `ANTHROPIC_API_KEY`)
- Local dev: Python `server.py` on `http://127.0.0.1:8000`
- Production: Vercel (serverless functions in `api/`)

## Running Locally

```bat
start.bat
```

Or manually:
```
set ANTHROPIC_API_KEY=sk-ant-...
python server.py
```

Then open: http://127.0.0.1:8000

## UI Preferences

- Clean, modern, academic-feeling design
- Dark or light mode toggle
- Mobile friendly
- Readable typography — this is for reading papers, not gaming

## Code Preferences

- Simple and readable over clever
- Well commented so non-developers can understand it
- localStorage for all persistence (Firebase sync is additive/optional)
- All global state lives in `js/app.js` — other files read/write those globals directly
- No ES modules, no import/export — plain globals shared across script files
