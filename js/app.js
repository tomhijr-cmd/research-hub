// -- app.js --
// App constants, global state, initialization, core UI, and shared helpers.
// This file must load after firebase.js and before all other app files.
// -----

// ── Constants ──────────────────────────────────────────────

const THEME_KEY            = 'researchhub_theme';
const LAST_FETCH_KEY       = 'researchhub_last_fetch';
const HEALTH_KEY           = 'researchhub_health';
const SEEN_PAPERS_KEY      = 'researchhub_seen_papers';
const READING_LIST_KEY     = 'researchhub_reading_list'; // { paper, likedAt }[]
const KEYWORDS_LOCAL_KEY   = 'researchhub_keywords_local'; // localStorage fallback when signed out
const SCORE_TIP_SEEN_KEY   = 'researchhub_score_tip_seen';
const WILDCARD_TIP_SEEN_KEY= 'researchhub_wildcard_tip_seen';
const AI_RECENT_KEY   = 'researchhub_ai_recent'; // string[] max 10 recent AI queries
const AI_CLAUDE_BASE  = '/api/claude';
const AI_MIN_SCORE    = 3;   // papers ranked below this by Claude are filtered out
const AI_MAX_RECENT   = 10;
const FETCH_TTL_MS    = 24 * 60 * 60 * 1000;
const PAGE_SIZE       = 20;

const API_BASE     = '/api/papers';
const PAPERS_LIMIT = 30;

// Stop words excluded when extracting topic keywords from paper titles/abstracts.
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','this','that',
  'these','those','it','its','we','our','they','their','study','paper','research',
  'using','used','results','show','shows','showed','approach','method','methods',
  'system','based','new','also','can','two','one','both','between','more','most',
  'such','than','when','which','who','how','data','model','propose','proposed',
  'present','demonstrate','find','found','analysis','evaluate','evaluation',
  'provide','different','task','tasks','work','works','high','large','small',
  'number','recent','review','effect','effects','related','across','within',
  'toward','through','during','while','where','other','each','into','over',
]);

const DEFAULT_KEYWORDS = [
  { text: 'social robots',          active: true },
  { text: 'human-robot interaction', active: true },
  { text: 'emotional contagion',    active: true },
  { text: 'priming public spaces',  active: true },
  { text: 'non-humanoid robots',    active: true },
];

// Fields we request from Semantic Scholar.
// All fields are returned in a single API response — no extra calls needed.
const API_FIELDS = 'title,abstract,authors,year,publicationDate,externalIds,url,' +
  'citationCount,influentialCitationCount,referenceCount,' +
  'isOpenAccess,openAccessPdf,publicationVenue,fieldsOfStudy';


// ── App State ──────────────────────────────────────────────

let keywords    = [];   // { text, active }[]
let allPapers   = [];   // raw results per fetch — never mutated after set
let papers      = [];   // derived filtered+sorted view of allPapers
let loading     = false;

let searchQuery = '';       // current live search string
let searchTimer = null;     // debounce handle

// ── AI Search state ─────────────────────────────────────────
let aiPapers    = [];          // AI-ranked papers { ...paper, aiScore, aiExplanation, source:'ai' }
let aiQuery     = '';          // last submitted natural-language query
let aiSummary   = null;        // { interpretation, searchTerms[], suggestions[] } from Claude
let aiLoading   = false;       // prevents double-submit
let aiAbortCtrl = null;        // AbortController for in-flight fetch
let aiEditTerms = [];          // editable copy of search terms shown in summary bar

let filterState = {
  scores:        [1, 2, 3, 4, 5],  // active score checkboxes
  dateRange:     'all',             // 'all'|'7d'|'30d'|'90d'|'1y'
  status:        'all',             // 'all'|'unread'|'liked'|'saved'|'hidden'
  keywords:      [],                // [] = no keyword filter; strings = must match one
  citations:     0,                 // minimum total citation count: 0|10|50|100|500
  inflCitations: 0,                 // minimum influential citations: 0|5|10|25
  velocity:      'any',             // 'any'|'trending'|'growing'|'stable'
  openAccess:    false,             // true = open-access papers only
  pubType:       'all',             // 'all'|'journal'|'conference'|'preprint'
  fields:        [],                // [] = all fields; strings = must match at least one
};

let sortOrder  = 'relevance';  // 'newest'|'oldest'|'relevance'|'cited'|'influential'|'trending'
let pageIndex  = 0;

// Cache of { [paperId]: { liked, saved, hidden } } loaded from Firestore
let userActions = {};

// Cache of { [paperId]: { liked, saved, expanded, clicked, secondsVisible, ... } }
// Separate from userActions — stores richer behavioral signals for learning
let userSignals = {};

// Learned keywords extracted from papers the user has liked/saved
// { text: string, weight: number }[]  — persisted to Firestore users/{uid}.learnedKeywords
let learnedKeywords = [];

// Set of paperIds seen in a previous session (for unread badge)
let seenPaperIds = new Set();

