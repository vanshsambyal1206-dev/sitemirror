'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { generateKeyPairSync } = require('crypto');
const forge = require('node-forge');
const { ensureDir, mimeFromExt, normalizeUrl, hostOf } = require('./util');

const CA_CERT = 'sitemirror-ca.crt';
const CA_KEY = 'sitemirror-ca.key';
const CA_COMMON_NAME = 'SiteMirror Local Archive CA';

/**
 * Local certificate authority. Generates a throwaway CA on first run and signs
 * per-host certificates so the mirror proxy can answer TLS for the original
 * hostnames. Nothing leaves the machine.
 */
class CertAuthority {
  constructor({ dir }) {
    this.dir = dir;
    this.certDir = path.join(dir, 'certs');
    this.caCertPem = null;
    this.caKeyPem = null;
    this.caForgeKey = null;
    this.caForgeCert = null;
    this.contexts = new Map();
    this.defaultContext = null;
  }

  async init() {
    await ensureDir(this.certDir);
    const certPath = path.join(this.dir, CA_CERT);
    const keyPath = path.join(this.dir, CA_KEY);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      this.caCertPem = await fsp.readFile(certPath, 'utf8');
      this.caKeyPem = await fsp.readFile(keyPath, 'utf8');
    } else {
      const made = createCa();
      this.caCertPem = made.certPem;
      this.caKeyPem = made.keyPem;
      await fsp.writeFile(certPath, this.caCertPem, 'utf8');
      await fsp.writeFile(keyPath, this.caKeyPem, 'utf8');
    }
    this.caForgeCert = forge.pki.certificateFromPem(this.caCertPem);
    this.caForgeKey = forge.pki.privateKeyFromPem(this.caKeyPem);

    // A default cert is required for clients that omit SNI.
    const def = signHostCert(this.caForgeCert, this.caForgeKey, 'localhost');
    this.defaultCertPem = def.certPem;
    this.defaultKeyPem = def.keyPem;
    this.defaultContext = tls.createSecureContext({ key: def.keyPem, cert: def.certPem });
    this.contexts.set('localhost', this.defaultContext);
    return this;
  }

  caCertPath() {
    return path.join(this.dir, CA_CERT);
  }

  cacheFile(host) {
    return path.join(this.certDir, `${host.replace(/[^a-z0-9._-]/gi, '_')}.json`);
  }

  issueContext(host, { persist = true } = {}) {
    const cached = this.contexts.get(host);
    if (cached) return cached;

    if (persist) {
      try {
        const raw = fs.readFileSync(this.cacheFile(host), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.cert && parsed.key && new Date(parsed.expiresAt) > new Date(Date.now() + 86400000)) {
          const ctx = tls.createSecureContext({ key: parsed.key, cert: parsed.cert });
          this.contexts.set(host, ctx);
          return ctx;
        }
      } catch {
        /* regenerate below */
      }
    }

    const { certPem, keyPem, expiresAt } = signHostCert(this.caForgeCert, this.caForgeKey, host);
    const ctx = tls.createSecureContext({ key: keyPem, cert: certPem });
    this.contexts.set(host, ctx);
    if (persist) {
      try {
        fs.writeFileSync(this.cacheFile(host), JSON.stringify({ host, cert: certPem, key: keyPem, expiresAt }));
      } catch {
        /* cache is best-effort */
      }
    }
    return ctx;
  }

  async warm(hosts = []) {
    const unique = [...new Set(hosts.filter(Boolean))];
    for (const host of unique) {
      try {
        this.issueContext(host);
      } catch {
        /* an un-signable host simply will not be MITM'd */
      }
      await new Promise((r) => setImmediate(r));
    }
    return unique.length;
  }

  getSecureContext(host) {
    try {
      return this.issueContext(host);
    } catch {
      return this.defaultContext;
    }
  }
}

function createCa() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^0+/, '') || '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 86400000);
  const attrs = [
    { name: 'commonName', value: CA_COMMON_NAME },
    { name: 'organizationName', value: 'SiteMirror (local, throwaway)' },
    { shortName: 'OU', value: 'Local Archive' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: privateKey };
}

