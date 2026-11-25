'use strict';

/**
 * Live-backend dependency check: WebAssembly modules and persistent WebSockets
 * cannot be replayed from a static archive. Flagged, never faked.
 */

function run({ wasmModules = [], websockets = [] } = {}) {
  const ws = websockets.filter(Boolean);
  if (!wasmModules.length && !ws.length) {
    return {
      check: 'wasm-socket',
      status: 'green',
      detail: 'no WebAssembly or WebSocket dependency observed',
      meta: { wasm: 0, websockets: 0 },
    };
  }

  const bits = [];
  if (wasmModules.length) bits.push(`${wasmModules.length} WebAssembly module(s) (${wasmModules.map(shortest).slice(0, 3).join(', ')})`);
  if (ws.length) bits.push(`${ws.length} WebSocket connection(s) (${ws.map((w) => shortest(w.url)).slice(0, 3).join(', ')})`);

  return {
    check: 'wasm-socket',
    status: 'yellow',
    detail: `depends on live backend — may not function identically offline: ${bits.join('; ')}`,
    meta: { wasm: wasmModules, websockets: ws.map((w) => ({ url: w.url, messages: w.messages })) },
  };
}

function shortest(url) {
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname}${p}`.slice(0, 48);
  } catch {
    return String(url).slice(0, 48);
  }
}

module.exports = { name: 'wasm-socket', run };
