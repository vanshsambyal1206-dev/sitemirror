'use strict';

/**
 * Dynamic / session-specific content check.
 *
 * Static JSON replay cannot refresh. We look for the usual tells in captured
 * XHR/fetch bodies and report them honestly instead of pretending the mirror is
 * live.
 */

const SIGNAL_KEYS = [
  'token',
  'access_token',
  'refresh_token',
  'session',
  'sessionid',
  'nonce',
  'csrf',
  'expires',
  'expires_at',
  'expiry',
  'timestamp',
  'server_time',
  'iat',
  'user_id',
  'userid',
  'email',
  'cart',
  'personal',
  'price',
  'stock',
  'availability',
];

const ISO_TS = /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function run({ apiBodies = [] } = {}) {
  if (!apiBodies.length) {
    return {
      check: 'dynamic-api',
      status: 'green',
      detail: 'no XHR/fetch data captured on this page',
      meta: { endpoints: 0 },
    };
  }

  const flagged = [];
  for (const item of apiBodies) {
    const sample = item.body || '';
    if (!sample) continue;
    const lower = sample.toLowerCase();
    const keys = new Set();
    for (const k of SIGNAL_KEYS) {
      if (lower.includes(`"${k}"`) || lower.includes(`'${k}'`)) keys.add(k);
    }
    if (ISO_TS.test(sample)) keys.add('iso-timestamp');
    if (keys.size) flagged.push({ url: item.url, signals: [...keys].slice(0, 6) });
  }

  if (!flagged.length) {
    return {
      check: 'dynamic-api',
      status: 'green',
      detail: `no session/timestamp markers in ${apiBodies.length} captured API response(s)`,
      meta: { endpoints: apiBodies.length },
    };
  }

  const examples = flagged.slice(0, 4).map((f) => `${shortPath(f.url)} (${f.signals.join(', ')})`);
  return {
    check: 'dynamic-api',
    status: 'yellow',
    detail: `dynamic/session-specific content — local copy will not update (${flagged.length}/${apiBodies.length} endpoints; ${examples.join('; ')})`,
    meta: { endpoints: apiBodies.length, flagged },
  };
}

function shortPath(url) {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    return p.length > 64 ? p.slice(0, 61) + '…' : p;
  } catch {
    return url;
  }
}

module.exports = { name: 'dynamic-api', run, SIGNAL_KEYS };
