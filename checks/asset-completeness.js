'use strict';

/**
 * Asset completeness: diff what the page requested against what actually landed
 * on disk, and explain every failure by class.
 */

const REASON_LABELS = {
  'CORS blocked': 'CORS blocked',
  timeout: 'timed out',
  'connection refused': 'connection refused',
  'DNS failure': 'DNS failure',
  'TLS certificate error': 'TLS error',
  aborted: 'aborted',
  'network error': 'network error',
  'body unavailable': 'body unavailable',
  'page closed before body': 'page closed early',
};

function run({ requested = 0, saved = 0, failures = [] } = {}) {
  const total = Math.max(requested, saved + failures.length);
  const mirrorFailures = failures.filter((f) => !f.origin);
  const originFailures = failures.filter((f) => f.origin);
  const failed = mirrorFailures.length;
  if (total === 0) {
    return { check: 'asset-completeness', status: 'green', detail: 'no subresources requested', meta: { total, saved, failed } };
  }
  if (failed === 0) {
    const originNote = originFailures.length
      ? ` · ${originFailures.length} URL(s) already return an error on the live site`
      : '';
    return {
      check: 'asset-completeness',
      status: 'green',
      detail: `${saved}/${total} assets saved${originNote}`,
      meta: { total, saved, failed: 0, originFailures: originFailures.length },
    };
  }

  const byReason = new Map();
  for (const f of mirrorFailures) {
    const label = REASON_LABELS[f.reason] || f.reason || 'unknown';
    byReason.set(label, (byReason.get(label) || 0) + 1);
  }
  const reasonText = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([r, n]) => `${n}× ${r}`)
    .join(', ');

  const ratio = failed / total;
  const status = ratio > 0.05 ? 'red' : 'yellow';
  const originNote = originFailures.length ? `; ${originFailures.length} more already fail on the live site` : '';
  return {
    check: 'asset-completeness',
    status,
    detail: `${saved}/${total} assets saved; ${failed} failed (${reasonText})${originNote}`,
    meta: {
      total,
      saved,
      failed,
      byReason: Object.fromEntries(byReason),
      failures: mirrorFailures.slice(0, 50),
      originFailures: originFailures.length,
    },
  };
}

module.exports = { name: 'asset-completeness', run };
