'use strict';

/**
 * Offline integrity check for a finished archive.
 *
 *   node _fixtures/verify.js <archive-dir> [upstream-origin]
 *
 * Starts the archive proxy + preview server from `manifest.json` only, then
 * fetches through both — with the origin server down — to prove the mirror is
 * genuinely self-contained.
 */

const path = require('path');
const http = require('http');
const net = require('net');
const { Manifest } = require('../core/manifest');
const { MirrorProxy } = require('../core/proxy');
const { PreviewServer } = require('../core/server');
const { readJson } = require('../core/util');

/** Send a hand-written HTTP request and return everything the server said. */
function rawRequest({ port, payload }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
    });
    socket.on('close', () => resolve(buf));
    socket.on('end', () => resolve(buf));
    socket.on('error', reject);
    socket.setTimeout(15000, () => socket.destroy(new Error('timeout')));
  });
}

function httpGet({ port, path: p, hostHeader, accept = 'text/html,*/*', method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: p,
        method,
        headers: hostHeader ? { host: hostHeader, accept } : { accept },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function main() {
  const archiveDir = path.resolve(process.argv[2] || '_test-archive/127.0.0.1_8741');
  const origin = process.argv[3] || 'http://127.0.0.1:8741';
  const originHost = new URL(origin).host;

  const json = await readJson(path.join(archiveDir, 'manifest.json'));
  if (!json) throw new Error(`no manifest.json in ${archiveDir}`);
  const manifest = Manifest.fromJSON(json, archiveDir);

  const proxy = new MirrorProxy({ manifest, options: { missPolicy: '404', spaFallback: true } });
  await proxy.start();
  const server = new PreviewServer({ manifest, proxy });
  const info = await server.start();

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    // 1. Through the proxy, using the ORIGINAL hostname (origin server is down).
    const proxied = await httpGet({ port: proxy.port, path: origin + '/', hostHeader: originHost });
    check(
      'proxy replays page for original host',
      proxied.status === 200 && /Deterministic fixture/.test(proxied.body),
      `status ${proxied.status}, ${proxied.body.length}b`,
    );
    check('proxy tags hit', proxied.headers['x-sitemirror-hit'] === 'captured', proxied.headers['x-sitemirror-hit']);

    const css = await httpGet({ port: proxy.port, path: origin + '/styles.css', hostHeader: originHost });
    check(
      'proxy replays root-relative asset',
      css.status === 200 && css.headers['content-type'].includes('text/css') && css.body.includes('--accent'),
      `${css.status} ${css.headers['content-type']}`,
    );

    const missing = await httpGet({
      port: proxy.port,
      path: origin + '/never-captured.json',
      hostHeader: originHost,
      accept: 'application/json',
    });
    check('uncaptured URL is an honest 404', missing.status === 404, `status ${missing.status}`);

    const skipped = await httpGet({
      port: proxy.port,
      path: origin + '/login',
      hostHeader: originHost,
      accept: 'application/json',
    });
    check('auth-walled page is not replayed', skipped.status === 404, `status ${skipped.status}`);

    const spa = await httpGet({ port: proxy.port, path: origin + '/app/route-b', hostHeader: originHost });
    check('SPA catch-all serves the shell', spa.status === 200, `status ${spa.status}`);

    // 2. Preview server surface.
    const root = await httpGet({ port: server.port, path: '/' });
    check(
      'preview server serves archive root',
      root.status === 200 && /Deterministic fixture/.test(root.body),
      `status ${root.status}`,
    );

    const report = await httpGet({ port: server.port, path: '/__report/' });
    check(
      'report renders',
      report.status === 200 && /Mirror report/.test(report.body) && /auth/.test(report.body),
      `status ${report.status}, ${report.body.length}b`,
    );

    const localSpa = await httpGet({ port: server.port, path: '/spa' });
    check(
      'preview server replays snapshots inert',
      localSpa.status === 200 &&
        /Rendered on the client/.test(localSpa.body) &&
        String(localSpa.headers['content-security-policy'] || '').includes("script-src 'none'"),
      `status ${localSpa.status}, csp ${localSpa.headers['content-security-policy'] || 'none'}`,
    );

    const reportJson = await httpGet({ port: server.port, path: '/__report/report.json' });
    check('report.json served', reportJson.status === 200 && reportJson.body.includes('"summary"'));

    const diff = await httpGet({ port: server.port, path: '/__report/diffs/index-desktop-diff.png' });
    check('diff image served', diff.status === 200 && diff.body.length > 1000, `${diff.body.length}b`);

    const pac = await httpGet({ port: server.port, path: '/__proxy.pac' });
    check('PAC file served', pac.status === 200 && pac.body.includes('FindProxyForURL'));

    const traversal = await httpGet({ port: server.port, path: '/../../../../Windows/win.ini' });
    check('path traversal blocked', traversal.status === 404 || traversal.status === 400, `status ${traversal.status}`);

    const ca = await httpGet({ port: server.port, path: '/__ca.crt' });
    check('CA cert available for trust', ca.status === 200 && ca.body.includes('BEGIN CERTIFICATE'));

    const key = await httpGet({ port: server.port, path: '/.sitemirror/sitemirror-ca.key' });
    check('CA private key NOT served', key.status === 404, `status ${key.status}`);

    // 3. The client-rendered page must replay its DOM snapshot, because the raw
    //    HTML has no feed content and the POST that builds it cannot be replayed.
    const spaSnapshot = await httpGet({ port: proxy.port, path: origin + '/spa', hostHeader: originHost });
    check(
      'client-rendered page replays its rendered snapshot',
      spaSnapshot.status === 200 && /Rendered on the client/.test(spaSnapshot.body),
      `status ${spaSnapshot.status}, ${spaSnapshot.body.length}b`,
    );

    const write = await httpGet({ port: proxy.port, path: origin + '/api/feed', hostHeader: originHost, method: 'POST' });
    check('write request is refused (405), not faked', write.status === 405, `status ${write.status}`);

    const feedGet = await httpGet({
      port: proxy.port,
      path: origin + '/api/feed',
      hostHeader: originHost,
      accept: 'application/json',
    });
    check('POST response is not replayable as a GET asset', feedGet.status === 404, `status ${feedGet.status}`);

    const stats = manifest.stats();
    check('manifest stats coherent', stats.pagesCaptured === 5 && stats.pagesSkipped === 1, JSON.stringify(stats));

    const spaPage = manifest.pages.find((p) => /\/spa$/.test(p.url));
    check('snapshot strategy persisted to manifest', !!spaPage && spaPage.documentMode === 'snapshot', spaPage && spaPage.documentMode);
    check('write requests recorded as evidence, not assets', (json.writes || []).some((w) => /\/api\/feed$/.test(w.url)));

    // 4. Live-backend dependencies are detected, not silently swallowed.
    check('websocket dependency recorded', (json.websockets || []).some((w) => /\/ws$/.test(w.url)));
    check('wasm module recorded', (json.wasmModules || []).some((w) => /tiny\.wasm$/.test(w)));
    const livePage = manifest.pages.find((p) => /\/live$/.test(p.url));
    check(
      'live-backend page flagged yellow, not green',
      !!livePage && livePage.checks && livePage.checks.wasmSocket && livePage.checks.wasmSocket.status === 'yellow',
      livePage && livePage.checks && livePage.checks.wasmSocket && livePage.checks.wasmSocket.status,
    );

    // 5. Connection policy. CONNECT targets carry a port while manifest keys do
    //    not for default ports; a mismatch here once tunnelled replays straight
    //    to the live internet, so both directions are pinned.
    check(
      'CONNECT target with port matches the archive',
      proxy.shouldMitm(originHost) === true,
      `${originHost} -> ${proxy.shouldMitm(originHost)}`,
    );
    check(
      'unrelated host is not claimed as archived',
      proxy.shouldMitm('not-this-archive.example') === false,
      String(proxy.shouldMitm('not-this-archive.example')),
    );

    // A WebSocket must be refused with a defined status. If it were tunnelled
    // instead, the replay would reach the live backend and score as faithful.
    const upgrade = await rawRequest({
      port: proxy.port,
      payload:
        `GET ${origin}/ws HTTP/1.1\r\n` +
        `Host: ${originHost}\r\n` +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    });
    check(
      'WebSocket is refused (501), not tunnelled to the live backend',
      /^HTTP\/1\.1 501/.test(upgrade),
      upgrade.split('\r\n')[0] || 'no response',
    );
  } finally {
    await server.stop();
    await proxy.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
