'use strict';

/**
 * Raw-mode key reader. Emits normalized keys:
 *   { name: 'char', ch } | { name: 'enter' | 'escape' | 'backspace' | ... }
 *
 * Handles chunked escape sequences, bracketed-paste markers, and the fact that
 * Windows terminals can deliver a multi-byte sequence split across reads.
 */
function createKeyReader(stream = process.stdin) {
  const handlers = new Set();
  let started = false;
  let pending = '';
  let escTimer = null;
  let onData = null;

  function emit(key) {
    for (const fn of [...handlers]) {
      try {
        fn(key);
      } catch {
        /* a broken handler must not kill input */
      }
    }
  }

  function armEscape(delay = 30) {
    if (escTimer) return;
    escTimer = setTimeout(() => {
      escTimer = null;
      if (pending === '\x1b' || pending === '\x1b[' || pending === '\x1bO') {
        pending = '';
        emit({ name: 'escape' });
      } else {
        parse();
      }
    }, delay);
    escTimer.unref?.();
  }

  function emitChar(ch) {
    if (ch === '\r' || ch === '\n') return emit({ name: 'enter' });
    if (ch === '\x7f' || ch === '\b') return emit({ name: 'backspace' });
    if (ch === '\t') return emit({ name: 'tab' });
    if (ch === '\x03') return emit({ name: 'ctrl-c' });
    if (ch === '\x15') return emit({ name: 'ctrl-u' });
    if (ch === '\x17') return emit({ name: 'ctrl-w' });
    if (ch === '\x01') return emit({ name: 'home' });
    if (ch === '\x05') return emit({ name: 'end' });
    if (ch < ' ') return;
    emit({ name: 'char', ch });
  }

  function handleCsi(code, final) {
    const dirs = { A: 'up', B: 'down', C: 'right', D: 'left' };
    if (dirs[final]) return emit({ name: dirs[final], ctrl: /(?:^|;)5(?:;|$)/.test(code) });
    if (final === 'H') return emit({ name: 'home' });
    if (final === 'F') return emit({ name: 'end' });
    if (final === 'Z') return emit({ name: 'tab', shift: true });
    if (final === '~') {
      const n = parseInt(String(code).split(';')[0], 10);
      if (n === 1 || n === 7) return emit({ name: 'home' });
      if (n === 3) return emit({ name: 'delete' });
      if (n === 4 || n === 8) return emit({ name: 'end' });
      if (n === 5) return emit({ name: 'pageup' });
      if (n === 6) return emit({ name: 'pagedown' });
      if (n === 200 || n === 201) return;
    }
  }

  function parse() {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    while (pending.length) {
      if (pending[0] !== '\x1b') {
        const idx = pending.indexOf('\x1b');
        const text = idx === -1 ? pending : pending.slice(0, idx);
        pending = idx === -1 ? '' : pending.slice(idx);
        for (const ch of text) emitChar(ch);
        continue;
      }
      if (pending.length === 1) {
        armEscape();
        return;
      }
      // Bracketed paste markers — swallow, keep the body as ordinary chars.
      if (pending.startsWith('\x1b[200~')) {
        pending = pending.slice(6);
        continue;
      }
      if (pending.startsWith('\x1b[201~')) {
        pending = pending.slice(6);
        continue;
      }
      if (pending === '\x1b[' || pending === '\x1bO') {
        armEscape(60);
        return;
      }
      const m = /^\x1b(?:\[|O)([0-9;]*)([A-Za-z~])/.exec(pending);
      if (m) {
        pending = pending.slice(m[0].length);
        handleCsi(m[1], m[2]);
        continue;
      }
      // Unknown/corrupt sequence: consume the ESC, keep the rest.
      pending = pending.slice(1);
      emit({ name: 'escape' });
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      onData = (chunk) => {
        pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        parse();
      };
      try {
        stream.setEncoding?.('utf8');
        if (stream.isTTY && stream.setRawMode) stream.setRawMode(true);
        stream.resume();
      } catch {
        /* non-TTY: the UI refuses to start before this point anyway */
      }
      stream.on('data', onData);
      stream.on('error', () => {});
    },
    stop() {
      if (!started) return;
      started = false;
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      if (onData) stream.removeListener('data', onData);
      try {
        if (stream.isTTY && stream.setRawMode) stream.setRawMode(false);
      } catch {
        /* ignore */
      }
    },
    onKey(fn) {
      handlers.add(fn);
      return () => handlers.delete(fn);
    },
    get active() {
      return started;
    },
  };
}

module.exports = { createKeyReader };
