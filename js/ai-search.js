// -- ai-search.js --
// AI semantic search (unified bar): query expansion, S2 fetch, re-ranking.
// Functions: initAiSearchBtn, renderRecentSearches,
//            saveRecentSearch, removeRecentSearch, renderKeywordContextHint,
//            runAiSearch, cancelAiSearch, clearAiResults, setPipelineStep,
//            renderMixedFeed, showSummaryBar, toggleSummaryBar, toggleEditTerms,
//            renderEditChips, rerunWithEditedTerms, saveAiTermsAsKeywords, showAiEmptyState
// -----


// ════════════════════════════════════════════════════════════
//  AI SEARCH — UNIFIED INPUT WIRING
// ════════════════════════════════════════════════════════════

function initAiSearchBtn() {
  // The aiSearchBtn click + searchInput keydown are wired in app.js bindEvents().
  // This function wires the remaining AI panel controls.
  document.getElementById('aiCancelBtn').addEventListener('click', cancelAiSearch);
  document.getElementById('aiClearBtn').addEventListener('click', clearAiResults);
  document.getElementById('aiSummaryHeader').addEventListener('click', toggleSummaryBar);
  document.getElementById('aiEditTermsBtn').addEventListener('click', e => {
    e.stopPropagation(); // don't trigger header collapse
    toggleEditTerms();
  });
  document.getElementById('aiSaveKwBtn').addEventListener('click', saveAiTermsAsKeywords);
  document.getElementById('aiRerunBtn').addEventListener('click', rerunWithEditedTerms);

  // Show recent searches dropdown on input focus (when history exists)
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('focus', () => {
      renderRecentSearches();
      const container = document.getElementById('aiRecentSearches');
      if (container && container.innerHTML.trim()) container.style.display = '';
    });
    // Hide dropdown on blur (small delay so click on item fires first)
    searchInput.addEventListener('blur', () => {
      setTimeout(() => {
        const container = document.getElementById('aiRecentSearches');
        if (container) container.style.display = 'none';
      }, 200);
    });
  }

  // Also render context hint on init
  renderKeywordContextHint();
}

function renderRecentSearches() {
  const recent    = JSON.parse(localStorage.getItem(AI_RECENT_KEY) || '[]');
  const container = document.getElementById('aiRecentSearches');
  if (!container) return;
  if (!recent.length) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }

  container.innerHTML = recent.map((q, i) => `
    <div class="ai-recent-item" data-idx="${i}">
      <span class="ai-recent-icon">🕐</span>
      <span class="ai-recent-text" title="${esc(q)}">${esc(q.length > 60 ? q.slice(0, 57) + '…' : q)}</span>
      <button class="ai-recent-remove" data-idx="${i}" aria-label="Remove">×</button>
    </div>
  `).join('');

  container.querySelectorAll('.ai-recent-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('ai-recent-remove')) {
        removeRecentSearch(+e.target.dataset.idx);
      } else {
        // Populate the unified search input and trigger AI search
        const input = document.getElementById('searchInput');
        if (input) {
          input.value = recent[+el.dataset.idx];
          input.dispatchEvent(new Event('input')); // update clear/AI button visibility
        }
        container.style.display = 'none';
        runAiSearch(recent[+el.dataset.idx]);
      }
    });
  });
}

function saveRecentSearch(query) {
  let recent = JSON.parse(localStorage.getItem(AI_RECENT_KEY) || '[]');
  recent = [query, ...recent.filter(q => q !== query)].slice(0, AI_MAX_RECENT);
  localStorage.setItem(AI_RECENT_KEY, JSON.stringify(recent));
}

function removeRecentSearch(idx) {
  let recent = JSON.parse(localStorage.getItem(AI_RECENT_KEY) || '[]');
  recent.splice(idx, 1);
  localStorage.setItem(AI_RECENT_KEY, JSON.stringify(recent));
  renderRecentSearches();
}

function renderKeywordContextHint() {
  const hint = document.getElementById('aiContextHint');
  if (!hint) return;
  const kws  = activeKeywords();
  if (!kws.length) { hint.innerHTML = ''; return; }
  const shown = kws.slice(0, 6);
  const more  = kws.length - shown.length;
  hint.innerHTML = 'Your keywords (sent as context): ' +
    shown.map(k => `<span class="matched-kw-tag">${esc(k)}</span>`).join(' ') +
    (more > 0 ? ` <span style="color:var(--text-muted)">+ ${more} more</span>` : '');
}


