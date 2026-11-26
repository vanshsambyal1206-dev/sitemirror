'use strict';

/**
 * End-to-end harness: runs the full pipeline against the local fixture and exits.
 *   node _fixtures/e2e.js [url] [outDir]
 */

const path = require('path');
const { runMirror } = require('../core/mirror');
const { resolveViewports } = require('../core/launcher');

async function main() {
  const url = process.argv[2] || 'http://127.0.0.1:8741';
  const outDir = path.resolve(process.argv[3] || './_test-archive');
  const maxPages = Number(process.env.MAX_PAGES || 8);
  const diffMaxPages = Number(process.env.DIFF_PAGES || 6);

  const session = await runMirror({
    rootUrl: url,
    outDir,
    open: false,
    options: {
      maxPages,
      delay: 100,
      // The diff is opt-in and runs last; this harness needs it because the
      // offline stage asserts the winning document strategy was persisted.
      diff: true,
      diffMaxPages,
      // The static export is on by default; pass it explicitly so the fixture
      // keeps testing it even if that default ever changes.
      export: true,
      clickNav: true,
      respectRobots: true,
      insecure: process.env.INSECURE === '1',
      ...(process.env.DIFF_VIEWPORTS ? { diffViewports: resolveViewports(process.env.DIFF_VIEWPORTS) } : {}),
    },
    emit: (event, payload) => {
      if (event === 'capture:page') return;
      if (event === 'log') return;
      console.log(`[${event}]`, JSON.stringify(payload, (k, v) => (k === 'report' || k === 'manifest' ? undefined : v)).slice(0, 300));
    },
  });

  const stats = session.manifest.stats();
  console.log('\n--- summary ---');
  console.log(JSON.stringify({ stats, visual: session.report.summary.visual, overall: session.report.summary.overall }, null, 2));
  console.log('pages:', session.pageResults.map((p) => `${p.status} ${p.url}`).join('\n       '));
  console.log('archive:', path.relative(process.cwd(), session.archiveRoot));
  if (session.exportResult) {
    console.log(
      'static:',
      path.relative(process.cwd(), session.exportResult.outDir),
      `(${session.exportResult.pages} pages, ${session.exportResult.assets} assets, ${session.exportResult.unresolved} unresolved)`,
    );
  } else if (session.exportError) {
    console.log('static export failed:', session.exportError);
  }

  await session.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
