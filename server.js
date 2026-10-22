// Tiny live-reloading Lean file viewer.
// Watches a .lean file on disk, highlights it server-side with Shiki
// (using the real Lean 4 TextMate grammar), and streams the rendered
// HTML to the browser over Server-Sent Events — so the page updates
// automatically whenever the file changes, with no manual refresh.
//
// Hover info ("more info" on mouseover) is powered by Lean's own
// language server (`lean --server`, the same one VS Code's Lean
// extension talks to) via a minimal LSP client — we don't reimplement
// any type-checking or name-resolution logic ourselves.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { LeanClient } = require('./lspClient');

const PORT = process.env.PORT || 8080;
const PROOFS_DIR = process.env.LEAN_PROOFS_DIR
  ? path.resolve(process.env.LEAN_PROOFS_DIR)
  : path.join(__dirname, 'lean', 'proofs');

// Humanize a filename like "03_real_analysis.lean" -> "Real Analysis".
function labelFor(filename) {
  return filename
    .replace(/\.lean$/, '')
    .replace(/^\d+[_-]*/, '')
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function listProofFiles() {
  let names = [];
  try {
    names = fs
      .readdirSync(PROOFS_DIR)
      .filter((f) => f.endsWith('.lean'))
      .sort();
  } catch (err) {
    console.error(`Could not read proofs dir ${PROOFS_DIR}: ${err.message}`);
  }
  return names.map((name) => ({
    id: name,
    label: labelFor(name),
    path: path.join(PROOFS_DIR, name),
  }));
}

let PROOFS = listProofFiles();
let LEAN_FILE = PROOFS.length ? PROOFS[0].path : path.join(PROOFS_DIR, 'none.lean');
// Lake project root: the `lean/` directory containing lakefile.toml, one
// level up from proofs/ — needed so `lake serve` can find the Mathlib
// dependency config regardless of which proof file is open.
const LEAN_PROJECT_ROOT = path.dirname(PROOFS_DIR);

const THEMES = {
  dark: { shiki: 'github-dark-default', bg: '#0d1117', fg: '#e6edf3' },
  light: { shiki: 'github-light-default', bg: '#ffffff', fg: '#1f2328' },
};

// Shiki's bundled Lean grammar has no working rule for "--" line comments
// (only block comments `/- ... -/` are recognized — "--" text, including
// any keywords inside it, gets colored as plain/default code). We detect
// "--" comments ourselves and force the correct comment color over that
// range, overriding whatever Shiki assigned. commentColor is filled in at
// startup by probing a (correctly-handled) block comment per theme.
function computeLineCommentStarts(content) {
  const lines = content.split('\n');
  const starts = new Array(lines.length).fill(-1);
  let inBlockComment = false;
  let inString = false;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let ch = 0;
    while (ch < line.length) {
      if (inBlockComment) {
        if (line.startsWith('-/', ch)) {
          inBlockComment = false;
          ch += 2;
        } else {
          ch++;
        }
        continue;
      }
      if (inString) {
        if (line[ch] === '\\') {
          ch += 2;
          continue;
        }
        if (line[ch] === '"') inString = false;
        ch++;
        continue;
      }
      if (line.startsWith('/-', ch)) {
        inBlockComment = true;
        ch += 2;
        continue;
      }
      if (line[ch] === '"') {
        inString = true;
        ch++;
        continue;
      }
      if (line.startsWith('--', ch)) {
        starts[li] = ch;
        break;
      }
      ch++;
    }
  }
  return starts;
}

let clients = [];
let highlighter = null;
let leanStatus = 'starting'; // starting | elaborating | ready | crashed
let diagnosticsCount = 0;
let diagnostics = []; // full LSP diagnostics (errors, warnings, AND info — e.g. #eval/#check output)
let currentHtml = { dark: '', light: '' };