// Whether to include hidden papers in the feed
let showHidden = false;

// Reading List: array of { paper, likedAt (ISO string) }
// Persisted in localStorage — fully independent from the hide/learning signals.
let readingList     = [];
let readingListOpen = false;    // whether the RL view is currently showing
let rlSortOrder     = 'date-desc'; // 'date-desc'|'score-desc'|'pub-desc'


// ── Initialise ─────────────────────────────────────────────
function init() {
  renderAuthUI();
  loadKeywords();
  loadReadingList(); // load before first render so exclusion filter works
  loadTheme();
  loadSeenPapers();
  bindEvents();
  renderFilterPanel();
  renderHealthBar();
  smartRefresh();
}


// ── Auth UI ─────────────────────────────────────────────────

function renderAuthUI() {
  const area = document.getElementById('authArea');
  if (!area) return;

  if (currentUser) {
    const photo    = currentUser.photoURL;
    const name     = currentUser.displayName || currentUser.email || 'User';
    const initials = name.charAt(0).toUpperCase();

    const avatarHtml = photo
      ? `<img class="user-avatar" src="${esc(photo)}" alt="${esc(name)}" referrerpolicy="no-referrer">`
      : `<span class="user-avatar-fallback">${esc(initials)}</span>`;

    area.innerHTML = `
      <div class="auth-user">
        ${avatarHtml}
        <span class="user-name" title="${esc(name)}">${esc(name)}</span>
        <button class="btn-signout" id="signOutBtn">Sign out</button>
      </div>`;

    document.getElementById('signOutBtn').addEventListener('click', signOut);

    const row    = document.getElementById('addKeywordRow');
    const notice = document.getElementById('signinNotice');
    if (row)    row.classList.remove('disabled');
    if (notice) notice.style.display = 'none';

  } else {
    area.innerHTML = `
      <button class="btn-signin" id="signInBtn">
        <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
          <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
          <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
          <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
        Sign in with Google
      </button>`;

    document.getElementById('signInBtn').addEventListener('click', signIn);

    const notice = document.getElementById('signinNotice');
    // Add-keyword row is fully enabled when signed out — keywords save to localStorage.
    // Sign-in notice tells users what changes when they do sign in.
    if (notice) notice.style.display = 'block';
  }
}

function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithPopup(provider).catch(err => {
    console.error('Sign-in error:', err);
  });
}

function signOut() {
  auth.signOut().catch(err => {
    console.error('Sign-out error:', err);
  });
}


// ── Firestore: keywords ──────────────────────────────────────



// ── Keyword learning ──────────────────────────────────────────

// Extract the top N meaningful words from a paper's title + abstract.
// Title is weighted double (concatenated twice) so title words score higher.
function extractKeywords(title, abstract, topN = 3) {
  const text   = `${title} ${title} ${abstract}`.toLowerCase();
  const tokens = text.split(/[^a-z]+/).filter(w => w.length >= 4 && !STOP_WORDS.has(w));
  const freq   = {};
  for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word]) => word);
}

// Compute a relevance boost (0–2) from learned keywords matching this paper.
function scoreLearnedKeywords(paper) {
  if (!learnedKeywords.length) return 0;
  const text = `${paper.title || ''} ${paper.abstract || ''}`.toLowerCase();
  let boost  = 0;
  for (const lk of learnedKeywords) {
    if (text.includes(lk.text.toLowerCase())) {
      boost += lk.weight * 0.3;
    }
  }
  return Math.min(2, boost);
}

// Called when a user likes or saves a paper.
// Extracts keywords and adds/strengthens them in learnedKeywords[].
function addLearnedKeywords(paper) {
  if (!currentUser || !paper) return;
  const extracted = extractKeywords(paper.title || '', paper.abstract || '');
  const manualTexts = keywords.map(k => k.text.toLowerCase());
  let changed = false;

  for (const word of extracted) {
    // Don't learn words already in manual keywords
    if (manualTexts.some(m => m.includes(word) || word.includes(m))) continue;
    const existing = learnedKeywords.find(lk => lk.text === word);
    if (existing) {
      existing.weight = Math.min(3.0, existing.weight + 0.5); // strengthen
    } else {
      learnedKeywords.push({ text: word, weight: 1.0 });
    }
    changed = true;
  }

  if (changed) {
    saveLearnedKeywords();
    updateInsightsDotIndicator();
    renderInsightsPanel();
  }
}

// Remove a learned keyword by text (called from insights panel UI).
function removeLearnedKeyword(text) {
  learnedKeywords = learnedKeywords.filter(lk => lk.text !== text);
  saveLearnedKeywords();
  rescoreAll();
  updateInsightsDotIndicator();
  renderInsightsPanel();
  showToast('Removed from your learned topics');
}

// Load learnedKeywords from the users/{uid} document.

