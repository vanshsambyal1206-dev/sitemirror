'use strict';

/**
 * Tiny fixture server used by `npm test`.
 * Serves a mini site with a CSS/JS/image asset graph, an API endpoint that
 * returns session-flavoured JSON, and an auth-walled login page.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'site');
const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) || 8741);
const useTls = args.includes('--tls') || process.env.FIXTURE_TLS === '1';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const requestHandler = (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('User-agent: *\nDisallow: /private/\nCrawl-delay: 1\n');
  }

  if (pathname === '/tiny.wasm') {
    // Smallest valid WebAssembly module header (8 bytes) — enough for the
    // wasm-socket check to classify the load as a live-backend dependency.
    res.writeHead(200, { 'content-type': 'application/wasm', 'content-length': 8 });
    return res.end(Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  }

  if (pathname === '/api/feed') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      return res.end('POST only');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        items: [
          { title: 'Rendered on the client', body: 'Inserted after a POST resolved, so it only exists in the DOM snapshot.' },
          { title: 'Not in the HTML', body: 'The raw server response for this page is an empty container.' },
          { title: 'Replay cannot rebuild it', body: 'A static archive answers the POST with 405, which is the honest result.' },
        ],
      }),
    );
  }

  if (pathname === '/api/data.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        session: 'sess_8f21',
        expires_at: '2026-11-25T12:00:00Z',
        user: { id: 42, email: 'demo@example.test' },
        items: [{ sku: 'A-1', price: 19 }, { sku: 'A-2', price: 24 }],
      }),
    );
  }

  if (pathname === '/private/secret') {
    res.writeHead(401, { 'content-type': 'text/plain' });
    return res.end('auth required');
  }

  if (pathname === '/missing.png') {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  if (!path.extname(pathname)) pathname += '.html';

  const abs = path.join(root, pathname);
  if (!abs.startsWith(root)) {
    res.writeHead(403);
    return res.end('nope');
  }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<h1>404</h1>');
    }
    res.writeHead(200, { 'content-type': mime[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
};

const server = useTls ? https.createServer(tlsOptions(), requestHandler) : http.createServer(requestHandler);

server.on('upgrade', (req, socket) => {
  if (!String(req.url).startsWith('/ws')) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const payload = Buffer.from('tick 1');
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  socket.on('data', (buf) => {
    if (buf.length && (buf[0] & 0x0f) === 0x8) {
      socket.write(Buffer.from([0x88, 0x00]));
      socket.end();
    }
  });
  socket.on('error', () => {});
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixture site on ${useTls ? 'https' : 'http'}://127.0.0.1:${port}`);
});

/**
 * Throwaway self-signed cert for the HTTPS fixture (127.0.0.1 SAN). Only used by
 * the test suite to prove the archive proxy's MITM replay path works over TLS.
 */
function tlsOptions() {
  const forge = require('node-forge');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: '127.0.0.1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}
