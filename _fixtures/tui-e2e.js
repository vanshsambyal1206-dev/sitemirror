'use strict';

/**
 * Headless end-to-end test for the interactive UI.
 *
 * Drives the real wizard → dashboard → results flow against the local fixture
 * site, using fake TTY streams so it can run unattended. It exercises the real
 * key parser, the real state machine and the real capture pipeline — only the
 * terminal device is simulated.
 *
 *   node _fixtures/tui-e2e.js [url] [--rows 30] [--cols 78] [--profile standard]
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const strip = (s) => String(s).replace(ANSI_RE, '');

/** Turn one captured frame back into readable lines for failure output. */
function screenText(buffer) {
  return String(buffer)
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    .replace(ANSI_RE, '')
    .replace(/\r/g, '');
}

const argv = process.argv.slice(2);
const flagValue = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const url = argv.find((a) => /^https?:\/\//.test(a)) || 'http://127.0.0.1:8741';
const cols = Number(flagValue('cols', 78));
const rows = Number(flagValue('rows', 30));
const profile = flagValue('profile', 'standard');
const outDir = path.resolve(flagValue('out', './_tui-test'));

class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = cols;
    this.rows = rows;
    this.buffer = '';
  }
  write(chunk) {
    this.buffer += String(chunk);
    if (this.buffer.length > 4_000_000) this.buffer = this.buffer.slice(-2_000_000);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.rawMode = false;
  }
  setRawMode(v) {
    this.rawMode = !!v;
  }
  setEncoding() {}
  resume() {}
  pause() {}
  send(text) {
    this.emit('data', text);
  }
  key(name) {
    const map = { enter: '\r', escape: '\x1b', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C' };
    this.emit('data', map[name] || name);
  }
}

const stdout = new FakeStdout();
const stdin = new FakeStdin();

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail && !ok ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeout = 60000, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    if (predicate(strip(stdout.buffer))) return true;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(60);
  }
}

// ----------------------------------------------------------- fixture server
// The harness owns its fixture site. Leaving it to an earlier tool call makes
// the run depend on state outside this process, and a dead server turns a
// capture test into a misleading partial failure.

let fixture = null;

