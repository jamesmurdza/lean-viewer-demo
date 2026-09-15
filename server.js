// Tiny live-reloading Lean file viewer.
// Watches a .lean file on disk, highlights it server-side with Shiki
// (using the real Lean 4 TextMate grammar), and streams the rendered
// HTML to the browser over Server-Sent Events — so the page updates
// automatically whenever the file changes, with no manual refresh.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const LEAN_FILE = process.env.LEAN_FILE
  ? path.resolve(process.env.LEAN_FILE)
  : path.join(__dirname, 'lean', 'Test.lean');

const THEME = 'github-dark-default';

let clients = [];
let highlighter = null;

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

function broadcast() {
  const content = readFileSafe();
  const html = renderHtml(content);
  const payload = `data: ${JSON.stringify({ html, file: LEAN_FILE })}\n\n`;
  for (const res of clients) res.write(payload);
}

// Debounce rapid successive fs events (editors often fire several per save).
let debounceTimer = null;
function scheduleBroadcast() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(broadcast, 100);
}

function watchFile() {
  try {
    fs.watch(LEAN_FILE, { persistent: true }, () => scheduleBroadcast());
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
        scheduleBroadcast();
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
  header h1 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    color: #79c0ff;
  }
  header .file {
    font-size: 12px;
    color: #8b949e;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  #status {
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 999px;
    background: #1a3f2e;
    color: #7ee2a8;
  }
  #status.disconnected {
    background: #3f1a1a;
    color: #e27e7e;
  }
  main {
    padding: 24px;
    max-width: 980px;
    margin: 0 auto;
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
</style>
</head>
<body>
<header>
  <h1>&#955; Lean Live Viewer</h1>
  <span class="file" id="filepath"></span>
  <span id="status">connecting&hellip;</span>
</header>
<main>
  <div id="codewrap"><pre><code>loading&hellip;</code></pre></div>
</main>

<script>
  const codewrap = document.getElementById('codewrap');
  const statusEl = document.getElementById('status');
  const fileEl = document.getElementById('filepath');

  function addLineNumbers() {
    // Shiki emits one <span class="line"> per source line inside <code>.
    // Nothing extra needed here; the CSS counter above numbers them.
  }

  function render(html) {
    codewrap.innerHTML = html;
    addLineNumbers();
  }

  function connect() {
    const es = new EventSource('/events');
    es.onopen = () => {
      statusEl.textContent = 'live';
      statusEl.classList.remove('disconnected');
    };
    es.onerror = () => {
      statusEl.textContent = 'reconnecting\\u2026';
      statusEl.classList.add('disconnected');
    };
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      fileEl.textContent = data.file;
      render(data.html);
    };
  }

  connect();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('\n');
    clients.push(res);
    // Send current content immediately on connect.
    res.write(`data: ${JSON.stringify({ html: renderHtml(readFileSafe()), file: LEAN_FILE })}\n\n`);
    req.on('close', () => {
      clients = clients.filter((c) => c !== res);
    });
    return;
  }

  if (req.url === '/' || req.url === '/index.html') {
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
