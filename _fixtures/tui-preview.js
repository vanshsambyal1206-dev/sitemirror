'use strict';

/**
 * Offline frame preview for the TUI. Renders every screen to plain text and
 * checks two things per frame: no line is wider than the content width, and
 * no line is dropped by the alt-screen renderer's row budget.
 *
 *   node _fixtures/tui-preview.js [--width 78] [--height 30] [--color]
 *   node _fixtures/tui-preview.js --matrix      # width/height sweep only
 */

process.env.NO_COLOR = process.env.COLOR === '1' ? '' : '1';

const frames = require('../core/tui/frames');
const { initialWizardState, buildPreviewConfig } = require('../core/tui/index');
const T = require('../core/tui/theme');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const startWidth = arg('width', 78);
const startHeight = arg('height', 30);
const matrixOnly = flag('matrix');

let problems = 0;

/**
 * Render one frame and report layout problems against the context it was made for.
 * The screen keeps one row free at the bottom, so the budget is height - 1.
 */
function show(title, make, ctx = { width: startWidth, height: startHeight, version: '1.0.0' }) {
  const { width, height } = ctx;
  const result = make(ctx);
  const lines = result.lines;
  const budget = height - 1;
  const issues = [];

  if (lines.length > budget) issues.push(`${lines.length} lines > ${budget} row budget`);

  lines.forEach((line, i) => {
    const w = T.visibleWidth(line);
    if (w > width) issues.push(`line ${i} is ${w} wide (max ${width})`);
  });

  if (result.cursor && result.cursor.col > width) {
    issues.push(`cursor col ${result.cursor.col} > ${width}`);
  }

  if (!matrixOnly) {
    console.log(`\n${'='.repeat(width)}`);
    console.log(` ${title}   (${width}x${height})`);
    console.log('='.repeat(width));
    lines.forEach((line, i) => {
      console.log(line + (result.cursor && result.cursor.line === i ? '  <cursor>' : ''));
    });
    if (result.cursor) console.log(` cursor col: ${result.cursor.col}`);
  }

  for (const issue of issues) {
    problems += 1;
    console.log(`! ${title} @ ${width}x${height} — ${issue}`);
  }
  return result;
}

function wizardState(step = 'target') {
  const state = initialWizardState({ out: './archive', profile: 'standard' });
  state.target = 'https://example.com';
  state.targetCursor = state.target.length;
  state.step = step;
  if (step === 'destination') {
    state.pathInfo = { ok: true, display: '~/archive', free: '18.2 GB', note: null };
  }
  if (step === 'profile') state.profileIndex = 1;
  if (step === 'custom') {
    state.profile = 'custom';
    state.optionIndex = 3;
  }
  if (step === 'review') state.config = buildPreviewConfig(state);
  return state;
}

function dashboardState(finished) {
  const state = {
    startedAt: Date.now() - 74000,
    host: 'example.com',
    phase: 'capture',
    phaseLabel: 'CAPTURING',
    finished: false,
    error: null,
    captureDone: 7,
    captureTotal: 16,
    assetsSaved: 142,
    currentUrl: 'https://example.com/blog/designing-for-the-edge',
    stats: { pagesCaptured: 7, pagesTotal: 16, assetsSaved: 142, bytes: 24.8 * 1024 * 1024, fidelity: null },
    log: [
      'capture started — 16 pages',
      'captured https://example.com/',
      'captured https://example.com/about',
      'captured https://example.com/blog',
    ],
    phases: {
      crawl: { status: 'done', detail: '16 pages discovered' },
      capture: { status: 'active', detail: '' },
      prepare: { status: 'pending', detail: 'manifest + replay proxy' },
      diff: { status: 'pending', detail: 'live vs local render' },
      report: { status: 'pending', detail: 'self-contained html' },
      serve: { status: 'pending', detail: 'local preview server' },
    },
  };
  if (finished) {
    state.phases.capture = { status: 'done', detail: '16 pages · 341 assets · 24.8 MB' };
    state.phases.prepare = { status: 'done', detail: 'replay proxy on 127.0.0.1:63892' };
    state.phases.diff = { status: 'done', detail: '96% visual match across 10 pages' };
    state.phases.report = { status: 'done', detail: 'report.html written' };
    state.phases.serve = { status: 'done', detail: 'http://127.0.0.1:5173' };
    state.finished = true;
    state.phaseLabel = 'COMPLETE';
    state.stats.fidelity = 0.96;
    state.stats.pagesCaptured = 16;
    state.captureDone = 16;
    state.currentUrl = '';
  }
  return state;
}

const RESULTS = {
  durationMs: 214000,
  archiveRoot: 'C:\\Users\\vansh\\Desktop\\cite cloner\\archive\\example.com',
  serverUrl: 'http://127.0.0.1:5173',
  reportUrl: 'http://127.0.0.1:5173/__report/',
  proxyPort: 63892,
  stats: {
    pagesCaptured: 16,
    pagesTotal: 18,
    pagesSkipped: 2,
    pagesFailed: 0,
    assetsSaved: 341,
    assetsRequested: 347,
    assetsBytes: 26000000,
  },
  summary: {
    overall: 0.94,
    visual: { score: 0.96 },
    assets: { saved: 341, failed: 6, originFailures: 0 },
  },
  notice: null,
};

const ctx = { width: startWidth, height: startHeight, version: '1.0.0' };

/* ------------------------------------------------------- full screen review */

show('WIZARD · target', (c) => frames.renderWizard(wizardState('target'), c), ctx);
show('WIZARD · destination', (c) => frames.renderWizard(wizardState('destination'), c), ctx);
show('WIZARD · profile', (c) => frames.renderWizard(wizardState('profile'), c), ctx);
show('WIZARD · custom', (c) => frames.renderWizard(wizardState('custom'), c), ctx);
show('WIZARD · review', (c) => frames.renderWizard(wizardState('review'), c), ctx);
show('DASHBOARD · capturing', (c) => frames.renderDashboard(dashboardState(false), c), ctx);
show('DASHBOARD · complete', (c) => frames.renderDashboard(dashboardState(true), c), ctx);
show('RESULTS', (c) => frames.renderResults(RESULTS, c), ctx);
show(
  'ERROR',
  (c) => frames.renderError({ message: 'net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/', durationMs: 4200 }, c),
  ctx,
);

/* ------------------------------------------------------------ size matrix */

const SIZES = [
  [100, 34],
  [90, 30],
  [78, 30],
  [78, 28],
  [78, 24],
  [70, 24],
  [60, 24],
  [52, 20],
];

const screens = {
  target: (c) => frames.renderWizard(wizardState('target'), c),
  destination: (c) => frames.renderWizard(wizardState('destination'), c),
  profile: (c) => frames.renderWizard(wizardState('profile'), c),
  custom: (c) => frames.renderWizard(wizardState('custom'), c),
  review: (c) => frames.renderWizard(wizardState('review'), c),
  dashboard: (c) => frames.renderDashboard(dashboardState(false), c),
  'dashboard-done': (c) => frames.renderDashboard(dashboardState(true), c),
  results: (c) => frames.renderResults(RESULTS, c),
};

for (const [w, h] of SIZES) {
  const c = { width: w, height: h, version: '1.0.0' };
  for (const [name, render] of Object.entries(screens)) {
    show(`matrix · ${name}`, render, c);
  }
}

console.log(`\n${problems ? `${problems} layout problem(s)` : 'layout OK'}`);
process.exit(problems ? 1 : 0);