// ════════════════════════════════════════════════════════════
//  AI SEARCH — MAIN PIPELINE
// ════════════════════════════════════════════════════════════

async function runAiSearch(query) {
  if (aiLoading || !query) return;
  aiLoading = true;
  aiQuery   = query;
  saveRecentSearch(query);

  // Transition to loading view
  document.getElementById('aiLoadingPanel').style.display  = '';
  document.getElementById('aiSummaryBar').style.display    = 'none';
  document.getElementById('aiRecentSearches').style.display = 'none';
  document.getElementById('aiQueryPreview').textContent    =
    `"${query.slice(0, 80)}${query.length > 80 ? '…' : ''}"`;

  setPipelineStep(1, 'active');
  setPipelineStep(2, 'pending');
  setPipelineStep(3, 'pending');
  setPipelineStep(4, 'pending');

  aiAbortCtrl = new AbortController();
  const { signal } = aiAbortCtrl;

  try {
    // ── Step 1 + 2: AI query expansion ──────────────────────
    const expandRes = await fetch(AI_CLAUDE_BASE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'expand', query, keywords: activeKeywords() }),
      signal,
    });
    if (!expandRes.ok) {
      const err = await expandRes.json().catch(() => ({}));
      throw new Error(err.error || `AI search error (${expandRes.status})`);
    }
    const expandData = await expandRes.json();
    // expandData = { searchTerms[], interpretation, suggestions[] }
    aiSummary   = expandData;
    aiEditTerms = [...(expandData.searchTerms || [])];

    setPipelineStep(1, 'done');
    setPipelineStep(2, 'done');
    setPipelineStep(3, 'active');

    // ── Step 3: Parallel Semantic Scholar searches ───────────
    const terms      = (expandData.searchTerms || []).slice(0, 4);
    const seen       = new Set();
    const candidates = [];

    await Promise.all(terms.map(async term => {
      try {
        const batch = await fetchOneKeyword(term); // reuse existing function
        for (const p of batch) {
          if (p.paperId && !seen.has(p.paperId) && p.title) {
            seen.add(p.paperId);
            candidates.push(p);
          }
        }
      } catch (e) {
        console.warn('[AI Search] S2 fetch failed for term:', term, e.message);
      }
    }));

    setPipelineStep(3, 'done');

    if (candidates.length === 0) {
      showAiEmptyState(expandData.suggestions || []);
      return;
    }

    // ── Step 4: AI re-ranking + explanations ─────────────────
    setPipelineStep(4, 'active');

    const top20 = candidates.slice(0, 20).map(p => ({
      paperId:  p.paperId,
      title:    p.title,
      abstract: (p.abstract || '').slice(0, 400),
      authors:  (p.authors || []).map(a => a.name).join(', '),
      year:     p.year,
    }));

    const rankRes = await fetch(AI_CLAUDE_BASE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'rank', query, papers: top20 }),
      signal,
    });
    if (!rankRes.ok) {
      const err = await rankRes.json().catch(() => ({}));
      throw new Error(err.error || `AI ranking error (${rankRes.status})`);
    }
    const rankData = await rankRes.json();
    // rankData = [{ paperId, score, explanation }]

    setPipelineStep(4, 'done');

    // Build a score/explanation lookup
    const rankMap = Object.fromEntries(rankData.map(r => [r.paperId, r]));

    // Merge: filter by min score, attach AI metadata, sort by score desc
    aiPapers = candidates
      .filter(p => rankMap[p.paperId] && rankMap[p.paperId].score >= AI_MIN_SCORE)
      .map(p => ({
        ...p,
        aiScore:       rankMap[p.paperId].score,
        aiExplanation: rankMap[p.paperId].explanation || '',
        source:        'ai',
        score:         Math.max(1, Math.round(rankMap[p.paperId].score / 2)), // map 1-10 → 1-5
      }))
      .sort((a, b) => b.aiScore - a.aiScore);

    if (aiPapers.length === 0) {
      showAiEmptyState(expandData.suggestions || []);
      return;
    }

    showSummaryBar();

  } catch (err) {
    if (err.name === 'AbortError') {
      // User cancelled — input still has the query text, just hide loading
    } else {
      console.error('[AI Search] Error:', err);
      setStatus('AI search failed: ' + err.message, true);
    }
  } finally {
    aiLoading = false;
    document.getElementById('aiLoadingPanel').style.display = 'none';
  }
}

function cancelAiSearch() {
  if (aiAbortCtrl) aiAbortCtrl.abort();
  aiLoading = false;
  document.getElementById('aiLoadingPanel').style.display = 'none';
  // Leave search input as-is so user can see / edit the query
}

