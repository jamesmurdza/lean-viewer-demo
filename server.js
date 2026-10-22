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

let clients = [];
let highlighter = null;
let leanStatus = 'starting'; // starting | elaborating | ready | crashed
let diagnosticsCount = 0;
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
    let body = '';
    lines.forEach((lineTokens, lineIdx) => {
      let ch = 0;
      let lineHtml = '';
      for (const tok of lineTokens) {
        const color = tok.color || theme.fg;
        const pieces = tok.content.match(SUBTOKEN_RE) || [tok.content];
        for (const piece of pieces) {
          if (/^\s+$/.test(piece)) {
            lineHtml += escapeHtml(piece);
          } else {
            lineHtml += `<span class="tok" data-line="${lineIdx}" data-ch="${ch}" style="color:${color}">${escapeHtml(piece)}</span>`;
          }
          ch += piece.length;
        }
      }
      body += `<span class="line">${lineHtml}</span>\n`;
    });
    body = body.replace(/\n$/, '');
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

function sendToAll() {
  const payload = `data: ${JSON.stringify({
    htmlDark: currentHtml.dark,
    htmlLight: currentHtml.light,
    file: LEAN_FILE,
    files: PROOFS.map((p) => ({ id: p.id, label: p.label })),
    currentFile: currentFileId(),
    leanStatus,
    diagnosticsCount,
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

// Switch the file being watched/elaborated — stops the current Lean
// client and fs watcher, then starts fresh ones pointed at the new file.
async function selectFile(fileId) {
  const target = PROOFS.find((p) => p.id === fileId);
  if (!target || target.path === LEAN_FILE) return;

  LEAN_FILE = target.path;
  leanStatus = 'starting';
  diagnosticsCount = 0;

  const content = readFileSafe();
  currentHtml = renderHtml(content);
  sendToAll();

  if (leanClient) {
    leanClient.stop();
    leanClient = null;
  }

  leanClient = new LeanClient(LEAN_FILE, {
    projectRoot: LEAN_PROJECT_ROOT,
    onStatus: (status) => {
      leanStatus = status;
      sendToAll();
    },
    onDiagnostics: (diags) => {
      diagnosticsCount = diags.filter((d) => d.severity === 1 || d.severity === 2).length;
      sendToAll();
    },
  });
  leanClient.start(content).catch((err) => {
    console.error('Failed to start Lean language server:', err);
    leanStatus = 'crashed';
    sendToAll();
  });

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
  }
  main {
    padding: 0;
    margin: 0 0 34px 0;
    width: 100%;
    max-width: 100%;
  }
  #menubar {
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    height: 40px;
    padding: 0 16px;
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--statusbar-bg);
    border-bottom: 1px solid var(--border);
    z-index: 400;
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
  #codewrap {
    width: 100%;
    max-width: 100%;
  }
  #codewrap pre {
    margin: 0;
    width: 100%;
    max-width: 100%;
    padding: 18px 20px;
    font-size: 14px;
    line-height: 1.6;
    overflow-x: auto;
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
  #codewrap .tok.tok-hover {
    background: rgba(88, 166, 255, 0.18);
    border-radius: 3px;
    box-shadow: 0 0 0 1px rgba(88, 166, 255, 0.4);
    filter: brightness(1.2);
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
    pointer-events: none;
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
  <label for="proofSelect">Proof</label>
  <select id="proofSelect"></select>
</div>
<main>
  <div id="codewrap"><pre><code>loading&hellip;</code></pre></div>
</main>
<div id="statusbar">
  <span class="file" id="filepath"></span>
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

  // --- hover interaction ---
  // Driven entirely by real mouseover events on real .tok spans (each
  // carrying its own data-line/data-ch), not mouse-coordinate math. This
  // is cheaper (the browser only fires on element-enter, not every
  // mousemove) and lets us highlight the exact hovered token(s) by
  // toggling a class, using the range Lean's language server reports.
  var lastKey = null;
  var lastRange = null;
  var hoveredEls = [];
  var hoverDebounce = null;
  var currentAbort = null;

  function withinRange(line, ch, range) {
    if (!range) return false;
    var s = range.start, e = range.end;
    if (line < s.line || line > e.line) return false;
    if (line === s.line && ch < s.character) return false;
    if (line === e.line && ch >= e.character) return false;
    return true;
  }

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
          lastRange = {
            start: { line: line, character: character },
            end: { line: line, character: character + 1 },
          };
          clearHighlight();
          tooltip.style.display = 'none';
        }
      })
      .catch(function () { /* aborted or server hiccup — ignore */ });
  }

  function onMouseOver(e) {
    var el = e.target.closest ? e.target.closest('.tok') : null;
    if (!el) return;

    var line = parseInt(el.getAttribute('data-line'), 10);
    var ch = parseInt(el.getAttribute('data-ch'), 10);

    // Moving within the same already-resolved token (e.g. between two
    // adjacent sub-spans Lean treats as one syntax node) — keep showing
    // what's already there, no new request.
    if (lastRange && withinRange(line, ch, lastRange)) return;

    var key = line + ':' + ch;
    if (key === lastKey) return;
    lastKey = key;

    clearTimeout(hoverDebounce);
    hoverDebounce = setTimeout(function () {
      fetchHover(line, ch, el);
    }, 80);
  }

  codewrap.addEventListener('mouseover', onMouseOver);
  codewrap.addEventListener('mouseleave', function () {
    clearTimeout(hoverDebounce);
    if (currentAbort) currentAbort.abort();
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

  proofSelect.addEventListener('change', function () {
    fetch('/api/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: proofSelect.value }),
    }).catch(function () { /* SSE will reflect whatever the server ends up at */ });
  });

  // --- SSE live updates ---
  function connect() {
    var es = new EventSource('/events');
    es.onmessage = function (e) {
      var data = JSON.parse(e.data);
      lastData = data;
      fileEl.textContent = data.file;
      if (data.files) renderMenu(data.files, data.currentFile);
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

  const initialContent = readFileSafe();
  currentHtml = renderHtml(initialContent);

  leanClient = new LeanClient(LEAN_FILE, {
    projectRoot: LEAN_PROJECT_ROOT,
    onStatus: (status) => {
      leanStatus = status;
      sendToAll();
    },
    onDiagnostics: (diags) => {
      diagnosticsCount = diags.filter((d) => d.severity === 1 || d.severity === 2).length;
      sendToAll();
    },
  });
  leanClient.start(initialContent).catch((err) => {
    console.error('Failed to start Lean language server:', err);
    leanStatus = 'crashed';
  });

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