function readFileSafe() {
  try {
    return fs.readFileSync(LEAN_FILE, 'utf8');
  } catch (err) {
    return `-- Could not read file: ${LEAN_FILE}\n-- ${err.message}`;
  }
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Splits a colored Shiki token's text into hoverable sub-spans: runs of
// word characters (identifiers/numbers), runs of whitespace (left
// unwrapped — nothing to hover), or single other characters (operators,
// punctuation, unicode notation like → ∀ λ). This lets the browser use
// real DOM elements + real `mouseover` events for hover targeting,
// instead of computing a character offset from mouse pixel coordinates.
const SUBTOKEN_RE = /[\p{L}\p{N}_][\p{L}\p{N}_'!?]*|\s+|./gsu;

function renderHtmlForTheme(content, themeKey) {
  const theme = THEMES[themeKey];
  if (!highlighter) {
    return `<pre class="shiki-fallback"><code>${escapeHtml(content)}</code></pre>`;
  }
  try {
    const lines = highlighter.codeToTokensBase(content, { lang: 'lean', theme: theme.shiki });
    const commentStarts = computeLineCommentStarts(content);
    let body = '';
    lines.forEach((lineTokens, lineIdx) => {
      let ch = 0;
      let lineHtml = '';
      const commentStart = commentStarts[lineIdx];
      for (const tok of lineTokens) {
        const pieces = tok.content.match(SUBTOKEN_RE) || [tok.content];
        for (const piece of pieces) {
          const inLineComment = commentStart !== -1 && ch >= commentStart;
          const color = inLineComment ? theme.commentColor || theme.fg : tok.color || theme.fg;
          if (/^\s+$/.test(piece)) {
            lineHtml += escapeHtml(piece);
          } else {
            lineHtml += `<span class="tok" data-line="${lineIdx}" data-ch="${ch}" style="color:${color}">${escapeHtml(piece)}</span>`;
          }
          ch += piece.length;
        }
      }
      // No trailing newline here: .line is already `display: block`, so it
      // provides its own line break. Adding a literal "\n" too (inside a
      // whitespace-preserving <pre>) doubled every line's vertical gap.
      body += `<span class="line">${lineHtml || '&#8203;'}</span>`;
    });
    return `<pre class="shiki-tok" tabindex="0"><code>${body}</code></pre>`;
  } catch (err) {
    console.error(`Shiki tokenize failed: ${err.message}`);
    return `<pre class="shiki-fallback"><code>${escapeHtml(content)}</code></pre>`;
  }
}

function renderHtml(content) {
  return { dark: renderHtmlForTheme(content, 'dark'), light: renderHtmlForTheme(content, 'light') };
}

function currentFileId() {
  const found = PROOFS.find((p) => p.path === LEAN_FILE);
  return found ? found.id : null;
}

// Simplified shape for the browser's output panel: just what each
// message needs to render (line, severity, text) — LSP severity numbers
// (1=Error, 2=Warning, 3=Information, 4=Hint), sorted top-to-bottom.
function serializeDiagnostics() {
  return diagnostics
    .map((d) => ({
      line: d.range?.start?.line ?? 0,
      character: d.range?.start?.character ?? 0,
      severity: d.severity ?? 3,
      message: d.message,
    }))
    .sort((a, b) => a.line - b.line || a.character - b.character);
}

function sendToAll() {
  const payload = `data: ${JSON.stringify({
    htmlDark: currentHtml.dark,
    htmlLight: currentHtml.light,
    file: LEAN_FILE,
    files: PROOFS.map((p) => ({ id: p.id, label: p.label })),
    currentFile: currentFileId(),
    leanStatus,
    diagnosticsCount,
    diagnostics: serializeDiagnostics(),
  })}\n\n`;
  for (const res of clients) res.write(payload);
}

let leanClient = null;

function refresh() {
  const content = readFileSafe();
  currentHtml = renderHtml(content);
  sendToAll();
  if (leanClient) leanClient.didChange(content);
}

// Debounce rapid successive fs events (editors often fire several per save).
let debounceTimer = null;
function scheduleRefresh() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refresh, 100);
}

let fsWatcher = null;
let pollInterval = null;