function clearAiResults() {
  aiPapers    = [];
  aiQuery     = '';
  aiSummary   = null;
  aiEditTerms = [];
  // Hide AI UI and restore keyword feed
  document.getElementById('aiSummaryBar').style.display   = 'none';
  document.getElementById('aiLoadingPanel').style.display  = 'none';
  applyAndRender();
}

function setPipelineStep(stepNum, state) {
  const el = document.getElementById(`step${stepNum}`);
  if (!el) return;
  // Build the icon based on state
  let icon;
  if (state === 'active')  icon = '<span class="ai-spinner"></span>';
  else if (state === 'done')   icon = '✓';
  else if (state === 'failed') icon = '✗';
  else                         icon = '○';

  el.className = `pipeline-step ${state}`;
  // Replace or create icon span
  let iconEl = el.querySelector('.pipeline-step-icon');
  if (!iconEl) {
    iconEl = document.createElement('span');
    iconEl.className = 'pipeline-step-icon';
    el.prepend(iconEl);
  }
  iconEl.innerHTML = icon;
}


// ════════════════════════════════════════════════════════════
//  AI SEARCH — MIXED FEED RENDERING
// ════════════════════════════════════════════════════════════

function renderMixedFeed() {
  // AI papers at top (sorted by aiScore), keyword papers below in their normal order
  const keywordPapers = applyFiltersAndSort(allPapers).map(p => ({ ...p, source: 'keywords' }));
  const combined      = [...aiPapers, ...keywordPapers];

  const feed = document.getElementById('paperFeed');
  if (combined.length === 0) {
    feed.innerHTML = '<p style="color:var(--text-muted);padding:32px 0;text-align:center;">No papers to show.</p>';
    return;
  }
  feed.innerHTML = combined.map(p => buildPaperCardHtml(p)).join('');
  bindCardActions();
}


// ════════════════════════════════════════════════════════════
//  AI SEARCH — SUMMARY BAR
// ════════════════════════════════════════════════════════════

function showSummaryBar() {
  // Populate interpretation
  const interpEl = document.getElementById('aiSummaryInterp');
  if (interpEl) {
    interpEl.textContent = aiSummary?.interpretation
      ? `Interpreted as: ${aiSummary.interpretation}`
      : '';
  }

  // Populate term chips (read-only view)
  const termsEl = document.getElementById('aiSummaryTerms');
  if (termsEl) {
    termsEl.innerHTML = (aiSummary?.searchTerms || [])
      .map(t => `<span class="ai-term-chip">${esc(t)}</span>`).join('');
  }

  // Reset edit panel to hidden
  const editPanel = document.getElementById('aiEditTermsPanel');
  if (editPanel) editPanel.style.display = 'none';

  // Show the bar
  const bar = document.getElementById('aiSummaryBar');
  if (bar) bar.style.display = '';

  // Hide loading panel
  document.getElementById('aiLoadingPanel').style.display = 'none';

  // Render the mixed feed
  renderMixedFeed();
}

function toggleSummaryBar(e) {
  // Don't collapse when clicking the action buttons
  if (e.target.closest('.ai-summary-actions')) return;
  const body    = document.getElementById('aiSummaryBody');
  const chevron = document.getElementById('aiSummaryChevron');
  const expanded = body.classList.contains('expanded');
  body.classList.toggle('expanded', !expanded);
  chevron.textContent = expanded ? '▾' : '▴';
}

function toggleEditTerms() {
  const panel   = document.getElementById('aiEditTermsPanel');
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? '' : 'none';
  if (isHidden) {
    // Also expand the summary body so edit panel is visible
    document.getElementById('aiSummaryBody').classList.add('expanded');
    document.getElementById('aiSummaryChevron').textContent = '▴';
    renderEditChips();
  }
}

function renderEditChips() {
  const container = document.getElementById('aiEditChips');
  if (!container) return;

  container.innerHTML = aiEditTerms.map((t, i) => `
    <span class="ai-edit-chip">
      ${esc(t)}
      <button class="ai-edit-chip-remove" data-idx="${i}" aria-label="Remove ${esc(t)}">×</button>
    </span>
  `).join('') +
  `<input class="ai-add-term-input" id="aiAddTermInput"
          placeholder="+ Add term" maxlength="60" aria-label="Add search term">`;

  container.querySelectorAll('.ai-edit-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      aiEditTerms.splice(+btn.dataset.idx, 1);
      renderEditChips();
    });
  });

  const addInput = document.getElementById('aiAddTermInput');
  if (addInput) {
    addInput.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ',') && addInput.value.trim()) {
        e.preventDefault();
        aiEditTerms.push(addInput.value.trim());
        renderEditChips();
      }
    });
  }
}