// Show inline confirmation UI in place of the reset button.
function showResetConfirmation() {
  const area = document.getElementById('resetConfirmArea');
  if (!area) return;
  area.innerHTML = `
    <p class="reset-warning">This clears inferred keywords, topics, and author data. Your manual keywords stay. This cannot be undone.</p>
    <div class="reset-confirm-btns">
      <button class="btn-secondary" id="resetCancelBtn">Cancel</button>
      <button class="btn-danger" id="resetConfirmBtn">Yes, reset</button>
    </div>
  `;
  document.getElementById('resetCancelBtn').addEventListener('click', () => {
    area.innerHTML = '<button class="btn-reset-profile" id="resetProfileBtn">🔄 Reset learning profile</button>';
    document.getElementById('resetProfileBtn').addEventListener('click', showResetConfirmation);
  });
  document.getElementById('resetConfirmBtn').addEventListener('click', resetLearningProfile);
}

// Reset the full learning profile: delete all signals + learned keywords.
async function resetLearningProfile() {
  if (!currentUser) return;

  try {
    // Batch-delete all signal docs
    const snap = await userSignalsRef().get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Clear learned keywords from Firestore
    await db.collection('users').doc(currentUser.uid).set(
      { learnedKeywords: [] },
      { merge: true }
    );
  } catch (e) {
    console.error('Error resetting profile:', e);
  }

  userSignals     = {};
  learnedKeywords = [];
  rescoreAll();
  updateInsightsDotIndicator();
  renderInsightsPanel();
  showToast('Learning profile cleared');
}


// ── Combined scoring ──────────────────────────────────────────

// Full relevance score incorporating keyword match, signal history, and learned keywords.
// Returns integer 1–5. This replaces the direct scorepaper() call during fetch.
function scoreWithSignals(paper) {
  const base          = scorepaper(paper);                       // 1–5 keyword score
  const learnedBoost  = scoreLearnedKeywords(paper);             // 0–2 boost
  const signalBoost   = computeSignalScore(paper.paperId);       // raw signal value

  // Signals contribute up to ±2 to the score (clamped and scaled)
  const signalContrib = Math.max(-2, Math.min(2, signalBoost * 0.3));

  const raw = base + (learnedBoost * 0.5) + signalContrib;
  return Math.max(1, Math.min(5, Math.round(raw)));
}

// Re-score allPapers[] with the current signals + learned keywords, then re-render.
function rescoreAll() {
  if (allPapers.length === 0) return;
  allPapers = allPapers.map(p => ({ ...p, score: scoreWithSignals(p) }));
  papers    = applyFiltersAndSort(allPapers);
  renderPapers();
}


// ── Score explanation (for tooltip) ──────────────────────────

// Returns up to 3 human-readable reasons for a paper's score.
function buildScoreExplanation(paper) {
  const reasons = [];
  const base    = scorepaper(paper);
  const learned = scoreLearnedKeywords(paper);
  const s       = userSignals[paper.paperId];

  if (base >= 4)      reasons.push(`Strong keyword match (base ${base}/5)`);
  else if (base >= 2) reasons.push(`Partial keyword match (base ${base}/5)`);
  else                reasons.push('Outside your main keywords');

  if (s?.liked)                        reasons.push('You liked this paper');
  if (s?.saved)                        reasons.push('You saved this paper');
  if (s?.clicked)                      reasons.push('You previously opened this paper');
  if ((s?.secondsVisible || 0) >= 30)  reasons.push('You spent time reading this');
  if (learned > 0.2)                   reasons.push('Matches topics from papers you liked');
  if (paper.isWildcard)                reasons.push('🔍 Explore: highly cited, outside your usual keywords');

  return reasons.slice(0, 3);
}


// ── Wildcard paper selection ──────────────────────────────────

// Pick a "wildcard" paper for diversity — low keyword match but notably cited.
// Returns a paper object with isWildcard=true, or null if none available.
function pickWildcard(allPapersArr, alreadyShown) {
  const shownIds = new Set(alreadyShown.map(p => p.paperId));
  // Candidates: not already shown, low keyword score, but cited (interesting discovery)
  const candidates = allPapersArr
    .filter(p => !shownIds.has(p.paperId) && p.score <= 2 && (p.influentialCitationCount || 0) >= 3)
    .sort((a, b) => (b.influentialCitationCount || 0) - (a.influentialCitationCount || 0));
  if (!candidates.length) return null;
  return { ...candidates[0], isWildcard: true };
}


// ── Auth state observer ──────────────────────────────────────

function loadKeywords() {
  // When signed out, load from localStorage (allows local customisation without sign-in).
  // When signed in, Firestore is canonical — this function is only called for the signed-out path.
  try {
    const saved = localStorage.getItem(KEYWORDS_LOCAL_KEY);
    keywords = saved ? JSON.parse(saved) : DEFAULT_KEYWORDS.map(k => ({ ...k }));
  } catch(e) {
    keywords = DEFAULT_KEYWORDS.map(k => ({ ...k }));
  }
}

