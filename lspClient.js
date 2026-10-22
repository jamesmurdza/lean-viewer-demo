// Minimal LSP client for talking to Lean's built-in language server
// (`lean --server`), the same server VS Code's Lean extension uses.
// We only implement the handful of messages needed to open a document,
// keep it in sync, and ask for hover info — everything else (parsing,
// elaboration, type info, docstrings, goal state) is Lean's own.

const { spawn } = require('child_process');
const path = require('path');

class LeanClient {
  constructor(filePath, { onProgress, onDiagnostics, onStatus } = {}) {
    this.filePath = path.resolve(filePath);
    this.uri = 'file://' + this.filePath;
    this.onProgress = onProgress || (() => {});
    this.onDiagnostics = onDiagnostics || (() => {});
    this.onStatus = onStatus || (() => {});
    this.nextId = 1;
    this.pending = new Map();
    this.version = 1;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.ready = null;
  }

  start(initialText) {
    const env = {
      ...process.env,
      PATH: `${process.env.HOME}/.elan/bin:${process.env.PATH}`,
    };
    this.proc = spawn('lean', ['--server'], {
      cwd: path.dirname(this.filePath),
      env,
    });

    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (d) => {
      console.error('[lean --server]', d.toString().trim());
    });
    this.proc.on('exit', (code, signal) => {
      console.error(`lean --server exited (code=${code}, signal=${signal})`);
      this.onStatus('crashed');
      for (const { reject } of this.pending.values()) {
        reject(new Error('lean --server exited'));
      }
      this.pending.clear();
    });

    this.ready = this._request('initialize', {
      processId: process.pid,
      rootUri: 'file://' + path.dirname(this.filePath),
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    }).then(() => {
      this._notify('initialized', {});
      this._notify('textDocument/didOpen', {
        textDocument: {
          uri: this.uri,
          languageId: 'lean4',
          version: this.version,
          text: initialText,
        },
      });
      this.onStatus('elaborating');
    });

    return this.ready;
  }

  async didChange(newText) {
    await this.ready;
    this.version += 1;
    this._notify('textDocument/didChange', {
      textDocument: { uri: this.uri, version: this.version },
      // Omitting range = whole-document replacement (valid per LSP spec
      // regardless of whether the server negotiated incremental sync).
      contentChanges: [{ text: newText }],
    });
    this.onStatus('elaborating');
  }

  async hover(line, character) {
    await this.ready;
    return this._request('textDocument/hover', {
      textDocument: { uri: this.uri },
      position: { line, character },
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
  }

  _send(obj) {
    const json = JSON.stringify(obj);
    const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
    this.proc.stdin.write(header + json);
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  _notify(method, params) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buf.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        this.buf = this.buf.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buf.length < bodyStart + len) break;
      const body = this.buf.slice(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.slice(bodyStart + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch (err) {
        console.error('Failed to parse LSP message:', err);
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(msg.error);
      else resolve(msg.result);
      return;
    }
    if (msg.method === '$/lean/fileProgress') {
      const processing = msg.params?.processing || [];
      this.onProgress(processing.length > 0);
      this.onStatus(processing.length > 0 ? 'elaborating' : 'ready');
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      this.onDiagnostics(msg.params?.diagnostics || []);
      return;
    }
    // Other notifications (registerCapability, etc.) are ignored — we
    // don't need them for hover-only usage.
  }
}

module.exports = { LeanClient };
