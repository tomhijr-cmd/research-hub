// -- feed-filters.js --
// Feed filtering, sorting logic, and filter panel rendering.
// Functions: applyAndRender, applyFiltersAndSort, all applyXxx filter fns,
//            renderFilterPanel and sub-renderers, clearAllFilters
// -----

function applyAndRender() {
  papers    = applyFiltersAndSort(allPapers);
  pageIndex = 0;
  renderPapers();
}

// Chains all 6 filter steps then sort. Returns a new array (never mutates input).
function applyFiltersAndSort(arr) {
  let result = arr.slice(); // shallow copy — safe because we never mutate paper objects
  result = applySearchFilter(result, searchQuery);
  result = applyScoreFilter(result, filterState.scores);
  result = applyDateFilter(result, filterState.dateRange);
  result = applyStatusFilter(result, filterState.status, userActions);
  result = applyKeywordFilter(result, filterState.keywords);
  result = applyCitationFilter(result, filterState.citations);
  result = applyInflCitationFilter(result, filterState.inflCitations);
  result = applyVelocityFilter(result, filterState.velocity);
  result = applyOpenAccessFilter(result, filterState.openAccess);
  result = applyPubTypeFilter(result, filterState.pubType);
  result = applyFieldsFilter(result, filterState.fields);
  // Unless "show hidden" is on, remove hidden papers from the default view
  if (!showHidden) {
    result = result.filter(p => !userActions[p.paperId]?.hidden);
  }
  // Papers in the reading list are moved there — exclude from main feed
  // (like signal is preserved; this is purely a UI routing decision)
  result = result.filter(p => !readingList.some(e => e.paper.paperId === p.paperId));
  result = applySortOrder(result, sortOrder);
  return result;
}

// Full-text search across title, abstract, authors (case-insensitive substring).
function applySearchFilter(arr, q) {
  if (!q || !q.trim()) return arr;
  const term = q.trim().toLowerCase();
  return arr.filter(p => {
    const title    = (p.title    || '').toLowerCase();
    const abstract = (p.abstract || '').toLowerCase();
    const authors  = (p.authors  || []).map(a => (a.name || '').toLowerCase()).join(' ');
    return title.includes(term) || abstract.includes(term) || authors.includes(term);
  });
}

// Keep only papers whose score is in the allowed scores array.
function applyScoreFilter(arr, scores) {
  if (!scores || scores.length === 5) return arr; // all selected = no filter
  return arr.filter(p => scores.includes(p.score));
}

// Filter by publication date using paper.publicationDate (YYYY-MM-DD).
// Falls back to paper.year if publicationDate is absent.
function applyDateFilter(arr, range) {
  if (range === 'all') return arr;

  const now = Date.now();
  const cutoffMs = {
    '7d':  7  * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
    '90d': 90 * 24 * 60 * 60 * 1000,
    '1y':  365 * 24 * 60 * 60 * 1000,
  }[range];

  if (!cutoffMs) return arr;
  const cutoff = now - cutoffMs;

  return arr.filter(p => {
    // Prefer full date, fall back to year-only
    const dateStr = p.publicationDate || (p.year ? `${p.year}-01-01` : null);
    if (!dateStr) return false;
    const ts = new Date(dateStr).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });
}

// Filter by status: all / unread / liked / saved / hidden
function applyStatusFilter(arr, status, actions) {
  if (status === 'all') return arr;
  return arr.filter(p => {
    const a = actions[p.paperId] || {};
    if (status === 'liked')  return !!a.liked;
    if (status === 'saved')  return !!a.saved;
    if (status === 'hidden') return !!a.hidden;
    if (status === 'unread') return !seenPaperIds.has(p.paperId);
    return true;
  });
}