function saveKeywords() {
  if (currentUser) {
    // Signed in: persist to Firestore (canonical store)
    saveKeywordsToFirestore();
  } else {
    // Signed out: persist to localStorage so edits survive page reload
    try {
      localStorage.setItem(KEYWORDS_LOCAL_KEY, JSON.stringify(keywords));
    } catch(e) { /* storage quota — skip */ }
  }
}

function loadTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Swap theme icon: sun in dark mode, moon in light mode
  document.getElementById('themeBtn').innerHTML = theme === 'dark'
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  localStorage.setItem(THEME_KEY, theme);
}


// ── Unread tracking ──────────────────────────────────────────
// We store the IDs of papers seen in the last session in localStorage.
// Papers in the current fetch that aren't in seenPaperIds are "new".

function loadSeenPapers() {
  try {
    const raw = localStorage.getItem(SEEN_PAPERS_KEY);
    if (raw) seenPaperIds = new Set(JSON.parse(raw));
  } catch (e) {
    seenPaperIds = new Set();
  }
}

// Save the current allPapers IDs as "seen" (capped at 500).
function updateSeenPapers() {
  const currentIds = allPapers.map(p => p.paperId).filter(Boolean);
  // Merge with previous (keep old seen IDs, add new ones)
  const merged = [...seenPaperIds, ...currentIds];
  const capped  = merged.slice(-500);
  try {
    localStorage.setItem(SEEN_PAPERS_KEY, JSON.stringify(capped));
  } catch (e) { /* quota exceeded — skip silently */ }
  // Update the in-memory set to include just-seen papers
  // so they won't be "unread" next session
  // (we set it AFTER renderPapers so the badge shows this session's new papers)
}


// ── Smart refresh ─────────────────────────────────────────────

function smartRefresh() {
  fetchPapers();
}

function friendlyTime(date) {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}


// ── Health check ──────────────────────────────────────────────

async function runHealthCheck() {
  const firstKeyword = activeKeywords()[0];
  if (!firstKeyword) return;

  let ok = false, msg = '';
  try {
    const params = new URLSearchParams({ query: firstKeyword, fields: 'title,year', limit: 1 });
    const res  = await fetch(`${API_BASE}?${params}`);
    const data = await res.json();
    if (res.status === 429 || (data.message && !data.data)) {
      msg = 'API rate-limited';
    } else if (!res.ok) {
      msg = `API error (HTTP ${res.status})`;
    } else if (!data.data || data.data.length === 0) {
      msg = 'API returned no papers';
    } else if (!data.data[0].title) {
      msg = 'API returned malformed data';
    } else {
      ok = true; msg = 'All systems good';
    }
  } catch (e) {
    msg = e.message === 'Failed to fetch' ? 'Cannot reach API' : e.message;
  }
  const result = { ok, msg, ts: new Date().toISOString() };
  localStorage.setItem(HEALTH_KEY, JSON.stringify(result));
  renderHealthBar(result);
}

function renderHealthBar(result) {
  if (!result) {
    try {
      const saved = localStorage.getItem(HEALTH_KEY);
      if (!saved) return;
      result = JSON.parse(saved);
    } catch (e) { return; }
  }
  const el = document.getElementById('healthBar');
  if (!el) return;
  const time = friendlyTime(new Date(result.ts));
  el.style.display = 'inline-block';
  el.className = 'health-bar ' + (result.ok ? 'ok' : 'error');
  el.textContent = result.ok
    ? `✅ ${result.msg} — last checked ${time}`
    : `❌ ${result.msg} — last checked ${time}`;
}


// ── Reading List ──────────────────────────────────────────────

// Load reading list from localStorage.
function updateInsightsDotIndicator() {
  const btn = document.getElementById('insightsToggle');
  if (!btn) return;
  btn.classList.toggle('has-insights', learnedKeywords.length > 0);
}


// ── Toast notifications ───────────────────────────────────────

// Show a non-blocking toast message at the bottom of the screen.
function showToast(message, duration = 2500) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  // Trigger CSS transition (must be a separate frame from append)
  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, duration);
}


// Animate a paper card out of the feed (slide-left + fade), then fire callback.
// Reuses the existing .paper-card--fading CSS transition (~380ms).
function animateCardOut(paperId, callback) {
  const card = document.querySelector(`[data-paperid="${paperId}"]`);
  if (!card) { callback?.(); return; }
  card.classList.add('paper-card--fading');
  setTimeout(() => callback?.(), 380);
}

