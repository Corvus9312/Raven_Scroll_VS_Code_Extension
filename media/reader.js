(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const FONT_FAMILIES = {
    'lxgw':     "'LXGW WenKai TC', 'LXGW WenKai', serif",
    'serif':    "'Georgia', 'Noto Serif TC', 'STSong', 'SimSun', serif",
    'sans':     "'Segoe UI', 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans TC', sans-serif",
    'kaiti':    "'KaiTi', 'STKaiti', 'DFKai-SB', cursive, serif",
    'fangsong': "'FangSong', 'STFangsong', 'FangSong_GB2312', serif",
    'cutive':   "'Cutive Mono', 'Courier New', monospace",
  };

  let chapters = [];
  let fontSize = 14;
  let lineHeight = 1.3;
  let fontFamily = 'serif';
  let theme = 'dark';
  let currentUriKey = '';
  let activeChapterIdx = -1;
  let saveTimer = null;
  let scrollTimer = null;
  let nextFileRequested = false;

  // Maintained after scroll settles; used to restore position on resize events
  let liveAnchor = null;
  let anchorRefreshTimer = null;

  const $ = (id) => document.getElementById(id);

  const nextBookBanner = $('next-book-banner');
  const btnNextBook    = $('btn-next-book');

  const sidebar       = $('sidebar');
  const bookTitle     = $('book-title');
  const chapterList   = $('chapter-list');
  const chapterSearch = $('chapter-search');
  const btnSidebar    = $('btn-sidebar');
  const btnClose      = $('btn-close-sidebar');
  const btnFontDec    = $('btn-font-dec');
  const btnFontInc    = $('btn-font-inc');
  const fontLabel     = $('font-label');
  const btnLhDec      = $('btn-lh-dec');
  const btnLhInc      = $('btn-lh-inc');
  const lhLabel       = $('lh-label');
  const fontSelect    = $('font-select');
  const btnTheme      = $('btn-theme');
  const progressLabel = $('progress-label');
  const readerScroll  = $('reader-scroll');
  const contentEl     = $('content');
  const loadingEl     = $('loading');

  // ── Message from extension ──────────────────────────────────────────────────
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'loadContent') { init(data); }
    if (data.type === 'nextFile') {
      if (data.exists) {
        btnNextBook.textContent = data.name;
        btnNextBook.onclick = () => vscode.postMessage({ type: 'openNextFile', uriKey: data.uriKey, fileName: data.fileName });
        nextBookBanner.style.display = 'block';
      }
    }
  });

  function currentPercent() {
    const { scrollTop, scrollHeight, clientHeight } = readerScroll;
    const max = scrollHeight - clientHeight;
    return max > 0 ? Math.min(100, Math.round((scrollTop / max) * 100)) : 0;
  }

  function saveProgressNow() {
    if (currentUriKey) {
      clearTimeout(saveTimer);
      vscode.postMessage({ type: 'saveProgress', scrollTop: readerScroll.scrollTop, percent: currentPercent(), uriKey: currentUriKey });
    }
  }

  function init({ text, title, savedProgress, prefs, uriKey }) {
    saveProgressNow(); // save previous file before switching
    currentUriKey = uriKey ?? '';
    nextFileRequested = false;
    nextBookBanner.style.display = 'none';
    fontSize   = prefs.fontSize   ?? 14;
    lineHeight = prefs.lineHeight ?? 1.3;
    fontFamily = prefs.fontFamily ?? 'serif';
    theme      = prefs.theme      ?? 'dark';

    applyFontSize();
    applyLineHeight();
    applyFont();
    applyTheme();

    bookTitle.textContent = title;
    chapters = detectChapters(text);
    renderText(text);
    buildChapterNav();

    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    liveAnchor = null; // reset anchor for new file

    requestAnimationFrame(() => {
      readerScroll.scrollTop = savedProgress;
      updateProgress();
      syncActiveChapter();
      liveAnchor = captureScrollAnchor();
    });
  }

  // ── Scroll anchor ────────────────────────────────────────────────────────────
  // Uses caretRangeFromPoint to pin the exact character at the top of the
  // visible area before a layout change, then scrolls it back to the same
  // visual position afterwards.
  function captureScrollAnchor() {
    if (readerScroll.scrollTop < 5) { return null; }
    const rect = readerScroll.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + 4;
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      if (range) { return { range, anchorY: y }; }
    }
    return null;
  }

  function restoreScrollAnchor(anchor) {
    if (!anchor) { return; }
    const rect = anchor.range.getBoundingClientRect();
    if (rect.height === 0) { return; } // range no longer in DOM
    readerScroll.scrollTop += rect.top - anchor.anchorY;
  }

  function scheduleAnchorRefresh() {
    clearTimeout(anchorRefreshTimer);
    anchorRefreshTimer = setTimeout(() => { liveAnchor = captureScrollAnchor(); }, 80);
  }

  // Restore top line whenever the panel is resized externally.
  // ResizeObserver fires post-layout (before paint) so getBoundingClientRect
  // already reflects new dimensions — no rAF needed, and restoration is
  // idempotent so both observers can safely call the same handler.
  function handleResize() {
    if (!liveAnchor) { return; }
    restoreScrollAnchor(liveAnchor);
    scheduleAnchorRefresh();
  }
  new ResizeObserver(handleResize).observe(readerScroll);
  window.addEventListener('resize', handleResize);

  // ── Chapter detection ───────────────────────────────────────────────────────
  const PATTERNS = [
    /^第[零○〇一二三四五六七八九十百千万億\d]+[章節节回篇卷幕]/,
    /^Chapter\s+\d+/i,
    /^(?:序[章言]|前言|後記|后记|尾聲|尾声|番外|楔子|引子|正文)[\s\S]{0,20}$/,
    /^\d{1,4}[.、。]\s*.{1,30}$/,
  ];

  function detectChapters(text) {
    const lines = text.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.length > 60) { continue; }
      for (const p of PATTERNS) {
        if (p.test(trimmed)) { result.push({ title: trimmed, lineIdx: i }); break; }
      }
    }
    return result;
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderText(text) {
    if (chapters.length === 0) {
      contentEl.textContent = text;
      return;
    }
    const lines = text.split('\n');
    const chapterLines = new Set(chapters.map(c => c.lineIdx));
    const parts = [];
    for (let i = 0; i < lines.length; i++) {
      const esc = escHtml(lines[i]);
      parts.push(chapterLines.has(i)
        ? `<span id="ch-${i}" class="chapter-line">${esc}</span>`
        : esc);
      parts.push('\n');
    }
    contentEl.innerHTML = parts.join('');
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Chapter nav ─────────────────────────────────────────────────────────────
  function buildChapterNav() {
    chapterList.innerHTML = '';
    if (chapters.length === 0) {
      const li = document.createElement('li');
      li.className = 'no-chapters';
      li.textContent = '未偵測到章節';
      chapterList.appendChild(li);
      return;
    }
    const frag = document.createDocumentFragment();
    chapters.forEach((ch, idx) => {
      const li = document.createElement('li');
      li.textContent = ch.title;
      li.addEventListener('click', () => {
        jumpTo(idx);
        if (window.innerWidth < 600) { closeSidebar(); }
      });
      frag.appendChild(li);
    });
    chapterList.appendChild(frag);
  }

  function jumpTo(idx) {
    const ch = chapters[idx];
    if (!ch) { return; }
    const el = document.getElementById(`ch-${ch.lineIdx}`);
    if (el) {
      const r = readerScroll.getBoundingClientRect();
      const target = readerScroll.scrollTop + (el.getBoundingClientRect().top - r.top) - 20;
      readerScroll.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
    setActiveChapter(idx);
  }

  function setActiveChapter(idx) {
    if (idx === activeChapterIdx) { return; }
    const items = chapterList.querySelectorAll('li:not(.no-chapters)');
    if (activeChapterIdx >= 0 && items[activeChapterIdx]) {
      items[activeChapterIdx].classList.remove('active');
    }
    if (items[idx]) {
      items[idx].classList.add('active');
      items[idx].scrollIntoView({ block: 'nearest' });
    }
    activeChapterIdx = idx;
  }

  function syncActiveChapter() {
    if (chapters.length === 0) { return; }
    const top = readerScroll.getBoundingClientRect().top;
    let best = 0;
    for (let i = 0; i < chapters.length; i++) {
      const el = document.getElementById(`ch-${chapters[i].lineIdx}`);
      if (el && el.getBoundingClientRect().top <= top + 80) { best = i; } else { break; }
    }
    setActiveChapter(best);
  }

  // ── Scroll ──────────────────────────────────────────────────────────────────
  readerScroll.addEventListener('scroll', () => {
    updateProgress();
    scheduleAnchorRefresh();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      vscode.postMessage({ type: 'saveProgress', scrollTop: readerScroll.scrollTop, percent: currentPercent(), uriKey: currentUriKey });
    }, 800);
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(syncActiveChapter, 160);

    if (!nextFileRequested && currentUriKey && currentPercent() >= 95) {
      nextFileRequested = true;
      vscode.postMessage({ type: 'requestNextFile', uriKey: currentUriKey });
    }
  }, { passive: true });

  function updateProgress() {
    const { scrollTop, scrollHeight, clientHeight } = readerScroll;
    const max = scrollHeight - clientHeight;
    progressLabel.textContent = (max > 0 ? Math.min(100, Math.round((scrollTop / max) * 100)) : 0) + '%';
  }

  // ── Chapter search ──────────────────────────────────────────────────────────
  chapterSearch.addEventListener('input', () => {
    const q = chapterSearch.value.toLowerCase();
    chapterList.querySelectorAll('li:not(.no-chapters)').forEach((li, i) => {
      li.style.display = (chapters[i]?.title ?? '').toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // ── Toolbar ─────────────────────────────────────────────────────────────────

  // Sidebar toggle: set liveAnchor so the resize events during CSS transition
  // restore the correct position.
  btnSidebar.addEventListener('click', () => {
    liveAnchor = captureScrollAnchor();
    sidebar.classList.toggle('open');
  });
  btnClose.addEventListener('click', () => {
    liveAnchor = captureScrollAnchor();
    closeSidebar();
  });
  function closeSidebar() { sidebar.classList.remove('open'); }

  btnFontDec.addEventListener('click', () => {
    const anchor = captureScrollAnchor();
    fontSize = Math.max(12, fontSize - 1);
    applyFontSize();
    savePrefs();
    requestAnimationFrame(() => restoreScrollAnchor(anchor));
  });
  btnFontInc.addEventListener('click', () => {
    const anchor = captureScrollAnchor();
    fontSize = Math.min(40, fontSize + 1);
    applyFontSize();
    savePrefs();
    requestAnimationFrame(() => restoreScrollAnchor(anchor));
  });

  btnLhDec.addEventListener('click', () => {
    const anchor = captureScrollAnchor();
    lineHeight = Math.max(1.2, +(lineHeight - 0.1).toFixed(1));
    applyLineHeight();
    savePrefs();
    requestAnimationFrame(() => restoreScrollAnchor(anchor));
  });
  btnLhInc.addEventListener('click', () => {
    const anchor = captureScrollAnchor();
    lineHeight = Math.min(3.5, +(lineHeight + 0.1).toFixed(1));
    applyLineHeight();
    savePrefs();
    requestAnimationFrame(() => restoreScrollAnchor(anchor));
  });

  fontSelect.addEventListener('change', () => {
    const anchor = captureScrollAnchor();
    fontFamily = fontSelect.value;
    applyFont();
    savePrefs();
    requestAnimationFrame(() => restoreScrollAnchor(anchor));
  });

  btnTheme.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(); savePrefs();
  });

  function applyFontSize()   { contentEl.style.fontSize   = fontSize + 'px'; fontLabel.textContent = String(fontSize); }
  function applyLineHeight() { contentEl.style.lineHeight = String(lineHeight); lhLabel.textContent = lineHeight.toFixed(1); }
  function applyFont()       { contentEl.style.fontFamily = FONT_FAMILIES[fontFamily] ?? FONT_FAMILIES['serif']; fontSelect.value = fontFamily; }
  function applyTheme()      { document.body.classList.toggle('light', theme === 'light'); }

  function savePrefs() {
    vscode.postMessage({ type: 'savePrefs', prefs: { fontSize, lineHeight, fontFamily, theme } });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '\\') {
      e.preventDefault();
      liveAnchor = captureScrollAnchor();
      sidebar.classList.toggle('open');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { saveProgressNow(); }
  });

  vscode.postMessage({ type: 'ready' });
})();