function signHostCert(caCert, caKey, host) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16)).replace(/^0+/, '') || '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 825 * 86400000);
  cert.setSubject([
    { name: 'commonName', value: host },
    { name: 'organizationName', value: 'SiteMirror (local, throwaway)' },
  ]);
  cert.setIssuer(caCert.subject.attributes);

  const altNames = [];
  if (net.isIP(host)) altNames.push({ type: 7, ip: host });
  else {
    altNames.push({ type: 2, value: host });
    altNames.push({ type: 2, value: `*.${host.replace(/^\*\./, '')}` });
  }
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: privateKey,
    expiresAt: cert.validity.notAfter.toISOString(),
  };
}

/**
 * Hostname-preserving mirror proxy.
 *
 * The browser keeps requesting the original absolute URLs (https://cdn.site/x.js).
 * The proxy terminates TLS for those names and answers from the manifest, so no
 * HTML/JS source rewriting is needed and dynamically constructed URLs work.
 */
class MirrorProxy {
  constructor({ manifest, options = {}, log = () => {} }) {
    this.manifest = manifest;
    this.log = log;
    this.missPolicy = options.missPolicy || '404'; // '404' | 'passthrough'
    this.spaFallback = options.spaFallback !== false;
    this.mitmAll = !!options.mitmAll;
    this.port = options.port || 0;
    this.stats = {
      hits: 0,
      misses: 0,
      spaFallbacks: 0,
      passthrough: 0,
      wsRefused: 0,
      errors: 0,
      bytes: 0,
      requests: 0,
      byHost: {},
    };
    this.log_ = [];
    this.server = null;
    this.mitmServer = null;
    this.ca = null;
    this.hosts = new Set(manifest.hosts());
    // Bare hostnames (no port) for CONNECT-time matching, where the target is
    // always "host:port" and the manifest key may or may not carry a port.
    this.hostNames = new Set([...this.hosts].map(bareHost).filter(Boolean));
    const rootHost = bareHost(hostOf(manifest.rootUrl) || '');
    this.apex = String(rootHost || '').replace(/^www\./i, '').toLowerCase();
  }

  async start() {
    const cacheDir = path.join(this.manifest.archiveRoot, '.sitemirror');
    this.ca = await new CertAuthority({ dir: cacheDir }).init();
    await this.ca.warm([...this.hosts]);

    this.mitmServer = https.createServer(
      {
        key: this.ca.defaultKeyPem,
        cert: this.ca.defaultCertPem,
        SNICallback: (servername, cb) => {
          try {
            cb(null, this.ca.getSecureContext(servername));
          } catch (err) {
            cb(err);
          }
        },
      },
      (req, res) => this.handle(req, res, 'https'),
    );
    this.mitmServer.on('clientError', (err, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });

    this.server = http.createServer((req, res) => {
      const isAbsolute = /^https?:\/\//i.test(req.url || '');
      this.handle(req, res, isAbsolute ? new URL(req.url).protocol.replace(':', '') : 'http');
    });

    this.server.on('connect', (req, clientSocket, head) => this.handleConnect(req, clientSocket, head));
    this.server.on('clientError', (err, socket) => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });

    // WebSockets cannot be replayed from a static archive. Refuse them with a
    // defined status instead of leaving the browser to hang or, worse, letting
    // the socket reach the live backend.
    const refuseUpgrade = (proto) => (req, socket) => {
      const raw = String(req.url || '');
      const fullUrl = /^https?:\/\//i.test(raw)
        ? raw
        : `${proto}://${req.headers.host || 'unknown'}${raw}`;
      this.stats.wsRefused++;
      this.pushLog(fullUrl, 'websocket', 501, 'live socket refused');
      const body =
        'This mirror is static: it cannot carry a live WebSocket.\n' +
        'The connection is refused rather than faked.\n';
      try {
        socket.write(
          'HTTP/1.1 501 Not Implemented\r\n' +
            'Connection: close\r\n' +
            'Content-Type: text/plain; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body,
        );
        socket.end();
      } catch {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    };
    this.server.on('upgrade', refuseUpgrade('ws'));
    this.mitmServer.on('upgrade', refuseUpgrade('wss'));

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
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (this.mitmServer) await new Promise((resolve) => this.mitmServer.close(() => resolve()));
  }

