'use strict';

/**
 * Terminal theme: colour modes, gradients, glyph sets and frame primitives.
 *
 * Everything here is pure string composition — no cursor movement, no I/O —
 * so the same helpers drive the live UI and the offline frame previews.
 */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(str) {
  return String(str).replace(ANSI_RE, '');
}

function visibleWidth(str) {
  // Our glyph set is single-cell; counting code points is enough and cheap.
  return [...stripAnsi(str)].length;
}

/* ------------------------------------------------------------------ colour */

const NO_COLOR = !!process.env.NO_COLOR || String(process.env.TERM || '').toLowerCase() === 'dumb';

const COLOR_MODE = (() => {
  if (NO_COLOR) return 'none';
  const forced = String(process.env.SITEMIRROR_COLOR || '').toLowerCase();
  if (forced === 'none' || forced === 'off' || forced === '0') return 'none';
  if (forced === '256') return '256';
  if (forced === 'truecolor' || forced === '24bit') return 'truecolor';
  if (forced === '16') return '16';
  if (!process.stdout.isTTY) return 'none';
  const ct = String(process.env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  if (process.env.WT_SESSION) return 'truecolor';
  if (/^(vscode|iterm|wezterm|kitty|alacritty|hyper|tabby|ghostty)/i.test(process.env.TERM_PROGRAM || '')) return 'truecolor';
  if (/256color/i.test(process.env.TERM || '')) return '256';
  return '256';
})();

const ENABLED = COLOR_MODE !== 'none';

// Light terminals get a darker ink palette so contrast survives.
const LIGHT_BG = (() => {
  const fgbg = String(process.env.COLORFGBG || '');
  if (!fgbg) return false;
  const parts = fgbg.split(';');
  const bg = Number(parts[parts.length - 1]);
  return bg === 7 || bg === 15;
})();

const DARK = {
  ink: '#dce8f5',
  muted: '#8ba0b8',
  faint: '#566b82',
  line: '#26374a',
  accent: '#2df5a8',
  accent2: '#3fc6ff',
  warn: '#ffc46b',
  danger: '#ff5f7a',
  violet: '#b18cff',
  blue: '#6aa8ff',
  white: '#f4faff',
  track: '#33475d',
};

const LIGHT = {
  ink: '#16212e',
  muted: '#4e6479',
  faint: '#8496a9',
  line: '#c9d6e3',
  accent: '#007a52',
  accent2: '#0069a8',
  warn: '#9a6100',
  danger: '#bf1f3a',
  violet: '#5b3fbf',
  blue: '#1f5fbf',
  white: '#0b1520',
  track: '#b8c6d4',
};

const PALETTE = LIGHT_BG ? LIGHT : DARK;

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]) {
  const p = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

const CUBE = [0, 95, 135, 175, 215, 255];
const ANSI16 = [
  [0, 0, 0, 30],
  [128, 0, 0, 31],
  [0, 128, 0, 32],
  [128, 128, 0, 33],
  [0, 0, 128, 34],
  [128, 0, 128, 35],
  [0, 128, 128, 36],
  [192, 192, 192, 37],
  [128, 128, 128, 90],
  [255, 0, 0, 91],
  [0, 255, 0, 92],
  [255, 255, 0, 93],
  [0, 0, 255, 94],
  [255, 0, 255, 95],
  [0, 255, 255, 96],
  [255, 255, 255, 97],
];

const colorCache = new Map();

function colorParams(hex, layer = 38) {
  if (!ENABLED) return '';
  const key = `${layer}:${hex}`;
  if (colorCache.has(key)) return colorCache.get(key);
  const [r, g, b] = hexToRgb(hex);
  let code;
  if (COLOR_MODE === 'truecolor') {
    code = `${layer};2;${r};${g};${b}`;
  } else if (COLOR_MODE === '256') {
    let best = 16;
    let bestD = Infinity;
    for (let i = 0; i < 24; i++) {
      const v = 8 + i * 10;
      const d = (r - v) ** 2 + (g - v) ** 2 + (b - v) ** 2;
      if (d < bestD) {
        bestD = d;
        best = 232 + i;
      }
    }
    for (let ri = 0; ri < 6; ri++) {
      for (let gi = 0; gi < 6; gi++) {
        for (let bi = 0; bi < 6; bi++) {
          const d = (r - CUBE[ri]) ** 2 + (g - CUBE[gi]) ** 2 + (b - CUBE[bi]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = 16 + 36 * ri + 6 * gi + bi;
          }
        }
      }
    }
    code = `${layer};5;${best}`;
  } else {
    let best = 37;
    let bestD = Infinity;
    for (const [ar, ag, ab, ac] of ANSI16) {
      const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
      if (d < bestD) {
        bestD = d;
        best = ac;
      }
    }
    code = String(best + 10);
  }
  const prefix = `\x1b[${code}m`;
  colorCache.set(key, prefix);
  return prefix;
}

function paint(color, text) {
  const str = text === undefined || text === null ? '' : String(text);
  if (!ENABLED || !str) return str;
  const hex = PALETTE[color] || (/^#[0-9a-f]{6}$/i.test(color) ? color : null);
  if (!hex) return str;
  return `${colorParams(hex, 38)}${str}\x1b[39m`;
}

function bg(color, text) {
  const str = text === undefined || text === null ? '' : String(text);
  if (!ENABLED || !str) return str;
  const hex = PALETTE[color] || (/^#[0-9a-f]{6}$/i.test(color) ? color : null);
  if (!hex) return str;
  return `${colorParams(hex, 48)}${str}\x1b[49m`;
}

const ACCENT_INK = LIGHT_BG ? '#f5fbff' : '#05130d';

/** Solid accent bar with readable ink — used for the one call-to-action. */
function onAccent(text) {
  const str = String(text ?? '');
  if (!ENABLED || !str) return str;
  return `${colorParams(PALETTE.accent, 48)}${colorParams(ACCENT_INK, 38)}${str}\x1b[39m\x1b[49m`;
}

const bold = (s) => (ENABLED && s ? `\x1b[1m${s}\x1b[22m` : String(s ?? ''));
const dim = (s) => (ENABLED && s ? `\x1b[2m${s}\x1b[22m` : String(s ?? ''));
const italic = (s) => (ENABLED && s ? `\x1b[3m${s}\x1b[23m` : String(s ?? ''));
const underline = (s) => (ENABLED && s ? `\x1b[4m${s}\x1b[24m` : String(s ?? ''));
const inverse = (s) => (ENABLED && s ? `\x1b[7m${s}\x1b[27m` : String(s ?? ''));

function mix(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]);
}

function brighten(hex, factor) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * factor, g * factor, b * factor]);
}

