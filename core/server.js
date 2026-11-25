'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { mimeFromExt, normalizeUrl } = require('./util');

/**
 * Local archive server.
 *
 * Serves captured pages and assets by their original path so root-relative
 * references resolve without any rewriting. `/__report` is mounted alongside.
 */
class PreviewServer {
  constructor({ manifest, proxy = null, port = 0, log = () => {} }) {
    this.manifest = manifest;
    this.proxy = proxy;
    this.port = port;
    this.log = log;
    this.server = null;
    this.rootOrigin = new URL(manifest.rootUrl).origin;
    this.stats = { requests: 0, hits: 0, misses: 0, spaFallbacks: 0 };
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(() => {
        try {
          res.statusCode = 500;
          res.end('mirror error');
        } catch {
          /* ignore */
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
    return { port: this.port, url: `http://127.0.0.1:${this.port}` };
  }

  async stop() {
    if (!this.server) return;
    await new Promise((r) => this.server.close(() => r()));
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async handle(req, res) {
    this.stats.requests++;
    const url = new URL(req.url, this.url);
    const pathname = decodeURIComponentSafe(url.pathname);

    res.setHeader('cache-control', 'no-store');

    // --- control surface -----------------------------------------------------
    if (pathname === '/__report') {
      res.statusCode = 302;
      res.setHeader('location', '/__report/');
      return res.end();
    }
    if (pathname === '/__report/') {
      return this.sendFile(res, path.join(this.manifest.archiveRoot, 'report', 'report.html'), 'text/html; charset=utf-8');
    }
    if (pathname.startsWith('/__report/')) {
      const rel = pathname.slice('/__report/'.length);
      const abs = safeJoin(path.join(this.manifest.archiveRoot, 'report'), rel);
      if (!abs) return this.notFound(res);
      if (abs.endsWith(path.sep)) return this.sendFile(res, path.join(abs, 'index.html'), 'text/html; charset=utf-8');
      return this.sendFile(res, abs);
    }
    if (pathname === '/__report.json') {
      return this.sendFile(res, path.join(this.manifest.archiveRoot, 'report', 'report.json'), 'application/json');
    }
    if (pathname === '/__manifest.json') {
      return this.sendFile(res, path.join(this.manifest.archiveRoot, 'manifest.json'), 'application/json');
    }
    if (pathname === '/__proxy.pac' && this.proxy) {
      res.setHeader('content-type', 'application/x-ns-proxy-autoconfig');
      return res.end(this.proxy.pac());
    }
    if (pathname === '/__ca.crt' && this.proxy) {
      res.setHeader('content-type', 'application/x-x509-ca-cert');
      return res.end(await fsp.readFile(this.proxy.ca.caCertPath()));
    }
    if (pathname === '/__health') {
      res.setHeader('content-type', 'application/json');
      return res.end(
        JSON.stringify({
          ok: true,
          pages: this.manifest.pages.length,
          assets: this.manifest.assets.filter((a) => a.ok).length,
          proxy: this.proxy ? this.proxy.port : null,
          stats: this.stats,
        }),
      );
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      return res.end('This mirror is read-only.');
    }

    // --- archive files served directly (page slugs, report assets) -----------
    if (/\.(html?|png|jpe?g|gif|svg|webp|ico|css|js|json|woff2?|ttf|otf|mp4|webm|glb|gltf|wasm|txt)$/i.test(pathname)) {
      const abs = safeJoin(this.manifest.archiveRoot, pathname.replace(/^\/+/, ''));
      if (abs && !isPrivate(abs) && (await exists(abs))) {
        // Opening a snapshot file directly must be just as inert as opening its
        // pretty URL, or the page's own scripts would re-hydrate over the DOM.
        const rel = pathname.replace(/^\/+/, '').split('/').join(path.sep);
        const snapshot = this.manifest.pages.find((p) => p.file === rel && p.documentMode === 'snapshot');
        return this.sendFile(res, abs, null, { inert: !!snapshot });
      }
    }

    // --- manifest lookup on the original origin -----------------------------
    const target = normalizeUrl(`${this.rootOrigin}${pathname}${url.search}`);
    const found = target ? this.manifest.find(target) : null;
    if (found) {
      this.stats.hits++;
      const entry = found.entry;
      const replayRaw = found.type === 'page' && entry.documentMode !== 'snapshot' && entry.rawFile;
      const serve = replayRaw ? { file: entry.rawFile } : entry;
      return this.sendFile(
        res,
        this.manifest.absoluteFile(serve),
        replayRaw ? 'text/html; charset=utf-8' : entry.contentType,
        { inert: found.type === 'page' && !replayRaw },
      );
    }

    // --- direct archive path (e.g. /index.html, /about.html) ----------------
    const direct = safeJoin(this.manifest.archiveRoot, pathname.replace(/^\/+/, ''));
    if (direct && !isPrivate(direct) && (await exists(direct))) {
      return this.sendFile(res, direct);
    }

    // --- SPA catch-all: client-side routes have no server file --------------
    const ext = path.extname(pathname);
    if ((!ext || ext === '.html') && this.manifest.spaMode) {
      const index = this.manifest.pages.find((p) => p.file && p.status === 'captured');
      if (index) {
        this.stats.spaFallbacks++;
        return this.sendFile(res, this.manifest.absoluteFile(index), 'text/html; charset=utf-8');
      }
    }

    this.stats.misses++;
    if (!ext || ext === '.html') {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(notCapturedPage(pathname, this.proxy));
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`Not captured: ${pathname}\n`);
  }

  async sendFile(res, absPath, contentType, { inert = false } = {}) {
    if (!absPath) return this.notFound(res);
    try {
      const stat = await fsp.stat(absPath);
      if (stat.isDirectory()) return this.sendFile(res, path.join(absPath, 'index.html'), contentType);
      const ct = contentType || mimeFromExt(absPath);
      res.statusCode = 200;
      res.setHeader('content-type', ct || 'application/octet-stream');
      res.setHeader('content-length', stat.size);
      if (inert) res.setHeader('content-security-policy', "script-src 'none'");
      if (res.req && res.req.method === 'HEAD') return res.end();
      return fs.createReadStream(absPath).pipe(res);
    } catch {
      return this.notFound(res);
    }
  }

  notFound(res) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found in archive');
  }
}

function notCapturedPage(pathname, proxy) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Not captured</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7e9ee;
font:15px/1.6 ui-sans-serif,system-ui,"Segoe UI",sans-serif}.c{max-width:620px;padding:36px 40px;border:1px solid #262b33;
border-radius:14px;background:#12151a}h1{font-size:20px;margin:0 0 10px}p{color:#9aa4b2;margin:0 0 12px}
code{font:12px/1.5 ui-monospace,monospace;background:#0b0d10;border:1px solid #262b33;padding:2px 6px;border-radius:6px}</style>
</head><body><div class="c"><h1>Page not in archive</h1><p><code>${escapeHtml(pathname)}</code> was never captured.</p>
<p>For URLs that only exist client-side, open the mirror through the archive proxy — it replays the SPA's own routing.
${proxy ? `Proxy: <code>127.0.0.1:${proxy.port}</code> · PAC: <code>/__proxy.pac</code>` : ''}</p>
<p><a style="color:#8ab4ff" href="/__report">Open the capture report</a></p></div></body></html>`;
}

function safeJoin(root, rel) {
  const abs = path.resolve(root, rel);
  const normalRoot = path.resolve(root);
  if (abs !== normalRoot && !abs.startsWith(normalRoot + path.sep)) return null;
  return abs;
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Never serve the CA keys or cert cache from the web surface. */
function isPrivate(abs) {
  return abs.split(path.sep).includes('.sitemirror');
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { PreviewServer };