// Like showToast() but with an Undo button. onUndo fires if tapped within duration.
function showToastWithUndo(message, onUndo, duration = 4000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast--with-undo';
  toast.innerHTML = `<span>${esc(message)}</span><button class="toast-undo-btn">Undo</button>`;
  container.appendChild(toast);

  let undone = false;
  toast.querySelector('.toast-undo-btn').addEventListener('click', () => {
    undone = true;
    onUndo?.();
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  });

  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  setTimeout(() => {
    if (!undone) {
      toast.classList.remove('toast--visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }
  }, duration);
}


// ── Panel open/close helpers ───────────────────────────────────

// Open a named side-panel (closes any already-open panel first).
function openPanel(id) {
  // If the Reading List full-page view is showing, restore the feed first
  if (readingListOpen) closeReadingListView();

  // Close all panels and strip their active button states
  closeAllPanels();

  // Open the target panel and highlight its toggle button
  document.getElementById(id)?.classList.add('open');
  const btnId = id === 'keywordsPanel' ? 'keywordsToggle' : 'insightsToggle';
  document.getElementById(btnId)?.classList.add('active');
}

// Close all side-panels and clear their active button highlights.
function closeAllPanels() {
  ['keywordsPanel', 'insightsPanel'].forEach(pid => {
    document.getElementById(pid)?.classList.remove('open');
  });
  document.getElementById('keywordsToggle')?.classList.remove('active');
  document.getElementById('insightsToggle')?.classList.remove('active');
}


// ── Event binding ─────────────────────────────────────────────

function bindEvents() {
  // Header: My Topics panel — clicking again while open closes it
  document.getElementById('keywordsToggle').addEventListener('click', () => {
    const panel = document.getElementById('keywordsPanel');
    if (panel?.classList.contains('open')) {
      closeAllPanels();
    } else {
      openPanel('keywordsPanel');
      renderKeywordChips();
    }
  });

  // Header: Feed Insights panel — clicking again while open closes it
  document.getElementById('insightsToggle').addEventListener('click', () => {
    const panel = document.getElementById('insightsPanel');
    if (panel?.classList.contains('open')) {
      closeAllPanels();
    } else {
      openPanel('insightsPanel');
      renderInsightsPanel();
    }
  });

  // Header: Reading List view
  document.getElementById('readingListToggle').addEventListener('click', () => {
    if (readingListOpen) {
      closeReadingListView();
    } else {
      closeAllPanels();
      openReadingListView();
    }
  });

  // Close buttons inside each panel
  document.getElementById('keywordsPanelClose').addEventListener('click', closeAllPanels);
  document.getElementById('insightsPanelClose').addEventListener('click', closeAllPanels);

  // Click outside panels (on .app-main) closes them
  document.querySelector('.app-main')?.addEventListener('click', (e) => {
    if (!e.target.closest('.side-panel') && !e.target.closest('#keywordsToggle') && !e.target.closest('#insightsToggle')) {
      closeAllPanels();
    }
  });

  document.getElementById('refreshBtn').addEventListener('click', fetchPapers);
  document.getElementById('themeBtn').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('addKeywordBtn').addEventListener('click', addKeyword);
  document.getElementById('newKeywordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addKeyword();
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', handleSearchInput);
  document.getElementById('searchClearBtn').addEventListener('click', clearSearch);

  // AI inline button: click → run AI search with current input value
  document.getElementById('aiSearchBtn').addEventListener('click', () => {
    const q = document.getElementById('searchInput').value.trim();
    if (q) runAiSearch(q);
  });

  // Enter key in unified search input: if it looks like a question, run AI search
  document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (!q) return;
      if (looksLikeQuestion(q)) {
        e.preventDefault();
        runAiSearch(q);
      }
      // Otherwise let normal behaviour apply (form submit / nothing)
    }
  });

  // Wire remaining AI search panel controls
  initAiSearchBtn();

  // Filter panel toggle
  document.getElementById('filterToggleBtn').addEventListener('click', () => {
    const body = document.getElementById('filterPanelBody');
    body.style.display = body.style.display === 'none' ? 'flex' : 'none';
  });

  // Advanced filters toggle inside the filter panel body
  document.getElementById('filterAdvancedToggle')?.addEventListener('click', () => {
    const sec = document.getElementById('filterAdvancedSection');
    const btn = document.getElementById('filterAdvancedToggle');
    if (!sec || !btn) return;
    const isOpen = sec.style.display !== 'none';
    sec.style.display = isOpen ? 'none' : 'flex';
    btn.textContent = isOpen ? 'Advanced filters ▸' : 'Advanced filters ▴';
  });

  // Clear all filters
  document.getElementById('clearAllFiltersBtn').addEventListener('click', clearAllFilters);

  // Sort select
  document.getElementById('sortSelect').addEventListener('change', (e) => {
    sortOrder = e.target.value;
    applyAndRender();
  });

  // Show hidden toggle
  document.getElementById('showHiddenToggle').addEventListener('change', (e) => {
    showHidden = e.target.checked;
    applyAndRender();
  });
}


// ── Keyword management ────────────────────────────────────────

function addKeyword() {
  const input = document.getElementById('newKeywordInput');
  const text  = input.value.trim().toLowerCase();
  if (!text) return;
  if (keywords.some(k => k.text === text)) { input.value = ''; return; }
  keywords.push({ text, active: true });
  saveKeywords();
  input.value = '';
  renderKeywordChips();
  renderActiveKeywordsBar();
  renderKeywordFilterGroup(); // update filter panel
  fetchPapers();
  showToast('Keyword added — feed will update');
}

