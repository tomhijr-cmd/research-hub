// -- citations.js --
// APA and BibTeX citation formatting, citation modal UI.
// Functions: buildApa, buildBibtex, showCiteModal
// -----

function buildApa(paper) {
  const rawAuthors = paper.authors || [];
  const fmtAuthors = rawAuthors.map(a => {
    const parts = (a.name || '').trim().split(/\s+/);
    if (parts.length < 2) return a.name || '';
    const last     = parts[parts.length - 1];
    const initials = parts.slice(0, -1).map(p => p[0] + '.').join(' ');
    return `${last}, ${initials}`;
  });
  let authorStr = '';
  if (fmtAuthors.length === 1)     authorStr = fmtAuthors[0];
  else if (fmtAuthors.length > 1)  authorStr = fmtAuthors.slice(0, -1).join(', ') + ', & ' + fmtAuthors[fmtAuthors.length - 1];

  const year    = paper.year || (paper.publicationDate ? new Date(paper.publicationDate).getFullYear() : null);
  const title   = paper.title   || '';
  const journal = paper.publicationVenue?.name || '';
  const doi     = paper.externalIds?.DOI || '';

  let citation = '';
  if (authorStr) citation += authorStr + ' ';
  citation += year ? `(${year}). ` : '(n.d.). ';
  if (title)   citation += `${title}. `;
  if (journal) citation += `${journal}. `;
  if (doi)     citation += `https://doi.org/${doi}`;

  return citation.trim();
}

// Build a BibTeX entry from a paper object.
function buildBibtex(paper) {
  const firstAuthorLast = (() => {
    const name  = (paper.authors?.[0]?.name || 'unknown').trim();
    const parts = name.split(/\s+/);
    return parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
  })();
  const year    = paper.year || (paper.publicationDate ? new Date(paper.publicationDate).getFullYear() : '');
  const key     = `${firstAuthorLast}${year}`;
  const authors = (paper.authors || []).map(a => a.name || '').filter(Boolean).join(' and ');
  const title   = paper.title || '';
  const journal = paper.publicationVenue?.name || '';
  const doi     = paper.externalIds?.DOI || '';

  const lines = [`@article{${key},`];
  if (authors) lines.push(`  author  = {${authors}},`);
  if (title)   lines.push(`  title   = {${title}},`);
  if (journal) lines.push(`  journal = {${journal}},`);
  if (year)    lines.push(`  year    = {${year}},`);
  if (doi)     lines.push(`  doi     = {${doi}},`);
  lines.push('}');
  return lines.join('\n');
}

// ── Citation modal ────────────────────────────────────────

// Open the citation modal for a given paper, pre-populated with APA format.
function showCiteModal(paperId) {
  const paper = allPapers.find(p => p.paperId === paperId);
  if (!paper) return;

  const modal     = document.getElementById('citeModal');
  const textarea  = document.getElementById('citeTextarea');
  const tabApa    = document.getElementById('citeTabApa');
  const tabBibtex = document.getElementById('citeTabBibtex');
  const copyBtn   = document.getElementById('citeCopyBtn');
  const copiedMsg = document.getElementById('citeCopiedMsg');
  const closeBtn  = document.getElementById('citeModalClose');
  if (!modal || !textarea) return;

  function setTab(format) {
    const isApa = format === 'apa';
    tabApa.classList.toggle('active', isApa);
    tabBibtex.classList.toggle('active', !isApa);
    tabApa.setAttribute('aria-selected', isApa);
    tabBibtex.setAttribute('aria-selected', !isApa);
    textarea.value = isApa ? buildApa(paper) : buildBibtex(paper);
    // BibTeX entries are taller — expand textarea minimum height
    textarea.style.minHeight = isApa ? '90px' : '160px';
    // Reset the Copied! confirmation on tab switch
    copiedMsg.classList.remove('visible');
    copiedMsg.textContent = '';
  }

  function closeModal() {
    modal.style.display = 'none';
    document.removeEventListener('keydown', onEsc);
    // Detach one-time backdrop listener safely (already consumed if backdrop was clicked)
    modal.removeEventListener('click', onBackdrop);
  }

  function onEsc(e) {
    if (e.key === 'Escape') closeModal();
  }

  function onBackdrop(e) {
    if (e.target === modal) closeModal();
  }

  // Re-wire event listeners fresh each open (avoids stacking from previous papers)
  tabApa.onclick    = () => setTab('apa');
  tabBibtex.onclick = () => setTab('bibtex');
  closeBtn.onclick  = closeModal;

  copyBtn.onclick = () => {
    navigator.clipboard.writeText(textarea.value).then(() => {
      copiedMsg.textContent = '✅ Copied!';
      copiedMsg.classList.add('visible');
      setTimeout(() => {
        copiedMsg.classList.remove('visible');
        setTimeout(() => { copiedMsg.textContent = ''; }, 350);
      }, 1500);
    }).catch(() => {
      // Clipboard API unavailable (e.g. non-HTTPS) — select text as fallback
      textarea.select();
    });
  };

  modal.addEventListener('click', onBackdrop);
  document.addEventListener('keydown', onEsc);

  // Open on APA tab
  setTab('apa');
  modal.style.display = 'flex';
}


// ════════════════════════════════════════════════════════════
//  RENDERING
// ════════════════════════════════════════════════════════════

// Update the feed header: paper count, unread badge, last refresh time.
