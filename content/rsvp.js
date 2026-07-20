/* global Zotero */
"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────

const WPM_STEPS = [150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900];
const DEFAULT_WPM = 300;
const ORP_TABLE = [0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3];

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg) { Zotero.getMainWindow().console.log(`[RSVP] ${msg}`); }
function warn(msg) { Zotero.getMainWindow().console.warn(`[RSVP] ${msg}`); }

function getOrpIndex(word) {
  const len = word.length;
  return len > 13 ? 4 : (ORP_TABLE[len] ?? 0);
}

function extractWords(text) {
  return text
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 0 && /[a-zA-Z0-9]/.test(w));
}

function esc(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nextWpm(current, dir) {
  const idx = WPM_STEPS.indexOf(current);
  if (dir === "up") return WPM_STEPS[Math.min(idx + 1, WPM_STEPS.length - 1)] ?? current;
  if (dir === "down") return WPM_STEPS[Math.max(idx - 1, 0)] ?? current;
  return current;
}

/** Get the current page number from the PDF.js viewer inside the reader iframe. */
function getCurrentPage(reader) {
  try {
    const win = reader._iframeWindow;
    const app = win?.wrappedJSObject?.PDFViewerApplication
      || win?.PDFViewerApplication;
    return app?.pdfViewer?.currentPageNumber ?? 1;
  } catch (_) { return 1; }
}

// ─── Text extraction ──────────────────────────────────────────────────────────

/**
 * Extract full text from the PDF, returning:
 *   { words: string[], pageOffsets: number[] }
 *
 * pageOffsets[i] = word index where page (i+1) begins.
 * e.g. pageOffsets[0]=0 (page 1 starts at word 0), pageOffsets[1]=142 (page 2 starts at word 142)
 */
async function extractPdfText(reader) {
  const itemID = reader.itemID;
  if (!itemID) return { words: [], pageOffsets: [0] };

  // Strategy 1: PDFWorker — best because it returns per-page data
  try {
    const item = Zotero.Items.get(itemID);
    if (item) {
      const result = await Zotero.PDFWorker.getFullText(item.id, 0, false, item.libraryID);
      if (result) {
        const pages = Array.isArray(result.text) ? result.text
          : Array.isArray(result.pages) ? result.pages
            : null;

        if (pages && pages.length > 0) {
          const words = [];
          const pageOffsets = [];
          for (const page of pages) {
            pageOffsets.push(words.length);
            words.push(...extractWords(page.content ?? page.text ?? ""));
          }
          if (words.length > 10) {
            log(`PDFWorker: ${words.length} words, ${pages.length} pages`);
            return { words, pageOffsets };
          }
        }

        // Flat string fallback
        const flat = typeof result.text === "string" ? result.text
          : typeof result === "string" ? result : "";
        if (flat.trim().length > 50) {
          const words = extractWords(flat);
          log(`PDFWorker flat: ${words.length} words (no page offsets)`);
          return { words, pageOffsets: [0] };
        }
      }
    }
  } catch (e) { warn("PDFWorker: " + e); }

  // Strategy 2: FullText index
  try {
    const result = await Zotero.FullText.getItemContent(itemID);
    if (result?.content?.trim().length > 50) {
      const words = extractWords(result.content);
      log(`FullText index: ${words.length} words`);
      return { words, pageOffsets: [0] };
    }
  } catch (e) { warn("FullText: " + e); }

  // Strategy 3: trigger indexing then retry
  try {
    const item = Zotero.Items.get(itemID);
    if (item) {
      log("Triggering FullText indexing…");
      await Zotero.FullText.indexItem(item, true);
      const result = await Zotero.FullText.getItemContent(itemID);
      if (result?.content?.trim().length > 50) {
        const words = extractWords(result.content);
        log(`After indexing: ${words.length} words`);
        return { words, pageOffsets: [0] };
      }
    }
  } catch (e) { warn("indexItem: " + e); }

  // Strategy 4: DOM text layers (partial — only rendered pages)
  try {
    const doc = reader._iframeWindow?.document;
    if (doc) {
      const spans = doc.querySelectorAll(".textLayer span");
      if (spans.length > 0) {
        const text = Array.from(spans).map(s => s.textContent).join(" ");
        if (text.trim().length > 20) {
          const words = extractWords(text);
          log(`DOM layers: ${words.length} words (partial)`);
          return { words, pageOffsets: [0] };
        }
      }
    }
  } catch (e) { warn("DOM layers: " + e); }

  warn("All extraction strategies failed for item " + itemID);
  return { words: [], pageOffsets: [0] };
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const OVERLAY_CSS = `
#zrsvp-panel {
  position: fixed;
  bottom: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10000;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 14px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.14);
  min-width: 360px;
  max-width: 540px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  display: none;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}
#zrsvp-panel.open { display: flex; }

#zrsvp-word-area {
  position: relative;
  padding: 22px 32px 18px;
  display: flex; align-items: center; justify-content: center;
  min-height: 64px;
}
#zrsvp-guide {
  position: absolute; top: 0; bottom: 0; left: 50%; width: 1px;
  background: rgba(249,115,22,0.2); pointer-events: none;
}
#zrsvp-word {
  font-size: 32px;
  font-family: "Courier New", Courier, monospace;
  line-height: 1; white-space: nowrap; letter-spacing: 0.01em; position: relative;
}
#zrsvp-word .orp  { color: #f97316; font-weight: 700; }
#zrsvp-word .hint {
  font-size: 13px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #94a3b8; font-weight: 400;
}
#zrsvp-source {
  text-align: center; font-size: 10px; color: #94a3b8;
  padding: 2px 12px 0; letter-spacing: 0.02em; min-height: 14px;
}
#zrsvp-footer {
  display: flex; align-items: center; gap: 2px;
  padding: 7px 10px; border-top: 1px solid #f1f5f9;
}
.zrsvp-btn {
  background: none; border: none; cursor: pointer;
  width: 30px; height: 28px; border-radius: 6px; font-size: 14px;
  display: flex; align-items: center; justify-content: center;
  color: #374151; padding: 0; flex-shrink: 0;
}
.zrsvp-btn:hover  { background: #f1f5f9; }
.zrsvp-btn:active { background: #e2e8f0; }
#zrsvp-wpm {
  font-size: 12px; color: #64748b; cursor: pointer; padding: 0 8px; height: 28px;
  display: flex; align-items: center; border-radius: 6px; white-space: nowrap;
}
#zrsvp-wpm:hover { background: #f1f5f9; }
#zrsvp-progress { font-size: 11px; color: #cbd5e1; margin-left: auto; padding-right: 4px; white-space: nowrap; }
#zrsvp-hints {
  padding: 3px 12px 7px; display: flex; gap: 10px;
  flex-wrap: wrap; justify-content: center;
}
.zrsvp-hint { font-size: 10px; color: #94a3b8; display: flex; align-items: center; gap: 3px; }
.zrsvp-kbd  {
  background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 3px;
  padding: 0 4px; font-size: 9px; font-family: monospace; color: #64748b;
}
#zrsvp-bar-track { height: 2px; background: #f1f5f9; }
#zrsvp-bar-fill  { height: 100%; background: #f97316; width: 0%; transition: width 0.1s linear; }

#zrsvp-toolbar-btn {
  display: flex; align-items: center; gap: 5px; padding: 3px 10px;
  border-radius: 6px; background: none; border: 1px solid transparent;
  cursor: pointer; font-size: 12.5px; font-weight: 600; color: #374151;
  white-space: nowrap;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  transition: background 0.12s, border-color 0.12s;
}
#zrsvp-toolbar-btn:hover  { background: #fff7ed; border-color: #fed7aa; color: #c2410c; }
#zrsvp-toolbar-btn.active { background: #fff7ed; border-color: #f97316; color: #ea580c; }

.zrsvp-selection-btn {
  display: flex; align-items: center; gap: 4px; padding: 2px 8px;
  background: none; border: none; cursor: pointer;
  font-size: 13px; color: #f97316; font-weight: 600; border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.zrsvp-selection-btn:hover { background: rgba(249,115,22,0.1); }
`;

// ─── State ────────────────────────────────────────────────────────────────────

class RSVPState {
  constructor(win) {
    this.win = win;
    this.words = [];
    this.pageOffsets = [0];
    this.idx = 0;
    this.wpm = DEFAULT_WPM;
    this.playing = false;
    this.loaded = false;
    this.loading = false;
    this.timer = null;
    this.mode = "doc"; // "doc" | "selection"
  }
  get totalWords() { return this.words.length; }
  get currentWord() { return this.words[this.idx] ?? null; }
  get progressPct() { return this.totalWords ? (this.idx / (this.totalWords - 1)) * 100 : 0; }
  get intervalMs() { return Math.floor(60000 / this.wpm); }

  wordIndexForPage(pageNum) {
    const i = Math.max(0, pageNum - 1);
    return this.pageOffsets[Math.min(i, this.pageOffsets.length - 1)] ?? 0;
  }
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function renderWord(state, doc) {
  const display = doc.getElementById("zrsvp-word");
  const progress = doc.getElementById("zrsvp-progress");
  const bar = doc.getElementById("zrsvp-bar-fill");
  if (!display) return;

  const word = state.currentWord;
  if (word === null) {
    display.innerHTML = `<span class="hint">Press ▶ to start</span>`;
  } else {
    const i = getOrpIndex(word);
    display.innerHTML =
      `<span>${esc(word.slice(0, i))}</span>` +
      `<span class="orp">${esc(word[i] ?? "")}</span>` +
      `<span>${esc(word.slice(i + 1))}</span>`;
  }
  if (progress) progress.textContent = state.totalWords ? `${state.idx + 1} / ${state.totalWords}` : "";
  if (bar) bar.style.width = `${state.progressPct}%`;
}

function updatePlayBtn(state, doc) {
  const btn = doc.getElementById("zrsvp-play");
  if (btn) btn.textContent = state.playing ? "⏸" : "▶";
}

function updateWpmDisplay(state, doc) {
  const el = doc.getElementById("zrsvp-wpm");
  if (el) el.textContent = `${state.wpm} wpm`;
}

function setSourceBadge(doc, text) {
  const el = doc.getElementById("zrsvp-source");
  if (el) el.textContent = text;
}

// ─── Playback ─────────────────────────────────────────────────────────────────

function play(state, doc) {
  if (!state.totalWords) return;
  state.playing = true;
  updatePlayBtn(state, doc);
  state.timer = state.win.setInterval(() => {
    if (state.idx >= state.totalWords - 1) { pause(state, doc); return; }
    state.idx++;
    renderWord(state, doc);
  }, state.intervalMs);
}

function pause(state, doc) {
  state.playing = false;
  updatePlayBtn(state, doc);
  if (state.timer) { state.win.clearInterval(state.timer); state.timer = null; }
}

function stop(state, doc) {
  pause(state, doc);
  state.idx = 0;
  renderWord(state, doc);
}

function togglePlay(state, doc) {
  if (state.playing) pause(state, doc); else play(state, doc);
}

function stepBack(state, doc) {
  pause(state, doc);
  state.idx = Math.max(0, state.idx - 1);
  renderWord(state, doc);
}

function stepForward(state, doc) {
  if (state.idx < state.totalWords - 1) { state.idx++; renderWord(state, doc); }
}

function changeSpeed(state, doc, dir) {
  state.wpm = nextWpm(state.wpm, dir);
  updateWpmDisplay(state, doc);
  if (state.playing) { pause(state, doc); play(state, doc); }
}

// ─── Load from selection ──────────────────────────────────────────────────────

function loadSelection(selectionText, state, doc) {
  const words = extractWords(selectionText);
  if (words.length === 0) return false;
  state.words = words;
  state.pageOffsets = [0];
  state.idx = 0;
  state.loaded = true;
  state.loading = false;
  state.mode = "selection";
  setSourceBadge(doc, `SELECTION · ${words.length} words`);
  renderWord(state, doc);
  log(`Selection: ${words.length} words`);
  return true;
}

// ─── Load from document ───────────────────────────────────────────────────────

async function loadText(reader, state, doc, startPage) {
  if (state.loading) return;
  state.loading = true;
  state.loaded = false;
  state.mode = "doc";

  const wordEl = doc.getElementById("zrsvp-word");
  if (wordEl) wordEl.innerHTML = `<span class="hint">Extracting text…</span>`;
  setSourceBadge(doc, "");

  try {
    const { words, pageOffsets } = await extractPdfText(reader);

    if (words.length < 5) {
      if (wordEl) wordEl.innerHTML = `<span class="hint" style="color:#ef4444;font-size:11px">
        No text found. PDF may be a scanned image.<br>
        Right-click item → Retrieve Metadata, then try again.
      </span>`;
      state.loading = false;
      return;
    }

    state.words = words;
    state.pageOffsets = pageOffsets;
    state.loaded = true;
    state.loading = false;

    const page = startPage ?? getCurrentPage(reader);
    state.idx = state.wordIndexForPage(page);

    setSourceBadge(doc,
      pageOffsets.length > 1
        ? `DOC · p.${page} · ${words.length} words total`
        : `DOC · ${words.length} words`
    );

    log(`Loaded ${words.length} words, starting at word ${state.idx} (p.${page})`);
    renderWord(state, doc);
  } catch (e) {
    warn("loadText: " + e);
    state.loading = false;
  }
}

// ─── Overlay injection ────────────────────────────────────────────────────────

async function injectOverlay(reader) {
  try { await reader._waitForReader(); }
  catch (e) { warn("_waitForReader: " + e); return; }

  const win = reader._iframeWindow;
  if (!win?.document?.body) { warn("No iframe body"); return; }
  if (win.document.getElementById("zrsvp-panel")) return;

  const doc = win.document;

  const styleEl = doc.createElement("style");
  styleEl.id = "zrsvp-style";
  styleEl.textContent = OVERLAY_CSS;
  doc.head.appendChild(styleEl);

  const panel = doc.createElement("div");
  panel.id = "zrsvp-panel";
  panel.innerHTML = `
    <div id="zrsvp-word-area">
      <div id="zrsvp-guide"></div>
      <div id="zrsvp-word"><span class="hint">Press ▶ to start</span></div>
    </div>
    <div id="zrsvp-source"></div>
    <div id="zrsvp-bar-track"><div id="zrsvp-bar-fill"></div></div>
    <div id="zrsvp-footer">
      <button class="zrsvp-btn" id="zrsvp-prev"     title="Previous word (←)">‹</button>
      <button class="zrsvp-btn" id="zrsvp-play"     title="Play / Pause (Space)">▶</button>
      <button class="zrsvp-btn" id="zrsvp-next"     title="Next word (→)">›</button>
      <button class="zrsvp-btn" id="zrsvp-stop"     title="Stop and reset to beginning">■</button>
      <button class="zrsvp-btn" id="zrsvp-frompage" title="Jump to current page (P)">⤴</button>
      <div id="zrsvp-wpm" title="Click: faster  Right-click: slower">300 wpm</div>
      <span id="zrsvp-progress"></span>
      <button class="zrsvp-btn" id="zrsvp-close" title="Close (Esc)">✕</button>
    </div>
    <div id="zrsvp-hints">
      <span class="zrsvp-hint"><span class="zrsvp-kbd">Space</span> Play/Pause</span>
      <span class="zrsvp-hint"><span class="zrsvp-kbd">← →</span> Step</span>
      <span class="zrsvp-hint"><span class="zrsvp-kbd">↑ ↓</span> Speed</span>
      <span class="zrsvp-hint"><span class="zrsvp-kbd">P</span> Jump to page</span>
      <span class="zrsvp-hint"><span class="zrsvp-kbd">Esc</span> Close</span>
    </div>
  `;
  doc.body.appendChild(panel);

  const state = new RSVPState(win);
  reader._rsvpState = state;

  doc.getElementById("zrsvp-play").addEventListener("click", () => togglePlay(state, doc));
  doc.getElementById("zrsvp-prev").addEventListener("click", () => stepBack(state, doc));
  doc.getElementById("zrsvp-next").addEventListener("click", () => stepForward(state, doc));
  doc.getElementById("zrsvp-stop").addEventListener("click", () => stop(state, doc));
  doc.getElementById("zrsvp-close").addEventListener("click", () => closePanel(reader, doc));

  doc.getElementById("zrsvp-frompage").addEventListener("click", () => {
    const wasPlaying = state.playing;
    pause(state, doc);
    if (state.loaded && state.mode === "doc") {
      const page = getCurrentPage(reader);
      state.idx = state.wordIndexForPage(page);
      setSourceBadge(doc,
        state.pageOffsets.length > 1
          ? `DOC · p.${page} · ${state.totalWords} words total`
          : `DOC · ${state.totalWords} words`
      );
      renderWord(state, doc);
      if (wasPlaying) play(state, doc);
    } else {
      loadText(reader, state, doc, getCurrentPage(reader))
        .catch(e => warn("frompage reload: " + e));
    }
  });

  const wpmEl = doc.getElementById("zrsvp-wpm");

  wpmEl.addEventListener("click", (e) => {
    if (e.button === 0) {
      changeSpeed(state, doc, "up");
    }
  });
  wpmEl.addEventListener("auxclick", (e) => {
    if (e.button === 2) {
      e.preventDefault();
      changeSpeed(state, doc, "down");
    }
  });

  wpmEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  doc.addEventListener("keydown", e => {
    if (!panel.classList.contains("open")) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    switch (e.key) {
      case " ": e.preventDefault(); togglePlay(state, doc); break;
      case "ArrowLeft": e.preventDefault(); stepBack(state, doc); break;
      case "ArrowRight": e.preventDefault(); stepForward(state, doc); break;
      case "ArrowUp": e.preventDefault(); changeSpeed(state, doc, "up"); break;
      case "ArrowDown": e.preventDefault(); changeSpeed(state, doc, "down"); break;
      case "p": case "P":
        // Jump to current page without closing
        doc.getElementById("zrsvp-frompage")?.click();
        break;
      case "Escape": closePanel(reader, doc); break;
    }
  });

  log("Overlay injected for item " + reader.itemID);
}

// ─── Panel open / close ───────────────────────────────────────────────────────

function openPanel(reader, doc, selectionText) {
  const panel = doc.getElementById("zrsvp-panel");
  const btn = doc.getElementById("zrsvp-toolbar-btn");
  if (!panel) return;
  panel.classList.add("open");
  if (btn) btn.classList.add("active");

  const state = reader._rsvpState;
  if (!state) return;

  if (selectionText) {
    pause(state, doc);
    loadSelection(selectionText, state, doc);
  } else if (!state.loaded && !state.loading) {
    loadText(reader, state, doc, getCurrentPage(reader))
      .catch(e => warn("loadText on open: " + e));
  }
}

function closePanel(reader, doc) {
  const panel = doc.getElementById("zrsvp-panel");
  const btn = doc.getElementById("zrsvp-toolbar-btn");
  if (!panel) return;
  panel.classList.remove("open");
  if (btn) btn.classList.remove("active");
  const state = reader._rsvpState;
  if (state) pause(state, doc);
}

function togglePanel(reader) {
  const doc = reader._iframeWindow?.document;
  if (!doc) return;
  const panel = doc.getElementById("zrsvp-panel");
  if (!panel) {
    injectOverlay(reader)
      .then(() => openPanel(reader, reader._iframeWindow.document))
      .catch(e => warn("injectOverlay on click: " + e));
    return;
  }
  if (panel.classList.contains("open")) closePanel(reader, doc);
  else openPanel(reader, doc);
}

// ─── Plugin object ────────────────────────────────────────────────────────────

var ZoteroRSVP = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,

  init({ id, version, rootURI }) {
    if (this.initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.initialized = true;

    // Toolbar button — append() MUST be called synchronously
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      (event) => {
        const { reader, doc, append } = event;
        const btn = doc.createElement("button");
        btn.id = "zrsvp-toolbar-btn";
        btn.innerHTML = `<span>⚡</span><span>RSVP</span>`;
        btn.addEventListener("click", () => togglePanel(reader));
        append(btn);
        injectOverlay(reader).catch(e => warn("injectOverlay: " + e));
      },
      this.id
    );

    // Text selection popup button — append() is also synchronous here
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event) => {
        const { reader, doc, params, append } = event;
        const selectedText = params?.annotation?.text || params?.text || "";
        if (!selectedText.trim()) return;

        const btn = doc.createElement("button");
        btn.className = "zrsvp-selection-btn";
        btn.title = "Read selection with RSVP";
        btn.innerHTML = `⚡ RSVP`;
        btn.addEventListener("click", () => {
          const readerDoc = reader._iframeWindow?.document;
          if (!readerDoc) return;
          const panel = readerDoc.getElementById("zrsvp-panel");
          if (!panel) {
            injectOverlay(reader)
              .then(() => openPanel(reader, reader._iframeWindow.document, selectedText))
              .catch(e => warn("injectOverlay from selection: " + e));
          } else {
            openPanel(reader, readerDoc, selectedText);
          }
        });
        append(btn);
      },
      this.id
    );

    log(`Initialized v${version}`);
  },

  addToWindow(_win) { },
  addToAllWindows() { },
  removeFromWindow(_win) { },

  shutdown() {
    try {
      for (const reader of (Zotero.Reader._readers ?? [])) {
        try {
          const doc = reader._iframeWindow?.document;
          if (!doc) continue;
          if (reader._rsvpState?.timer) reader._iframeWindow.clearInterval(reader._rsvpState.timer);
          doc.getElementById("zrsvp-style")?.remove();
          doc.getElementById("zrsvp-panel")?.remove();
          delete reader._rsvpState;
        } catch (_) { }
      }
    } catch (_) { }
    this.initialized = false;
    log("Shutdown");
  },
};