function removeKeyword(index) {
  keywords.splice(index, 1);
  saveKeywords();
  renderKeywordChips();
  renderActiveKeywordsBar();
  renderKeywordFilterGroup();
  fetchPapers();
  showToast('Keyword removed');
}

function toggleKeyword(index) {
  keywords[index].active = !keywords[index].active;
  saveKeywords();
  renderKeywordChips();
  renderActiveKeywordsBar();
  renderKeywordFilterGroup();
  fetchPapers();
}

function activeKeywords() {
  return keywords.filter(k => k.active).map(k => k.text);
}


// ── Relevance scoring ─────────────────────────────────────────

function scorepaper(paper) {
  const active = activeKeywords();
  if (active.length === 0) return 1;

  const title    = (paper.title    || '').toLowerCase();
  const abstract = (paper.abstract || '').toLowerCase();

  let depthScore = 0;  // sum of per-keyword depth points (max 3 per kw: 2 title + 1 abstract)
  let matchedKws = 0;  // how many keywords appeared at all in this paper

  for (const kw of active) {
    const kwLower    = kw.toLowerCase();
    const inTitle    = title.includes(kwLower);
    const inAbstract = abstract.includes(kwLower);
    if (inTitle || inAbstract) {
      matchedKws++;
      if (inTitle)    depthScore += 2; // title match worth more
      if (inAbstract) depthScore += 1;
    }
  }

  // No keyword found in this paper at all → not relevant
  if (matchedKws === 0) return 1;

  // Breadth: what fraction of ALL active keywords matched this paper?
  // e.g. 1 of 4 keywords → 0.25; 4 of 4 → 1.0
  const breadth = matchedKws / active.length;

  // Depth: how deeply did the matched keywords hit (title vs abstract)?
  // Always in [0.33, 1.0] when matchedKws > 0.
  const depth = depthScore / (matchedKws * 3);

  // Combined score weighted 70% breadth (coverage) + 30% depth (title/abstract hit).
  // This ensures a paper matching only 1 of 4 keywords cannot score 5/5,
  // even if that one keyword appears in both title and abstract.
  const combined = (breadth * 0.7) + (depth * 0.3);

  if (combined >= 0.75) return 5; // strong multi-keyword match
  if (combined >= 0.50) return 4; // good coverage
  if (combined >= 0.30) return 3; // partial match
  if (combined >= 0.10) return 2; // weak match
  return 1;                       // effectively no match
}


// ════════════════════════════════════════════════════════════
//  FILTER & SORT PIPELINE
//  All pure functions — no DOM side effects.
//  Input: allPapers[]  →  Output: filtered+sorted papers[]
// ════════════════════════════════════════════════════════════

