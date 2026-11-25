'use strict';

/**
 * Interactive terminal experience:
 *   wizard  → asks for target, destination and scope
 *   capture → live pipeline dashboard fed by runMirror events
 *   results → scores, archive path, replay links, clipboard
 *
 * The renderers live in frames.js and stay pure; this file owns the state
 * machine, key handling and process lifecycle.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { Screen } = require('./screen');
const { createKeyReader } = require('./input');
const frames = require('./frames');
const T = require('./theme');
const { resolveViewports } = require('../launcher');
const { runMirror, openExternal } = require('../mirror');
const { humanBytes } = require('../util');

const DEFAULTS = {
  target: '',
  out: './archive',
  profile: 'standard',
};

/* --------------------------------------------------------------- utilities */

function displayPath(p) {
  const abs = path.resolve(p);
  const home = os.homedir();
  if (home && abs.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${abs.slice(home.length)}`;
  }
  return abs;
}

function safeHost(host) {
  return String(host || 'site').replace(/[<>:"/\\|?*\s]/g, '_');
}

function nearestExisting(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try {
      if (fs.existsSync(d)) return d;
    } catch {
      /* keep walking up */
    }
    const parent = path.dirname(d);
    if (parent === d) return d;
    d = parent;
  }
}

function freeSpace(dir) {
  try {
    const st = fs.statfsSync(nearestExisting(dir));
    const bytes = Number(st.bsize) * Number(st.bavail);
    return Number.isFinite(bytes) ? humanBytes(bytes) : null;
  } catch {
    return null;
  }
}

/**
 * The authority exactly as typed, before URL normalisation.
 *
 * `new URL` is far too forgiving for live validation: it happily rewrites
 * `127` to `0.0.0.127` and `example` to `example/`, so a half-typed address
 * would look finished while the user is still on the second keystroke. We
 * validate what was typed, then let the parser build the canonical URL.
 */
function typedAuthority(raw) {
  const afterScheme = String(raw || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const end = afterScheme.search(/[/?#]/);
  let authority = end >= 0 ? afterScheme.slice(0, end) : afterScheme;
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  return authority;
}

function splitAuthority(authority) {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return { host: authority, port: '' };
    return { host: authority.slice(0, close + 1), port: authority.slice(close + 1).replace(/^:/, '') };
  }
  const first = authority.indexOf(':');
  const last = authority.lastIndexOf(':');
  if (first >= 0 && first === last) return { host: authority.slice(0, first), port: authority.slice(first + 1) };
  return { host: authority, port: '' };
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

function validateAuthority(authority) {
  if (!authority) return { ok: false, reason: 'missing a hostname' };

  const { host: typedHost, port } = splitAuthority(authority);
  if (!typedHost) return { ok: false, reason: 'missing a hostname' };
  if (port && !/^\d{1,5}$/.test(port)) return { ok: false, reason: 'the port must be a number' };
  if (port && Number(port) > 65535) return { ok: false, reason: 'that port is out of range' };

  // A trailing dot is a valid FQDN terminator, but while typing it almost
  // always means the name is unfinished. Keep the affordance pending.
  if (typedHost.endsWith('.')) return { ok: false, reason: 'finish the domain name' };

  if (typedHost.startsWith('[')) {
    const ipv6 = /^\[([0-9a-f:.]+)\]$/i.exec(typedHost);
    if (!ipv6 || !ipv6[1].includes(':')) return { ok: false, reason: 'finish the IPv6 address' };
    return { ok: true };
  }
  if (typedHost.includes(':')) return { ok: false, reason: 'wrap IPv6 addresses in [brackets]' };
  if (typedHost === 'localhost') return { ok: true };

  let host = typedHost;
  if (/[^\x00-\x7f]/.test(host)) {
    host = require('url').domainToASCII(host);
    if (!host) return { ok: false, reason: 'that hostname cannot be converted to a domain' };
  }

  if (/^[0-9.]+$/.test(host)) {
    const octets = host.split('.');
    if (octets.length !== 4) return { ok: false, reason: 'an IP address needs four octets - or use a full domain' };
    if (octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
      return { ok: false, reason: 'that IP address is not valid' };
    }
    return { ok: true };
  }

  if (!host.includes('.')) return { ok: false, reason: 'that hostname has no TLD - try a full domain' };
  const labels = host.split('.');
  if (labels.some((label) => !HOST_LABEL.test(label) || label.length > 63)) {
    return { ok: false, reason: 'that hostname contains characters a domain cannot use' };
  }
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i.test(tld)) {
    return { ok: false, reason: 'finish the domain name - it needs a real TLD' };
  }
  return { ok: true };
}

function normalizeTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, reason: 'paste a site address to continue' };
  if (/\s/.test(s)) return { ok: false, reason: 'the address contains whitespace' };

  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme && !/^https?$/i.test(scheme[1])) return { ok: false, reason: 'only http and https are supported' };

  const verdict = validateAuthority(typedAuthority(s));
  if (!verdict.ok) return verdict;

  const candidate = scheme ? s : `https://${s}`;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return { ok: false, reason: 'not a valid URL yet' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'only http and https are supported' };
  if (!u.hostname) return { ok: false, reason: 'missing a hostname' };
  u.hash = '';
  return { ok: true, url: u.toString(), host: u.host };
}

function pathInfoFor(outRoot) {
  const abs = path.resolve(outRoot || './archive');
  let exists = false;
  try {
    exists = fs.existsSync(abs);
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    abs,
    display: displayPath(abs),
    free: freeSpace(abs),
    note: exists ? 'folder exists — captured files merge into it' : null,
  };
}

function copyText(text) {
  return new Promise((resolve) => {
    try {
      const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
      const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
      child.stdin.on('error', () => finish(false));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

function waitAnyKey(keys) {
  return new Promise((resolve) => {
    const off = keys.onKey((key) => {
      off();
      resolve(key);
    });
  });
}

/* ------------------------------------------------------------------ wizard */

const PROFILE_MAP = {
  recon: { maxPages: 12, delay: 500, viewports: 'desktop', diff: false, diffMaxPages: 0 },
  standard: { maxPages: 40, delay: 700, viewports: 'default', diff: true, diffMaxPages: 10 },
  deep: { maxPages: 120, delay: 500, viewports: 'default', diff: true, diffMaxPages: 30 },
};

const VIEWPORT_ENUM = [
  { value: 'desktop', label: 'desktop only' },
  { value: 'desktop,tablet', label: 'desktop · tablet' },
  { value: 'desktop,tablet,mobile', label: 'desktop · tablet · mobile' },
];

function defaultOptionValues() {
  return {
    maxPages: 40,
    delay: 700,
    viewports: 'desktop,tablet,mobile',
    diff: true,
    clickNav: true,
    respectRobots: true,
    open: true,
    visible: false,
    allowLiveFallback: false,
    insecure: false,
  };
}

function buildOptionRows(values) {
  const rows = [
    { key: 'maxPages', label: 'Max pages', type: 'number', value: values.maxPages, min: 1, max: 500, step: 10 },
    { key: 'delay', label: 'Politeness delay', type: 'number', value: values.delay, min: 0, max: 5000, step: 100, unit: 'ms' },
    { key: 'viewports', label: 'Viewports', type: 'enum', value: values.viewports, options: VIEWPORT_ENUM },
    { key: 'diff', label: 'Visual diff', type: 'bool', value: values.diff },
    { key: 'clickNav', label: 'SPA click-nav', type: 'bool', value: values.clickNav },
    { key: 'respectRobots', label: 'Respect robots.txt', type: 'bool', value: values.respectRobots },
    { key: 'open', label: 'Open when finished', type: 'bool', value: values.open },
    { key: 'visible', label: 'Visible browser', type: 'bool', value: values.visible },
    { key: 'allowLiveFallback', label: 'Live fallback', type: 'bool', value: values.allowLiveFallback },
    { key: 'insecure', label: 'Ignore TLS errors', type: 'bool', value: values.insecure },
  ];
  syncRows(rows);
  return rows;
}

function syncRows(rows) {
  for (const row of rows) {
    if (row.type === 'bool') {
      row.display = row.value ? 'ON' : 'OFF';
    } else if (row.type === 'number') {
      row.display = `${row.value}${row.unit ? ` ${row.unit}` : ''}`;
    } else if (row.type === 'enum') {
      const found = row.options.find((o) => o.value === row.value) || row.options[0];
      row.display = found.label;
    }
  }
}

function changeRow(row, dir) {
  if (row.type === 'bool') {
    row.value = !row.value;
  } else if (row.type === 'number') {
    row.value = Math.max(row.min, Math.min(row.max, row.value + dir * row.step));
  } else if (row.type === 'enum') {
    const idx = Math.max(0, row.options.findIndex((o) => o.value === row.value));
    const next = (idx + dir + row.options.length) % row.options.length;
    row.value = row.options[next].value;
  }
  syncRows([row]);
}

function optionValuesFromRows(rows) {
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function buildPreviewConfig(state) {
  const check = state.targetCheck;
  const target = check && check.ok ? check.url : state.target || 'https://example.com';
  const host = check && check.ok ? check.host : 'example.com';
  const outRoot = path.resolve(state.out || './archive');
  const archive = path.join(outRoot, safeHost(host));

  let opts;
  if (state.profile === 'custom') {
    const v = optionValuesFromRows(state.optionRows);
    opts = {
      maxPages: v.maxPages,
      delay: v.delay,
      viewports: v.viewports,
      diff: v.diff,
      clickNav: v.clickNav,
      respectRobots: v.respectRobots,
      open: v.open,
      visible: v.visible,
      allowLiveFallback: v.allowLiveFallback,
      insecure: v.insecure,
      diffMaxPages: v.diff ? Math.min(30, v.maxPages) : 0,
    };
  } else {
    const p = PROFILE_MAP[state.profile] || PROFILE_MAP.standard;
    const v = optionValuesFromRows(state.optionRows);
    opts = {
      maxPages: p.maxPages,
      delay: p.delay,
      viewports: p.viewports,
      diff: p.diff,
      clickNav: true,
      respectRobots: true,
      open: v.open,
      visible: v.visible,
      allowLiveFallback: false,
      insecure: false,
      diffMaxPages: p.diffMaxPages,
    };
  }

  const viewports = resolveViewports(opts.viewports);
  const profileNames = {
    recon: `RECON · ${opts.maxPages} pages · desktop only`,
    standard: `STANDARD · ${opts.maxPages} pages · ${viewports.length} viewports`,
    deep: `DEEP · ${opts.maxPages} pages · ${viewports.length} viewports`,
    custom: `CUSTOM · ${opts.maxPages} pages · ${viewports.length} viewport${viewports.length === 1 ? '' : 's'}`,
  };
  const eta = { recon: '~1 min', standard: '~4 min', deep: '~15 min', custom: 'depends on options' };

  const audit = [
    `diff ${opts.diff ? 'on' : 'off'}`,
    `click-nav ${opts.clickNav ? 'on' : 'off'}`,
    `robots ${opts.respectRobots ? 'on' : 'off'}`,
  ].join(` ${T.glyphs.sep} `);

  return {
    target,
    outDir: outRoot,
    archivePreview: displayPath(archive),
    profileLabel: profileNames[state.profile] || profileNames.standard,
    auditLabel: audit,
    engineLabel: `chromium ${opts.visible ? 'visible' : 'headless'}${opts.insecure ? ' · TLS relaxed' : ''}`,
    etaLabel: eta[state.profile] || eta.standard,
    options: {
      maxPages: opts.maxPages,
      delay: opts.delay,
      respectRobots: opts.respectRobots,
      clickNav: opts.clickNav,
      clickBudget: 10,
      timeout: 30000,
      maxAssetBytes: 64 * 1024 * 1024,
      viewports,
      diff: opts.diff,
      diffMaxPages: opts.diffMaxPages,
      diffViewports: viewports,
      maskSelectors: [],
      maskRects: [],
      allowLiveFallback: opts.allowLiveFallback,
      insecure: opts.insecure,
      headless: !opts.visible,
      port: 0,
      open: opts.open,
    },
    open: opts.open,
  };
}

function initialWizardState(defaults) {
  const target = defaults.target || '';
  const out = defaults.out || DEFAULTS.out;
  const profile = ['recon', 'standard', 'deep', 'custom'].includes(defaults.profile) ? defaults.profile : 'standard';
  const optionDefaults = defaultOptionValues();
  if (defaults.open === false) optionDefaults.open = false;
  const state = {
    step: 'target',
    target,
    targetCursor: target.length,
    targetCheck: null,
    out,
    outCursor: out.length,
    outPreview: '',
    pathInfo: null,
    profile,
    profileIndex: frames.profileItems().findIndex((p) => p.id === profile),
    optionRows: buildOptionRows(optionDefaults),
    optionIndex: 0,
    config: null,
    settled: false,
  };
  if (state.profileIndex < 0) state.profileIndex = 1;
  return state;
}

function refreshWizard(state) {
  state.targetCheck = normalizeTarget(state.target);
  const host = state.targetCheck.ok ? safeHost(state.targetCheck.host) : null;
  state.outPreview = host ? displayPath(path.join(path.resolve(state.out || './archive'), host)) : '';
  if (state.step === 'destination') state.pathInfo = pathInfoFor(state.out);
  state.config = buildPreviewConfig(state);
}

function editText(state, field, key) {
  const valueKey = field;
  const cursorKey = `${field}Cursor`;
  const value = state[valueKey];
  const cursor = state[cursorKey];
  const set = (next, nextCursor) => {
    state[valueKey] = next.slice(0, 4096);
    state[cursorKey] = Math.min(nextCursor, state[valueKey].length);
  };
  switch (key.name) {
    case 'left':
      state[cursorKey] = Math.max(0, cursor - 1);
      return true;
    case 'right':
      state[cursorKey] = Math.min(value.length, cursor + 1);
      return true;
    case 'home':
      state[cursorKey] = 0;
      return true;
    case 'end':
      state[cursorKey] = value.length;
      return true;
    case 'backspace':
      if (cursor === 0) return true;
      set(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return true;
    case 'delete':
      if (cursor >= value.length) return true;
      set(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      return true;
    case 'ctrl-u':
      set('', 0);
      return true;
    case 'ctrl-w': {
      if (cursor === 0) return true;
      const before = value.slice(0, cursor);
      const cut = before.replace(/\S+\s*$/, '');
      set(cut + value.slice(cursor), cut.length);
      return true;
    }
    case 'char': {
      const ch = key.ch;
      if (!ch) return true;
      set(value.slice(0, cursor) + ch + value.slice(cursor), cursor + ch.length);
      return true;
    }
    default:
      return false;
  }
}

async function runWizard({ screen, keys, version, defaults }) {
  const state = initialWizardState(defaults);
  return new Promise((resolve) => {
    let offKey = null;
    let offResize = null;

    const finish = (config) => {
      if (state.settled) return;
      state.settled = true;
      if (offKey) offKey();
      if (offResize) offResize();
      resolve(config);
    };

    const draw = () => {
      refreshWizard(state);
      const { lines, cursor } = frames.renderWizard(state, {
        width: screen.contentWidth,
        height: screen.rows,
        version,
      });
      screen.render(lines, cursor);
    };

    const goBack = () => {
      if (state.step === 'review') state.step = state.profile === 'custom' ? 'custom' : 'profile';
      else if (state.step === 'custom') state.step = 'profile';
      else if (state.step === 'profile') state.step = 'destination';
      else if (state.step === 'destination') state.step = 'target';
      else finish(null);
    };

    const onKey = (key) => {
      if (key.name === 'ctrl-c') return finish(null);

      if (state.step === 'target' || state.step === 'destination') {
        const field = state.step === 'target' ? 'target' : 'out';
        if (key.name === 'enter') {
          if (state.step === 'target') {
            refreshWizard(state);
            if (!state.targetCheck.ok) return;
            state.step = 'destination';
          } else {
            if (!state.out.trim()) state.out = DEFAULTS.out;
            state.step = 'profile';
          }
          return draw();
        }
        if (key.name === 'escape') return goBack();
        if (editText(state, field, key)) return draw();
        return;
      }

      if (state.step === 'profile') {
        const items = frames.profileItems();
        if (key.name === 'up' || (key.name === 'tab' && key.shift)) {
          state.profileIndex = (state.profileIndex - 1 + items.length) % items.length;
          return draw();
        }
        if (key.name === 'down' || key.name === 'tab') {
          state.profileIndex = (state.profileIndex + 1) % items.length;
          return draw();
        }
        if (key.name === 'enter') {
          state.profile = items[state.profileIndex].id;
          state.step = state.profile === 'custom' ? 'custom' : 'review';
          return draw();
        }
        if (key.name === 'escape') return goBack();
        return;
      }

      if (state.step === 'custom') {
        const rows = state.optionRows;
        if (key.name === 'up') {
          state.optionIndex = (state.optionIndex - 1 + rows.length) % rows.length;
          return draw();
        }
        if (key.name === 'down' || (key.name === 'tab' && !key.shift)) {
          state.optionIndex = (state.optionIndex + 1) % rows.length;
          return draw();
        }
        if (key.name === 'left' || key.name === 'right') {
          changeRow(rows[state.optionIndex], key.name === 'right' ? 1 : -1);
          return draw();
        }
        if (key.name === 'char' && key.ch === ' ') {
          const row = rows[state.optionIndex];
          if (row.type === 'bool') changeRow(row, 1);
          return draw();
        }
        if (key.name === 'enter') {
          state.step = 'review';
          return draw();
        }
        if (key.name === 'escape') return goBack();
        return;
      }

      if (state.step === 'review') {
        if (key.name === 'enter') {
          refreshWizard(state);
          if (!state.targetCheck.ok) {
            state.step = 'target';
            return draw();
          }
          return finish({
            target: state.config.target,
            outDir: state.config.outDir,
            options: state.config.options,
            open: state.config.open,
          });
        }
        if (key.name === 'escape') return goBack();
      }
    };

    offKey = keys.onKey(onKey);
    offResize = screen.onResize(draw);
    draw();
  });
}

/* --------------------------------------------------------------- dashboard */

const PHASE_LABEL = {
  crawl: 'CRAWLING',
  capture: 'CAPTURING',
  prepare: 'PREPARING',
  diff: 'COMPARING',
  report: 'REPORTING',
  serve: 'SERVING',
};

const DEFAULT_DETAIL = {
  crawl: 'robots.txt + link discovery',
  capture: 'pages and their assets',
  prepare: 'manifest + replay proxy',
  diff: 'live vs local render',
  report: 'self-contained html',
  serve: 'local preview server',
};

function createDashboardState(host) {
  const phases = {};
  for (const p of frames.PHASES) phases[p.id] = { status: 'pending', detail: DEFAULT_DETAIL[p.id] };
  return {
    startedAt: Date.now(),
    host,
    phase: null,
    phaseLabel: 'STARTING',
    finished: false,
    error: null,
    phases,
    captureDone: 0,
    captureTotal: 0,
    assetsSaved: 0,
    currentUrl: '',
    stats: { pagesCaptured: 0, pagesTotal: 0, assetsSaved: 0, bytes: 0, fidelity: null },
    log: [],
  };
}

function setPhase(state, id, status, detail) {
  const p = state.phases[id];
  if (!p) return;
  p.status = status;
  if (detail !== undefined) p.detail = detail;
  if (status === 'active') {
    state.phase = id;
    state.phaseLabel = PHASE_LABEL[id] || id.toUpperCase();
  }
}

function pushLog(state, line) {
  const clean = String(line || '').replace(/\s+/g, ' ').trim();
  if (!clean) return;
  state.log.push(clean);
  if (state.log.length > 40) state.log.splice(0, state.log.length - 40);
}

function applyEvent(state, event, payload) {
  switch (event) {
    case 'crawl:start':
      setPhase(state, 'crawl', 'active');
      break;
    case 'crawl:done': {
      const pages = Array.isArray(payload.pages) ? payload.pages.length : 0;
      const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
      setPhase(state, 'crawl', 'done', `${pages} page${pages === 1 ? '' : 's'} discovered${skipped ? ` · ${skipped} skipped` : ''}`);
      if (payload.blocked) pushLog(state, `bot protection detected: ${payload.blocked}`);
      pushLog(state, `crawl finished — ${pages} URL${pages === 1 ? '' : 's'} in scope`);
      break;
    }
    case 'capture:start':
      state.captureTotal = payload.total || 0;
      state.stats.pagesTotal = payload.total || 0;
      setPhase(state, 'capture', 'active');
      break;
    case 'capture:page':
      state.currentUrl = payload.url || '';
      if (typeof payload.index === 'number') state.captureDone = Math.max(state.captureDone, payload.index - 1);
      break;
    case 'capture:page:done': {
      const result = payload.result || {};
      state.captureDone = payload.index || state.captureDone;
      if (result.status === 'captured') {
        state.stats.pagesCaptured += 1;
        pushLog(state, `captured ${result.url}`);
      } else if (result.status === 'skipped') {
        pushLog(state, `skipped ${result.url} — ${result.skipReason || 'auth wall'}`);
      } else {
        pushLog(state, `failed ${result.url} — ${result.failureReason || result.skipReason || 'error'}`);
      }
      if (result.assetSummary) {
        state.stats.assetsSaved += result.assetSummary.saved || 0;
        state.stats.bytes += result.assetSummary.bytes || 0;
        state.assetsSaved = state.stats.assetsSaved;
      }
      break;
    }
    case 'capture:done': {
      const bits = [`${payload.captured} captured`];
      if (payload.skipped) bits.push(`${payload.skipped} auth-walled`);
      if (payload.failed) bits.push(`${payload.failed} failed`);
      setPhase(state, 'capture', 'done', bits.join(' · '));
      state.currentUrl = '';
      break;
    }
    case 'assets:done':
      state.stats.assetsSaved = payload.assetsSaved;
      state.stats.bytes = payload.assetsBytes;
      state.assetsSaved = payload.assetsSaved;
      setPhase(state, 'capture', 'done', `${payload.pagesCaptured} pages · ${payload.assetsSaved} assets · ${humanBytes(payload.assetsBytes)}`);
      break;
    case 'proxy:start':
      setPhase(state, 'prepare', 'active');
      break;
    case 'proxy:done':
      setPhase(state, 'prepare', 'done', `replay proxy on 127.0.0.1:${payload.port}`);
      break;
    case 'diff:start':
      setPhase(state, 'diff', 'active', `${payload.pages} page${payload.pages === 1 ? '' : 's'}`);
      break;
    case 'diff:done': {
      if (payload.score === null || payload.score === undefined) {
        setPhase(state, 'diff', 'done', 'no comparable pages');
      } else {
        state.stats.fidelity = payload.score;
        setPhase(state, 'diff', 'done', `${Math.round(payload.score * 100)}% visual match across ${payload.pages} page${payload.pages === 1 ? '' : 's'}`);
      }
      setPhase(state, 'report', 'active');
      break;
    }
    case 'report:done':
      setPhase(state, 'report', 'done', 'report.html written');
      break;
    case 'server:done':
      setPhase(state, 'serve', 'done', payload.url || 'listening');
      break;
    case 'log': {
      const line = String(payload || '').trim();
      if (!line) break;
      pushLog(state, line);
      const m = /^diff\s+·\s+(\S+)/.exec(line);
      if (m) state.currentUrl = m[1];
      break;
    }
    default:
      break;
  }
}

function finishDashboardState(state, session) {
  const stats = session.manifest.stats();
  state.stats = {
    pagesCaptured: stats.pagesCaptured,
    pagesTotal: stats.pagesTotal,
    assetsSaved: stats.assetsSaved,
    bytes: stats.assetsBytes,
    fidelity: session.report && session.report.summary ? session.report.summary.visual.score : null,
  };
  state.captureDone = stats.pagesTotal;
  state.captureTotal = stats.pagesTotal;
  state.assetsSaved = stats.assetsSaved;
  state.currentUrl = '';
  state.finished = true;
  state.phaseLabel = 'COMPLETE';
  for (const p of frames.PHASES) {
    if (state.phases[p.id].status !== 'failed') state.phases[p.id].status = 'done';
  }
}

async function runCapture({ screen, keys, version, config }) {
  const state = createDashboardState(new URL(config.target).host);
  let session = null;

  const draw = () => {
    const { lines, cursor } = frames.renderDashboard(state, {
      width: screen.contentWidth,
      height: screen.rows,
      version,
    });
    screen.render(lines, cursor);
  };

  const timer = setInterval(draw, 100);
  const offResize = screen.onResize(draw);
  const offKey = keys.onKey((key) => {
    if (key.name === 'ctrl-c') {
      clearInterval(timer);
      offResize();
      offKey();
      keys.stop();
      screen.leave();
      if (session) session.close().finally(() => process.exit(130));
      else process.exit(130);
    }
  });

  draw();

  try {
    session = await runMirror({
      rootUrl: config.target,
      outDir: config.outDir,
      options: config.options,
      open: config.open,
      emit: (event, payload) => applyEvent(state, event, payload),
    });
    finishDashboardState(state, session);
    draw();
  } catch (err) {
    state.error = err && err.message ? err.message : String(err);
    state.phaseLabel = 'FAILED';
    if (state.phase && state.phases[state.phase]) state.phases[state.phase].status = 'failed';
    clearInterval(timer);
    draw();
    offResize();
    offKey();
    const { lines } = frames.renderError(
      { message: state.error, durationMs: Date.now() - state.startedAt },
      { width: screen.contentWidth, height: screen.rows, version },
    );
    screen.render(lines, null);
    await waitAnyKey(keys);
    if (session) await session.close().catch(() => {});
    return { session: null, error: state.error };
  }

  clearInterval(timer);
  offResize();
  offKey();
  draw();
  await new Promise((r) => setTimeout(r, 350));
  return { session };
}

/* ----------------------------------------------------------------- results */

async function runResults({ screen, keys, version, session }) {
  const data = {
    durationMs: session.durationMs,
    archiveRoot: session.archiveRoot,
    serverUrl: session.serverUrl,
    reportUrl: session.reportUrl,
    proxyPort: session.proxy ? session.proxy.port : null,
    stats: session.manifest.stats(),
    summary: session.report.summary,
    notice: null,
  };

  return new Promise((resolve) => {
    let offKey = null;
    let offResize = null;
    let closing = false;

    const draw = () => {
      const { lines } = frames.renderResults(data, {
        width: screen.contentWidth,
        height: screen.rows,
        version,
      });
      screen.render(lines, null);
    };

    const close = () => {
      if (closing) return;
      closing = true;
      if (offKey) offKey();
      if (offResize) offResize();
      resolve();
    };

    offKey = keys.onKey(async (key) => {
      const name = key.name === 'char' ? key.ch.toLowerCase() : key.name;
      if (name === 'q' || name === 'escape' || name === 'ctrl-c') return close();
      if (name === 'enter' || name === 'o') {
        if (data.reportUrl) openExternal(data.reportUrl);
        return;
      }
      if (name === 'c') {
        const ok = data.reportUrl ? await copyText(data.reportUrl) : false;
        data.notice = ok ? 'report URL copied to clipboard' : 'clipboard unavailable — copy the URL above';
        draw();
      }
    });
    offResize = screen.onResize(draw);
    draw();
  });
}

/* -------------------------------------------------------------------- entry */

async function runTui({
  target,
  outDir,
  options,
  open,
  version,
  defaults = {},
  stdout = process.stdout,
  stdin = process.stdin,
}) {
  if (!stdout.isTTY || !stdin.isTTY) {
    throw new Error('The interactive UI needs a TTY. Run without --tui, or pipe the plain output.');
  }

  const screen = new Screen({ stdout, stdin });
  const keys = createKeyReader(stdin);
  const emergency = () => {
    try {
      keys.stop();
      screen.leave();
    } catch {
      /* last-ditch restore */
    }
  };

  screen.enter();
  keys.start();
  process.once('exit', emergency);

  try {
    let config;
    if (target) {
      config = {
        target,
        outDir: path.resolve(outDir || './archive'),
        options: options || {},
        open: open !== false,
      };
    } else {
      config = await runWizard({
        screen,
        keys,
        version,
        defaults: { ...defaults, out: outDir || defaults.out },
      });
      if (!config) return null;
    }

    const { session } = await runCapture({ screen, keys, version, config });
    if (session) {
      await runResults({ screen, keys, version, session });
      await session.close().catch(() => {});
      return { closed: true };
    }
    return null;
  } finally {
    keys.stop();
    screen.leave();
  }
}

module.exports = {
  runTui,
  runWizard,
  normalizeTarget,
  displayPath,
  safeHost,
  buildPreviewConfig,
  initialWizardState,
};