// Keep papers that match at least one of the selected keyword filters.
// Empty array = no keyword filter (show all).
function applyKeywordFilter(arr, kws) {
  if (!kws || kws.length === 0) return arr;
  const kwsLower = kws.map(k => k.toLowerCase());
  return arr.filter(p => {
    const text = ((p.title || '') + ' ' + (p.abstract || '')).toLowerCase();
    return kwsLower.some(kw => text.includes(kw));
  });
}

// Keep papers where citationCount >= min (undefined/null treated as 0).
function applyCitationFilter(arr, min) {
  if (!min || min === 0) return arr;
  return arr.filter(p => (p.citationCount || 0) >= min);
}

// ── Citation velocity helpers ─────────────────────────────────
// Returns citations per year since publication. Papers published this year
// get a minimum age of 1 to avoid division-by-zero / inflation.
function citationVelocity(paper) {
  const count   = paper.citationCount || 0;
  const pubYear = paper.publicationDate
    ? new Date(paper.publicationDate).getFullYear()
    : (paper.year || null);
  if (!pubYear) return 0;
  const yearsOld = Math.max(1, new Date().getFullYear() - pubYear + 1);
  return count / yearsOld;
}

// Returns 'trending' (≥20/yr) | 'growing' (5-20/yr) | 'stable' (<5/yr)
function velocityLabel(paper) {
  const v = citationVelocity(paper);
  if (v >= 20) return 'trending';
  if (v >= 5)  return 'growing';
  return 'stable';
}

// ── New filter functions ──────────────────────────────────────

// Keep papers where influentialCitationCount >= min.
function applyInflCitationFilter(arr, min) {
  if (!min || min === 0) return arr;
  return arr.filter(p => (p.influentialCitationCount || 0) >= min);
}

// Keep papers whose citation velocity matches the given label.
// 'any' returns all papers unchanged.
function applyVelocityFilter(arr, v) {
  if (!v || v === 'any') return arr;
  return arr.filter(p => velocityLabel(p) === v);
}

// Keep open-access papers only (when oa === true).
function applyOpenAccessFilter(arr, oa) {
  if (!oa) return arr;
  return arr.filter(p => !!p.isOpenAccess);
}

// Keep papers matching the publication type.
// Uses publicationVenue.type from Semantic Scholar; falls back to ArXiv
// external ID for preprints that have no venue set.
function applyPubTypeFilter(arr, type) {
  if (!type || type === 'all') return arr;
  return arr.filter(p => {
    const venueType = (p.publicationVenue?.type || '').toLowerCase();
    if (type === 'journal')    return venueType.includes('journal');
    if (type === 'conference') return venueType.includes('conference') || venueType.includes('workshop');
    if (type === 'preprint')   return venueType.includes('preprint') || venueType.includes('arxiv') ||
                                      (p.externalIds?.ArXiv && !venueType);
    return true;
  });
}

// Keep papers that have at least one fieldsOfStudy value matching the
// selected fields array. [] = no filter (return all).
function applyFieldsFilter(arr, fields) {
  if (!fields || fields.length === 0) return arr;
  const fLower = fields.map(f => f.toLowerCase());
  return arr.filter(p =>
    (p.fieldsOfStudy || []).some(f => fLower.includes(f.toLowerCase()))
  );
}

// Sort a copy of the array by the given order. Does NOT mutate input.
function applySortOrder(arr, order) {
  const a = arr.slice();
  if (order === 'newest') {
    return a.sort((x, y) => {
      const dx = x.publicationDate || (x.year ? `${x.year}-12-31` : '0000-01-01');
      const dy = y.publicationDate || (y.year ? `${y.year}-12-31` : '0000-01-01');
      return dy.localeCompare(dx);
    });
  }
  if (order === 'oldest') {
    return a.sort((x, y) => {
      const dx = x.publicationDate || (x.year ? `${x.year}-01-01` : '9999-12-31');
      const dy = y.publicationDate || (y.year ? `${y.year}-01-01` : '9999-12-31');
      return dx.localeCompare(dy);
    });
  }
  if (order === 'relevance') {
    return a.sort((x, y) => y.score - x.score);
  }
  if (order === 'cited') {
    return a.sort((x, y) => (y.citationCount || 0) - (x.citationCount || 0));
  }
  if (order === 'influential') {
    return a.sort((x, y) => (y.influentialCitationCount || 0) - (x.influentialCitationCount || 0));
  }
  if (order === 'trending') {
    return a.sort((x, y) => citationVelocity(y) - citationVelocity(x));
  }
  return a;
}

