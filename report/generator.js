'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { render } = require('./template');
const { ensureDir, humanBytes } = require('../core/util');

/**
 * Merges detection + diff results into report.json and a self-contained
 * report.html. This is the deliverable: the honest account of what survived.
 */
async function generateReport({ manifest, pageResults, diffResults = [], crawl = {}, meta = {} }) {
  const diffByUrl = new Map(diffResults.map((d) => [d.url, d]));

  const pages = pageResults.map((p) => {
    const diff = diffByUrl.get(p.url);
    const similarities = {};
    const diffs = {};
    const fidelity = {};
    if (diff) {
      for (const [vp, v] of Object.entries(diff.viewports)) {
        similarities[vp] = typeof v.similarity === 'number' ? v.similarity : null;
        if (v.fidelity) fidelity[vp] = v.fidelity;
        if (v.diffImage) diffs[vp] = { diffImage: v.diffImage, liveImage: v.liveImage, localImage: v.localImage };
        else if (v.error) diffs[vp] = { error: v.error };
      }
    }
    const checkList = Object.values(p.checks).filter(Boolean);
    const diffError = Object.values(diffs).some((d) => d && d.error);
    const hasIssues =
      p.status !== 'captured' ||
      checkList.some((c) => c.status !== 'green') ||
      diffError ||
      Object.values(similarities).some((v) => v !== null && v < 0.9);
    return {
      url: p.url,
      slug: p.slug,
      file: p.file,
      title: p.title || '',
      status: p.status,
      discoveryMethod: p.discoveryMethod || 'link',
      documentMode: p.documentMode || null,
      skipReason: p.skipReason || null,
      checks: p.checks,
      similarities,
      fidelity,
      diffs,
      screenshots: p.screenshots || {},
      similarityAverage: diff ? diff.average : null,
      hasIssues,
    };
  });

  const captured = pages.filter((p) => p.status === 'captured');
  const skipped = pages.filter((p) => p.status === 'skipped');
  const failed = pages.filter((p) => p.status === 'failed');

  const simScores = captured
    .map((p) => p.similarityAverage)
    .filter((n) => typeof n === 'number');
  const visualScore = simScores.length ? simScores.reduce((a, b) => a + b, 0) / simScores.length : null;

  const stats = manifest.stats();

  const failureKey = (f) => `${f.url}|${f.reason}`;
  const seenFailures = new Set();
  const assetFailures = [];
  for (const f of manifest.failures) {
    const key = failureKey(f);
    if (seenFailures.has(key)) continue;
    seenFailures.add(key);
    assetFailures.push({
      url: f.url,
      reason: f.reason,
      rawError: f.rawError || '',
      page: f.page,
      resourceType: f.resourceType,
      origin: !!f.origin,
      severity: f.origin ? 'muted' : 'yellow',
    });
  }
  assetFailures.sort((a, b) => String(a.reason).localeCompare(String(b.reason)));

  const byReason = {};
  for (const f of assetFailures) byReason[f.reason || 'unknown'] = (byReason[f.reason || 'unknown'] || 0) + 1;

  // Auth-walled pages are an explicit, documented exclusion — they don't count
  // against how complete the *capturable* public mirror is.
  const capturable = Math.max(1, stats.pagesTotal - stats.pagesSkipped);
  const captureRatio = stats.pagesCaptured / capturable;

  // Origin-side failures (the live site itself returns 404/500 for a URL) are
  // not mirror defects either.
  const originFailureCount = assetFailures.filter((f) => f.origin).length;
  const mirrorFailureCount = assetFailures.length - originFailureCount;
  const assetTotal = stats.assetsSaved + mirrorFailureCount;
  const assetRatio = assetTotal ? stats.assetsSaved / assetTotal : 1;

  const visualAttempts = captured.reduce((n, p) => n + Object.keys(p.similarities || {}).length, 0);
  const visualErrors = captured.reduce(
    (n, p) => n + Object.values(p.diffs || {}).filter((d) => d && d.error).length,
    0,
  );

  // A capture/asset ratio alone is not the advertised score. When nothing could
  // be compared visually the honest answer is "not measured", not a 100% ring.
  const overall = visualScore !== null ? 0.25 * captureRatio + 0.25 * assetRatio + 0.5 * visualScore : null;

  const notes = [...(crawl.notes || [])];
  if (meta.diffRequested && visualScore === null) {
    notes.push(
      visualAttempts
        ? `Visual comparison failed for all ${visualAttempts} viewport checks — see per-page errors in the report.`
        : 'Visual comparison produced no comparable pages.',
    );
  } else if (!meta.diffRequested) {
    notes.push('Visual comparison was disabled (--no-diff); capture and asset ratios are reported separately.');
  }

  const durationMs = meta.durationMs || 0;
  const report = {
    tool: 'sitemirror',
    version: 1,
    generatedAt: new Date().toISOString(),
    site: {
      domain: new URL(manifest.rootUrl).host,
      rootUrl: manifest.rootUrl,
      capturedAt: manifest.generatedAt,
      durationMs,
      durationLabel: formatDuration(durationMs),
      generatedAt: new Date().toISOString(),
      assetSize: humanBytes(stats.assetsBytes),
      spaMode: !!manifest.spaMode,
      blocked: crawl.blocked || null,
    },
    notes,
    summary: {
      overall,
      overallBasis: visualScore !== null ? 'capture 25% + assets 25% + visual 50%' : 'not scored — visual comparison produced no result',
      capture: {
        total: stats.pagesTotal,
        capturable,
        captured: stats.pagesCaptured,
        skipped: stats.pagesSkipped,
        failed: stats.pagesFailed,
        ratio: captureRatio,
      },
      assets: {
        total: assetTotal,
        requested: stats.assetsRequested,
        saved: stats.assetsSaved,
        failed: mirrorFailureCount,
        originFailures: originFailureCount,
        bytes: stats.assetsBytes,
        ratio: assetRatio,
      },
      visual: {
        score: visualScore,
        measured: visualScore !== null,
        pagesCovered: simScores.length,
        viewportChecks: visualAttempts,
        failedViewports: visualErrors,
        viewportCount: meta.viewportCount || 0,
      },
    },
    pages,
    assetFailures,
    assetFailuresByReason: byReason,
    websockets: manifest.websockets,
    wasm: manifest.wasmModules,
    writes: manifest.writes || [],
    fidelityMethod: {
      description:
        'Per-page fidelity blends four signals so a missing block cannot hide behind a low-contrast layout.',
      weights: { pixel: 0.3, region: 0.35, text: 0.25, height: 0.1 },
      pixel: 'pixelmatch mismatched-pixel ratio',
      region: '32×32 tile grid; a tile counts as changed when ≥2% of its pixels differ visibly',
      text: 'share of the live page’s words that appear in the local render',
      height: 'full-page height agreement (missing or extra content)',
    },
    proxy: meta.proxy || null,
    limitations: [
      'Authenticated content is out of scope; gated pages are skipped, never force-accessed.',
      'Real-time/server-generated content is snapshotted, not mirrored.',
      'WebSocket- and server-compute-dependent features do not function offline.',
      'Bot-protected sites may fail to load; this is recorded as an honest failure, not evaded.',
      'Cross-browser pixel differences are expected noise and are excluded from scoring.',
    ],
  };

  const dir = path.join(manifest.archiveRoot, 'report');
  await ensureDir(dir);
  await fsp.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await fsp.writeFile(path.join(dir, 'report.html'), render(report), 'utf8');

  return report;
}

function formatDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

module.exports = { generateReport };
