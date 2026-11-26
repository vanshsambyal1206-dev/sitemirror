'use strict';

/**
 * Pure frame renderers. Each function returns { lines, cursor } and never
 * touches the terminal, which keeps layout testable and previewable.
 */

const T = require('./theme');
const { glyphs: G, paint, bold, dim, underline, inverse, box, rule, progressBar, rightAlign, padEnd } = T;

const MARGIN = '  ';

/* ------------------------------------------------------------------- logo */

const GLYPHS = {
  S: ['█████', '█    ', '█████', '    █', '█████'],
  I: ['█████', '  █  ', '  █  ', '  █  ', '█████'],
  T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  O: ['█████', '█   █', '█   █', '█   █', '█████'],
};

const WORDMARK = 'SITEMIRROR';
const BANNER = [0, 1, 2, 3, 4].map((row) =>
  WORDMARK.split('')
    .map((ch) => GLYPHS[ch][row])
    .join(' '),
);
const BANNER_WIDTH = BANNER[0].length;

function bannerLines(width) {
  const out = [];
  BANNER.forEach((row, i) => {
    const falloff = T.LIGHT_BG ? 1 : 1 - Math.abs(i - 2) * 0.1;
    let line = MARGIN;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === ' ') {
        line += ' ';
        continue;
      }
      const hex = T.mix(T.PALETTE.accent, T.PALETTE.accent2, x / (row.length - 1));
      line += paint(T.brighten(hex, falloff), ch);
    }
    out.push(line);
  });
  return out;
}

function compactMark() {
  return `${MARGIN}${paint('accent', G.sigil)} ${gradientWord('SITEMIRROR')}`;
}

function gradientWord(word) {
  return T.gradient(word, 'accent', 'accent2');
}

function headerLines(width, height, version) {
  const out = [''];
  const roomy = height >= 30 && width >= BANNER_WIDTH + 4;
  if (roomy) {
    out.push(...bannerLines(width));
    const left = `${MARGIN}${paint('muted', 'OFFLINE MIRROR ENGINE')}${paint('faint', '  ·  public surfaces only')}`;
    out.push(rightAlign(left, paint('faint', `v${version}`), width));
  } else {
    const left = `${compactMark()}  ${paint('faint', 'offline mirror engine')}`;
    out.push(rightAlign(left, paint('faint', `v${version}`), width));
  }
  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  return out;
}

/* ------------------------------------------------------------- primitives */