// Returns the active keyword phrases found in a paper's title+abstract.
function getMatchedKeywords(paper) {
  const active = activeKeywords();
  if (!active.length) return [];
  const text = ((paper.title || '') + ' ' + (paper.abstract || '')).toLowerCase();
  return active.filter(kw => text.includes(kw.toLowerCase()));
}

// Wrap each occurrence of query in the pre-escaped text with <mark>.
// IMPORTANT: text must already be HTML-escaped before calling this function.
// We never inject user input as HTML — only hard-coded <mark> tags are inserted.
function highlightSearchTerms(text, q) {
  if (!q || !q.trim()) return text;
  // Escape regex special characters so they're treated as literals
  const escaped = q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex   = new RegExp(escaped, 'gi');
  return text.replace(regex, match => `<mark class="search-highlight">${match}</mark>`);
}


// ════════════════════════════════════════════════════════════
//  API FETCH
// ════════════════════════════════════════════════════════════

function renderFilterPanel() {
  renderScoreFilterGroup();
  renderDateFilterGroup();
  renderStatusFilterGroup();
  renderKeywordFilterGroup();
  renderCitationFilterGroup();
  renderInflCitationFilterGroup();
  renderVelocityFilterGroup();
  renderOpenAccessFilterGroup();
  renderPubTypeFilterGroup();
  renderFieldsFilterGroup();
  renderActiveFilterTags();

  // Auto-expand advanced section if any advanced filter is currently active,
  // so users returning with an active filter don't lose their context.
  const hasAdvancedActive =
    (filterState.keywords     && filterState.keywords.length > 0)   ||
    filterState.citations     > 0                                    ||
    filterState.inflCitations > 0                                    ||
    (filterState.velocity     && filterState.velocity !== 'any')     ||
    filterState.openAccess                                           ||
    (filterState.pubType      && filterState.pubType !== 'all')      ||
    (filterState.fields       && filterState.fields.length > 0);

  const advSec = document.getElementById('filterAdvancedSection');
  const advBtn = document.getElementById('filterAdvancedToggle');
  if (advSec && advBtn && hasAdvancedActive) {
    advSec.style.display = 'flex';
    advBtn.textContent   = 'Advanced filters ▴';
  }
}