function watchFile() {
  if (fsWatcher) {
    fsWatcher.close();
    fsWatcher = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  try {
    fsWatcher = fs.watch(LEAN_FILE, { persistent: true }, () => scheduleRefresh());
  } catch (err) {
    console.error(`Could not watch ${LEAN_FILE}: ${err.message}`);
  }
  // Fallback poll in case fs.watch misses events (some filesystems/editors).
  let lastMtime = 0;
  pollInterval = setInterval(() => {
    try {
      const { mtimeMs } = fs.statSync(LEAN_FILE);
      if (mtimeMs !== lastMtime) {
        lastMtime = mtimeMs;
        scheduleRefresh();
      }
    } catch {
      // ignore, file may not exist yet
    }
  }, 1000);
}

// Stop the current Lean client (if any) — used when switching files,
// right before starting a fresh one against the new file.
function stopLeanClient() {
  if (leanClient) {
    leanClient.stop();
    leanClient = null;
  }
}

// Start a fresh Lean client against the current LEAN_FILE/content.
function startLeanClient(content) {
  leanStatus = 'starting';
  diagnosticsCount = 0;
  diagnostics = [];
  const thisClient = new LeanClient(LEAN_FILE, {
    projectRoot: LEAN_PROJECT_ROOT,
    onStatus: (status) => {
      if (leanClient !== thisClient) return; // stale callback from a client we've since replaced/stopped
      leanStatus = status;
      sendToAll();
    },
    onDiagnostics: (diags) => {
      if (leanClient !== thisClient) return;
      diagnostics = diags;
      diagnosticsCount = diags.filter((d) => d.severity === 1 || d.severity === 2).length;
      sendToAll();
    },
  });
  leanClient = thisClient;
  leanClient.start(content).catch((err) => {
    if (leanClient !== thisClient) return; // we've already moved on (stopped/switched) — not a real crash
    console.error('Failed to start Lean language server:', err);
    leanStatus = 'crashed';
    sendToAll();
  });
}

// Switch the file being watched/elaborated — stops the current Lean
// client and fs watcher, then starts fresh ones pointed at the new file.
async function selectFile(fileId) {
  const target = PROOFS.find((p) => p.id === fileId);
  if (!target || target.path === LEAN_FILE) return;

  LEAN_FILE = target.path;
  diagnosticsCount = 0;
  diagnostics = [];

  const content = readFileSafe();
  currentHtml = renderHtml(content);
  stopLeanClient();
  leanStatus = 'starting';
  sendToAll();

  startLeanClient(content);
  watchFile();
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Lean Live Viewer</title>
<script>
// Applied synchronously (before first paint) to avoid a flash of the
// wrong theme when a saved preference exists.
(function () {
  try {
    if (localStorage.getItem('lean-viewer-theme') === 'light') {
      document.documentElement.classList.add('light');
    }
  } catch (e) {}
})();
</script>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #21262d;
    --statusbar-bg: #010409;
    --tooltip-bg: #161b22;
    --tooltip-border: #30363d;
    --tooltip-code-bg: #0d1117;
    --accent: #58a6ff;
    --gutter: #484f58;
    --btn-bg: #21262d;
    --btn-fg: #e6edf3;
  }
  html.light {
    color-scheme: light;
    --bg: #ffffff;
    --fg: #1f2328;
    --muted: #59636e;
    --border: #d0d7de;
    --statusbar-bg: #f6f8fa;
    --tooltip-bg: #f6f8fa;
    --tooltip-border: #d0d7de;
    --tooltip-code-bg: #ffffff;
    --accent: #0969da;
    --gutter: #8c959f;
    --btn-bg: #eaeef2;
    --btn-fg: #1f2328;
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    overflow-x: hidden;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--fg);
    display: flex;
    flex-direction: column;
  }
  main {
    padding: 0;
    margin: 0 0 34px 0;
    width: 100%;
    max-width: 100%;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  #menubar {
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    height: 40px;
    padding: 0 16px;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 10px;
    background: var(--statusbar-bg);
    border-bottom: 1px solid var(--border);
    z-index: 400;
  }
  #menubarRight {
    grid-column: 3;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
  #checkStatus {
    grid-column: 1;
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
  }
  #checkStatusDot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  #checkStatus.status-checking #checkStatusDot {
    background: var(--accent);
    animation: status-pulse 1.4s ease-in-out infinite;
  }
  #checkStatus.status-ok #checkStatusDot { background: #3fb950; }
  #checkStatus.status-error #checkStatusDot { background: #f85149; }
  #checkStatus.status-crashed #checkStatusDot { background: #f85149; }
  @keyframes status-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(88, 166, 255, 0.4); }
    50% { box-shadow: 0 0 0 4px rgba(88, 166, 255, 0); }
  }
  #menubar label {
    font-size: 12px;
    color: var(--muted);
  }
  #proofSelect {
    font-family: inherit;
    font-size: 13px;
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--btn-bg);
    color: var(--btn-fg);
    cursor: pointer;
  }
  #proofSelect:disabled {
    opacity: 0.6;
  }
  #splitContainer {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
    min-width: 0;
  }
  #splitContainer.split-horizontal { flex-direction: column; }
  #splitContainer.split-vertical { flex-direction: row; }
  #codePane {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  /* Default split sizes before the user drags the divider (persisted
     thereafter via inline flex-basis set from JS). */
  .split-horizontal #codePane { flex-basis: 70%; }
  .split-vertical #codePane { flex-basis: 60%; }
  #splitDivider {
    flex: 0 0 6px;
    background: var(--border);
    position: relative;
  }
  .split-horizontal #splitDivider { cursor: row-resize; }
  .split-vertical #splitDivider { cursor: col-resize; }
  #splitDivider:hover, #splitDivider.dragging { background: var(--accent); }
  #outputPane {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    overflow: hidden;
  }
  #outputHeader {
    flex: 0 0 auto;
    padding: 6px 12px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  #outputList {
    flex: 1 1 auto;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
  }
  .output-empty {
    padding: 10px 12px;
    color: var(--muted);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  .output-msg {
    display: flex;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .output-msg:hover { background: var(--btn-bg); }
  .output-msg .output-line {
    flex: 0 0 auto;
    color: var(--muted);
    user-select: none;
  }
  .output-msg .output-text {
    flex: 1 1 auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .output-msg.sev-error .output-text { color: #f85149; }
  .output-msg.sev-warning .output-text { color: #d29922; }
  .output-msg.sev-info .output-text { color: var(--fg); }
  #splitToggle {
    flex: 0 0 auto;
    margin-left: 12px;
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .split-toggle-btn {
    font-family: inherit;
    font-size: 11px;
    padding: 3px 8px;
    border: none;
    background: var(--btn-bg);
    color: var(--muted);
    cursor: pointer;
  }
  .split-toggle-btn + .split-toggle-btn { border-left: 1px solid var(--border); }
  .split-toggle-btn.active {
    background: var(--accent);
    color: #fff;
  }
  #skeleton {
    display: none;
    padding: 18px 20px;
  }
  #skeleton.active { display: block; }
  #skeleton.active + #codewrap { display: none; }
  #skeleton .sk-line {
    height: 14px;
    margin: 11px 0;
    border-radius: 4px;
    background: linear-gradient(
      90deg,
      var(--border) 25%,
      var(--btn-bg) 37%,
      var(--border) 63%
    );
    background-size: 400% 100%;
    animation: sk-shimmer 1.4s ease infinite;
  }
  @keyframes sk-shimmer {
    0% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  #codewrap {
    width: 100%;
    max-width: 100%;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  #codewrap pre {
    margin: 0;
    width: 100%;
    max-width: 100%;
    flex: 1 1 auto;
    min-height: 0;
    padding: 18px 20px;
    font-size: 14px;
    line-height: 1.6;
    overflow: auto;
    background: var(--bg);
    color: var(--fg);
  }
  #codewrap code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    counter-reset: line;
  }
  #codewrap .line {
    display: block;
    cursor: default;
    min-width: max-content;
  }
  #codewrap .line::before {
    counter-increment: line;
    content: counter(line);
    display: inline-block;
    width: 2.2em;
    margin-right: 1em;
    text-align: right;
    color: var(--gutter);
    user-select: none;
  }
  #codewrap .tok {
    cursor: pointer;
    border-radius: 3px;
  }
  #codewrap .tok:hover {
    background: rgba(136, 136, 136, 0.22);
    outline: 1px solid rgba(0, 0, 0, 0.35);
    outline-offset: 0;
  }
  #codewrap .tok.tok-hover {
    background: rgba(88, 166, 255, 0.18);
    outline: 2px solid var(--accent);
    outline-offset: 0;
  }
  #statusbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 34px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--statusbar-bg);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
    z-index: 500;
  }
  #statusbar .file {
    flex: 1 1 auto;
    min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #themeToggle {
    flex: 0 0 auto;
    margin-left: 12px;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--btn-bg);
    color: var(--btn-fg);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0;
  }
  #themeToggle:hover { filter: brightness(1.2); }
  #tooltip {
    position: fixed;
    z-index: 1000;
    max-width: 520px;
    background: var(--tooltip-bg);
    border: 1px solid var(--tooltip-border);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--fg);
    box-shadow: 0 8px 24px rgba(1,4,9,0.35);
    display: none;
  }
  #tooltip p { margin: 0 0 6px 0; }
  #tooltip p:last-child { margin-bottom: 0; }
  #tooltip hr { border: none; border-top: 1px solid var(--tooltip-border); margin: 8px 0; }
  #tooltip code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--tooltip-code-bg); padding: 1px 4px; border-radius: 3px; }
  #tooltip pre.tt-code {
    margin: 0 0 6px 0;
    padding: 8px 10px;
    background: var(--tooltip-code-bg);
    border: 1px solid var(--tooltip-border);
    border-radius: 4px;
    overflow-x: auto;
  }
  #tooltip pre.tt-code code { background: none; padding: 0; }
