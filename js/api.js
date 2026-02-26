// -- api.js --
// Semantic Scholar API calls: fetch papers by keyword, handle search input.
// Functions: fetchOneKeyword, fetchPapers, handleSearchInput, clearSearch
// -----

async function fetchOneKeyword(keyword) {
  const params = new URLSearchParams({
    query:  keyword,
    fields: API_FIELDS,
    limit:  10,
  });
  const res  = await fetch(`${API_BASE}?${params}`);
  const data = await res.json();
  if (res.status === 429 || (data.message && !data.data)) {
    throw new Error('Rate limited by Semantic Scholar. Wait 30 seconds and click Refresh.');
  }
  if (!res.ok) {
    throw new Error(`Semantic Scholar API error (${res.status}). Try again shortly.`);
  }
  return data.data || [];
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPapers() {
  if (loading) return;

  const active = activeKeywords();
  if (active.length === 0) {
    setStatus('No active keywords. Enable at least one keyword in settings.', true);
    return;
  }

  loading = true;
  setStatus(`Fetching papers for ${active.length} keyword${active.length > 1 ? 's' : ''}…`);
  showSkeletons();
  setRefreshSpinning(true);

  try {
    const seen    = new Set();
    const results = [];

    for (let i = 0; i < active.length; i++) {
      if (i > 0) await wait(500);
      setStatus(`Fetching papers… (${i + 1}/${active.length})`);
      try {
        const batch = await fetchOneKeyword(active[i]);
        for (const paper of batch) {
          if (paper.title && paper.paperId && !seen.has(paper.paperId)) {
            seen.add(paper.paperId);
            results.push(paper);
          }
        }
      } catch (kwErr) {
        console.warn(`Skipping keyword "${active[i]}": ${kwErr.message}`);
      }
    }

    // Score all results using keyword match + signal history + learned keywords
    allPapers = results.map(p => ({ ...p, score: scoreWithSignals(p) }));

    // One-time migration: move previously-liked papers into the reading list
    migrateOldLikesToReadingList();

    // Apply filters and sort to derive the view
    papers    = applyFiltersAndSort(allPapers);
    pageIndex = 0;

    if (allPapers.length === 0) {
      setStatus('No papers found. The API may be rate-limited — wait 30 seconds and click Refresh.', true);
    } else {
      const now = new Date();
      localStorage.setItem(LAST_FETCH_KEY, now.toISOString());
      setStatus(''); // clear status; feed header shows count
      runHealthCheck();
    }

    // Track unread BEFORE updating seen (so new papers show as unread this session)
    renderPapers();

    // After rendering, mark current papers as seen for next session
    updateSeenPapers();
    // Update the in-memory seenPaperIds so they don't show as unread in this session
    allPapers.forEach(p => { if (p.paperId) seenPaperIds.add(p.paperId); });

    // Load user actions if signed in
    if (currentUser) {
      await loadUserActions(); // will call renderPapers() again with actions
    }

  } catch (err) {
    console.error('Fetch error:', err);
    const msg = err.message === 'Failed to fetch'
      ? 'Could not reach local server. Make sure server.py is running.'
      : err.message;
    setStatus(msg, true);
    document.getElementById('paperFeed').innerHTML = '';
  } finally {
    loading = false;
    setRefreshSpinning(false);
  }
}


// ════════════════════════════════════════════════════════════
//  SEARCH BAR
// ════════════════════════════════════════════════════════════

function handleSearchInput(e) {
  const val      = e.target.value;
  const clearBtn = document.getElementById('searchClearBtn');
  const aiBtn    = document.getElementById('aiSearchBtn');

  // Show/hide clear button
  clearBtn.style.display = val.trim() ? 'block' : 'none';

  // Show AI button only when there is text; style based on intent
  if (val.trim()) {
    aiBtn.style.display = '';
    if (looksLikeQuestion(val)) {
      aiBtn.classList.remove('muted');
      aiBtn.textContent = 'Search with AI →';
    } else {
      aiBtn.classList.add('muted');
      aiBtn.textContent = 'AI →';
    }
  } else {
    aiBtn.style.display = 'none';
  }

  // If AI results are currently showing and the user edits the input, clear them
  if (aiPapers.length && val !== aiQuery) {
    clearAiResults();
  }

  // Debounce: wait 300ms after typing stops before live-filtering keyword feed
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = val;
    if (!aiPapers.length) applyAndRender(); // only live-filter in keyword mode
  }, 300);
}

function clearSearch() {
  searchQuery = '';
  const input  = document.getElementById('searchInput');
  const aiBtn  = document.getElementById('aiSearchBtn');
  if (input)  input.value = '';
  document.getElementById('searchClearBtn').style.display = 'none';
  if (aiBtn)  aiBtn.style.display = 'none';
  // If AI results were showing, clear them and restore keyword feed
  if (aiPapers.length) {
    aiPapers    = [];
    aiQuery     = '';
    aiSummary   = null;
    aiEditTerms = [];
    document.getElementById('aiSummaryBar').style.display  = 'none';
    document.getElementById('aiLoadingPanel').style.display = 'none';
  }
  applyAndRender();
}

