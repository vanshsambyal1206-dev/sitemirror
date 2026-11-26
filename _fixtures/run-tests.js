'use strict';

/**
 * One-command test suite: boots the local fixture, runs the full pipeline into
 * a throwaway archive, shuts the origin down, then replays that archive and
 * asserts every offline invariant.
 *
 *   node _fixtures/run-tests.js
 *   npm test
 *
 * Exits non-zero on the first stage that fails. No network required.
 */

const { spawn } = require('child_process');
const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');

const { Manifest } = require('../core/manifest');
const { MirrorProxy } = require('../core/proxy');
const { readJson } = require('../core/util');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) return reject(new Error(`fixture did not listen on ${port}`));
        setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

function runNode(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${script} killed by ${signal}`));
      if (code !== 0) return reject(new Error(`${script} exited with code ${code}`));
      resolve();
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const done = () => resolve();
    child.once('exit', done);
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

async function main() {
  console.log('\n── stage 1/6 · static export rewriter unit tests\n');
  await runNode('_fixtures/unit-export.js', []);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const outDir = path.join(ROOT, '_test-archive');
  const archiveDir = path.join(outDir, `127.0.0.1_${port}`);

  if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });

  console.log(`\n── stage 2/6 · fixture origin on ${origin}\n`);
  const fixture = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.stdout.on('data', (d) => process.stdout.write(`    ${d}`));
  fixture.stderr.on('data', (d) => process.stderr.write(`    ${d}`));

  try {
    await waitForPort(port);

    console.log(`\n── stage 3/6 · capture pipeline → ${path.relative(ROOT, archiveDir)}\n`);
    await runNode('_fixtures/e2e.js', [origin, outDir]);

    console.log('\n── origin shut down · archive must stand alone\n');
    await stop(fixture);
    await new Promise((r) => setTimeout(r, 200));

    console.log('\n── stage 4/6 · offline replay invariants\n');
    await runNode('_fixtures/verify.js', [archiveDir, origin]);

    console.log('\n── stage 5/6 · static export invariants (plain static server, no proxy)\n');
    await runNode('_fixtures/verify-export.js', [archiveDir]);
  } finally {
    await stop(fixture);
  }

  await httpsStage();

  console.log('\nall stages passed\n');
}

/**
 * HTTPS regression stage.
 *
 * The archive proxy intercepts TLS with its own CA. Chromium validates proxied
 * certificates below the browser context, so a replay browser launched without
 * certificate-error tolerance silently fails every comparison — the visual score
 * comes back null while capture and assets still read 100%. That bug is invisible
 * to an HTTP-only fixture, so this stage owns it.
 */
async function httpsStage() {
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const outDir = path.join(ROOT, '_test-archive-https');
  const archiveDir = path.join(outDir, `127.0.0.1_${port}`);

  if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });

  console.log(`\n── stage 6/6 · HTTPS replay · ${origin}\n`);
  const fixture = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(port), '--tls'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixture.stdout.on('data', (d) => process.stdout.write(`    ${d}`));
  fixture.stderr.on('data', (d) => process.stderr.write(`    ${d}`));

  try {
    await waitForPort(port);
    await runNode('_fixtures/e2e.js', [origin, outDir], {
      INSECURE: '1',
      MAX_PAGES: '2',
      DIFF_PAGES: '1',
      DIFF_VIEWPORTS: 'desktop',
    });
  } finally {
    await stop(fixture);
  }

  const report = JSON.parse(fs.readFileSync(path.join(archiveDir, 'report', 'report.json'), 'utf8'));
  const visual = report.summary.visual;

  const problems = [];
  if (typeof visual.score !== 'number') problems.push(`visual score is ${visual.score} (expected a number)`);
  if (visual.failedViewports !== 0) problems.push(`${visual.failedViewports} viewport check(s) failed`);
  if (typeof report.summary.overall !== 'number') problems.push(`overall is ${report.summary.overall}`);
  if (!report.pages.some((p) => p.fidelity && Object.keys(p.fidelity).length)) {
    problems.push('no per-page fidelity breakdown was recorded');
  }

  // With the origin gone, replay the archive over a CONNECT tunnel. This is the
  // path a real browser takes for https, and it is the one the visual diff uses.
  const replayed = await httpsReplayCheck(archiveDir, `127.0.0.1:${port}`);
  if (!/^HTTP\/1\.1 200/.test(replayed)) problems.push(`CONNECT replay did not return 200: ${replayed.split('\r\n')[0]}`);
  else if (!/x-sitemirror-hit: captured/i.test(replayed)) problems.push('CONNECT replay was not served from the archive');

  if (problems.length) throw new Error(`HTTPS replay stage failed: ${problems.join('; ')}`);
  console.log(
    `\nPASS  HTTPS replay is scored — visual ${(visual.score * 100).toFixed(2)}% across ${visual.pagesCovered} page(s)`,
  );
  console.log('PASS  CONNECT + TLS replay serves the archived page with the origin down\n');
}

/**
 * Open a CONNECT tunnel to the archive proxy and speak TLS through it, exactly
 * as a browser would for https. Returns the raw HTTP response.
 */
async function httpsReplayCheck(archiveDir, target) {
  const json = await readJson(path.join(archiveDir, 'manifest.json'));
  if (!json) throw new Error(`no manifest.json in ${archiveDir}`);
  const manifest = Manifest.fromJSON(json, archiveDir);
  const proxy = new MirrorProxy({ manifest, options: { missPolicy: '404' } });
  await proxy.start();

  try {
    return await new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1');
      const timer = setTimeout(() => reject(new Error('CONNECT replay timed out')), 15000);
      const fail = (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };

      socket.on('error', fail);
      socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let buf = '';
      socket.on('data', function onData(chunk) {
        buf += chunk.toString('latin1');
        if (!buf.includes('\r\n\r\n')) return;
        socket.off('data', onData);
        const parts = buf.split('\r\n\r\n');
        const head = parts[0];
        if (!/^HTTP\/1\.1 200/.test(head)) return fail(new Error(`CONNECT refused: ${head.split('\r\n')[0]}`));

        const secure = tls.connect({ socket, rejectUnauthorized: false }, () => {
          secure.write(`GET / HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
        });
        let out = '';
        secure.on('data', (x) => (out += x.toString('utf8')));
        secure.on('end', () => {
          clearTimeout(timer);
          resolve(out);
        });
        secure.on('error', fail);
      });
    });
  } finally {
    await proxy.stop().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\ntest suite failed: ${err.message}\n`);
  process.exit(1);
});