function renderScoreFilterGroup() {
  const el = document.getElementById('scoreFilterGroup');
  if (!el) return;
  el.innerHTML = [1, 2, 3, 4, 5].map(s => `
    <label class="filter-option-label">
      <input type="checkbox" value="${s}"
             ${filterState.scores.includes(s) ? 'checked' : ''}
             data-filter="score">
      ★${s}
    </label>
  `).join('');

  el.querySelectorAll('input[data-filter="score"]').forEach(inp => {
    inp.addEventListener('change', () => {
      const checked = [...el.querySelectorAll('input[data-filter="score"]')]
        .filter(i => i.checked).map(i => Number(i.value));
      filterState.scores = checked.length ? checked : [1, 2, 3, 4, 5];
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

function renderDateFilterGroup() {
  const el = document.getElementById('dateFilterGroup');
  if (!el) return;
  const options = [
    { val: 'all',  label: 'All time' },
    { val: '7d',   label: 'Last 7 days' },
    { val: '30d',  label: 'Last 30 days' },
    { val: '90d',  label: 'Last 3 months' },
    { val: '1y',   label: 'Last year' },
  ];
  el.innerHTML = options.map(o => `
    <label class="filter-option-label">
      <input type="radio" name="dateFilter" value="${o.val}"
             ${filterState.dateRange === o.val ? 'checked' : ''}
             data-filter="date">
      ${o.label}
    </label>
  `).join('');

  el.querySelectorAll('input[data-filter="date"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.dateRange = inp.value;
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

function renderStatusFilterGroup() {
  const el = document.getElementById('statusFilterGroup');
  if (!el) return;
  const options = [
    { val: 'all',    label: 'All' },
    { val: 'unread', label: 'Unread' },
    { val: 'liked',  label: 'Liked' },
    { val: 'saved',  label: 'Saved' },
    { val: 'hidden', label: 'Hidden' },
  ];
  el.innerHTML = options.map(o => `
    <label class="filter-option-label">
      <input type="radio" name="statusFilter" value="${o.val}"
             ${filterState.status === o.val ? 'checked' : ''}
             data-filter="status">
      ${o.label}
    </label>
  `).join('');

  el.querySelectorAll('input[data-filter="status"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.status = inp.value;
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

// Re-renders only the keyword filter group (called when keywords change).
function renderKeywordFilterGroup() {
  const el = document.getElementById('keywordFilterGroup');
  if (!el) return;
  const active = activeKeywords();
  if (active.length === 0) {
    el.innerHTML = '<span style="font-size:0.75rem; color:var(--text-muted)">No active keywords</span>';
    return;
  }
  el.innerHTML = active.map(kw => `
    <label class="filter-option-label">
      <input type="checkbox" value="${esc(kw)}"
             ${filterState.keywords.includes(kw) ? 'checked' : ''}
             data-filter="keyword">
      ${esc(kw)}
    </label>
  `).join('');

  el.querySelectorAll('input[data-filter="keyword"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.keywords = [...el.querySelectorAll('input[data-filter="keyword"]')]
        .filter(i => i.checked).map(i => i.value);
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

function renderCitationFilterGroup() {
  const el = document.getElementById('citationFilterGroup');
  if (!el) return;
  const options = [
    { val: 0,   label: 'Any' },
    { val: 10,  label: '≥10' },
    { val: 50,  label: '≥50' },
    { val: 100, label: '≥100' },
    { val: 500, label: '≥500' },
  ];
  el.innerHTML = options.map(o => `
    <label class="filter-option-label">
      <input type="radio" name="citationFilter" value="${o.val}"
             ${filterState.citations === o.val ? 'checked' : ''}
             data-filter="citation">
      ${o.label}
    </label>
  `).join('');

  el.querySelectorAll('input[data-filter="citation"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.citations = Number(inp.value);
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

function renderInflCitationFilterGroup() {
  const el = document.getElementById('inflCitationFilterGroup');
  if (!el) return;
  const options = [
    { val: 0,  label: 'Any' },
    { val: 5,  label: '≥5' },
    { val: 10, label: '≥10' },
    { val: 25, label: '≥25' },
  ];
  el.innerHTML = options.map(o => `
    <label class="filter-option-label">
      <input type="radio" name="inflCitationFilter" value="${o.val}"
             ${filterState.inflCitations === o.val ? 'checked' : ''}
             data-filter="inflCitation">
      ${o.label}
    </label>
  `).join('');
  el.querySelectorAll('input[data-filter="inflCitation"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.inflCitations = Number(inp.value);
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

function renderVelocityFilterGroup() {
  const el = document.getElementById('velocityFilterGroup');
  if (!el) return;
  const options = [
    { val: 'any',      label: 'Any' },
    { val: 'trending', label: '🔥 Trending (≥20/yr)' },
    { val: 'growing',  label: '↗ Growing (5–20/yr)' },
    { val: 'stable',   label: '→ Stable (<5/yr)' },
  ];
  el.innerHTML = options.map(o => `
    <label class="filter-option-label">
      <input type="radio" name="velocityFilter" value="${o.val}"
             ${filterState.velocity === o.val ? 'checked' : ''}
             data-filter="velocity">
      ${o.label}
    </label>
  `).join('');
  el.querySelectorAll('input[data-filter="velocity"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.velocity = inp.value;
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

function renderOpenAccessFilterGroup() {
  const el = document.getElementById('openAccessFilterGroup');
  if (!el) return;
  el.innerHTML = `
    <label class="filter-option-label">
      <input type="checkbox" data-filter="openAccess"
             ${filterState.openAccess ? 'checked' : ''}>
      🔓 Open Access only
    </label>`;
  el.querySelector('input[data-filter="openAccess"]').addEventListener('change', (e) => {
    filterState.openAccess = e.target.checked;
    renderActiveFilterTags();
    applyAndRender();
  });
}

function renderPubTypeFilterGroup() {
  const el = document.getElementById('pubTypeFilterGroup');
  if (!el) return;
  const options = [
    { val: 'all',        label: 'All' },
    { val: 'journal',    label: 'Journal' },
    { val: 'conference', label: 'Conference' },
    { val: 'preprint',   label: 'Preprint' },
  ];
  el.innerHTML = options.map(o => `
    <label class="filter-option-label">
      <input type="radio" name="pubTypeFilter" value="${o.val}"
             ${filterState.pubType === o.val ? 'checked' : ''}
             data-filter="pubType">
      ${o.label}
    </label>
  `).join('');
  el.querySelectorAll('input[data-filter="pubType"]').forEach(inp => {
    inp.addEventListener('change', () => {
      filterState.pubType = inp.value;
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

// Renders checkboxes for all unique fields of study present in allPapers.
function renderFieldsFilterGroup() {
  const el = document.getElementById('fieldsFilterGroup');
  if (!el) return;

  // Collect unique fields from current allPapers, sorted alphabetically (max 15)
  const fieldSet = new Set();
  allPapers.forEach(p => (p.fieldsOfStudy || []).forEach(f => fieldSet.add(f)));
  const allFields = [...fieldSet].sort().slice(0, 15);

  if (allFields.length === 0) {
    el.innerHTML = '<span style="color:var(--text-muted);font-size:0.78rem">No papers loaded yet</span>';
    return;
  }

  el.innerHTML = allFields.map(f => `
    <label class="filter-option-label">
      <input type="checkbox" data-filter="field" value="${esc(f)}"
             ${filterState.fields.includes(f) ? 'checked' : ''}>
      ${esc(f)}
    </label>
  `).join('');

  el.querySelectorAll('input[data-filter="field"]').forEach(inp => {
    inp.addEventListener('change', () => {
      if (inp.checked) {
        if (!filterState.fields.includes(inp.value)) {
          filterState.fields = [...filterState.fields, inp.value];
        }
      } else {
        filterState.fields = filterState.fields.filter(f => f !== inp.value);
      }
      renderActiveFilterTags();
      applyAndRender();
    });
  });
}

// Build the active filter tag data: each non-default filter gets a pill.
function buildActiveFilterTags() {
  const tags = [];

  if (searchQuery) {
    tags.push({ label: `Search: "${searchQuery}"`, clearFn: clearSearch });
  }
  if (filterState.scores.length < 5) {
    const label = 'Score: ' + filterState.scores.map(s => '★' + s).join(' ');
    tags.push({ label, clearFn: () => {
      filterState.scores = [1, 2, 3, 4, 5];
      renderFilterPanel(); applyAndRender();
    }});
  }
  if (filterState.dateRange !== 'all') {
    const labels = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 3 months', '1y': 'Last year' };
    tags.push({ label: labels[filterState.dateRange] || filterState.dateRange, clearFn: () => {
      filterState.dateRange = 'all'; renderFilterPanel(); applyAndRender();
    }});
  }
  if (filterState.status !== 'all') {
    tags.push({ label: `Status: ${filterState.status}`, clearFn: () => {
      filterState.status = 'all'; renderFilterPanel(); applyAndRender();
    }});
  }
  filterState.keywords.forEach(kw => {
    tags.push({ label: `Keyword: ${kw}`, clearFn: () => {
      filterState.keywords = filterState.keywords.filter(k => k !== kw);
      renderFilterPanel(); applyAndRender();
    }});
  });
  if (filterState.citations > 0) {
    tags.push({ label: `Citations ≥${filterState.citations}`, clearFn: () => {
      filterState.citations = 0; renderFilterPanel(); applyAndRender();
    }});
  }
  if (filterState.inflCitations > 0) {
    tags.push({ label: `Influential ≥${filterState.inflCitations}`, clearFn: () => {
      filterState.inflCitations = 0; renderFilterPanel(); applyAndRender();
    }});
  }
  if (filterState.velocity !== 'any') {
    const velLabels = { trending: '🔥 Trending', growing: '↗ Growing', stable: '→ Stable' };
    tags.push({ label: `Velocity: ${velLabels[filterState.velocity] || filterState.velocity}`, clearFn: () => {
      filterState.velocity = 'any'; renderFilterPanel(); applyAndRender();
    }});
  }
  if (filterState.openAccess) {
    tags.push({ label: '🔓 Open Access only', clearFn: () => {
      filterState.openAccess = false; renderFilterPanel(); applyAndRender();
    }});
  }
  if (filterState.pubType !== 'all') {
    const typeLabels = { journal: 'Journal', conference: 'Conference', preprint: 'Preprint' };
    tags.push({ label: `Type: ${typeLabels[filterState.pubType] || filterState.pubType}`, clearFn: () => {
      filterState.pubType = 'all'; renderFilterPanel(); applyAndRender();
    }});
  }
  filterState.fields.forEach(f => {
    tags.push({ label: `Field: ${f}`, clearFn: () => {
      filterState.fields = filterState.fields.filter(x => x !== f);
      renderFilterPanel(); applyAndRender();
    }});
  });
  return tags;
}

// Render the pill tags row and update badge count.
function renderActiveFilterTags() {
  const container = document.getElementById('activeFilterTags');
  const badge     = document.getElementById('filterActiveCount');
  const clearBtn  = document.getElementById('clearAllFiltersBtn');
  if (!container) return;

  const tags = buildActiveFilterTags();

  if (tags.length === 0) {
    container.innerHTML = '';
    badge.style.display    = 'none';
    clearBtn.style.display = 'none';
    return;
  }

  badge.textContent  = tags.length;
  badge.style.display    = 'inline-block';
  clearBtn.style.display = 'inline-block';

  container.innerHTML = tags.map((t, i) => `
    <span class="filter-tag">
      ${esc(t.label)}
      <button class="filter-tag-remove" data-tag-idx="${i}" aria-label="Remove filter">×</button>
    </span>
  `).join('');

  container.querySelectorAll('.filter-tag-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      tags[parseInt(btn.dataset.tagIdx)].clearFn();
    });
  });
}

// Reset all filters and search to defaults.
function clearAllFilters() {
  filterState = {
    scores:        [1, 2, 3, 4, 5],
    dateRange:     'all',
    status:        'all',
    keywords:      [],
    citations:     0,
    inflCitations: 0,
    velocity:      'any',
    openAccess:    false,
    pubType:       'all',
    fields:        [],
  };
  searchQuery = '';
  sortOrder   = 'newest';
  pageIndex   = 0;
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  document.getElementById('searchClearBtn').style.display = 'none';
  document.getElementById('sortSelect').value = 'newest';
  renderFilterPanel();
  applyAndRender();
}


// ════════════════════════════════════════════════════════════
//  USER ACTIONS: Like / Save / Hide / Copy citation
// ════════════════════════════════════════════════════════════

// Show a contextual sign-in popover anchored above the clicked action button.
// Triggered when a signed-out user clicks Like, Save, or Hide.