/** Per-character horizontal gradient. Falls back to a flat accent when colour is off. */
function gradient(text, from = 'accent', to = 'accent2', opts = {}) {
  const str = String(text ?? '');
  if (!ENABLED || !str) return str;
  const a = PALETTE[from] || from;
  const b = PALETTE[to] || to;
  const chars = [...str];
  const denom = Math.max(1, chars.length - 1);
  let out = '';
  chars.forEach((ch, i) => {
    if (ch === ' ') {
      out += ch;
      return;
    }
    const hex = mix(a, b, i / denom);
    out += `${colorParams(hex, 38)}${ch}`;
  });
  const body = `${out}\x1b[39m`;
  return opts.bold === false ? body : bold(body);
}

/* ------------------------------------------------------------------ glyphs */

const UNICODE = (() => {
  const forced = String(process.env.SITEMIRROR_ASCII || '').toLowerCase();
  if (forced === '1' || forced === 'true' || forced === 'yes') return false;
  if (process.platform !== 'win32') return true;
  if (process.env.WT_SESSION) return true;
  if (/^(vscode|iterm|wezterm|kitty|alacritty|hyper|tabby|ghostty)/i.test(process.env.TERM_PROGRAM || '')) return true;
  if (/256color/i.test(process.env.TERM || '')) return true;
  return false;
})();