</style>
</head>
<body>
<div id="menubar">
  <div id="checkStatus"><span id="checkStatusDot"></span><span id="checkStatusText">Starting…</span></div>
  <span></span>
  <div id="menubarRight">
    <label for="proofSelect">Proof</label>
    <select id="proofSelect"></select>
  </div>
</div>
<main>
  <div id="splitContainer" class="split-horizontal">
    <div id="codePane">
      <div id="skeleton">
        <div class="sk-line" style="width: 40%"></div>
        <div class="sk-line" style="width: 0%"></div>
        <div class="sk-line" style="width: 75%"></div>
        <div class="sk-line" style="width: 58%"></div>
        <div class="sk-line" style="width: 62%"></div>
        <div class="sk-line" style="width: 0%"></div>
        <div class="sk-line" style="width: 85%"></div>
        <div class="sk-line" style="width: 45%"></div>
      </div>
      <div id="codewrap"><pre><code>loading&hellip;</code></pre></div>
    </div>
    <div id="splitDivider" title="Drag to resize"></div>
    <div id="outputPane">
      <div id="outputHeader">Messages</div>
      <div id="outputList"><div class="output-empty">No output yet.</div></div>
    </div>
  </div>
</main>
<div id="statusbar">
  <span class="file" id="filepath"></span>
  <div id="splitToggle" role="group" aria-label="Split orientation">
    <button id="splitHorizontalBtn" class="split-toggle-btn active" title="Stack output below code">&#9601;&#9601;</button>
    <button id="splitVerticalBtn" class="split-toggle-btn" title="Show output beside code">&#9614;&#9614;</button>
  </div>
  <button id="themeToggle" title="Toggle light/dark theme">&#127769;</button>
