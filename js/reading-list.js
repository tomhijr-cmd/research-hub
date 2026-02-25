// -- reading-list.js --
// Reading list: add, remove, render, sort, and migration from legacy likes.
// Functions: loadReadingList, saveReadingList, updateReadingListBadge,
//            addToReadingList, removeFromReadingList, openReadingListView,
//            closeReadingListView, migrateOldLikesToReadingList,
//            buildRlCardHtml, renderReadingList
// -----

function loadReadingList() {
  try {
    readingList = JSON.parse(localStorage.getItem(READING_LIST_KEY) || '[]');
  } catch { readingList = []; }
  updateReadingListBadge();
}

// Persist reading list to localStorage and refresh the badge.
function saveReadingList() {
  localStorage.setItem(READING_LIST_KEY, JSON.stringify(readingList));
  updateReadingListBadge();
}

// Update the count badge on the Reading List header button.
function updateReadingListBadge() {
  const badge = document.getElementById('readingListBadge');
  if (!badge) return;
  if (readingList.length > 0) {
    badge.textContent = readingList.length;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

// Add a paper to the reading list (called on like). No-ops if already present.
function addToReadingList(paper) {
  if (!paper) return;
  if (readingList.some(e => e.paper.paperId === paper.paperId)) return;
  readingList.unshift({ paper, likedAt: new Date().toISOString() });
  saveReadingList();
}

// Remove a paper from the reading list WITHOUT touching the like signal.
// The learning algorithm keeps the positive like signal — removal just clears the queue.
function removeFromReadingList(paperId, silent = false) {
  readingList = readingList.filter(e => e.paper.paperId !== paperId);
  saveReadingList();
  if (readingListOpen) renderReadingList();
  if (!silent) showToast('Removed from Reading List');
}

// Show the Reading List view — hides feed elements, renders RL content.
function openReadingListView() {
  readingListOpen = true;
  closeAllPanels();
  ['activeKeywordsBar','searchBarContainer','filterPanel','feedHeader','statusBar','paperFeed']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  document.getElementById('readingListView').style.display = 'block';
  // Highlight the Reading List button to show it is the active view
  document.getElementById('readingListToggle')?.classList.add('active');
  renderReadingList();
}

// Hide the Reading List view and restore the feed.
function closeReadingListView() {
  readingListOpen = false;
  document.getElementById('readingListView').style.display = 'none';
  ['activeKeywordsBar','searchBarContainer','filterPanel','feedHeader','statusBar','paperFeed']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = ''; });
  document.getElementById('readingListToggle')?.classList.remove('active');
}

// One-time migration: add previously-liked OR saved papers (before RL existed, or before
// Save was wired to RL) into the reading list.
// Runs after both userActions and allPapers are available.
function migrateOldLikesToReadingList() {
  // v3 key: Reading List is now Save-only (Like is a pure learning signal, stays in feed).
  // Back-fill any previously-saved papers that aren't already in the RL.
  const migrationKey = 'researchhub_rl_migrated_v3';
  if (localStorage.getItem(migrationKey)) return;

  let migrated = 0;
  for (const [paperId, actions] of Object.entries(userActions)) {
    // Only saved papers belong in the Reading List (liked papers stay in feed)
    if (actions.saved && !readingList.some(e => e.paper.paperId === paperId)) {
      const paper = allPapers.find(p => p.paperId === paperId);
      if (paper) {
        readingList.push({ paper, likedAt: new Date().toISOString() });
        migrated++;
      }
    }
  }
  if (migrated > 0) {
    saveReadingList();
    localStorage.setItem('researchhub_rl_migration_notice', migrated.toString());
  }
  localStorage.setItem(migrationKey, '1');
}