// Master entry point: recompute papers[] from allPapers[], reset page, re-render.
function showSigninPopover(paperId, action) {
  // Remove any existing popover first
  document.querySelectorAll('.signin-popover').forEach(el => el.remove());

  const card = document.querySelector(`[data-paperid="${paperId}"]`);
  if (!card) return;
  const btn = card.querySelector(`[data-action="${action}"]`);
  if (!btn) return;

  const pop = document.createElement('div');
  pop.className = 'signin-popover';
  pop.innerHTML = `Sign in to save your actions &nbsp;<a id="signinPopoverLink">Sign in with Google</a>`;

  // Anchor the popover to the button (button needs relative positioning)
  btn.style.position = 'relative';
  btn.appendChild(pop);

  document.getElementById('signinPopoverLink')?.addEventListener('click', (e) => {
    e.stopPropagation();
    signIn();
    pop.remove();
  });

  // Auto-dismiss after 4s
  const timer = setTimeout(() => pop.remove(), 4000);
  // Dismiss on any outside click
  const dismiss = (e) => {
    if (!pop.contains(e.target)) {
      pop.remove();
      clearTimeout(timer);
      document.removeEventListener('click', dismiss);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

// Route an action button click to the correct handler.
function handlePaperAction(paperId, action) {
  if (!currentUser) {
    // Show contextual sign-in prompt instead of silently failing
    showSigninPopover(paperId, action);
    return;
  }

  const paper = allPapers.find(p => p.paperId === paperId);

  if (action === 'like') {
    const current = userActions[paperId]?.liked || false;
    const newVal  = !current;
    saveUserAction(paperId, 'liked', newVal);
    recordSignal(paperId, 'liked', newVal);
    if (newVal && paper) {
      // Like = pure learning signal. The card STAYS in the feed.
      // Keywords are learned and the score is updated in-place.
      addLearnedKeywords(paper);
      const updated = { ...paper, score: scoreWithSignals(paper) };
      allPapers = allPapers.map(p => p.paperId === paperId ? updated : p);
      updateCardActionDisplay(paperId);
      showToast('Liked — this helps tune your feed');
    } else if (!newVal) {
      // Un-liking: restore default state
      updateCardActionDisplay(paperId);
      if (filterState.status === 'liked') applyAndRender();
    }
  } else if (action === 'save') {
    const current = userActions[paperId]?.saved || false;
    const newVal  = !current;
    saveUserAction(paperId, 'saved', newVal);
    recordSignal(paperId, 'saved', newVal);
    if (newVal && paper) {
      // Positive signal: learn keywords and rescore
      addLearnedKeywords(paper);
      const updated = { ...paper, score: scoreWithSignals(paper) };
      allPapers = allPapers.map(p => p.paperId === paperId ? updated : p);

      // Save also adds to Reading List and animates card out of feed
      addToReadingList(updated);
      animateCardOut(paperId, () => applyAndRender());

      // Undo toast — undo removes from RL + un-saves
      showToastWithUndo('Saved to Reading List', () => {
        removeFromReadingList(paperId, /* silent */ true);
        saveUserAction(paperId, 'saved', false);
        recordSignal(paperId, 'saved', false);
        allPapers = allPapers.map(p => p.paperId === paperId ? { ...p, score: scoreWithSignals(p) } : p);
        applyAndRender();
      });
    } else if (!newVal) {
      // Un-saving manually (e.g. from a future saved-filter view) — just update display
      updateCardActionDisplay(paperId);
      if (filterState.status === 'saved') applyAndRender();
    }
  } else if (action === 'hide') {
    const current = userActions[paperId]?.hidden || false;
    const newVal  = !current;
    saveUserAction(paperId, 'hidden', newVal);
    if (newVal) recordSignal(paperId, 'removed', true); // strong negative signal
    if (newVal && !showHidden) {
      // Fade out then remove
      const card = document.querySelector(`[data-paperid="${paperId}"]`);
      if (card) {
        card.classList.add('paper-card--fading');
        setTimeout(() => applyAndRender(), 380);
      }
    } else {
      updateCardActionDisplay(paperId);
      if (filterState.status === 'hidden') applyAndRender();
    }
  } else if (action === 'copy') {
    showCiteModal(paperId);
  }
}

// Update just the action buttons of one card without re-rendering the whole feed.
function updateCardActionDisplay(paperId) {
  const card = document.querySelector(`[data-paperid="${paperId}"]`);
  if (!card) return;
  const a = userActions[paperId] || {};
  const isSignedIn = !!currentUser;

  const likeBtn = card.querySelector('.like-btn');
  const saveBtn = card.querySelector('.save-btn');
  const hideBtn = card.querySelector('.hide-btn');

  if (likeBtn) {
    likeBtn.classList.toggle('active', !!a.liked);
    likeBtn.innerHTML = a.liked
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg> Liked`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg> Like`;
  }
  if (saveBtn) {
    saveBtn.classList.toggle('active', !!a.saved);
    saveBtn.innerHTML = a.saved
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Saved`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg> Save`;
  }
  if (hideBtn) {
    hideBtn.classList.toggle('active', !!a.hidden);
    hideBtn.innerHTML = a.hidden
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Unhide`
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> Hide`;
  }
}

// ── Citation formatters ──────────────────────────────────

// Build a properly formatted APA citation string from a paper object.
// Missing fields are omitted gracefully — never "undefined".
function esc(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('statusBar');
  el.textContent = msg;
  el.className   = 'status-bar' + (isError ? ' error' : '');
}

function setRefreshSpinning(on) {
  document.getElementById('refreshIcon').className = on ? 'btn-spinning' : '';
}

function showSkeletons() {
  const feed = document.getElementById('paperFeed');
  feed.innerHTML = Array.from({ length: 4 }, () => `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:70%; height:18px;"></div>
      <div class="skeleton-line" style="width:40%; height:12px;"></div>
      <div class="skeleton-line" style="width:100%; height:12px;"></div>
      <div class="skeleton-line" style="width:95%; height:12px;"></div>
      <div class="skeleton-line" style="width:80%; height:12px;"></div>
    </div>
  `).join('');
}


// ── Render: keyword chips in settings panel ───────────────────

// ── Research Profile UI ───────────────────────────────────────
// Renders the "Your Research Profile" section in the settings panel.
// Shows learned keywords, top topics, top authors, and a reset button.
function renderInsightsPanel() {
  const container = document.getElementById('insightsPanelBody');
  if (!container) return;

  if (!currentUser) {
    container.innerHTML = '<p class="insights-empty" style="padding:20px 0;color:var(--text-muted);font-size:0.82rem;">Sign in to see your personalised feed insights.</p>';
    return;
  }

  // Build top 5 topics from signal data
  const topicFreq = {};
  for (const [, s] of Object.entries(userSignals)) {
    const hasPositiveSignal = s.liked || s.saved || s.expanded || s.clicked || (s.secondsVisible || 0) >= 10;
    if (!hasPositiveSignal) continue;
    const words = extractKeywords(s.title || '', s.abstract || '', 5);
    for (const w of words) topicFreq[w] = (topicFreq[w] || 0) + 1;
  }
  const topTopics = Object.entries(topicFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);

  // Build top 5 authors from liked/clicked signals
  const authorFreq = {};
  for (const [, s] of Object.entries(userSignals)) {
    if (!(s.liked || s.clicked)) continue;
    const firstAuthor = s.authors?.[0]?.name;
    if (firstAuthor) authorFreq[firstAuthor] = (authorFreq[firstAuthor] || 0) + 1;
  }
  const topAuthors = Object.entries(authorFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  // Render learned keywords as removable chips
  const learnedHtml = learnedKeywords.length
    ? learnedKeywords
        .sort((a, b) => b.weight - a.weight)
        .map(lk => `
          <span class="learned-kw-chip" title="Weight: ${lk.weight.toFixed(1)} — click × to remove">
            ${esc(lk.text)}
            <button class="remove-learned-btn" data-kw="${esc(lk.text)}" aria-label="Remove ${esc(lk.text)}">×</button>
          </span>`)
        .join('')
    : '<span class="insights-empty">Like or save papers to start learning.</span>';

  const topicsHtml = topTopics.length
    ? topTopics.map(t => `<span class="insights-chip">${esc(t)}</span>`).join('')
    : '<span class="insights-empty">No engagement data yet.</span>';

  const authorsHtml = topAuthors.length
    ? topAuthors.map(a => `<span class="insights-chip">${esc(a)}</span>`).join('')
    : '<span class="insights-empty">Like or click papers to track authors.</span>';

  container.innerHTML = `
    <div class="insights-section">
      <h3 class="insights-section-title">Keywords Learned for You</h3>
      <p class="insights-hint">Extracted from papers you liked or saved. Click × to remove.</p>
      <div class="learned-kw-list" id="learnedKeywordList">${learnedHtml}</div>
    </div>

    <div class="insights-section">
      <h3 class="insights-section-title">Your Top Topics</h3>
      <div class="insights-chips">${topicsHtml}</div>
    </div>

    <div class="insights-section">
      <h3 class="insights-section-title">Authors You Engage With Most</h3>
      <div class="insights-chips">${authorsHtml}</div>
    </div>

    <hr class="insights-divider">
    <div class="insights-reset-area">
      <div id="resetConfirmArea">
        <button class="btn-reset-profile" id="resetProfileBtn">🔄 Reset learning profile</button>
      </div>
    </div>
  `;

  // Wire up remove learned keyword buttons
  container.querySelectorAll('.remove-learned-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeLearnedKeyword(btn.dataset.kw);
    });
  });

  // Wire up reset button (inline confirmation)
  const resetBtn = document.getElementById('resetProfileBtn');
  if (resetBtn) resetBtn.addEventListener('click', showResetConfirmation);
}


function renderKeywordChips() {
  const list = document.getElementById('keywordList');

  if (keywords.length === 0) {
    list.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem;">No keywords yet.</span>';
    return;
  }

  list.innerHTML = keywords.map((kw, i) => `
    <span class="keyword-chip ${kw.active ? '' : 'off'}"
          data-index="${i}"
          role="button"
          tabindex="0"
          title="${kw.active ? 'Click to disable' : 'Click to enable'}"
          aria-pressed="${kw.active}">
      ${esc(kw.text)}
      <button class="remove-btn"
              data-remove="${i}"
              title="Remove keyword"
              aria-label="Remove ${esc(kw.text)}">×</button>
    </span>
  `).join('');

  list.querySelectorAll('.keyword-chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-btn')) return;
      toggleKeyword(parseInt(chip.dataset.index));
    });
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleKeyword(parseInt(chip.dataset.index));
      }
    });
  });

  list.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeKeyword(parseInt(btn.dataset.remove));
    });
  });
}