async function rerunWithEditedTerms() {
  // PM decision: re-run goes direct to S2, no Claude re-ranking
  if (!aiEditTerms.length) return;
  setStatus('Fetching papers with updated terms…');

  const seen       = new Set();
  const candidates = [];

  await Promise.all(aiEditTerms.slice(0, 4).map(async term => {
    try {
      const batch = await fetchOneKeyword(term);
      for (const p of batch) {
        if (p.paperId && !seen.has(p.paperId) && p.title) {
          seen.add(p.paperId);
          candidates.push(p);
        }
      }
    } catch (e) { /* skip failed terms silently */ }
  }));

  // Show results without AI score/explanation (raw S2 results)
  aiPapers = candidates.map(p => ({
    ...p,
    source:        'ai',
    aiScore:       5,   // neutral mid score
    aiExplanation: '',  // no explanation for direct S2 results
    score:         scoreWithSignals(p),
  }));

  // Update displayed terms in summary bar
  if (aiSummary) aiSummary.searchTerms = [...aiEditTerms];
  const termsEl = document.getElementById('aiSummaryTerms');
  if (termsEl) {
    termsEl.innerHTML = aiEditTerms
      .map(t => `<span class="ai-term-chip">${esc(t)}</span>`).join('');
  }

  // Close edit panel
  const editPanel = document.getElementById('aiEditTermsPanel');
  if (editPanel) editPanel.style.display = 'none';

  setStatus('');
  renderMixedFeed();
}

function saveAiTermsAsKeywords() {
  const existing = new Set(keywords.map(k => k.text.toLowerCase()));
  const toAdd    = aiEditTerms.filter(t => !existing.has(t.toLowerCase()));
  if (!toAdd.length) {
    showToast('All terms are already in your keywords');
    return;
  }
  toAdd.forEach(t => keywords.push({ text: t, active: true }));
  saveKeywords();
  renderKeywordList();
  showToast(`${toAdd.length} term${toAdd.length > 1 ? 's' : ''} added to your keywords`);
}


// ════════════════════════════════════════════════════════════
//  AI SEARCH — EMPTY STATE
// ════════════════════════════════════════════════════════════

function showAiEmptyState(suggestions) {
  document.getElementById('aiLoadingPanel').style.display = 'none';

  const searchedTerms = (aiSummary?.searchTerms || [])
    .map(t => `<span class="ai-term-chip">${esc(t)}</span>`).join(' ');

  const suggestionsHtml = suggestions.length ? `
    <div style="margin-top:16px;text-align:left;">
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:8px;">Try a broader question:</p>
      <ul class="ai-suggestion-list">
        ${suggestions.map(s => `
          <li class="ai-suggestion-row">
            <span style="font-size:14px;">${esc(s)}</span>
            <button class="btn-ghost ai-suggestion-btn" data-query="${esc(s)}">Search</button>
          </li>`).join('')}
      </ul>
    </div>` : '';

  const feed = document.getElementById('paperFeed');
  feed.innerHTML = `
    <div class="ai-empty-state">
      <h3>No relevant papers found for this query.</h3>
      <p style="color:var(--text-muted);font-size:14px;margin-top:6px;">
        AI searched for: ${searchedTerms}
      </p>
      ${suggestionsHtml}
      <p style="margin-top:20px;font-size:13px;color:var(--text-muted);">
        Or <button class="btn-text" id="aiReturnToKwBtn">return to keyword feed</button>
      </p>
    </div>`;

  // Wire suggestion buttons — populate unified input and auto-submit
  feed.querySelectorAll('.ai-suggestion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const q      = btn.dataset.query;
      const input  = document.getElementById('searchInput');
      if (input) {
        input.value = q;
        input.dispatchEvent(new Event('input')); // refresh AI button state
      }
      runAiSearch(q);
    });
  });

  // Return to keyword feed: clear AI state and restore normal feed
  document.getElementById('aiReturnToKwBtn')?.addEventListener('click', clearAiResults);
}


// ════════════════════════════════════════════════════════════
//  FILTER PANEL
// ════════════════════════════════════════════════════════════

// Renders ALL filter groups from scratch.
// Called on init and whenever keyword list changes.