  /**
   * Is this host part of the archive? Accepts "host" or "host:port" — CONNECT
   * targets always carry a port while manifest keys only do for non-default
   * ports, so both sides are normalised before comparing.
   */
  shouldMitm(host) {
    if (this.mitmAll) return true;
    const raw = String(host || '').toLowerCase();
    if (!raw) return false;
    if (this.hosts.has(raw)) return true;
    const bare = bareHost(raw);
    if (!bare) return false;
    if (this.hostNames.has(bare)) return true;
    for (const name of this.hostNames) {
      if (bare.endsWith(`.${name}`)) return true;
    }
    if (this.apex && (bare === this.apex || bare.endsWith(`.${this.apex}`))) return true;
    return false;
  }

  handleConnect(req, clientSocket, head) {
    const target = String(req.url || '');
    const [rawHost, rawPort] = target.split(':');
    const host = (rawHost || '').toLowerCase();
    const port = Number(rawPort || 443);

    clientSocket.on('error', () => {
      /* client went away */
    });

    // A CONNECT tunnel must not silently reach the live network while the
    // archive presents itself as offline: that lets a replay load live assets
    // and look faithful when nothing was archived. Only --allow-live-fallback
    // may forward an unknown host; everything else is intercepted so misses
    // become honest 404s.
    const replay = this.shouldMitm(target) || this.missPolicy !== 'passthrough';

    if (!replay) {
      const upstream = net.connect(port, host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => {
        try {
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        } catch {
          /* ignore */
        }
      });
      upstream.setTimeout(30000, () => upstream.destroy());
      return;
    }

    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) clientSocket.unshift(head);
    } catch {
      try {
        clientSocket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }

    // A tunnel can carry TLS (https, wss) or plaintext (http, ws). Peek at the
    // first byte: 0x16 opens a TLS handshake record, anything else is a plain
    // HTTP request line. Both paths stay inside the archive.
    clientSocket.setTimeout(30000, () => clientSocket.destroy());
    clientSocket.once('data', (buf) => {
      clientSocket.setTimeout(0);
      clientSocket.pause();
      clientSocket.unshift(buf);
      const isTls = buf.length > 0 && buf[0] === 0x16;
      const server = isTls ? this.mitmServer : this.server;
      try {
        server.emit('connection', clientSocket);
      } catch {
        clientSocket.destroy();
        return;
      }
      // A TLS server takes ownership of the raw socket and drives its own flow.
      // Resuming it here would let ciphertext bypass the TLSSocket and stall the
      // handshake, which is exactly how an HTTPS replay used to time out.
      if (!isTls) clientSocket.resume();
    });
  }

  async handle(req, res, schemeHint = 'http') {
    this.stats.requests++;
    const started = Date.now();
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const encrypted = !!(req.socket && req.socket.encrypted);
    const scheme = encrypted ? 'https' : schemeHint || 'http';
    const fullUrl = normalizeUrl(req.url.startsWith('http') ? req.url : `${scheme}://${hostHeader}${req.url}`);

    if (!fullUrl) {
      return sendText(res, 400, 'Bad request');
    }

    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-sitemirror', 'proxy');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const host = new URL(fullUrl).host;
    const hostStats = (this.stats.byHost[host] = this.stats.byHost[host] || { hits: 0, misses: 0 });

    // A static archive cannot replay writes. Say so instead of pretending.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      this.stats.misses++;
      hostStats.misses++;
      this.pushLog(fullUrl, 'non-GET', 405);
      return sendHtmlMiss(res, 405, fullUrl, 'This mirror is read-only — captured archives cannot replay form submissions or API writes.');
    }

    const found = this.manifest.find(fullUrl);
    if (found) {
      try {
        const requestedMode = String(req.headers['x-sitemirror-doc-mode'] || '').toLowerCase();
        const mode =
          requestedMode === 'snapshot' || requestedMode === 'raw'
            ? requestedMode
            : found.entry.documentMode || 'raw';
        const useRaw = found.type === 'page' && mode === 'raw' && found.entry.rawFile;
        const relFile = useRaw ? found.entry.rawFile : found.entry.file;
        const file = path.join(this.manifest.archiveRoot, relFile);
        const body = await fsp.readFile(file);
        this.stats.hits++;
        this.stats.bytes += body.length;
        hostStats.hits++;
        this.pushLog(fullUrl, useRaw ? 'hit-raw' : 'hit', 200, found.matched);
        return sendFile(req, res, body, useRaw ? { contentType: 'text/html; charset=utf-8' } : found.entry, file, {
          // A DOM snapshot is the page as it rendered. Its own scripts would
          // re-run on load and overwrite that DOM with a fresh (often failing)
          // hydration pass, so snapshot replay is delivered inert.
          inert: found.type === 'page' && !useRaw,
        });
      } catch (err) {
        this.stats.errors++;
        this.pushLog(fullUrl, 'error', 500, err.message);
        return sendHtmlMiss(res, 500, fullUrl, `Captured file missing on disk: ${path.basename(String(err.path || ''))}`);
      }
    }

    const accepts = String(req.headers.accept || '');
    const isNavigation = accepts.includes('text/html');
    if (this.spaFallback && isNavigation && this.manifest.spaMode) {
      const fallback = this.manifest.pages.find((p) => p.file && p.status === 'captured');
      if (fallback) {
        try {
          const body = await fsp.readFile(this.manifest.absoluteFile(fallback));
          this.stats.spaFallbacks++;
          this.pushLog(fullUrl, 'spa-fallback', 200);
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.setHeader('x-sitemirror-hit', 'spa-fallback');
          if (fallback.documentMode === 'snapshot') res.setHeader('content-security-policy', "script-src 'none'");
          res.statusCode = 200;
          if (req.method === 'HEAD') return res.end();
          return res.end(body);
        } catch {
          /* fall through to miss */
        }
      }
    }

    this.stats.misses++;
    hostStats.misses++;

    if (this.missPolicy === 'passthrough') {
      try {
        const upstream = await fetch(fullUrl, {
          headers: sanitizeRequestHeaders(req.headers),
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const buf = Buffer.from(await upstream.arrayBuffer());
        this.stats.passthrough++;
        this.stats.bytes += buf.length;
        this.pushLog(fullUrl, 'passthrough', upstream.status);
        res.statusCode = upstream.status;
        const ct = upstream.headers.get('content-type');
        if (ct) res.setHeader('content-type', ct);
        res.setHeader('x-sitemirror-hit', 'passthrough');
        if (req.method === 'HEAD') return res.end();
        return res.end(buf);
      } catch (err) {
        this.pushLog(fullUrl, 'passthrough-failed', 502);
        return sendHtmlMiss(res, 502, fullUrl, `Passthrough failed: ${err.message}`);
      }
    }

    this.pushLog(fullUrl, 'miss', 404);
    if (isNavigation) {
      return sendHtmlMiss(
        res,
        404,
        fullUrl,
        'This URL was never captured. It may be session-gated, generated by a live API, or simply unreachable during the crawl.',
      );
    }
    res.statusCode = 404;
    res.setHeader('x-sitemirror-hit', 'miss');
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'not captured', url: fullUrl }));
  }

  pushLog(url, kind, status, extra) {
    this.log_.push({ url, kind, status, extra, at: Date.now() });
    if (this.log_.length > 500) this.log_.shift();
  }

  pacUrl() {
    return `http://127.0.0.1:${this.port}/__proxy.pac`;
  }

  /**
   * PAC file so a normal browser can be pointed at the proxy with one setting
   * and only the mirrored hostnames are routed through it.
   */
  pac() {
    // PAC's `host` argument never carries a port, so compare bare names.
    const hosts = [...this.hostNames];
    const apex = this.apex;
    return `// Generated by sitemirror — mirrored hosts always use the local archive.
// No DIRECT fallback: if the proxy is down the browser must say so, not slip
// back onto the live site and look like a faithful replay.
// Hosts outside this mirror are not archived, so they stay DIRECT.
function FindProxyForURL(url, host) {
  var hosts = ${JSON.stringify(hosts)};
  var apex = ${JSON.stringify(apex)};
  for (var i = 0; i < hosts.length; i++) {
    if (host === hosts[i] || dnsDomainIs(host, "." + hosts[i])) return "PROXY 127.0.0.1:${this.port}";
  }
  if (host === apex || dnsDomainIs(host, "." + apex)) return "PROXY 127.0.0.1:${this.port}";
  return "DIRECT";
}`;
  }
}