</div>
<div id="tooltip"></div>

<script>
(function () {
  var codewrap = document.getElementById('codewrap');
  var fileEl = document.getElementById('filepath');
  var tooltip = document.getElementById('tooltip');
  var themeToggle = document.getElementById('themeToggle');
  var proofSelect = document.getElementById('proofSelect');
  var skeleton = document.getElementById('skeleton');
  var checkStatus = document.getElementById('checkStatus');
  var checkStatusText = document.getElementById('checkStatusText');
  var splitContainer = document.getElementById('splitContainer');
  var codePane = document.getElementById('codePane');
  var splitDivider = document.getElementById('splitDivider');
  var outputList = document.getElementById('outputList');
  var splitHorizontalBtn = document.getElementById('splitHorizontalBtn');
  var splitVerticalBtn = document.getElementById('splitVerticalBtn');

  var lineTokMap = null; // Map<lineNumber, Element[]> of .tok spans, for range highlighting

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderTextMd(t) {
    var s = escapeHtml(t);
    s = s.replace(/^\\s*\\*\\*\\*\\s*$/gm, '<hr>');
    s = s.replace(/\\n*<hr>\\n*/g, '<hr>');
    s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    s = s.trim();
    if (!s) return '';
    s = s.replace(/\\n{2,}/g, '</p><p>');
    s = s.replace(/\\n/g, '<br>');
    s = s.replace(/<p><\\/p>/g, '');
    return '<p>' + s + '</p>';
  }

  function renderMarkdownLite(md) {
    var out = '';
    var lastIndex = 0;
    var re = /\`\`\`([a-zA-Z0-9]*)\\n([\\s\\S]*?)\`\`\`/g;
    var m;
    while ((m = re.exec(md))) {
      if (m.index > lastIndex) out += renderTextMd(md.slice(lastIndex, m.index));
      var codeBody = m[2].replace(/\\n$/, '');
      out += '<pre class="tt-code"><code>' + escapeHtml(codeBody) + '</code></pre>';
      lastIndex = re.lastIndex;
    }
    if (lastIndex < md.length) out += renderTextMd(md.slice(lastIndex));
    return out;
  }

  function indexTokens() {
    lineTokMap = new Map();
    var toks = codewrap.querySelectorAll('.tok');
    for (var i = 0; i < toks.length; i++) {
      var el = toks[i];
      var line = parseInt(el.getAttribute('data-line'), 10);
      var bucket = lineTokMap.get(line);
      if (!bucket) { bucket = []; lineTokMap.set(line, bucket); }
      bucket.push(el);
    }
  }

  function render(html) {
    codewrap.innerHTML = html;
    indexTokens();
  }

  // --- theme (light/dark) ---
  var lastData = null; // most recent SSE payload, so toggling is instant (no refetch)

  function currentTheme() {
    return document.documentElement.classList.contains('light') ? 'light' : 'dark';
  }

  function updateThemeToggleIcon() {
    themeToggle.textContent = currentTheme() === 'light' ? '\\u2600\\ufe0f' : '\\ud83c\\udf19';
  }

  function renderForCurrentTheme() {
    if (!lastData) return;
    render(currentTheme() === 'light' ? lastData.htmlLight : lastData.htmlDark);
  }

  function setTheme(theme) {
    document.documentElement.classList.toggle('light', theme === 'light');
    try { localStorage.setItem('lean-viewer-theme', theme); } catch (e) {}
    updateThemeToggleIcon();
    renderForCurrentTheme();
    hideTooltip();
  }

  themeToggle.addEventListener('click', function () {
    setTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });

  updateThemeToggleIcon();

  // --- click-to-reveal hover interaction ---
  // Nothing is fetched just from moving the mouse — .tok spans only get
  // a pointer cursor via CSS as a hint that they are clickable. Clicking a
  // token fetches its info from Lean's language server and pins a
  // tooltip + highlight in place; it stays until the user clicks
  // elsewhere (outside the tooltip) or clicks a different token.
  var lastKey = null;
  var lastRange = null;
  var hoveredEls = [];
  var currentAbort = null;

  function clearHighlight() {
    for (var i = 0; i < hoveredEls.length; i++) hoveredEls[i].classList.remove('tok-hover');
    hoveredEls = [];
  }

  function applyHighlightForRange(range) {
    clearHighlight();
    if (!range || !lineTokMap) return;
    for (var line = range.start.line; line <= range.end.line; line++) {
      var bucket = lineTokMap.get(line);
      if (!bucket) continue;
      for (var i = 0; i < bucket.length; i++) {
        var el = bucket[i];
        var ch = parseInt(el.getAttribute('data-ch'), 10);
        if (line === range.start.line && ch < range.start.character) continue;
        if (line === range.end.line && ch >= range.end.character) continue;
        el.classList.add('tok-hover');
        hoveredEls.push(el);
      }
    }
  }

  function positionTooltipNear(el) {
    var pad = 12;
    var rect = el.getBoundingClientRect();
    var x = rect.left;
    var y = rect.bottom + 6;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    requestAnimationFrame(function () {
      var trect = tooltip.getBoundingClientRect();
      var nx = x, ny = y;
      if (trect.right > window.innerWidth - pad) nx = Math.max(pad, window.innerWidth - pad - trect.width);
      if (trect.bottom > window.innerHeight - pad) ny = Math.max(pad, rect.top - trect.height - 8);
      tooltip.style.left = nx + 'px';
      tooltip.style.top = ny + 'px';
    });
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    clearHighlight();
    lastRange = null;
    lastKey = null;
  }

  function fetchHover(line, character, el) {
    if (currentAbort) currentAbort.abort();
    var ctrl = new AbortController();
    currentAbort = ctrl;
    fetch('/hover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: line, character: character }),
      signal: ctrl.signal,
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.contents && data.contents.value) {
          var range = data.range || {
            start: { line: line, character: character },
            end: { line: line, character: character + 1 },
          };
          lastRange = range;
          applyHighlightForRange(range);
          tooltip.innerHTML = renderMarkdownLite(data.contents.value);
          tooltip.style.display = 'block';
          positionTooltipNear(el);
        } else {
          lastRange = null;
          lastKey = null;
          clearHighlight();
          tooltip.style.display = 'none';
        }
      })
      .catch(function () { /* aborted or server hiccup — ignore */ });
  }

  document.addEventListener('click', function (e) {
    var tokEl = e.target.closest ? e.target.closest('.tok') : null;

    if (tokEl) {
      var line = parseInt(tokEl.getAttribute('data-line'), 10);
      var ch = parseInt(tokEl.getAttribute('data-ch'), 10);
      var key = line + ':' + ch;
      // Clicking the same already-open token again closes it (toggle).
      if (key === lastKey && tooltip.style.display === 'block') {
        hideTooltip();
        return;
      }
      lastKey = key;
      fetchHover(line, ch, tokEl);
      return;
    }

    // Clicks inside the open tooltip (e.g. selecting text, clicking a
    // link) shouldn't dismiss it.
    if (e.target.closest && e.target.closest('#tooltip')) return;

    hideTooltip();
  });

  // --- proof selector menu ---
  var lastFilesKey = null; // avoid rebuilding <option>s (and losing focus) every SSE tick

  function renderMenu(files, currentFile) {
    var key = JSON.stringify(files);
    if (key !== lastFilesKey) {
      lastFilesKey = key;
      proofSelect.innerHTML = '';
      for (var i = 0; i < files.length; i++) {
        var opt = document.createElement('option');
        opt.value = files[i].id;
        opt.textContent = files[i].label;
        proofSelect.appendChild(opt);
      }
    }
    if (currentFile) proofSelect.value = currentFile;
  }

  function setSwitching(isSwitching) {
    proofSelect.disabled = isSwitching;
    skeleton.classList.toggle('active', isSwitching);
  }

  // --- check status indicator ---
  // Checking runs automatically and continuously; this just reflects the
  // live state Lean's own language server is reporting over SSE.
  function renderCheckStatus(leanStatus, diagnosticsCount) {
    checkStatus.classList.remove('status-checking', 'status-ok', 'status-error', 'status-crashed');
    if (leanStatus === 'starting' || leanStatus === 'elaborating') {
      checkStatus.classList.add('status-checking');
      checkStatusText.textContent = 'Checking…';
    } else if (leanStatus === 'crashed') {
      checkStatus.classList.add('status-crashed');
      checkStatusText.textContent = 'Checker crashed';
    } else if (leanStatus === 'ready' && diagnosticsCount > 0) {
      checkStatus.classList.add('status-error');
      checkStatusText.textContent = diagnosticsCount === 1 ? '1 issue found' : diagnosticsCount + ' issues found';
    } else if (leanStatus === 'ready') {
      checkStatus.classList.add('status-ok');
      checkStatusText.textContent = 'Checked';
    } else {
      checkStatusText.textContent = 'Starting…';
    }
  }

  // --- output panel (real Lean messages: #eval/#check results, plus any
  // error/warning text — not just the pass/fail count in the status bar) ---
  var SEV_CLASS = { 1: 'sev-error', 2: 'sev-warning', 3: 'sev-info', 4: 'sev-info' };

  function renderOutput(diags) {
    if (!diags || diags.length === 0) {
      outputList.innerHTML = '<div class="output-empty">No output yet.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < diags.length; i++) {
      var d = diags[i];
      html +=
        '<div class="output-msg ' + (SEV_CLASS[d.severity] || 'sev-info') + '" data-line="' + d.line + '">' +
        '<span class="output-line">L' + (d.line + 1) + '</span>' +
        '<span class="output-text"></span>' +
        '</div>';
    }
    outputList.innerHTML = html;
    // Set text via textContent (not interpolated into the HTML string
    // above) so message content can never be interpreted as markup.
    var rows = outputList.querySelectorAll('.output-msg');
    for (var j = 0; j < rows.length; j++) {
      rows[j].querySelector('.output-text').textContent = diags[j].message;
    }
  }

  outputList.addEventListener('click', function (e) {
    var row = e.target.closest ? e.target.closest('.output-msg') : null;
    if (!row || !lineTokMap) return;
    var line = parseInt(row.getAttribute('data-line'), 10);
    var bucket = lineTokMap.get(line);
    if (bucket && bucket[0]) bucket[0].scrollIntoView({ block: 'center' });
  });

  // --- split layout: orientation toggle + draggable divider ---
  var SPLIT_KEY = 'lean-viewer-split';
  var RATIO_KEY_PREFIX = 'lean-viewer-split-ratio-';

  function applyRatio(orientation) {
    var saved = null;
    try { saved = localStorage.getItem(RATIO_KEY_PREFIX + orientation); } catch (e) {}
    codePane.style.flexBasis = saved ? saved + '%' : '';
  }

  function setOrientation(orientation) {
    splitContainer.classList.remove('split-horizontal', 'split-vertical');
    splitContainer.classList.add('split-' + orientation);
    splitHorizontalBtn.classList.toggle('active', orientation === 'horizontal');
    splitVerticalBtn.classList.toggle('active', orientation === 'vertical');
    applyRatio(orientation);
    try { localStorage.setItem(SPLIT_KEY, orientation); } catch (e) {}
  }

  splitHorizontalBtn.addEventListener('click', function () { setOrientation('horizontal'); });
  splitVerticalBtn.addEventListener('click', function () { setOrientation('vertical'); });

  (function initSplit() {
    var saved = null;
    try { saved = localStorage.getItem(SPLIT_KEY); } catch (e) {}
    setOrientation(saved === 'vertical' ? 'vertical' : 'horizontal');
  })();

  (function initDrag() {
    var dragging = false;

    function orientation() {
      return splitContainer.classList.contains('split-vertical') ? 'vertical' : 'horizontal';
    }

    function onMove(e) {
      if (!dragging) return;
      var rect = splitContainer.getBoundingClientRect();
      var pct;
      if (orientation() === 'vertical') {
        pct = ((e.clientX - rect.left) / rect.width) * 100;
      } else {
        pct = ((e.clientY - rect.top) / rect.height) * 100;
      }
      pct = Math.max(15, Math.min(85, pct));
      codePane.style.flexBasis = pct + '%';
      try { localStorage.setItem(RATIO_KEY_PREFIX + orientation(), String(pct)); } catch (err) {}
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      splitDivider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    splitDivider.addEventListener('mousedown', function (e) {
      dragging = true;
      splitDivider.classList.add('dragging');
      e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  var pendingFile = null; // id we're waiting on the server to confirm/send

  proofSelect.addEventListener('change', function () {
    // Show the skeleton right away — just long enough to cover the
    // network round trip to /api/select. The server pushes the new
    // file's source over SSE as soon as it switches (well before Lean
    // finishes re-elaborating it), so real code replaces the skeleton
    // quickly; hover/diagnostics catch up separately in the background.
    pendingFile = proofSelect.value;
    setSwitching(true);
    fetch('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: proofSelect.value }),
    }).catch(function () { pendingFile = null; setSwitching(false); });
  });

  // --- SSE live updates ---
  // The EventSource connection itself going down (server process crashed,
  // network hiccup, etc.) is a distinct failure mode from the Lean
  // checker crashing — surface it with the same status indicator so
  // there's never a silently-stale page.
  function renderOfflineStatus() {
    checkStatus.classList.remove('status-checking', 'status-ok', 'status-error', 'status-crashed');
    checkStatus.classList.add('status-crashed');
    checkStatusText.textContent = 'Server offline';
  }

  function connect() {
    var es = new EventSource('/events');
    es.onerror = function () {
      // The browser will keep retrying this connection automatically;
      // we just reflect "offline" until a message actually gets through.
      renderOfflineStatus();
    };
    es.onmessage = function (e) {
      var data = JSON.parse(e.data);
      lastData = data;
      fileEl.textContent = data.file;
      if (data.files) renderMenu(data.files, data.currentFile);
      if (pendingFile && data.currentFile === pendingFile) pendingFile = null;
      setSwitching(!!pendingFile);
      renderCheckStatus(data.leanStatus, data.diagnosticsCount);
      renderOutput(data.diagnostics);
      renderForCurrentTheme();
      hideTooltip();
    };
  }

  connect();
})();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('\n');
    clients.push(res);
    res.write(
      `data: ${JSON.stringify({
        htmlDark: currentHtml.dark,
        htmlLight: currentHtml.light,
        file: LEAN_FILE,
        files: PROOFS.map((p) => ({ id: p.id, label: p.label })),
        currentFile: currentFileId(),
        leanStatus,
        diagnosticsCount,
        diagnostics: serializeDiagnostics(),
      })}\n\n`
    );
    req.on('close', () => {
      clients = clients.filter((c) => c !== res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/select') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e4) req.destroy();
    });
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        await selectFile(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/hover') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(); // guard against abuse
    });
    req.on('end', async () => {
      try {
        const { line, character } = JSON.parse(body);
        if (!leanClient) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(null));
          return;
        }
        const result = await leanClient.hover(line, character);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(null));
      }
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

async function main() {
  const { createHighlighter } = await import('shiki');
  highlighter = await createHighlighter({
    themes: [THEMES.dark.shiki, THEMES.light.shiki],
    langs: ['lean'],
  });

  // Block comments ARE correctly recognized by the grammar, so probe one
  // to get each theme's real "comment" scope color, used to override the
  // (broken) "--" line-comment coloring above.
  for (const theme of Object.values(THEMES)) {
    const probe = highlighter.codeToTokensBase('/- x -/', { lang: 'lean', theme: theme.shiki });
    theme.commentColor = probe[0]?.[0]?.color || theme.fg;
  }

  const initialContent = readFileSafe();
  currentHtml = renderHtml(initialContent);

  startLeanClient(initialContent);
  watchFile();

  server.listen(PORT, () => {
    console.log(`Lean live viewer running on http://localhost:${PORT}`);
    console.log(`Proofs directory: ${PROOFS_DIR}`);
    console.log(`Available proofs: ${PROOFS.map((p) => p.id).join(', ') || '(none found)'}`);
    console.log(`Watching file: ${LEAN_FILE}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGTERM', () => { if (leanClient) leanClient.stop(); process.exit(0); });
process.on('SIGINT', () => { if (leanClient) leanClient.stop(); process.exit(0); });