function probe(target) {
  return new Promise((resolve) => {
    const client = target.protocol === 'https:' ? https : http;
    const req = client.get(
      target,
      { rejectUnauthorized: false, timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureFixtureServer(target) {
  if (argv.includes('--no-server')) return null;
  const u = new URL(target);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const health = new URL('/', u);

  // A server already answering on the port is fine — do not fight it.
  for (let i = 0; i < 20; i += 1) {
    if (await probe(health)) return null;
    await sleep(100);
  }

  const args = [path.join(__dirname, 'serve.js'), String(port)];
  if (u.protocol === 'https:') args.push('--tls');
  const child = spawn(process.execPath, args, {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));

  for (let i = 0; i < 100; i += 1) {
    if (await probe(health)) return child;
    if (child.exitCode !== null) {
      throw new Error(`fixture server exited (${child.exitCode}): ${output.trim()}`);
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`fixture server did not answer on ${u.host}: ${output.trim()}`);
}

function stopFixture() {
  if (!fixture || fixture.exitCode !== null) return;
  try {
    fixture.kill();
  } catch {
    /* already gone */
  }
}

process.on('exit', stopFixture);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopFixture();
    process.exit(130);
  });
}

async function main() {
  // The interactive flow must never pop a browser tab in a test run.
  const mirror = require('../core/mirror');
  mirror.openExternal = () => {};
  const tui = require('../core/tui');

  // Address validation is the first thing a user meets; assert the edges that
  // `new URL` gets wrong on its own (partial IPs, bare hosts, odd schemes).
  const validate = (input) => tui.normalizeTarget(input);
  check('rejects a half-typed IP', !validate('http://127').ok, JSON.stringify(validate('http://127')));
  check('accepts a loopback IP', validate('http://127.0.0.1').ok);
  check('rejects a host without a TLD', !validate('example').ok);
  check('accepts a normal domain', validate('example.com').ok);
  check('accepts bare http(s) schemes', validate('https://example.com').ok && validate('http://example.com').ok);
  check('rejects unknown schemes', !validate('ftp://example.com').ok);
  check('rejects an out-of-range octet', !validate('http://300.1.1.1').ok);
  check('keeps trailing dots pending', !validate('example.com.').ok);
  check('accepts bracketed IPv6', validate('http://[::1]:8741').ok);

  const watchdog = setTimeout(() => {
    console.error('\nTUI e2e exceeded 10 minutes — aborting.');
    stopFixture();
    process.exit(1);
  }, 10 * 60 * 1000);

  fixture = await ensureFixtureServer(url);
  if (fixture) console.log('  --   started fixture server');

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });

  const started = Date.now();
  const run = tui.runTui({
    target: null,
    outDir,
    version: '0.0.0-test',
    stdout,
    stdin,
    defaults: { out: outDir, profile, open: false },
  });

  await waitFor((s) => s.includes('TARGET URL'), { label: 'target step' });
  check('wizard opens on the target step', true);
  check('alternate screen entered', stdout.buffer.includes('\x1b[?1049h'));
  check('cursor is visible on the input', stdout.buffer.includes('\x1b[?25h'));

  stdin.send(url);
  await sleep(120);
  check('typed URL is echoed', strip(stdout.buffer).includes(url));
  stdin.key('enter');

  await waitFor((s) => s.includes('OUTPUT ROOT'), { label: 'destination step' });
  check('advances to the output step', true);
  stdin.key('enter');

  await waitFor((s) => s.includes('STEP 03'), { label: 'profile step' });
  check('advances to the profile step', true);
  stdin.key('enter');

  await waitFor((s) => s.includes('RUN CONFIGURATION'), { label: 'review step' });
  check('advances to the review step', true);
  check('review shows the archive preview', strip(stdout.buffer).includes('ARCHIVE'));

  stdin.key('enter');

  await waitFor((s) => s.includes('CAPTURE') && s.includes('SITEMIRROR'), { label: 'dashboard' });
  check('dashboard starts', true);

  await waitFor((s) => s.includes('MIRROR COMPLETE') || s.includes('CAPTURE FAILED'), {
    timeout: 240000,
    label: 'results screen',
  });
  const text = strip(stdout.buffer);
  const tail = screenText(stdout.buffer).split('\n').filter((line) => line.trim()).slice(-14).join('\n');
  check('capture completes', text.includes('MIRROR COMPLETE'), tail);
  check('results show a mirror URL', /http:\/\/127\.0\.0\.1:\d+/.test(text));
  check('results show the report URL', text.includes('/__report/'));
  check('results show the archive path', text.includes(path.basename(outDir)));

  stdin.key('q');
  const outcome = await run;
  await sleep(100);

  check('results key closes the UI', outcome && outcome.closed === true);
  check('alternate screen restored', stdout.buffer.includes('\x1b[?1049l'));
  check('raw mode released', stdin.rawMode === false);

  // runMirror names the archive after the host with filesystem-unsafe
  // characters replaced, so `127.0.0.1:8741` becomes `127.0.0.1_8741`.
  const domainDir = new URL(url).host.replace(/[<>:"/\\|?*\s]/g, '_');
  const reportFile = path.join(outDir, domainDir, 'report', 'report.html');
  check('report written to disk', fs.existsSync(reportFile), reportFile);

  clearTimeout(watchdog);
  stopFixture();

  const failures = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (failures.length) {
    console.log('\n--- last screen ---');
    console.log(screenText(stdout.buffer).split('\n').filter((line) => line.trim()).slice(-45).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  stopFixture();
  console.error(`\nTUI e2e failed: ${err.message}`);
  console.log('\n--- last screen ---');
  console.log(screenText(stdout.buffer).split('\n').filter((line) => line.trim()).slice(-45).join('\n'));
  process.exit(1);
});
