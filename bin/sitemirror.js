#!/usr/bin/env node
'use strict';

// Must run before the theme module is loaded — glyph support is decided at require time.
if (process.argv.includes('--ascii')) process.env.SITEMIRROR_ASCII = '1';

const path = require('path');
const fs = require('fs');

const { runMirror } = require('../core/mirror');
const { resolveViewports } = require('../core/launcher');
const { humanBytes } = require('../core/util');
const T = require('../core/tui/theme');
const { runTui } = require('../core/tui');
const pkg = require('../package.json');

const PROFILES = {
  recon: { maxPages: 12, delay: 500, viewport: 'desktop', diff: false, diffMaxPages: 0 },
  standard: { maxPages: 40, delay: 700, viewport: 'default', diff: true, diffMaxPages: 10 },
  deep: { maxPages: 120, delay: 500, viewport: 'default', diff: true, diffMaxPages: 30 },
};

const RAW_HELP = `
sitemirror — public frontend mirror & archivability report

Usage
  sitemirror                       interactive terminal wizard
  sitemirror <url>                 capture with the live dashboard
  sitemirror <url> --plain         line-by-line output (CI, logs, pipes)

Interactive keys
  ↑ ↓        move between options
  ← →        change a value
  ⏎          confirm / launch
  esc        back
  ctrl+c     abort

Options
  --out <dir>              Output root (default: ./archive)
  --viewport <spec>        desktop,tablet,mobile or WxH[,WxH] (default: all three)
  --profile <name>         recon | standard | deep preset
  --max-pages <n>          Maximum pages to crawl/capture (default: 40)
  --delay <ms>             Politeness delay between page loads (default: 700)
  --respect-robots <bool>  Obey robots.txt (default: true)
  --no-diff                Skip live-vs-local visual comparison
  --diff-max-pages <n>     Compare at most N pages (default: 10)
  --allow-live-fallback    Serve uncaptured URLs from the live network instead of 404
  --insecure               Accept invalid TLS certificates while capturing
  --click-nav              Probe SPA navigation by clicking nav controls (default: on)
  --no-click-nav           Disable click probing
  --headed                 Run the capture browser with a visible window
  --port <n>               Port for the preview server (default: auto)
  --max-asset-bytes <n>    Skip assets larger than N bytes (default: 67108864)
  --timeout <ms>           Per-navigation timeout (default: 30000)
  --config <file>          JSON config file (maskSelectors, maskRects, viewports, …)
  --no-open                Do not open browser tabs at the end
  --tui                    Force the interactive UI
  --plain                  Force plain output
  --ascii                  ASCII glyphs only
  -v, --version            Print the version
  -h, --help               Show this help

Scope
  This tool archives publicly reachable frontend content only. It does not log
  in, defeat bot protection, or capture anything the requester cannot already
  view as a normal visitor.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'no-diff') args.diff = false;
      else if (key === 'no-click-nav') args.clickNav = false;
      else if (key === 'no-open') args.open = false;
      else if (key === 'headed') args.headless = false;
      else if (key === 'allow-live-fallback') args.allowLiveFallback = true;
      else if (key === 'click-nav') args.clickNav = true;
      else if (key === 'diff') args.diff = true;
      else if (key === 'open') args.open = true;
      else if (key === 'tui' || key === 'plain' || key === 'ascii' || key === 'wizard') args[key] = true;
      else if (key.startsWith('no-')) args[camel(key.slice(3))] = false;
      else {
        const value = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : true;
        args[camel(key)] = value;
      }
    } else args._.push(a);
  }
  return args;
}

function camel(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(v, fallback) {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|off)$/i.test(String(v));
}

function normalizeTarget(raw) {
  let target = String(raw || '').trim();
  if (!target) return null;
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const u = new URL(target);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function buildOptions(args, config) {
  const profile = PROFILES[String(args.profile || config.profile || '').toLowerCase()] || null;
  const viewportSpec = args.viewport || config.viewport || (profile ? profile.viewport : 'default');
  const viewports = resolveViewports(viewportSpec);
  return {
    maxPages: num(args.maxPages ?? config.maxPages ?? (profile && profile.maxPages), 40),
    delay: num(args.delay ?? config.delay ?? (profile && profile.delay), 700),
    respectRobots: bool(args.respectRobots ?? config.respectRobots, true),
    clickNav: bool(args.clickNav ?? config.clickNav, true),
    clickBudget: num(config.clickBudget, 10),
    timeout: num(args.timeout ?? config.timeout, 30000),
    maxAssetBytes: num(args.maxAssetBytes ?? config.maxAssetBytes, 64 * 1024 * 1024),
    viewports,
    diff: args.diff !== undefined ? args.diff : config.diff !== undefined ? config.diff : profile ? profile.diff : true,
    diffMaxPages: num(args.diffMaxPages ?? config.diffMaxPages ?? (profile && profile.diffMaxPages), 10),
    diffViewports: config.diffViewports ? resolveViewports(config.diffViewports) : viewports,
    maskSelectors: config.maskSelectors || [],
    maskRects: config.maskRects || [],
    allowLiveFallback: !!args.allowLiveFallback || !!config.allowLiveFallback,
    insecure: !!args.insecure || !!config.insecure,
    headless: args.headless !== false,
    port: num(args.port ?? config.port, 0),
    open: args.open !== false,
  };
}

/* --------------------------------------------------------------- help view */

function printHelp() {
  if (!process.stdout.isTTY) {
    process.stdout.write(RAW_HELP);
    return;
  }
  const g = T.glyphs;
  const width = Math.min(94, process.stdout.columns || 80);
  const line = (s = '') => `${' '.repeat(2)}${s}`;
  const out = [''];
  out.push(line(`${T.gradient('SITEMIRROR', 'accent', 'accent2')}  ${T.paint('faint', 'public frontend mirror & archivability report')}`));
  out.push(line(T.rule(width - 2)));
  out.push('');
  out.push(line(T.paint('faint', 'USAGE')));
  out.push(line(`  ${T.paint('accent', 'sitemirror')}                       ${T.paint('muted', 'interactive wizard')}`));
  out.push(line(`  ${T.paint('accent', 'sitemirror <url>')}                 ${T.paint('muted', 'capture with the live dashboard')}`));
  out.push(line(`  ${T.paint('accent', 'sitemirror <url> --plain')}         ${T.paint('muted', 'line-by-line output for CI')}`));
  out.push('');
  out.push(line(T.paint('faint', 'KEYS')));
  out.push(
    line(
      `  ${T.paint('ink', '↑ ↓')} move    ${T.paint('ink', '← →')} change    ` +
        `${T.paint('ink', '⏎')} confirm    ${T.paint('ink', 'esc')} back    ${T.paint('ink', 'ctrl+c')} abort`,
    ),
  );
  out.push('');
  out.push(line(T.paint('faint', 'OPTIONS')));
  const rows = [
    ['--out <dir>', 'output root (default ./archive)'],
    ['--profile <name>', 'recon | standard | deep'],
    ['--max-pages <n>', 'page cap (default 40)'],
    ['--viewport <spec>', 'desktop,tablet,mobile or WxH'],
    ['--no-diff', 'skip the visual comparison'],
    ['--insecure', 'accept invalid TLS certificates'],
    ['--headed', 'visible capture browser'],
    ['--allow-live-fallback', 'pass uncaptured URLs through to live'],
    ['--config <file>', 'JSON masks / viewports / caps'],
    ['--tui / --plain', 'force one output mode'],
    ['--ascii', 'ASCII glyphs only'],
    ['-v, --version', 'print version'],
    ['-h, --help', 'this help'],
  ];
  for (const [flag, desc] of rows) {
    out.push(line(`  ${T.paint('accent', flag.padEnd(22))} ${T.paint('muted', desc)}`));
  }
  out.push('');
  out.push(line(T.paint('faint', 'Scope: public, frontend-only content. No login bypass, no bot-protection evasion.')));
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

/* -------------------------------------------------------------- plain mode */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.SITEMIRROR_PLAIN;
const c = (color, s) => (useColor ? T.paint(color, s) : s);

const LABEL_WIDTH = 19;

class Status {
  constructor() {
    this.label = '';
    this.live = false;
    this.tty = !!process.stdout.isTTY;
  }
  step(label) {
    this.label = label.padEnd(LABEL_WIDTH);
    if (this.tty) {
      process.stdout.write(this.label);
      this.live = true;
    }
  }
  update(text) {
    if (!this.live) return;
    process.stdout.write(`\x1b[2K\r${this.label}${c('muted', text)}`);
  }
  done(text, ok = true) {
    if (!this.tty) {
      process.stdout.write(`${this.label}${ok ? 'OK' : 'FAIL'} ${text}\n`);
      this.live = false;
      return;
    }
    if (this.live) process.stdout.write('\x1b[2K\r');
    this.live = false;
    process.stdout.write(`${this.label}${ok ? c('accent', '✓') : c('danger', '✗')} ${text}\n`);
  }
  note(text) {
    if (this.tty && this.live) process.stdout.write('\x1b[2K\r');
    this.live = false;
    process.stdout.write(`${' '.repeat(LABEL_WIDTH)}${c('faint', text)}\n`);
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    const s = `${u.host}${p === '/' ? '' : p}`;
    return s.length > 64 ? `${s.slice(0, 63)}…` : s;
  } catch {
    return String(url);
  }
}

async function runPlain({ target, outDir, options }) {
  const status = new Status();
  let session;

  process.stdout.write(
    `\n${c('ink', T.bold('sitemirror'))} ${c('faint', '·')} ${target}\n` +
      `${c('faint', `${options.maxPages} page cap · ${options.delay}ms delay · robots ${options.respectRobots ? 'on' : 'OFF'} · ${options.viewports.map((v) => v.name).join('/')}`)}\n\n`,
  );

  try {
    status.step('Crawling...');
    session = await runMirror({
      rootUrl: target,
      outDir,
      options,
      open: false,
      emit: (event, payload) => {
        switch (event) {
          case 'crawl:done': {
            const n = payload.pages.length;
            status.done(`${n} page${n === 1 ? '' : 's'} found${payload.blocked ? c('warn', ' — blocked, see report') : ''}`);
            if (payload.skipped.length) status.note(`${payload.skipped.length} URL(s) skipped by robots.txt or caps`);
            status.step('Capturing...');
            break;
          }
          case 'capture:page':
            status.update(`${payload.index}/${payload.total}  ${shortUrl(payload.url)}`);
            break;
          case 'capture:done': {
            const bits = [`${payload.captured} page${payload.captured === 1 ? '' : 's'} captured`];
            if (payload.skipped) bits.push(`${payload.skipped} skipped (auth-walled)`);
            if (payload.failed) bits.push(`${payload.failed} failed`);
            status.done(bits.join(', '));
            status.step('Assets...');
            break;
          }
          case 'assets:done': {
            const s = payload;
            const failedText = s.assetsFailed ? ` (${s.assetsFailed} failed — see report)` : '';
            status.done(`${s.assetsSaved}/${s.assetsRequested} downloaded${failedText} · ${humanBytes(s.assetsBytes)}`);
            break;
          }
          case 'diff:start':
            status.step('Visual diff...');
            status.update(`${payload.pages} page(s) × ${options.diffViewports.length} viewports`);
            break;
          case 'diff:done': {
            if (payload.score === null) status.done('no comparable pages', false);
            else status.done(`${Math.round(payload.score * 100)}% match average across ${payload.pages} page${payload.pages === 1 ? '' : 's'}`);
            break;
          }
          default:
            break;
        }
      },
    });

    const captured = session.pageResults.filter((p) => p.status === 'captured').length;
    const stats = session.manifest.stats();

    process.stdout.write('\n');
    process.stdout.write(`${c('accent', '✓')} Mirror ready: ${c('accent2', session.serverUrl)}\n`);
    process.stdout.write(`${c('accent', '✓')} Report:       ${c('accent2', session.reportUrl)}\n`);
    if (session.proxy) {
      process.stdout.write(
        `${c('faint', '·')} Exact replay: open ${c('accent2', target)} in a browser proxied through ${c('accent2', `127.0.0.1:${session.proxy.port}`)} (PAC: ${session.serverUrl}/__proxy.pac)\n`,
      );
    }
    process.stdout.write(
      `${c('faint', `· ${captured} page(s) · ${humanBytes(stats.assetsBytes)} on disk · ${path.relative(process.cwd(), session.archiveRoot) || '.'} · Ctrl+C to stop`)}\n\n`,
    );

    if (options.open) {
      try {
        const { openExternal } = require('../core/mirror');
        const { launchBrowser } = require('../core/launcher');
        const mirrorBrowser = await launchBrowser({ headless: false });
        const ctx = await mirrorBrowser.newContext({
          viewport: { width: 1440, height: 900 },
          proxy: { server: `http://127.0.0.1:${session.proxy.port}` },
          ignoreHTTPSErrors: true,
        });
        const page = await ctx.newPage();
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        openExternal(`${session.serverUrl}/__report/`);
        session.mirrorBrowser = mirrorBrowser;
      } catch {
        const { openExternal } = require('../core/mirror');
        openExternal(`${session.serverUrl}/__report/`);
      }
    }

    const shutdown = async () => {
      process.stdout.write('\n');
      status.note('shutting down…');
      await session.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    status.done(`fatal: ${err.message}`, false);
    if (process.env.SITEMIRROR_DEBUG) console.error(err);
    if (session) await session.close().catch(() => {});
    process.exit(1);
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.version) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  let config = {};
  if (args.config && args.config !== true) {
    try {
      config = JSON.parse(fs.readFileSync(path.resolve(String(args.config)), 'utf8'));
    } catch (err) {
      console.error(`Could not read config ${args.config}: ${err.message}`);
      process.exit(1);
    }
  }

  const tty = !!process.stdout.isTTY && !!process.stdin.isTTY;
  const forceTui = !!args.tui;
  const interactive = !args.plain && (forceTui || tty);

  if (forceTui && !tty) {
    console.error('--tui needs an interactive terminal (stdout and stdin must be a TTY).');
    process.exit(1);
  }

  if (args._.length === 0) {
    if (interactive) {
      await runTui({
        target: null,
        outDir: args.out || config.out,
        version: pkg.version,
        defaults: {
          out: args.out || config.out,
          profile: args.profile || config.profile,
          open: args.open !== false,
        },
      });
      process.exit(0);
    }
    printHelp();
    process.exit(1);
  }

  const raw = args._[0];
  const target = normalizeTarget(raw);
  if (!target) {
    console.error(`Not a valid URL: ${raw}`);
    process.exit(1);
  }

  const options = buildOptions(args, config);
  const outDir = path.resolve(String(args.out || config.out || './archive'));

  if (interactive) {
    await runTui({
      target: args.wizard ? null : target,
      outDir,
      options,
      open: options.open,
      version: pkg.version,
      defaults: {
        out: outDir,
        profile: args.profile || config.profile,
        target: args.wizard ? target : '',
        open: options.open,
      },
    });
    process.exit(0);
  }

  await runPlain({ target, outDir, options });
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