const glyphs = UNICODE
  ? {
      tl: '╭',
      tr: '╮',
      bl: '╰',
      br: '╯',
      h: '─',
      v: '│',
      dot: '●',
      ring: '○',
      check: '✔',
      cross: '✖',
      arrow: '❯',
      caret: '▸',
      barFull: '▰',
      barEmpty: '▱',
      sep: '·',
      ellipsis: '…',
      sigil: '▚',
      arrows: { l: '‹', r: '›' },
      spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    }
  : {
      tl: '+',
      tr: '+',
      bl: '+',
      br: '+',
      h: '-',
      v: '|',
      dot: '*',
      ring: 'o',
      check: '+',
      cross: 'x',
      arrow: '>',
      caret: '>',
      barFull: '#',
      barEmpty: '-',
      sep: '.',
      ellipsis: '...',
      sigil: '#',
      arrows: { l: '<', r: '>' },
      spinner: ['|', '/', '-', '\\'],
    };

/* ------------------------------------------------------------------ layout */

function padEnd(str, width) {
  const gap = width - visibleWidth(str);
  return gap > 0 ? str + ' '.repeat(gap) : String(str);
}

function padStart(str, width) {
  const gap = width - visibleWidth(str);
  return gap > 0 ? ' '.repeat(gap) + str : String(str);
}

/** Left-truncate a plain path, keeping the tail visible. */
function ellipsisStart(text, max) {
  const str = String(text);
  if (str.length <= max) return str;
  if (max <= 1) return glyphs.ellipsis;
  return `${glyphs.ellipsis}${str.slice(str.length - (max - 1))}`;
}

function ellipsisEnd(text, max) {
  const str = String(text);
  if (str.length <= max) return str;
  if (max <= 1) return glyphs.ellipsis;
  return `${str.slice(0, max - 1)}${glyphs.ellipsis}`;
}

function truncateAnsi(str, max) {
  if (visibleWidth(str) <= max) return str;
  const plain = stripAnsi(str);
  return plain.slice(0, Math.max(0, max - 1)) + glyphs.ellipsis;
}

function box({ width, title = '', titleColor = 'accent', borderColor = 'line', lines = [], padX = 1 }) {
  const w = Math.max(12, width);
  const inner = Math.max(1, w - 2 - padX * 2);
  const b = (s) => paint(borderColor, s);
  const out = [];
  if (title) {
    const label = ` ${title} `;
    const fill = Math.max(1, w - 3 - visibleWidth(label));
    out.push(b(glyphs.tl + glyphs.h) + paint(titleColor, label) + b(glyphs.h.repeat(fill) + glyphs.tr));
  } else {
    out.push(b(glyphs.tl + glyphs.h.repeat(w - 2) + glyphs.tr));
  }
  for (const raw of lines) {
    const line = truncateAnsi(String(raw ?? ''), inner);
    const content = padEnd(line, inner);
    out.push(`${b(glyphs.v)}${' '.repeat(padX)}${content}${' '.repeat(padX)}${b(glyphs.v)}`);
  }
  out.push(b(glyphs.bl + glyphs.h.repeat(w - 2) + glyphs.br));
  return out;
}

function rule(width, color = 'line', char = null) {
  return paint(color, (char || glyphs.h).repeat(Math.max(0, width)));
}

function progressBar(fraction, width, { color = 'accent', track = 'track' } = {}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  return (
    paint(color, glyphs.barFull.repeat(filled)) +
    paint(track, glyphs.barEmpty.repeat(Math.max(0, width - filled)))
  );
}

function rightAlign(left, right, width) {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return left + ' '.repeat(gap) + right;
}

function center(text, width) {
  const gap = Math.max(0, width - visibleWidth(text));
  const left = Math.floor(gap / 2);
  return ' '.repeat(left) + text + ' '.repeat(gap - left);
}

function hint(items, gap = '   ') {
  return items
    .map(([key, label]) => `${paint('accent', key)} ${paint('faint', label)}`)
    .join(paint('line', ` ${gap} `));
}

module.exports = {
  ENABLED,
  COLOR_MODE,
  UNICODE,
  LIGHT_BG,
  PALETTE,
  glyphs,
  stripAnsi,
  visibleWidth,
  paint,
  bg,
  onAccent,
  bold,
  dim,
  italic,
  underline,
  inverse,
  mix,
  brighten,
  gradient,
  padEnd,
  padStart,
  ellipsisStart,
  ellipsisEnd,
  truncateAnsi,
  box,
  rule,
  progressBar,
  rightAlign,
  center,
  hint,
};