// Build the HTML for one dense Reading List card.
function buildRlCardHtml(paper, likedAt) {
  const paperId  = paper.paperId || '';
  const paperUrl = paper.url ||
    (paper.externalIds?.DOI
      ? `https://doi.org/${paper.externalIds.DOI}`
      : `https://www.semanticscholar.org/paper/${paperId}`);
  const firstAuthor = paper.authors?.[0]?.name || 'Unknown author';
  const authorCount = paper.authors?.length || 0;
  const yearDisplay = paper.publicationDate?.slice(0, 7) || (paper.year ? String(paper.year) : '');
  const venue       = paper.publicationVenue?.name || '';
  const metaParts   = [
    firstAuthor + (authorCount > 1 ? ` +${authorCount - 1}` : ''),
    yearDisplay,
    venue,
  ].filter(Boolean);
  const scoreClass = paper.score >= 4 ? 'high' : paper.score >= 2 ? 'mid' : '';
  const oaBadge    = paper.isOpenAccess
    ? `<span class="oa-badge" title="Open Access">🔓</span>` : '';
  const addedDate  = new Date(likedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const abstractSnippet = paper.abstract ? esc(paper.abstract) : '<em style="color:var(--text-muted)">No abstract available.</em>';
  const isSaved    = !!userActions[paperId]?.saved;

  return `
    <article class="rl-card" data-paperid="${esc(paperId)}">
      <div class="rl-card-top">
        <h2 class="rl-title">
          <a href="${esc(paperUrl)}" target="_blank" rel="noopener">${esc(paper.title || 'Untitled')}</a>
        </h2>
        <div class="rl-card-badges">
          ${oaBadge}
          ${isSaved ? '<span title="Also saved" style="font-size:0.85rem">🔖</span>' : ''}
          <span class="score-badge ${scoreClass}" title="Relevance score when liked">★ ${paper.score}/5</span>
        </div>
      </div>
      <div class="rl-meta">${esc(metaParts.join(' · '))}</div>
      <p class="rl-abstract" title="Click to expand">${abstractSnippet}</p>
      <div class="rl-card-actions">
        <span class="rl-added-date">Added ${esc(addedDate)}</span>
        <a class="btn-text" href="${esc(paperUrl)}" target="_blank" rel="noopener" style="font-size:0.78rem">Open ↗</a>
        <button class="rl-remove-btn" data-paperid="${esc(paperId)}" title="Remove from Reading List">Remove ✕</button>
      </div>
    </article>`;
}

// Render the full Reading List view inside #readingListView.
function renderReadingList() {
  const view = document.getElementById('readingListView');
  if (!view) return;

  // Show migration notice if applicable
  const migrationCount = localStorage.getItem('researchhub_rl_migration_notice');
  const migrationBanner = migrationCount
    ? `<div class="rl-migration-notice" id="rlMigrationNotice">
        📚 We've added ${migrationCount} previously liked paper${migrationCount > 1 ? 's' : ''} to your Reading List.
        <button class="btn-text" style="margin-left:8px;font-size:0.78rem" onclick="
          localStorage.removeItem('researchhub_rl_migration_notice');
          document.getElementById('rlMigrationNotice')?.remove();
        ">Dismiss</button>
      </div>`
    : '';

  if (readingList.length === 0) {
    view.innerHTML = `
      ${migrationBanner}
      <div class="rl-header"><h2>Reading List</h2>
        <button class="btn-secondary" onclick="closeReadingListView()">← Back to Feed</button>
      </div>
      <div class="rl-empty-state">
        <div class="icon">📚</div>
        <p>Your reading list is empty.</p>
        <p style="font-size:0.8rem;margin-top:4px">Save a paper in the feed to add it here.</p>
      </div>`;
    return;
  }

  // Sort the list
  const sorted = readingList.slice().sort((a, b) => {
    if (rlSortOrder === 'score-desc') return (b.paper.score || 0) - (a.paper.score || 0);
    if (rlSortOrder === 'pub-desc') {
      const da = a.paper.publicationDate || (a.paper.year ? `${a.paper.year}-01-01` : '0000');
      const db = b.paper.publicationDate || (b.paper.year ? `${b.paper.year}-01-01` : '0000');
      return db.localeCompare(da);
    }
    // default: date-desc — newest added first
    return new Date(b.likedAt) - new Date(a.likedAt);
  });

  const cardsHtml = sorted.map(({ paper, likedAt }) => buildRlCardHtml(paper, likedAt)).join('');

  view.innerHTML = `
    ${migrationBanner}
    <div class="rl-header">
      <h2>Reading List <span class="rl-count">(${readingList.length})</span></h2>
      <div class="rl-controls">
        <select class="rl-sort-select" id="rlSortSelect">
          <option value="date-desc"${rlSortOrder === 'date-desc' ? ' selected' : ''}>Date added</option>
          <option value="score-desc"${rlSortOrder === 'score-desc' ? ' selected' : ''}>Relevance score</option>
          <option value="pub-desc"${rlSortOrder === 'pub-desc' ? ' selected' : ''}>Publication date</option>
        </select>
        <button class="btn-secondary" onclick="closeReadingListView()">← Back to Feed</button>
      </div>
    </div>
    <div id="rlCardList">${cardsHtml}</div>`;

  // Wire sort selector
  document.getElementById('rlSortSelect')?.addEventListener('change', (e) => {
    rlSortOrder = e.target.value;
    renderReadingList();
  });

  // Wire remove buttons
  view.querySelectorAll('.rl-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => removeFromReadingList(btn.dataset.paperid));
  });

  // Abstract expand on click
  view.querySelectorAll('.rl-abstract').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('expanded'));
  });
}


// ── Insights dot indicator ────────────────────────────────────

// Toggle the .has-insights class on the ✦ button whenever learnedKeywords changes.