function wrapPlain(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fieldRow(label, valuePlain, valueColor, maxValue) {
  const l = paint('faint', label.padEnd(12));
  const v = paint(valueColor, T.ellipsisEnd(String(valuePlain), Math.max(8, maxValue)));
  return l + v;
}

function hintLine(items, width = Infinity) {
  let list = items.slice();
  let text = T.hint(list);
  // Narrow terminals lose the least important hint first — the first key always stays.
  while (list.length > 1 && T.visibleWidth(text) + MARGIN.length > width) {
    list = list.slice(0, -1);
    text = T.hint(list);
  }
  return `${MARGIN}${text}`;
}

/**
 * Row-budget guard. Drops blank spacers from the bottom up (never above the
 * cursor) and, as a last resort, keeps the footer line instead of the middle.
 */
function squeeze(lines, budget, protectBefore = 0) {
  if (!Number.isFinite(budget) || lines.length <= budget) return lines;
  const out = lines.slice();
  for (let i = out.length - 1; i >= 0 && out.length > budget; i--) {
    if (out[i] === '' && i > protectBefore) out.splice(i, 1);
  }
  if (out.length > budget) {
    const tail = out[out.length - 1];
    return out.slice(0, Math.max(1, budget - 1)).concat(tail);
  }
  return out;
}

function inputField(value, cursor, width, placeholder) {
  const inner = width - 4; // border + 1 pad each side
  const max = Math.max(4, inner - 2);
  let text = value;
  let offset = cursor;
  if (value.length > max) {
    let start = 0;
    if (cursor > max - 1) start = cursor - max + 1;
    text = value.slice(start, start + max);
    offset = cursor - start;
    if (start > 0) {
      text = G.ellipsis + text.slice(1);
      offset = cursor - start;
    }
  }
  if (!value) {
    return {
      content: `${paint('accent', G.arrow)} ${paint('faint', placeholder)}`,
      offset: 0,
    };
  }
  return {
    content: `${paint('accent', G.arrow)} ${paint('ink', text)}`,
    offset,
  };
}

function statusLine(kind, text, width) {
  const mark = kind === 'ok' ? paint('accent', G.check) : kind === 'warn' ? paint('warn', '!') : paint('faint', G.sep);
  return `${MARGIN}${mark} ${paint(kind === 'ok' ? 'muted' : kind === 'warn' ? 'warn' : 'faint', T.ellipsisEnd(text, width - 4))}`;
}

/* ----------------------------------------------------------------- wizard */

const STEP_LABELS = {
  target: 'TARGET',
  destination: 'OUTPUT',
  profile: 'PROFILE',
  custom: 'OPTIONS',
  review: 'REVIEW',
};

function visibleSteps(state) {
  return state.profile === 'custom'
    ? ['target', 'destination', 'profile', 'custom', 'review']
    : ['target', 'destination', 'profile', 'review'];
}

function stepRail(steps, current, width) {
  const parts = steps.map((id, i) => {
    const label = STEP_LABELS[id];
    if (i < current) return `${paint('accent', G.check)} ${paint('muted', label)}`;
    if (i === current) return `${paint('accent', G.caret)} ${bold(paint('ink', label))}`;
    return `${paint('faint', G.ring)} ${paint('faint', label)}`;
  });
  const sep = paint('line', '   ');
  const full = MARGIN + parts.join(sep);
  if (T.visibleWidth(full) <= width) return full;

  // Narrow terminal: keep the order visible as numbered stops.
  const compact = steps
    .map((id, i) => {
      const num = String(i + 1).padStart(2, '0');
      if (i < current) return paint('accent', num);
      if (i === current) return bold(paint('ink', `[${num}]`));
      return paint('faint', num);
    })
    .join(paint('line', ' '));
  return MARGIN + compact;
}

function stepTitle(steps, current, width) {
  const total = String(steps.length).padStart(2, '0');
  const num = String(current + 1).padStart(2, '0');
  return `${MARGIN}${paint('faint', 'STEP')} ${paint('accent', num)} ${paint('faint', `/ ${total}`)}   ${paint('line', G.sep)}   ${bold(paint('muted', STEP_LABELS[steps[current]]))}`;
}

function profileItems() {
  return [
    {
      id: 'recon',
      name: 'RECON',
      desc: '12 pages · desktop · no visual diff',
      eta: '~1 min',
    },
    {
      id: 'standard',
      name: 'STANDARD',
      desc: '40 pages · 3 viewports · static export',
      eta: '~4 min',
    },
    {
      id: 'deep',
      name: 'DEEP',
      desc: '120 pages · 3 viewports · static export',
      eta: '~15 min',
    },
    {
      id: 'custom',
      name: 'CUSTOM',
      desc: 'set every knob yourself',
      eta: '',
    },
  ];
}

function renderWizard(state, ctx) {
  const width = ctx.width;
  const height = ctx.height;
  const steps = visibleSteps(state);
  const current = Math.max(0, steps.indexOf(state.step));
  const out = [];
  const cursor = { line: null, col: 0 };

  out.push(...headerLines(width, height, ctx.version));
  out.push('');
  out.push(stepRail(steps, current, width));
  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  out.push('');
  out.push(stepTitle(steps, current, width));

  const roomy = height >= 24;
  const boxWidth = width - MARGIN.length;
  const tall = height >= 30;

  // The review screen is the densest one — drop a spacer so it still fits a 24-row terminal.
  if (state.step !== 'review' || tall) out.push('');

  if (state.step === 'target') {
    if (roomy) {
      out.push(`${MARGIN}${paint('muted', 'Paste the address of the site you want to mirror.')}`);
      out.push(`${MARGIN}${paint('faint', 'It is crawled as a normal visitor — public pages only.')}`);
      out.push('');
    }
    const { content, offset } = inputField(state.target, state.targetCursor, boxWidth, 'https://example.com');
    const lines = box({ width: boxWidth, title: 'TARGET URL', lines: [content] });
    out.push(MARGIN + lines[0]);
    const contentIndex = out.length;
    out.push(MARGIN + lines[1]);
    out.push(MARGIN + lines[2]);
    cursor.line = contentIndex;
    cursor.col = MARGIN.length + 2 + 2 + offset;

    const check = state.targetCheck;
    if (!check || !check.ok) {
      out.push(statusLine('hint', check && check.reason ? check.reason : 'https:// is assumed if you omit the scheme', width));
    } else {
      const tail = state.outPreview ? `  ${G.sep}  archive → ${state.outPreview}` : '';
      out.push(statusLine('ok', `${check.host}${tail}`, width));
    }
    out.push('');
    out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
    out.push(hintLine([['⏎', 'continue'], ['esc', 'quit']], width));
    return { lines: squeeze(out, height - 1, cursor.line), cursor };
  }

  if (state.step === 'destination') {
    if (roomy) {
      out.push(`${MARGIN}${paint('muted', 'Where the archive should live.')}`);
      out.push(`${MARGIN}${paint('faint', 'The site gets its own subfolder inside this root.')}`);
      out.push('');
    }
    const { content, offset } = inputField(state.out, state.outCursor, boxWidth, './archive');
    const lines = box({ width: boxWidth, title: 'OUTPUT ROOT', lines: [content] });
    out.push(MARGIN + lines[0]);
    const contentIndex = out.length;
    out.push(MARGIN + lines[1]);
    out.push(MARGIN + lines[2]);
    cursor.line = contentIndex;
    cursor.col = MARGIN.length + 2 + 2 + offset;

    if (state.pathInfo) {
      const info = state.pathInfo;
      const free = info.free ? `  ${G.sep}  ${info.free} free` : '';
      out.push(statusLine(info.ok ? 'ok' : 'warn', `${info.display}${free}`, width));
      if (info.note) out.push(statusLine('hint', info.note, width));
    } else {
      out.push(statusLine('hint', 'relative paths resolve from the current directory', width));
    }
    out.push('');
    out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
    out.push(hintLine([['⏎', 'continue'], ['esc', 'back'], ['ctrl+c', 'abort']], width));
    return { lines: squeeze(out, height - 1, cursor.line), cursor };
  }

  if (state.step === 'profile') {
    if (roomy) {
      out.push(`${MARGIN}${paint('muted', 'Pick how hard the mirror should work.')}`);
      out.push('');
    }
    const items = profileItems();
    items.forEach((item, i) => {
      const active = i === state.profileIndex;
      const selected = item.id === state.profile;
      const radio = selected ? G.dot : G.ring;
      const caret = active ? paint('accent', G.arrow) : ' ';
      const name = active ? bold(paint('ink', item.name)) : paint(selected ? 'muted' : 'faint', item.name);
      const descColor = active ? 'ink' : 'faint';
      const leadLen = 2 + 1 + 1 + 1 + 1 + 9 + 2; // margin, caret, gap, radio, gap, name, gap
      const etaLen = item.eta.length;
      const descMax = Math.max(10, width - leadLen - etaLen - 2);
      const desc = T.ellipsisEnd(item.desc, descMax);
      const row =
        `${MARGIN}${caret} ${paint(selected ? 'accent' : 'faint', radio)} ` +
        padEnd(name, 9) +
        '  ' +
        paint(descColor, padEnd(desc, descMax)) +
        (etaLen ? `  ${paint('faint', item.eta)}` : '');
      out.push(row);
    });
    out.push('');
    if (state.profile === 'custom') {
      out.push(`${MARGIN}${paint('faint', 'Custom opens a second panel of switches.')}`);
      out.push('');
    }
    out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
    out.push(hintLine([['↑↓', 'select'], ['⏎', 'continue'], ['esc', 'back']], width));
    return { lines: squeeze(out, height - 1, cursor.line), cursor };
  }

  if (state.step === 'custom') {
    if (tall) {
      out.push(`${MARGIN}${paint('muted', 'Tune the capture.')} ${paint('faint', 'Values are written to the run, not saved globally.')}`);
      out.push('');
    }
    const rows = state.optionRows;
    const labelWidth = Math.max(12, Math.min(20, width - 34));
    const valueMax = Math.max(10, width - MARGIN.length - 4 - labelWidth);
    rows.forEach((row, i) => {
      const active = i === state.optionIndex;
      const caret = active ? paint('accent', G.arrow) : ' ';
      const labelText = padEnd(T.ellipsisEnd(row.label, labelWidth), labelWidth);
      const label = active ? bold(paint('ink', labelText)) : paint('muted', labelText);
      let value;
      if (row.type === 'bool') {
        value = row.value
          ? `${paint('accent', `${G.dot} ON`)}`
          : `${paint('faint', `${G.ring} OFF`)}`;
      } else {
        const arrow = active ? paint('accent', G.arrows.l) : paint('faint', G.arrows.l);
        const arrow2 = active ? paint('accent', G.arrows.r) : paint('faint', G.arrows.r);
        const shown = T.ellipsisEnd(row.display, valueMax - 4);
        value = `${arrow} ${paint(active ? 'ink' : 'muted', shown)} ${arrow2}`;
      }
      out.push(`${MARGIN}${caret} ${label}${value}`);
    });
    out.push('');
    out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
    out.push(
      hintLine([['↑↓', 'move'], ['←→', 'change'], ['space', 'toggle'], ['⏎', 'review'], ['esc', 'back']], width),
    );
    return { lines: squeeze(out, height - 1, cursor.line), cursor };
  }

  // review
  const c = state.config;
  if (tall) {
    out.push(`${MARGIN}${paint('muted', 'Everything is staged. The crawler starts on launch.')}`);
    out.push('');
  }
  const cardWidth = boxWidth;
  const innerW = cardWidth - 4;
  const row = (label, value, color) => fieldRow(label, value, color, innerW - 12);
  const card = box({
    width: cardWidth,
    title: 'RUN CONFIGURATION',
    lines: [
      row('TARGET', c.target, 'ink'),
      row('ARCHIVE', c.archivePreview, 'muted'),
      row('PROFILE', c.profileLabel, 'ink'),
      row('AUDIT', c.auditLabel, 'muted'),
      ...(height >= 24 ? [row('ENGINE', `${c.engineLabel}  ${T.glyphs.sep}  ${c.etaLabel}`, 'muted')] : []),
    ],
  });
  out.push(...card.map((l) => MARGIN + l));
  const cta = ` ${G.arrow}   LAUNCH MIRROR `;
  const pad = Math.max(0, boxWidth - 2 - cta.length);
  const ctaTop = paint('accent', G.tl + G.h.repeat(boxWidth - 2) + G.tr);
  const ctaBottom = paint('accent', G.bl + G.h.repeat(boxWidth - 2) + G.br);
  out.push(MARGIN + ctaTop);
  out.push(MARGIN + paint('accent', G.v) + T.onAccent(cta + ' '.repeat(pad)) + paint('accent', G.v));
  out.push(MARGIN + ctaBottom);
  out.push('');
  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  out.push(hintLine([['⏎', 'launch'], ['esc', 'back'], ['ctrl+c', 'abort']], width));
  return { lines: squeeze(out, height - 1), cursor };
}

/* -------------------------------------------------------------- dashboard */

const PHASES = [
  { id: 'crawl', label: 'CRAWL' },
  { id: 'capture', label: 'CAPTURE' },
  { id: 'prepare', label: 'PREPARE' },
  { id: 'export', label: 'EXPORT' },
  { id: 'diff', label: 'DIFF' },
  { id: 'report', label: 'REPORT' },
  { id: 'serve', label: 'SERVE' },
];

const PHASE_LABEL_WIDTH = 8;

function spinnerFrame() {
  const frames = G.spinner;
  return frames[Math.floor(Date.now() / 90) % frames.length];
}

function meter() {
  if (!T.UNICODE) return '~~~~~~';
  const t = Date.now() / 220;
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];
  let out = '';
  for (let i = 0; i < 6; i++) {
    const v = (Math.sin(t + i * 0.9) + 1) / 2;
    out += chars[Math.min(chars.length - 1, Math.floor(v * chars.length))];
  }
  return out;
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function humanBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function phaseMark(status) {
  if (status === 'done') return paint('accent', G.check);
  if (status === 'failed') return paint('danger', G.cross);
  if (status === 'active') return paint('accent', spinnerFrame());
  return paint('faint', G.ring);
}

function renderDashboard(state, ctx) {
  const width = ctx.width;
  const out = [];
  const now = Date.now();
  const elapsed = now - state.startedAt;
  const failed = state.error;
  const ledColor = failed ? 'danger' : state.finished ? 'accent2' : 'accent';
  const mode = failed ? 'FAILED' : state.finished ? 'COMPLETE' : state.phaseLabel || 'STARTING';

  const clock = paint('muted', formatClock(elapsed));
  const modeText = paint(ledColor, bold(mode));
  const meterText = paint('faint', meter());
  const rightBase = `${clock}  ${modeText}`;
  const rightWithMeter = `${meterText}  ${rightBase}`;
  const right = T.visibleWidth(rightWithMeter) + MARGIN.length + 22 <= width ? rightWithMeter : rightBase;
  const prefixPlain = `${MARGIN}${G.dot} SITEMIRROR   `;
  const hostMax = Math.max(4, width - T.visibleWidth(right) - 1 - T.visibleWidth(prefixPlain));
  const left =
    `${MARGIN}${paint(ledColor, G.dot)} ${bold(paint('ink', 'SITEMIRROR'))}   ` +
    `${paint('muted', T.ellipsisEnd(state.host, hostMax))}`;
  out.push(rightAlign(left, right, width));
  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  out.push('');

  PHASES.forEach((phase) => {
    const p = state.phases[phase.id] || { status: 'pending', detail: '' };
    const label = padEnd(phase.label, PHASE_LABEL_WIDTH);
    const glyph = phaseMark(p.status);
    const labelStyled =
      p.status === 'active'
        ? bold(paint('ink', label))
        : paint(p.status === 'done' ? 'muted' : p.status === 'failed' ? 'danger' : 'faint', label);

    let detail = p.detail || '';
    if (phase.id === 'capture' && p.status === 'active') {
      const frac = state.captureTotal ? state.captureDone / state.captureTotal : 0;
      const barWidth = Math.min(18, Math.max(8, width - 54));
      const pct = `${Math.round(frac * 100)}%`.padStart(4);
      detail =
        `${progressBar(frac, barWidth)} ${paint('ink', pct)}  ` +
        `${paint('muted', `${state.captureDone}/${state.captureTotal} pages`)}` +
        `${state.assetsSaved && width >= 74 ? paint('faint', `  ${G.sep}  ${state.assetsSaved} assets`) : ''}`;
    } else {
      detail = paint(
        p.status === 'active' ? 'muted' : p.status === 'done' ? 'muted' : 'faint',
        T.ellipsisEnd(detail, width - 14),
      );
    }

    out.push(`${MARGIN} ${glyph}  ${labelStyled}${detail}`);
  });

  out.push('');
  if (state.currentUrl) {
    const label = paint('accent', G.caret);
    out.push(`${MARGIN} ${label} ${paint('faint', T.ellipsisEnd(state.currentUrl, width - 5))}`);
    out.push('');
  }

  const stats = state.stats;
  const cells = [
    ['PAGES', `${stats.pagesCaptured}/${stats.pagesTotal || '—'}`],
    ['ASSETS', `${stats.assetsSaved}`],
    ['DATA', humanBytes(stats.bytes)],
    ['MATCH', stats.fidelity === null || stats.fidelity === undefined ? '—' : `${Math.round(stats.fidelity * 100)}%`],
  ];
  const cell = (label, value) => `${paint('faint', label)}  ${bold(paint('ink', value))}`;
  const statsRow = (list) => `${MARGIN}${list.map(([l, v]) => cell(l, v)).join(paint('line', '   ·   '))}`;
  // Narrow terminals shed the least important counters rather than wrap.
  while (cells.length > 1 && T.visibleWidth(statsRow(cells)) > width) cells.pop();
  out.push(statsRow(cells));

  const logCount = Math.max(0, Math.min(5, ctx.height - 22));
  if (logCount > 0 && state.log.length) {
    out.push('');
    out.push(`${MARGIN}${paint('faint', 'ACTIVITY')}`);
    const tail = state.log.slice(-logCount);
    for (const line of tail) {
      out.push(`${MARGIN}${paint('line', G.sep)} ${paint('faint', T.ellipsisEnd(T.stripAnsi(line), width - 5))}`);
    }
  }

  out.push('');
  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  const hints = failed
    ? [['any key', 'exit']]
    : [['ctrl+c', 'abort']];
  out.push(hintLine(hints, width));

  return { lines: squeeze(out, ctx.height - 1), cursor: null };
}

/* ---------------------------------------------------------------- results */

function renderResults(data, ctx) {
  const width = ctx.width;
  const out = [];
  const boxWidth = width - MARGIN.length;
  const stats = data.stats;
  const summary = data.summary || {};

  const headlineLeft = ` ${paint('accent', G.check)}  ${bold(paint('ink', 'MIRROR COMPLETE'))}`;
  const headlineRight =
    `${paint('muted', formatClock(data.durationMs))}  ${paint('line', G.sep)}  ` +
    `${paint('muted', humanBytes(stats.assetsBytes))}  `;
  const headline = box({
    width: boxWidth,
    borderColor: 'accent',
    lines: [rightAlign(headlineLeft, headlineRight, boxWidth - 4)],
  });
  out.push('');
  out.push(...headline.map((l) => MARGIN + l));
  out.push('');

  const overall = summary.overall;
  const visual = summary.visual && summary.visual.score;
  const assetsFailed = summary.assets ? (summary.assets.failed || 0) + (summary.assets.originFailures || 0) : 0;
  if (typeof overall === 'number') {
    const barWidth = Math.min(28, Math.max(12, boxWidth - 30));
    out.push(
      `${MARGIN}${paint('faint', 'OVERALL'.padEnd(11))}` +
        `${progressBar(overall, barWidth)}  ${bold(paint('accent', `${Math.round(overall * 100)}%`))}`,
    );
    const bits = [];
    if (typeof visual === 'number') bits.push(`visual ${Math.round(visual * 100)}%`);
    bits.push(`pages ${stats.pagesCaptured}/${Math.max(1, stats.pagesTotal - stats.pagesSkipped)}`);
    bits.push(`assets ${stats.assetsSaved}/${stats.assetsSaved + assetsFailed}`);
    out.push(`${MARGIN}${paint('faint', bits.join(`  ${G.sep}  `))}`);
  } else {
    out.push(`${MARGIN}${paint('warn', 'OVERALL'.padEnd(11))}${paint('warn', 'not scored — visual comparison produced no result')}`);
  }
  out.push('');

  const skipped = stats.pagesSkipped;
  const failedPages = stats.pagesFailed;
  const captureNote = [
    `${stats.pagesCaptured} captured`,
    skipped ? `${skipped} auth-walled` : null,
    failedPages ? `${failedPages} failed` : null,
  ]
    .filter(Boolean)
    .join(` ${G.sep} `);
  out.push(`${MARGIN}${paint('faint', 'CAPTURE'.padEnd(11))}${paint('muted', captureNote)}`);

  out.push(
    `${MARGIN}${paint('faint', 'ASSETS'.padEnd(11))}${paint('muted', `${stats.assetsSaved} saved`)}` +
      (assetsFailed ? paint('faint', `  ${G.sep}  ${assetsFailed} unavailable`) : ''),
  );
  out.push(`${MARGIN}${paint('faint', 'ARCHIVE'.padEnd(11))}${paint('muted', T.ellipsisStart(data.archiveRoot, boxWidth - 14))}`);
  if (data.exportDir && data.exportResult) {
    out.push(`${MARGIN}${paint('faint', 'STATIC'.padEnd(11))}${paint('muted', T.ellipsisStart(data.exportDir, boxWidth - 14))}`);
    if (data.exportResult.unresolved) {
      out.push(
        `${MARGIN}${paint('warn', '!')} ${paint('faint', T.ellipsisEnd(`${data.exportResult.unresolved} reference(s) still point at the live site — see EXPORT-NOTES.md`, width - 5))}`,
      );
    }
  } else if (data.exportError) {
    out.push(
      `${MARGIN}${paint('warn', 'STATIC'.padEnd(11))}${paint('warn', T.ellipsisEnd('export failed — see the report', width - 14))}`,
    );
  }
  out.push('');

  const liveLines = [
    `${paint('faint', 'MIRROR'.padEnd(9))}${paint('accent', data.serverUrl || '—')}`,
    `${paint('faint', 'REPORT'.padEnd(9))}${paint('accent', data.reportUrl || '—')}`,
  ];
  if (data.proxyPort) {
    liveLines.push(
      `${paint('faint', 'REPLAY'.padEnd(9))}${paint('muted', `proxy 127.0.0.1:${data.proxyPort}`)}` +
        paint('faint', `  ${G.sep}  PAC at /__proxy.pac`),
    );
  }
  out.push(...box({ width: boxWidth, title: 'LIVE', borderColor: 'line', lines: liveLines }).map((l) => MARGIN + l));
  out.push('');

  const notes = [];
  if (skipped) notes.push(`${skipped} page${skipped === 1 ? '' : 's'} skipped behind a login wall — out of scope, listed in the report.`);
  if (failedPages) notes.push(`${failedPages} page${failedPages === 1 ? '' : 's'} failed to capture — reasons are in the report.`);
  if (notes.length) {
    for (const note of notes.slice(0, 2)) {
      out.push(`${MARGIN}${paint('warn', '!')} ${paint('faint', T.ellipsisEnd(note, width - 5))}`);
    }
    out.push('');
  }

  if (data.notice) {
    out.push(`${MARGIN}${paint('accent', G.check)} ${paint('muted', T.ellipsisEnd(data.notice, width - 5))}`);
    out.push('');
  }

  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  out.push(
    hintLine(
      [
        ['⏎', 'open report'],
        ['c', 'copy report url'],
        ['q', 'stop & exit'],
      ],
      width,
    ),
  );
  return { lines: squeeze(out, ctx.height - 1), cursor: null };
}

/* ------------------------------------------------------------------ error */

function renderError(data, ctx) {
  const width = ctx.width;
  const out = [];
  const boxWidth = width - MARGIN.length;
  out.push('');
  const headlineLeft = ` ${paint('danger', G.cross)}  ${bold(paint('ink', 'CAPTURE FAILED'))}`;
  const headline = box({
    width: boxWidth,
    borderColor: 'danger',
    lines: [rightAlign(headlineLeft, paint('faint', formatClock(data.durationMs || 0)), boxWidth - 4)],
  });
  out.push(...headline.map((l) => MARGIN + l));
  out.push('');
  const msgLines = wrapPlain(data.message || 'Unknown failure.', boxWidth - 6).slice(0, 5);
  for (const line of msgLines) out.push(`${MARGIN}${paint('ink', line)}`);
  out.push('');
  out.push(`${MARGIN}${paint('faint', 'Try:')}`);
  const hints = [
    '--headed to watch the capture browser',
    '--insecure for self-signed TLS',
    'confirm the site loads in a normal browser',
    'a bot challenge is recorded, never evaded',
  ];
  for (const h of hints) out.push(`${MARGIN}${paint('line', G.sep)} ${paint('faint', T.ellipsisEnd(h, width - 5))}`);
  out.push('');
  out.push(`${MARGIN}${rule(width - MARGIN.length)}`);
  out.push(hintLine([['any key', 'exit']], width));
  return { lines: squeeze(out, ctx.height - 1), cursor: null };
}

module.exports = {
  renderWizard,
  renderDashboard,
  renderResults,
  renderError,
  visibleSteps,
  profileItems,
  wrapPlain,
  formatClock,
  humanBytes,
  PHASES,
  BANNER_WIDTH,
};
