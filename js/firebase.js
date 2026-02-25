// -- firebase.js --
// Firebase config, auth, and all Firestore read/write operations.
// Globals declared: auth, db, currentUser
// Functions: userDocRef, loadKeywordsFromFirestore, saveKeywordsToFirestore,
//            userActionsRef, loadUserActions, saveUserAction,
//            userSignalsRef, loadUserSignals, recordSignal, computeSignalScore,
//            loadLearnedKeywords, saveLearnedKeywords
// -----

// ════════════════════════════════════════════════════════════
//  Research Hub — HRI Paper Feed
//  Single-file vanilla JS app. No frameworks, no build step.
//  Keywords sync to Firestore when signed in.
//  Paper actions (like/save/hide) stored in Firestore subcollection.
// ════════════════════════════════════════════════════════════

// ── Firebase setup ──────────────────────────────────────────

const firebaseConfig = {
  apiKey:            'AIzaSyCGeXjURWaP02MdENQIR5wjQJdmapyAEPo',
  authDomain:        'research-hub-8da6a.firebaseapp.com',
  projectId:         'research-hub-8da6a',
  storageBucket:     'research-hub-8da6a.firebasestorage.app',
  messagingSenderId: '765872653008',
  appId:             '1:765872653008:web:ea08868e0e59e86acb14d5',
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// Holds the signed-in Firebase User object, or null if signed out.
let currentUser = null;


function userDocRef() {
  return db.collection('users').doc(currentUser.uid);
}

async function loadKeywordsFromFirestore() {
  try {
    const snap = await userDocRef().get();
    if (snap.exists && snap.data().keywords) {
      keywords = snap.data().keywords;
    } else {
      keywords = DEFAULT_KEYWORDS.map(k => ({ ...k }));
      await saveKeywordsToFirestore();
    }
  } catch (e) {
    console.error('Firestore load error:', e);
    keywords = DEFAULT_KEYWORDS.map(k => ({ ...k }));
  }
}

async function saveKeywordsToFirestore() {
  try {
    await userDocRef().set({ keywords }, { merge: true });
  } catch (e) {
    console.error('Firestore save error:', e);
  }
}


// ── Firestore: user actions ──────────────────────────────────
// Actions are stored in a subcollection: users/{uid}/actions/{paperId}
// Each doc: { liked: bool, saved: bool, hidden: bool, updatedAt: Timestamp }

function userActionsRef() {
  return db.collection('users').doc(currentUser.uid).collection('actions');
}

// Load all action docs for the current user into the userActions cache.
async function loadUserActions() {
  if (!currentUser) return;
  try {
    const snap = await userActionsRef().get();
    userActions = {};
    snap.forEach(doc => {
      userActions[doc.id] = doc.data();
    });
    renderPapers(); // re-render with loaded actions
  } catch (e) {
    console.error('Error loading user actions:', e);
  }
}

// Update one action field for a paper (merges with existing doc).
async function saveUserAction(paperId, key, value) {
  if (!currentUser) return;
  userActions[paperId] = userActions[paperId] || {};
  userActions[paperId][key] = value;
  try {
    await userActionsRef().doc(paperId).set(
      { [key]: value, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    console.error('Error saving user action:', e);
  }
}


// ── Firestore: behavioral signals ─────────────────────────────
// Signals are stored in: users/{uid}/signals/{paperId}
// Separate from 'actions' — stores richer behavioral data for learning.
// Each doc: { liked, saved, expanded, clicked, secondsVisible, removed,
//             title, abstract, authors, updatedAt }

function userSignalsRef() {
  return db.collection('users').doc(currentUser.uid).collection('signals');
}

// Load all signal docs into the in-memory userSignals cache.
async function loadUserSignals() {
  if (!currentUser) return;
  try {
    const snap = await userSignalsRef().get();
    userSignals = {};
    snap.forEach(doc => { userSignals[doc.id] = doc.data(); });
  } catch (e) {
    console.error('Error loading user signals:', e);
  }
}

// Write a single field to a signal doc (merge). Also snapshots the paper
// content so we can do keyword extraction later without re-fetching.
async function recordSignal(paperId, field, value) {
  if (!currentUser) return;
  const paper = allPapers.find(p => p.paperId === paperId);
  // Update in-memory cache immediately
  userSignals[paperId] = userSignals[paperId] || {};
  userSignals[paperId][field] = value;
  const doc = {
    [field]: value,
    title:    paper?.title    || userSignals[paperId]?.title    || '',
    abstract: paper?.abstract || userSignals[paperId]?.abstract || '',
    authors:  paper?.authors  || userSignals[paperId]?.authors  || [],
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  try {
    await userSignalsRef().doc(paperId).set(doc, { merge: true });
  } catch (e) {
    console.error('Error recording signal:', e);
  }
}

// Compute a signal-based score adjustment for a paper based on past interactions.
// Returns a raw number (positive = boost, negative = penalty). Not clamped yet.
function computeSignalScore(paperId) {
  const s = userSignals[paperId];
  if (!s) return 0;

  // Recency multiplier based on updatedAt timestamp
  const updatedAt = s.updatedAt?.toDate?.() || new Date(0);
  const daysAgo   = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  const recency   = daysAgo <= 7 ? 1.0 : daysAgo <= 30 ? 0.7 : 0.4;

  let raw = 0;
  if (s.liked)    raw += 3;
  if (s.saved)    raw += 2;
  if (s.removed)  raw -= 5;
  if (s.expanded) raw += 1;
  if (s.clicked)  raw += 2;
  // Time on screen: +0.5 per 10s, capped at 120s = max +6
  raw += Math.min(s.secondsVisible || 0, 120) / 10 * 0.5;

  return raw * recency;
}
async function loadLearnedKeywords() {
  if (!currentUser) return;
  try {
    const doc = await db.collection('users').doc(currentUser.uid).get();
    learnedKeywords = doc.data()?.learnedKeywords || [];
  } catch (e) {
    console.error('Error loading learned keywords:', e);
    learnedKeywords = [];
  }
}

// Persist learnedKeywords back to Firestore.
async function saveLearnedKeywords() {
  if (!currentUser) return;
  try {
    await db.collection('users').doc(currentUser.uid).set(
      { learnedKeywords },
      { merge: true }
    );
  } catch (e) {
    console.error('Error saving learned keywords:', e);
  }
}
auth.onAuthStateChanged(async (user) => {
  currentUser = user;

  if (user) {
    await loadKeywordsFromFirestore();
    // Firestore is now canonical — discard any localStorage draft made while signed out
    localStorage.removeItem(KEYWORDS_LOCAL_KEY);
    await loadUserActions();
    await loadUserSignals();
    await loadLearnedKeywords();
  } else {
    // Signed out: load from localStorage (allows local keyword customisation without sign-in)
    loadKeywords();
    userActions     = {};
    userSignals     = {};
    learnedKeywords = [];
  }

  renderAuthUI();
  renderKeywordChips();
  renderActiveKeywordsBar();
  renderFilterPanel(); // keyword filter group depends on active keywords
  updateInsightsDotIndicator();

  // Re-score papers already on screen with updated signals + learned keywords
  if (allPapers.length > 0) {
    allPapers = allPapers.map(p => ({ ...p, score: scoreWithSignals(p) }));
    papers    = applyFiltersAndSort(allPapers);
    pageIndex = 0;
    renderPapers();
  }
});


// ── localStorage helpers ─────────────────────────────────────

