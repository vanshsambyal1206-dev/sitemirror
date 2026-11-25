'use strict';

const { truncateAnsi } = require('./theme');

/**
 * Alternate-screen renderer. Frames are written in a single chunk with
 * absolute cursor addressing, so resizing or partial frames never tear.
 */
class Screen {
  constructor({ stdout = process.stdout, stdin = process.stdin } = {}) {
    this.out = stdout;
    this.in = stdin;
    this.active = false;
    this._resizeHandlers = new Set();
    this._onResize = () => {
      for (const fn of this._resizeHandlers) fn(this.columns, this.rows);
    };
  }

  get columns() {
    return Math.max(40, this.out.columns || 80);
  }

  get rows() {
    return Math.max(12, this.out.rows || 24);
  }

  get contentWidth() {
    return Math.max(40, Math.min(100, this.columns - 2));
  }

  get indent() {
    return Math.max(1, Math.floor((this.columns - this.contentWidth) / 2));
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.out.write('\x1b[0m\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H');
    this.out.on?.('resize', this._onResize);
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.out.write('\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
    this.out.off?.('resize', this._onResize);
  }

  onResize(fn) {
    this._resizeHandlers.add(fn);
    return () => this._resizeHandlers.delete(fn);
  }

  /**
   * lines: array of styled strings (no trailing newline)
   * cursor: { line, col } (0-based, within the content block) or null
   */
  render(lines, cursor = null) {
    if (!this.active) return;
    const maxRows = this.rows - 1;
    const visible = lines.slice(0, maxRows);
    const pad = ' '.repeat(this.indent);
    let buf = '';
    for (let i = 0; i < visible.length; i++) {
      buf += `\x1b[${i + 1};1H\x1b[2K${pad}${truncateAnsi(visible[i], this.contentWidth)}`;
    }
    buf += `\x1b[${visible.length + 1};1H\x1b[J`;
    if (cursor && cursor.line !== null && cursor.line !== undefined) {
      const row = Math.min(visible.length, Math.max(1, cursor.line + 1));
      const col = this.indent + Math.max(0, cursor.col) + 1;
      buf += `\x1b[?25h\x1b[${row};${col}H`;
    } else {
      buf += '\x1b[?25l';
    }
    this.out.write(buf);
  }

  clear() {
    if (!this.active) return;
    this.out.write('\x1b[2J\x1b[H');
  }
}

module.exports = { Screen };