// ── Render: active keyword tags below header ──────────────────

function renderActiveKeywordsBar() {
  const bar    = document.getElementById('activeKeywordsBar');
  const active = activeKeywords();

  if (active.length === 0) {
    bar.innerHTML = '<span class="bar-label">No active keywords</span>';
    return;
  }

  bar.innerHTML =
    '<span class="bar-label">Searching:</span>' +
    active.map(k => `<span class="active-kw-tag">${esc(k)}</span>`).join('');
}


// ── Intent detection ──────────────────────────────────────────

// Returns true when the input looks like a natural-language question
// rather than a short keyword phrase.
// Used to decide whether to highlight the "Search with AI →" button.
function looksLikeQuestion(text) {
  const t = text.trim();
  if (t.length < 15) return false;                  // too short to be a question
  if (t.includes('?')) return true;                 // explicit question mark
  const words = t.split(/\s+/);
  if (words.length >= 5) return true;               // 5+ words → probably a question
  const starters = ['how','why','what','when','where','which','does','do',
                    'can','is','are','will','would','should'];
  return starters.includes(words[0].toLowerCase()); // starts with question word
}


// ── Start the app ─────────────────────────────────────────────
// init() is called from index.html after all script files have loaded,
// so that functions defined in later files (reading-list.js, feed.js, etc.)
// are available when init() runs.