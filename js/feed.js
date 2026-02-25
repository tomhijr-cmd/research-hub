// -- feed.js --
// Paper feed rendering: card HTML builder, feed header, pagination, visibility.
// Functions: renderFeedHeader, buildPaperCardHtml, renderPapers, renderEmptyState,
//            maybeShowScoreExplainer, startVisibilityTracking, bindCardActions, loadMorePapers
// -----

function renderFeedHeader() {
  const countEl    = document.getElementById('feedCount');
  const badgeEl    = document.getElementById('unreadBadge');
  const refreshEl  = document.getElementById('feedLastRefreshed');

  if (countEl) {
    countEl.textContent = papers.length === 0
      ? 'No papers'
      : `${papers.length} paper${papers.length !== 1 ? 's' : ''}`;
  }

  // Unread = papers in current allPapers that weren't in last session's seenPaperIds
  const unreadCount = allPapers.filter(p => p.paperId && !seenPaperIds.has(p.paperId)).length;
  // (seenPaperIds is updated AFTER render, so new papers show as unread in this session)
  if (badgeEl) {
    if (unreadCount > 0) {
      badgeEl.textContent  = `${unreadCount} new`;
      badgeEl.style.display = 'inline-block';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  if (refreshEl) {
    try {
      const ts = localStorage.getItem(LAST_FETCH_KEY);
      refreshEl.textContent = ts ? `Updated ${friendlyTime(new Date(ts))}` : '';
    } catch (e) { refreshEl.textContent = ''; }
  }
}

// Build the HTML string for one paper card.
function buildPaperCardHtml(paper) {
  const paperId  = paper.paperId || '';
  const paperUrl = paper.url ||
    (paper.externalIds?.DOI
      ? `https://doi.org/${paper.externalIds.DOI}`
      : `https://www.semanticscholar.org/paper/${paperId}`);

  // ── Authors ─────────────────────────────────────────────────
  const authorsList   = paper.authors || [];
  const firstAuthor   = authorsList[0]?.name || 'Unknown author';
  const firstAuthorId = authorsList[0]?.authorId || '';
  const authorCount   = authorsList.length;
  const authorProfileUrl = firstAuthorId
    ? `https://www.semanticscholar.org/author/${firstAuthorId}`
    : `https://www.semanticscholar.org/search?q=${encodeURIComponent(firstAuthor)}&sort=Relevance`;

  // ── Year + "N yrs ago" ──────────────────────────────────────
  const pubYear = paper.publicationDate
    ? new Date(paper.publicationDate).getFullYear()
    : (paper.year || null);
  const yearDisplay = paper.publicationDate
    ? paper.publicationDate.slice(0, 7)  // "YYYY-MM"
    : (paper.year ? String(paper.year) : 'Year unknown');
  const currentYear = new Date().getFullYear();
  const yearsAgoStr = pubYear && pubYear < currentYear
    ? ` · ${currentYear - pubYear} yr${currentYear - pubYear === 1 ? '' : 's'} ago`
    : '';

  // ── Open access + PDF ───────────────────────────────────────
  const isOA   = !!paper.isOpenAccess;
  const pdfUrl = paper.openAccessPdf?.url || null;
  const oaBadge = isOA
    ? `<span class="oa-badge" title="Open Access — free to read">🔓</span>`
    : `<span class="oa-badge locked" title="Paywalled">🔒</span>`;
  const pdfLink = pdfUrl
    ? `<a class="pdf-link" href="${esc(pdfUrl)}" target="_blank" rel="noopener">PDF ↗</a>`
    : '';

  // ── Score badge ─────────────────────────────────────────────
  const scoreClass       = paper.score >= 4 ? 'high' : paper.score >= 2 ? 'mid' : '';
  const scoreExplanation = buildScoreExplanation(paper).join('\n');
  const wildcardTipSeen = localStorage.getItem(WILDCARD_TIP_SEEN_KEY);
  const wildcardBadge   = paper.isWildcard
    ? `<span class="wildcard-badge" title="Explore: outside your usual keywords but highly cited">🔍 Explore</span>${
        !wildcardTipSeen
          ? `<span class="wildcard-first-tip">A highly-cited paper outside your keywords, shown for discovery.
               <button onclick="localStorage.setItem('${WILDCARD_TIP_SEEN_KEY}','1');this.closest('.wildcard-first-tip').remove()" title="Dismiss">×</button>
             </span>`
          : ''
      }`
    : '';

  // ── Citation metrics ────────────────────────────────────────
  const citeCount  = typeof paper.citationCount            === 'number' ? paper.citationCount            : null;
  const inflCount  = typeof paper.influentialCitationCount === 'number' ? paper.influentialCitationCount : null;
  // referenceCount is fetched from API but not displayed (manuscript-writing metric, low value for discovery)

  // Colour tier for total citations
  const citeBadgeClass = citeCount === null ? ''
    : citeCount < 10  ? 'cite-grey'
    : citeCount < 50  ? 'cite-blue'
    : citeCount < 200 ? 'cite-green'
    : 'cite-gold';

  // Citation velocity — compute actual rate for the tooltip
  const vel      = velocityLabel(paper);
  const velClass = `velocity-${vel}`;
  const velIcon  = vel === 'trending' ? '🔥' : vel === 'growing' ? '↗' : '→';
  const velText  = vel === 'trending' ? 'Trending' : vel === 'growing' ? 'Growing' : 'Stable';
  const velRate  = citationVelocity(paper);
  const velRateStr = velRate >= 10 ? Math.round(velRate) : velRate.toFixed(1);
  const velTooltip = vel === 'trending'
    ? `🔥 Trending — ${velRateStr} citations/year. This paper is gaining citations rapidly.`
    : vel === 'growing'
    ? `↗ Growing — ${velRateStr} citations/year. Steadily building impact.`
    : `→ Stable — ${velRateStr} citations/year. Cited occasionally but not accelerating.`;
  // Note: Highly Influential badge removed — inflCount already shown inline in metrics row

  // ── Venue ───────────────────────────────────────────────────
  // Venue moves into the meta row (author · date · venue), not the metrics row
  const venueName = paper.publicationVenue?.name || '';
  const venueInMetaHtml = venueName
    ? `&nbsp;·&nbsp; <span class="venue-name" title="${esc(venueName)}">${esc(venueName.length > 40 ? venueName.slice(0, 37) + '…' : venueName)}</span>`
    : '';

  // ── Fields of study (max 3 tags) — shown under "Topics" label ──
  const fields = (paper.fieldsOfStudy || []).slice(0, 3);
  const fieldTagsHtml = fields.length
    ? `<div class="chip-group">
         <span class="chip-group-label">Topics</span>
         <div class="field-tags">${fields.map(f => `<span class="field-tag">${esc(f)}</span>`).join('')}</div>
       </div>`
    : '';

  // ── Metrics row ─────────────────────────────────────────────
  const ssBase     = `https://www.semanticscholar.org/paper/${esc(paperId)}`;
  const citedByUrl = `${ssBase}#citing-papers`;

  const metricsHtml = `
    <div class="paper-metrics">
      ${citeCount !== null
        ? `<a class="metric metric-link ${citeBadgeClass}" href="${citedByUrl}" target="_blank" rel="noopener"
              title="Cited by ${citeCount} paper${citeCount !== 1 ? 's' : ''} — click to see who cited this on Semantic Scholar">📄 ${citeCount} cited</a>`
        : ''}
      ${inflCount !== null
        ? `<span class="metric" title="Influential citations — ${inflCount} paper${inflCount !== 1 ? 's' : ''} that substantially built on this work (Semantic Scholar calculates this separately from total citations)">⭐ ${inflCount} infl.</span>`
        : ''}
      <span class="metric ${velClass}" title="${esc(velTooltip)}">${velIcon} ${velText}</span>
    </div>`;

  // ── Abstract ─────────────────────────────────────────────────
  const rawAbstract  = paper.abstract || '';
  const abstractHtml = rawAbstract
    ? highlightSearchTerms(esc(rawAbstract), searchQuery)
    : '<em style="color:var(--text-muted)">No abstract available.</em>';

  // ── Title ─────────────────────────────────────────────────────
  const titleHtml = highlightSearchTerms(esc(paper.title || 'Untitled'), searchQuery);

  // ── Matched keyword tags — shown under "Your keywords" label ──
  const matched    = getMatchedKeywords(paper);
  const kwTagsHtml = matched.length
    ? `<div class="chip-group">
         <span class="chip-group-label">Your keywords</span>
         <div class="paper-keyword-tags">${matched.map(k => `<span class="matched-kw-tag">${esc(k)}</span>`).join('')}</div>
       </div>`
    : '';

  // ── Unread indicator ─────────────────────────────────────────
  const isUnread = paperId && !seenPaperIds.has(paperId);

  // ── Action buttons — disabled when signed out ─────────────────
  const a           = userActions[paperId] || {};
  const disabledCls = currentUser ? '' : ' disabled-action';

  // SVG icon sets — outline = default, filled = active state
  const svgHeart = a.liked
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> Liked`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> Like`;

  const svgBookmark = a.saved
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Saved`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save`;

  const svgEye = a.hidden
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Unhide`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> Hide`;

  const svgCite = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg> Cite`;

  return `
    <article class="paper-card${isUnread ? ' paper-card--unread' : ''}${paper.isWildcard ? ' paper-card--wildcard' : ''}${paper.source === 'ai' ? ' ai-sourced' : ' keyword-sourced'}" data-paperid="${esc(paperId)}">
      <div class="paper-card-top">
        <h2 class="paper-title">
          <a href="${esc(paperUrl)}" target="_blank" rel="noopener">
            ${titleHtml}
          </a>
        </h2>
        <div class="paper-card-badges">
          ${wildcardBadge}
          ${paper.source === 'ai'
            ? `<span class="source-badge ai">AI Match</span>
               <span class="ai-score ${paper.aiScore >= 7 ? 'high' : paper.aiScore >= 4 ? 'mid' : 'low'}"
                     title="AI relevance score: ${paper.aiScore}/10 for your search question">
                 ◈ ${paper.aiScore}/10
               </span>`
            : `<span class="score-badge ${scoreClass}" title="Relevance score: ${paper.score}/5 (matches your keywords — not a star rating)&#10;${esc(scoreExplanation)}">
                 ★ ${paper.score}/5
               </span>`
          }
        </div>
      </div>
      <div class="paper-meta">
        <a class="author-link" href="${esc(authorProfileUrl)}" target="_blank" rel="noopener"
           title="View author profile on Semantic Scholar">${esc(firstAuthor)}</a>${authorCount > 1
          ? ` <span class="author-count">+${authorCount - 1} author${authorCount > 2 ? 's' : ''}</span>` : ''}
        &nbsp;·&nbsp; ${esc(yearDisplay)}${esc(yearsAgoStr)}
        ${venueInMetaHtml}
        &nbsp; ${oaBadge} ${pdfLink}
      </div>
      <p class="paper-abstract" id="abstract-${esc(paperId)}">${abstractHtml}</p>
      ${rawAbstract.length > 300
        ? `<button class="expand-btn" data-paperid="${esc(paperId)}">Show more</button>`
        : ''}
      ${metricsHtml}
      ${paper.source === 'ai' && paper.aiExplanation
        ? `<div class="why-matches">
             <div class="why-matches-label">Why this matches</div>
             <div class="why-matches-text">${esc(paper.aiExplanation)}</div>
           </div>`
        : ''}
      ${paper.source === 'ai'
        ? (matched.length
            ? `<div class="kw-overlap-section">
                 <span class="kw-overlap-label">Also matches your keywords:</span>
                 ${matched.slice(0, 3).map(k => `<span class="matched-kw-tag">${esc(k)}</span>`).join('')}
               </div>`
            : '')
        : kwTagsHtml}
      ${fieldTagsHtml}
      <div class="paper-actions">
        <button class="action-btn like-btn${a.liked ? ' active' : ''}${disabledCls}"
                data-paperid="${esc(paperId)}" data-action="like"
                title="Like — signals relevance to your interests. Stays in feed.">${svgHeart}</button>
        <button class="action-btn save-btn${a.saved ? ' active' : ''}${disabledCls}"
                data-paperid="${esc(paperId)}" data-action="save"
                title="Save — adds to your Reading List. Removes from feed.">
          <span class="action-btn-hint">Moves to Reading List</span>${svgBookmark}</button>
        <button class="action-btn hide-btn${a.hidden ? ' active' : ''}${disabledCls}"
                data-paperid="${esc(paperId)}" data-action="hide">${svgEye}</button>
        <button class="action-btn copy-btn"
                data-paperid="${esc(paperId)}" data-action="copy">${svgCite}</button>
      </div>
    </article>
  `;
}

// Render the current page slice of papers[] into #paperFeed.
function renderPapers() {
  renderFeedHeader();
  const feed = document.getElementById('paperFeed');

  if (papers.length === 0) {
    feed.innerHTML = renderEmptyState();
    return;
  }

  // Show a paginated slice: first (pageIndex+1)*PAGE_SIZE papers
  const rawSlice = papers.slice(0, (pageIndex + 1) * PAGE_SIZE);
  const hasMore  = papers.length > rawSlice.length;

  // Inject a wildcard paper every 10th slot (index 9, 19, 29...) for diversity
  const slice = rawSlice.slice(); // copy so we don't mutate papers[]
  for (let i = 9; i < slice.length; i += 10) {
    const wildcard = pickWildcard(allPapers, slice);
    if (wildcard) slice.splice(i, 0, wildcard); // insert before pushing index further
  }

  feed.innerHTML = slice.map(p => buildPaperCardHtml(p)).join('') +
    (hasMore ? `
      <div class="feed-load-more">
        <button id="loadMoreBtn">Load more (${papers.length - slice.length} remaining)</button>
      </div>
    ` : '');

  // Bind delegated events
  bindCardActions();

  // Wire up expand buttons — also record expand as a mild positive signal
  feed.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pid   = btn.dataset.paperid;
      const absEl = document.getElementById(`abstract-${pid}`);
      if (!absEl) return;
      const expanded = absEl.classList.toggle('expanded');
      btn.textContent = expanded ? 'Show less' : 'Show more';
      if (expanded) recordSignal(pid, 'expanded', true); // mild +1 signal
    });
  });

  // Track title link clicks as a strong positive signal
  if (!feed._titleClickListener) {
    feed._titleClickListener = (e) => {
      const link = e.target.closest('.paper-title a');
      if (!link) return;
      const card = link.closest('[data-paperid]');
      if (card?.dataset.paperid) {
        recordSignal(card.dataset.paperid, 'clicked', true); // +2 signal
      }
    };
    feed.addEventListener('click', feed._titleClickListener);
  }

  // Time-on-screen tracking via IntersectionObserver
  startVisibilityTracking();

  // Load more button
  const loadMoreBtn = document.getElementById('loadMoreBtn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', loadMorePapers);
  }

  // First-visit score badge explainer (shown once, gated by localStorage)
  maybeShowScoreExplainer();
}

// Show a one-time callout below the first score badge explaining what ★ X/5 means.
// Dismisses permanently when the user clicks "Got it".
function maybeShowScoreExplainer() {
  if (localStorage.getItem(SCORE_TIP_SEEN_KEY)) return;
  const firstBadge = document.querySelector('.paper-card .score-badge');
  if (!firstBadge) return;
  const badgesContainer = firstBadge.closest('.paper-card-badges');
  if (!badgesContainer) return;

  const callout = document.createElement('div');
  callout.className = 'score-explainer-callout';
  callout.innerHTML = `
    <strong>★ X/5</strong> = how closely this paper matches your keywords.
    Not a star rating — generated automatically.
    <button class="score-explainer-dismiss" id="scoreDismissBtn">Got it</button>
  `;
  badgesContainer.appendChild(callout);

  document.getElementById('scoreDismissBtn')?.addEventListener('click', () => {
    localStorage.setItem(SCORE_TIP_SEEN_KEY, '1');
    callout.remove();
  });
}

// Returns an appropriate empty-state HTML string.
function renderEmptyState() {
  if (allPapers.length === 0) {
    return `<div class="empty-state">
      <div class="icon">📄</div>
      No papers found for these keywords. Try adding broader terms or click Refresh.
    </div>`;
  }
  // Papers exist but filters removed all of them
  return `<div class="empty-state">
    <div class="icon">🔍</div>
    No papers match the current filters.
    <br><button class="btn-text" onclick="clearAllFilters()" style="margin-top:8px">Clear filters</button>
  </div>`;
}

// Track how long each paper card is visible on screen.
// Uses IntersectionObserver. Cards must be 50% visible for ≥5 seconds to record.
let _visibilityObserver = null;
const _visibilityTimers = new Map(); // paperId → { startMs, accumulatedMs }

function startVisibilityTracking() {
  // Disconnect old observer if any
  if (_visibilityObserver) _visibilityObserver.disconnect();

  _visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const id = entry.target.dataset?.paperid;
      if (!id) continue;
      if (entry.isIntersecting) {
        // Card entered viewport — start timer
        const prev = _visibilityTimers.get(id) || { startMs: null, accumulatedMs: 0 };
        _visibilityTimers.set(id, { startMs: Date.now(), accumulatedMs: prev.accumulatedMs });
      } else {
        // Card left viewport — accumulate time
        const t = _visibilityTimers.get(id);
        if (t?.startMs) {
          const elapsed = Date.now() - t.startMs;
          const total   = t.accumulatedMs + elapsed;
          _visibilityTimers.set(id, { startMs: null, accumulatedMs: total });
          // Only record signals for meaningful dwell time (≥5 seconds total)
          if (total >= 5000) {
            recordSignal(id, 'secondsVisible', Math.floor(total / 1000));
          }
        }
      }
    }
  }, { threshold: 0.5 }); // fire when ≥50% of card is visible

  document.querySelectorAll('.paper-card[data-paperid]').forEach(el => {
    _visibilityObserver.observe(el);
  });
}

// Single delegated listener for all action buttons in the feed.
function bindCardActions() {
  const feed = document.getElementById('paperFeed');
  // Remove any existing listener by replacing the node (simplest approach for a full re-render)
  // We use a named function stored on the element to avoid double-binding.
  if (feed._actionListener) {
    feed.removeEventListener('click', feed._actionListener);
  }
  feed._actionListener = (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { paperid, action } = btn.dataset;
    if (paperid && action) handlePaperAction(paperid, action);
  };
  feed.addEventListener('click', feed._actionListener);
}

// Increment pageIndex and append the next slice (no scroll reset).
function loadMorePapers() {
  pageIndex++;
  renderPapers();
}


// ── Rendering helpers ─────────────────────────────────────────