/** Strip a port from "host:port"; leaves IPv6 brackets intact. */
function bareHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/:[0-9]+$/, '');
}

function sanitizeRequestHeaders(headers) {
  const out = {};
  const drop = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'proxy-connection', 'keep-alive', 'upgrade']);
  for (const [k, v] of Object.entries(headers)) {
    if (drop.has(k.toLowerCase())) continue;
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function sendFile(req, res, body, entry, absPath, { inert = false } = {}) {
  const contentType = entry.contentType || mimeFromExt(absPath);
  res.setHeader('content-type', contentType || 'application/octet-stream');
  res.setHeader('x-sitemirror-hit', 'captured');
  if (inert) res.setHeader('content-security-policy', "script-src 'none'");

  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [startRaw, endRaw] = range.replace('bytes=', '').split('-');
    let start = startRaw === '' ? undefined : Number(startRaw);
    let end = endRaw === '' ? undefined : Number(endRaw);
    if (start === undefined && end !== undefined) {
      start = Math.max(0, body.length - end);
      end = body.length - 1;
    }
    start = start ?? 0;
    end = end === undefined ? body.length - 1 : Math.min(end, body.length - 1);
    if (start <= end) {
      const slice = body.subarray(start, end + 1);
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${body.length}`);
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-length', slice.length);
      if (req.method === 'HEAD') return res.end();
      return res.end(slice);
    }
  }

  res.setHeader('accept-ranges', 'bytes');
  res.statusCode = 200;
  res.setHeader('content-length', body.length);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function sendHtmlMiss(res, code, url, reason) {
  res.statusCode = code;
  res.setHeader('x-sitemirror-hit', 'miss');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Not captured — sitemirror</title>
<style>
  :root{color-scheme:light}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7e9ee;
       font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .card{max-width:640px;padding:40px 44px;border:1px solid #262b33;border-radius:14px;background:#12151a}
  .tag{display:inline-block;font:600 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;
       color:#ffb4a1;background:rgba(255,120,90,.1);border:1px solid rgba(255,120,90,.35);padding:6px 9px;border-radius:999px}
  h1{font-size:22px;margin:18px 0 8px;letter-spacing:-.01em}
  p{color:#9aa4b2;margin:0 0 14px}
  code{font:12px/1.5 ui-monospace,monospace;color:#cfd6e4;background:#0b0d10;border:1px solid #262b33;
       padding:2px 6px;border-radius:6px;word-break:break-all}
  .hint{margin-top:20px;padding-top:16px;border-top:1px solid #1e232b;font-size:13px;color:#7d8794}
</style></head>
<body><div class="card">
  <span class="tag">HTTP ${code} · not in archive</span>
  <h1>This resource was not captured</h1>
  <p><code>${escapeHtml(url)}</code></p>
  <p>${escapeHtml(reason)}</p>
  <div class="hint">sitemirror is designed to say "no" rather than fake a resource. See the capture report for the full list of misses and why they happened.</div>
</div></body></html>`);
}

function sendText(res, code, text) {
  res.statusCode = code;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { MirrorProxy, CertAuthority };
