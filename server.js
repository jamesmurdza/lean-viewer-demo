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
const LEAN_FILE = process.env.LEAN_FILE
  ? path.resolve(process.env.LEAN_FILE)
  : path.join(__dirname, 'lean', 'Test.lean');

const THEME = 'github-dark-default';

let clients = [];
let highlighter = null;
let leanStatus = 'starting'; // starting | elaborating | ready | crashed
let diagnosticsCount = 0;
let currentHtml = '';

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

function renderHtml(content) {
  if (highlighter) {
    try {
      return highlighter.codeToHtml(content, { lang: 'lean', theme: THEME });
    } catch (err) {
      console.error(`Shiki highlight failed: ${err.message}`);
    }
  }
  // Fallback: plain escaped text if the highlighter isn't ready yet or errors.
  return `<pre class="shiki-fallback"><code>${escapeHtml(content)}</code></pre>`;
}

function sendToAll() {
  const payload = `data: ${JSON.stringify({
    html: currentHtml,
    file: LEAN_FILE,
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

function watchFile() {
  try {
    fs.watch(LEAN_FILE, { persistent: true }, () => scheduleRefresh());
  } catch (err) {
    console.error(`Could not watch ${LEAN_FILE}: ${err.message}`);
  }
  // Fallback poll in case fs.watch misses events (some filesystems/editors).
  let lastMtime = 0;
  setInterval(() => {
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

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Lean Live Viewer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0d1117;
    color: #e6edf3;
  }
  header {
    padding: 14px 22px;
    background: #010409;
    border-bottom: 1px solid #21262d;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    position: sticky;
    top: 0;
  }
  header .file {
    font-size: 13px;
    color: #e6edf3;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  main {
    padding: 0;
    margin: 0;
  }
  #codewrap pre {
    margin: 0;
    padding: 18px 20px;
    border-radius: 8px;
    border: 1px solid #21262d;
    font-size: 14px;
    line-height: 1.6;
    overflow-x: auto;
  }
  #codewrap code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    counter-reset: line;
  }
  #codewrap .line {
    display: inline-block;
    width: 100%;
    cursor: default;
  }
  #codewrap .line::before {
    counter-increment: line;
    content: counter(line);
    display: inline-block;
    width: 2.2em;
    margin-right: 1em;
    text-align: right;
    color: #484f58;
    user-select: none;
  }
  #tooltip {
    position: fixed;
    z-index: 1000;
    max-width: 520px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.5;
    box-shadow: 0 8px 24px rgba(1,4,9,0.6);
    pointer-events: none;
    display: none;
  }
  #tooltip p { margin: 0 0 6px 0; }
  #tooltip p:last-child { margin-bottom: 0; }
  #tooltip hr { border: none; border-top: 1px solid #30363d; margin: 8px 0; }
  #tooltip code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; padding: 1px 4px; border-radius: 3px; }
  #tooltip pre.tt-code {
    margin: 0 0 6px 0;
    padding: 8px 10px;
    background: #0d1117;
    border: 1px solid #21262d;
    border-radius: 4px;
    overflow-x: auto;
  }
  #tooltip pre.tt-code code { background: none; padding: 0; }
</style>
</head>
<body>
<header>
  <span class="file" id="filepath"></span>
</header>
<main>
  <div id="codewrap"><pre><code>loading&hellip;</code></pre></div>
</main>
<div id="tooltip"></div>

<script>
(function () {
  var codewrap = document.getElementById('codewrap');
  var fileEl = document.getElementById('filepath');
  var tooltip = document.getElementById('tooltip');

  var lineEls = [];
  var charWidthPx = null;

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

  function measureCharWidth() {
    var codeEl = codewrap.querySelector('code');
    if (!codeEl) return 8;
    var cs = getComputedStyle(codeEl);
    var probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.textContent = 'M'.repeat(40);
    document.body.appendChild(probe);
    var w = probe.getBoundingClientRect().width / 40;
    probe.remove();
    return w || 8;
  }

  function lineTextStartX(lineEl) {
    // A collapsed Range positioned before the line's real text nodes
    // (i.e. after any ::before pseudo-element content) gives the exact
    // caret x-position where the actual source text begins — this
    // works regardless of the line-number gutter's CSS width.
    try {
      var range = document.createRange();
      range.setStart(lineEl, 0);
      range.setEnd(lineEl, 0);
      var rects = range.getClientRects();
      if (rects.length) return rects[0].left;
    } catch (e) {}
    return lineEl.getBoundingClientRect().left;
  }

  function indexLines() {
    lineEls = Array.prototype.slice.call(codewrap.querySelectorAll('.line'));
    charWidthPx = measureCharWidth();
  }

  function render(html) {
    codewrap.innerHTML = html;
    indexLines();
  }

  // --- hover interaction ---
  var lastKey = null;
  var lastRange = null;
  var hoverDebounce = null;
  var currentAbort = null;
  var lastMouseX = 0, lastMouseY = 0;

  function withinRange(line, ch, range) {
    if (!range) return false;
    var s = range.start, e = range.end;
    if (line < s.line || line > e.line) return false;
    if (line === s.line && ch < s.character) return false;
    if (line === e.line && ch >= e.character) return false;
    return true;
  }

  function positionTooltip() {
    var pad = 14;
    var x = lastMouseX + 14;
    var y = lastMouseY + 18;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    // Clamp after layout so we know its size.
    requestAnimationFrame(function () {
      var rect = tooltip.getBoundingClientRect();
      var nx = x, ny = y;
      if (rect.right > window.innerWidth - pad) nx = Math.max(pad, window.innerWidth - pad - rect.width);
      if (rect.bottom > window.innerHeight - pad) ny = Math.max(pad, lastMouseY - rect.height - 10);
      tooltip.style.left = nx + 'px';
      tooltip.style.top = ny + 'px';
    });
  }

  function showTooltip(html) {
    if (!html) { hideTooltip(); return; }
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    positionTooltip();
  }

  function hideTooltip() {
    tooltip.style.display = 'none';
    lastRange = null;
    lastKey = null;
  }

  function fetchHover(line, character) {
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
          lastRange = data.range || {
            start: { line: line, character: character },
            end: { line: line, character: character + 1 },
          };
          showTooltip(renderMarkdownLite(data.contents.value));
        } else {
          lastRange = {
            start: { line: line, character: character },
            end: { line: line, character: character + 1 },
          };
          hideTooltip();
        }
      })
      .catch(function () { /* aborted or server hiccup — ignore */ });
  }

  function onMouseMove(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    var lineEl = e.target.closest ? e.target.closest('.line') : null;
    if (!lineEl) { hideTooltip(); return; }
    var line = lineEls.indexOf(lineEl);
    if (line === -1) { hideTooltip(); return; }

    if (charWidthPx == null) indexLines();
    var startX = lineTextStartX(lineEl);
    var rel = e.clientX - startX;
    if (rel < 0) { hideTooltip(); return; }
    var character = Math.floor(rel / charWidthPx);

    if (lastRange && withinRange(line, character, lastRange)) {
      if (tooltip.style.display === 'block') positionTooltip();
      return;
    }

    var key = line + ':' + character;
    if (key === lastKey) return;
    lastKey = key;

    clearTimeout(hoverDebounce);
    hoverDebounce = setTimeout(function () {
      fetchHover(line, character);
    }, 100);
  }

  codewrap.addEventListener('mousemove', onMouseMove);
  codewrap.addEventListener('mouseleave', function () {
    clearTimeout(hoverDebounce);
    hideTooltip();
  });

  // --- SSE live updates ---
  function connect() {
    var es = new EventSource('/events');
    es.onmessage = function (e) {
      var data = JSON.parse(e.data);
      fileEl.textContent = data.file;
      render(data.html);
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
      `data: ${JSON.stringify({ html: currentHtml, file: LEAN_FILE, leanStatus, diagnosticsCount })}\n\n`
    );
    req.on('close', () => {
      clients = clients.filter((c) => c !== res);
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
  highlighter = await createHighlighter({ themes: [THEME], langs: ['lean'] });

  const initialContent = readFileSafe();
  currentHtml = renderHtml(initialContent);

  leanClient = new LeanClient(LEAN_FILE, {
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
    console.log(`Watching file: ${LEAN_FILE}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGTERM', () => { if (leanClient) leanClient.stop(); process.exit(0); });
process.on('SIGINT', () => { if (leanClient) leanClient.stop(); process.exit(0); });
