'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { launchBrowser, newContext, settle, describeError, isBotChallenge, resolveViewports } = require('./launcher');
const { Crawler } = require('./crawler');
const { Interceptor } = require('./interceptor');
const { CaptureWriter } = require('./capture-writer');
const { Manifest } = require('./manifest');
const { MirrorProxy } = require('./proxy');
const { DiffEngine } = require('./diff-engine');
const { PreviewServer } = require('./server');
const { exportStatic, finalizeExport } = require('./static-export');
const { generateReport } = require('../report/generator');
const authWall = require('../checks/auth-wall');
const dynamicApi = require('../checks/dynamic-api');
const wasmSocket = require('../checks/wasm-socket');
const assetCompleteness = require('../checks/asset-completeness');
const { ensureDir, pageSlug, humanBytes, hostOf, sleep } = require('./util');

async function runMirror({ rootUrl, outDir, options = {}, emit = () => {}, open = true }) {
  const startedAt = Date.now();
  const url = new URL(rootUrl);
  const domain = url.host;

  // Normalise defaults so programmatic callers get the same behaviour as the CLI.
  options = {
    maxPages: 40,
    delay: 700,
    respectRobots: true,
    clickNav: true,
    clickBudget: 10,
    timeout: 30000,
    maxAssetBytes: 64 * 1024 * 1024,
    // The visual diff is expensive and runs last, after capture and export.
    // It is opt-in: --diff / options.diff === true.
    diff: false,
    diffMaxPages: 10,
    // A portable static tree is written next to the replay archive. It costs
    // seconds and no network, so it is on by default.
    export: true,
    exportLayout: 'pretty',
    exportLink: false,
    ...options,
  };
  const viewports = options.viewports && options.viewports.length ? options.viewports : resolveViewports('default');
  options.viewports = viewports;
  options.diffViewports = options.diffViewports || viewports;

  // Windows forbids : < > " / \ | ? * in directory names — ports and IPv6 need sanitising.
  const domainDir = domain.replace(/[<>:"/\\|?*\s]/g, '_');
  const archiveRoot = path.join(outDir, domainDir);
  const exportDir = options.exportDir ? path.resolve(options.exportDir) : path.join(archiveRoot, '_static');
  await ensureDir(archiveRoot);

  const writer = new CaptureWriter({ archiveRoot });
  const manifest = new Manifest({ rootUrl: url.toString(), site: domain });
  manifest.setArchiveRoot(archiveRoot);

  const browser = await launchBrowser({ headless: options.headless !== false });
  let proxy = null;
  let server = null;
  let mirrorBrowser = null;

  try {
    // ---------------------------------------------------------------- crawl
    emit('crawl:start', { url: url.toString() });
    const crawler = new Crawler({
      browser,
      rootUrl: url.toString(),
      options,
      log: (m) => emit('log', m),
    });
    const crawl = await crawler.discover();
    emit('crawl:done', crawl);

    const queue = crawl.pages.slice(0, options.maxPages || crawl.pages.length);
    if (crawl.spaMode) manifest.spaMode = true;

    // -------------------------------------------------------------- capture
    emit('capture:start', { total: queue.length });
    const pageResults = [];
    const viewports = options.viewports;
    const primary = viewports[0];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      emit('capture:page', { index: i + 1, total: queue.length, url: item.url });
      const result = await capturePage({
        browser,
        item,
        viewports,
        primary,
        manifest,
        writer,
        archiveRoot,
        options,
      });
      pageResults.push(result);
      emit('capture:page:done', { index: i + 1, total: queue.length, result });
      if (options.delay) await sleep(Math.min(options.delay, 1200));
    }

    // ------------------------------------------------------------ manifest
    manifest.buildIndexes();
    await fsp.writeFile(path.join(archiveRoot, 'manifest.json'), JSON.stringify(manifest.toJSON(), null, 2), 'utf8');
    emit('capture:done', {
      total: pageResults.length,
      captured: pageResults.filter((p) => p.status === 'captured').length,
      skipped: pageResults.filter((p) => p.status === 'skipped').length,
      failed: pageResults.filter((p) => p.status === 'failed').length,
    });
    emit('assets:done', manifest.stats());

    // ---------------------------------------------------------------- proxy
    emit('proxy:start', {});
    proxy = new MirrorProxy({
      manifest,
      options: {
        missPolicy: options.allowLiveFallback ? 'passthrough' : '404',
        spaFallback: true,
        mitmAll: false,
      },
      log: (m) => emit('log', m),
    });
    await proxy.start();
    emit('proxy:done', { port: proxy.port });

    // --------------------------------------------------------------- export
    // Runs before the visual diff: the diff is the final, optional check.
    let exportResult = null;
    let exportError = null;
    if (options.export !== false) {
      emit('export:start', { outDir: exportDir });
      try {
        exportResult = await exportStatic({
          archiveRoot,
          outDir: exportDir,
          layout: options.exportLayout,
          link: !!options.exportLink,
          log: (m) => emit('log', m),
        });
        emit('export:done', exportResult);
      } catch (err) {
        exportError = describeError(err);
        emit('export:failed', { error: exportError });
      }
    } else {
      emit('export:skip', {});
    }

    // ----------------------------------------------------------------- diff
    let diffResults = [];
    let localBrowser = null;
    if (options.diff) {
      emit('diff:start', { pages: Math.min(options.diffMaxPages, pageResults.filter((p) => p.status === 'captured').length) });
      // Browser-level proxy: context-level proxies are not applied to
      // WebSockets, so an offline replay could still open live sockets.
      localBrowser = await launchBrowser({
        headless: options.headless !== false,
        proxy: { server: `http://127.0.0.1:${proxy.port}` },
        ignoreCertErrors: true,
      });
      const engine = new DiffEngine({
        browser,
        localBrowser,
        manifest,
        proxyUrl: `http://127.0.0.1:${proxy.port}`,
        options: {
          viewports: options.diffViewports || viewports,
          maskSelectors: options.maskSelectors || [],
          maskRects: options.maskRects || [],
          maxPages: options.diffMaxPages,
          timeout: options.timeout,
          insecure: !!options.insecure,
        },
        log: (m) => emit('log', m),
      });
      diffResults = await engine.run(pageResults.filter((p) => p.status === 'captured'));
      if (localBrowser) {
        await localBrowser.close().catch(() => {});
        localBrowser = null;
      }
      const scores = diffResults.map((d) => d.average).filter((n) => typeof n === 'number');
      emit('diff:done', {
        score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
        pages: diffResults.length,
      });

      // Persist the winning document strategy per page so both the proxy and
      // the preview server replay each page the way it actually renders best.
      const changedPages = [];
      for (const d of diffResults) {
        const page = manifest.pages.find((p) => p.url === d.url);
        if (!page) continue;
        const modes = Object.values(d.viewports || {})
          .map((v) => v && v.documentMode)
          .filter(Boolean);
        if (!modes.length) continue;
        const beforeMode = page.documentMode;
        const rawWins = modes.filter((m) => m === 'raw').length;
        page.documentMode = rawWins >= modes.length / 2 ? 'raw' : 'snapshot';
        if (beforeMode !== page.documentMode) changedPages.push(page.url);
        const pr = pageResults.find((p) => p.url === d.url);
        if (pr) pr.documentMode = page.documentMode;
      }
      await fsp.writeFile(path.join(archiveRoot, 'manifest.json'), JSON.stringify(manifest.toJSON(), null, 2), 'utf8');

      // The diff may have flipped a page from raw to snapshot (or back). Re-export
      // only those pages; assets are already in place and are not touched.
      if (exportResult && changedPages.length) {
        emit('export:redo', { pages: changedPages.length });
        try {
          const redo = await exportStatic({
            archiveRoot,
            outDir: exportDir,
            layout: options.exportLayout,
            link: !!options.exportLink,
            pages: changedPages,
            overwrite: false,
            log: (m) => emit('log', m),
          });

          // A partial export only reports the pages it rewrote. Merge it into
          // the full pass so the session and the report describe the whole site.
          const seen = new Set(
            (exportResult.unresolvedRefs || []).map((u) => `${u.page}\u0000${u.file}\u0000${u.ref}`),
          );
          const refs = [...(exportResult.unresolvedRefs || [])];
          for (const u of redo.unresolvedRefs || []) {
            const key = `${u.page}\u0000${u.file}\u0000${u.ref}`;
            if (seen.has(key)) continue;
            seen.add(key);
            refs.push(u);
          }

          const merged = {
            ...exportResult,
            pages: redo.pages,
            assets: redo.assets,
            rewritten: exportResult.rewritten + redo.rewritten,
            cssRewritten: exportResult.cssRewritten + redo.cssRewritten,
            durationMs: exportResult.durationMs + redo.durationMs,
            generatedAt: new Date().toISOString(),
            unresolvedRefs: refs,
            unresolved: refs.length,
          };
          const written = await finalizeExport({
            outDir: exportDir,
            report: { ...merged, unresolved: refs },
            recountBytes: true,
          });
          merged.bytes = written.bytes;
          merged.notesPath = written.notesPath;
          merged.reportPath = written.reportPath;
          exportResult = merged;
          emit('export:done', exportResult);
        } catch (err) {
          exportError = describeError(err);
          emit('export:failed', { error: exportError });
        }
      }
    } else {
      emit('diff:skip', {});
    }

    // --------------------------------------------------------------- report
    const report = await generateReport({
      manifest,
      pageResults,
      diffResults,
      crawl,
      meta: {
        durationMs: Date.now() - startedAt,
        viewportCount: viewports.length,
        diffRequested: !!options.diff,
        export: exportResult,
        exportError,
        proxy: { port: proxy.port, pac: proxy.pacUrl() },
      },
    });
    emit('report:done', { report });

    // ----------------------------------------------------------- local server
    server = new PreviewServer({ manifest, proxy, port: options.port || 0 });
    const serverInfo = await server.start();
    emit('server:done', serverInfo);

    // ------------------------------------------------------------ open tabs
    if (open && options.open !== false) {
      try {
        // Launch-time proxy so WebSockets are intercepted too, not bypassed.
        mirrorBrowser = await launchBrowser({
          headless: false,
          proxy: { server: `http://127.0.0.1:${proxy.port}` },
        });
        const ctx = await mirrorBrowser.newContext({
          viewport: { width: 1440, height: 900 },
          ignoreHTTPSErrors: true,
        });
        const page = await ctx.newPage();
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        emit('browser:mirror-opened', {});
      } catch {
        mirrorBrowser = null;
      }
      openExternal(url.toString());
      openExternal(`${serverInfo.url}/__report/`);
    }

    return {
      archiveRoot,
      exportDir,
      exportResult,
      exportError,
      manifest,
      report,
      diffResults,
      pageResults,
      crawl,
      proxy,
      server,
      serverUrl: server ? server.url : `http://127.0.0.1:${proxy.port}`,
      reportUrl: server ? `${server.url}/__report/` : null,
      mirrorBrowser,
      durationMs: Date.now() - startedAt,
      async close() {
        if (mirrorBrowser) await mirrorBrowser.close().catch(() => {});
        if (server) await server.stop();
        if (proxy) await proxy.stop();
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    if (localBrowser) await localBrowser.close().catch(() => {});
    await browser.close().catch(() => {});
    if (proxy) await proxy.stop().catch(() => {});
    if (server) await server.stop().catch(() => {});
    throw err;
  }
}

async function capturePage({ browser, item, viewports, primary, manifest, writer, archiveRoot, options }) {
  const context = await newContext(browser, { viewport: primary, ignoreHTTPSErrors: !!options.insecure });
  const page = await context.newPage();
  const interceptor = new Interceptor({ manifest, writer, pageUrl: item.url, options });
  interceptor.attach(page);
  interceptor.attachContext(context);

  const slug = pageSlug(item.url);
  const screenshots = {};
  let status = 'captured';
  let title = '';
  let file = null;
  let skipReason = null;
  let responseStatus = item.status || 0;
  let responseHeaders = {};

  try {
    let res = null;
    try {
      res = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: options.timeout });
    } catch (err) {
      const reason = describeError(err);
      await interceptor.drain();
      return failedResult({ item, slug, reason, checks: defaultChecks(reason), manifest });
    }
    if (res) {
      responseStatus = res.status();
      responseHeaders = res.headers();
    }

    // Raw server HTML: replaying this lets the site's own scripts rebuild the
    // page exactly once. The rendered-DOM snapshot is kept as the fallback for
    // pages whose content only exists after client-side hydration.
    let rawFile = null;
    if (res && responseStatus < 400) {
      try {
        const rawHtml = await res.text();
        if (rawHtml && rawHtml.length > 40) {
          rawFile = await writer.writeText(path.posix.join('_raw', slug), rawHtml).then(() => path.posix.join('_raw', slug));
        }
      } catch {
        /* raw body unavailable — snapshot-only page */
      }
    }

    const challenge = isBotChallenge(responseStatus, responseHeaders);
    if (challenge) {
      await interceptor.drain();
      return failedResult({
        item,
        slug,
        reason: `capture failed — possible bot protection (${challenge})`,
        checks: defaultChecks(`bot protection: ${challenge}`, 'red'),
        note: 'Standard Playwright browser was blocked. No evasion attempted.',
        manifest,
      });
    }

    await settle(page, { timeout: options.timeout });

    const dom = await page
      .evaluate(() => ({
        hasPasswordField: !!document.querySelector('input[type="password"]'),
        hasForm: !!document.querySelector('form'),
        textLength: (document.body && document.body.innerText ? document.body.innerText.length : 0) || 0,
        title: document.title || '',
      }))
      .catch(() => ({ hasPasswordField: false, hasForm: false, textLength: 0, title: '' }));
    title = dom.title;

    const auth = authWall.run({
      url: item.url,
      finalUrl: page.url(),
      status: responseStatus,
      headers: responseHeaders,
      dom,
    });

    if (auth.skip) {
      await interceptor.drain();
      manifest.addPage({
        url: item.url,
        slug,
        file: null,
        title,
        status: 'skipped',
        discoveryMethod: item.discoveryMethod,
        skipReason: auth.detail,
        capturedAt: new Date().toISOString(),
      });
      return {
        url: item.url,
        slug,
        file: null,
        title,
        status: 'skipped',
        discoveryMethod: item.discoveryMethod,
        skipReason: auth.detail,
        checks: {
          authWall: auth,
          dynamicApi: null,
          wasmSocket: null,
          assetCompleteness: null,
        },
        screenshots: {},
      };
    }

    // Multi-viewport passes: resize the live page, let responsive assets load,
    // screenshot for the report. No extra navigation.
    for (const vp of viewports) {
      try {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(450);
        await settle(page, { timeout: Math.min(options.timeout, 12000), scroll: false, quiet: 400 });
        const shot = await page.screenshot({ fullPage: false, animations: 'disabled', caret: 'hide' });
        const rel = `report/screenshots/${slug.replace(/\.html$/i, '')}-${vp.name}.png`;
        await writer.saveArtifact(rel, shot);
        screenshots[vp.name] = rel;
      } catch {
        /* a missing secondary screenshot never blocks capture */
      }
    }

    await page.setViewportSize({ width: primary.width, height: primary.height }).catch(() => {});
    await page.waitForTimeout(300);

    const html = await page.content();
    const saved = await writer.savePage({ url: item.url, html, extraMeta: { viewport: primary.name } });
    file = saved.file;

    await interceptor.drain();

    const summary = interceptor.summary();
    const checks = {
      authWall: auth,
      dynamicApi: dynamicApi.run({ apiBodies: interceptor.apiSamples }),
      wasmSocket: wasmSocket.run({ wasmModules: summary.wasm, websockets: interceptor.ws }),
      assetCompleteness: assetCompleteness.run({
        requested: summary.requested,
        saved: summary.saved,
        failures: summary.failures,
      }),
    };

    if (summary.failures.length) {
      // Failures are already recorded on the manifest by the interceptor; this
      // keeps the per-page summary for the report.
    }

    manifest.addPage({
      url: item.url,
      slug,
      file,
      rawFile,
      documentMode: rawFile ? 'raw' : 'snapshot',
      title,
      status: 'captured',
      discoveryMethod: item.discoveryMethod,
      statusCode: responseStatus,
      capturedAt: new Date().toISOString(),
      screenshots,
      checks,
      assetSummary: { requested: summary.requested, saved: summary.saved, failed: summary.failed, bytes: summary.bytes },
    });

    return {
      url: item.url,
      slug,
      file,
      rawFile,
      documentMode: rawFile ? 'raw' : 'snapshot',
      title,
      status: 'captured',
      discoveryMethod: item.discoveryMethod,
      checks,
      screenshots,
      assetSummary: summary,
    };
  } catch (err) {
    await interceptor.drain().catch(() => {});
    return failedResult({ item, slug, reason: describeError(err), checks: defaultChecks(describeError(err)), manifest });
  } finally {
    await context.close().catch(() => {});
  }
}

function failedResult({ item, slug, reason, checks, note, manifest }) {
  if (manifest) {
    manifest.addPage({
      url: item.url,
      slug,
      file: null,
      title: '',
      status: 'failed',
      discoveryMethod: item.discoveryMethod,
      skipReason: note || reason,
      failureReason: reason,
      capturedAt: new Date().toISOString(),
    });
  }
  return {
    url: item.url,
    slug,
    file: null,
    title: '',
    status: 'failed',
    discoveryMethod: item.discoveryMethod,
    skipReason: note || reason,
    failureReason: reason,
    checks,
    screenshots: {},
  };
}

function defaultChecks(reason, force = 'red') {
  return {
    authWall: { check: 'auth-wall', status: 'green', detail: 'no auth wall detected' },
    dynamicApi: null,
    wasmSocket: null,
    assetCompleteness: { check: 'asset-completeness', status: force, detail: reason },
  };
}

function openExternal(target) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* opening a tab is a nicety, not a requirement */
  }
}

module.exports = { runMirror, openExternal };
