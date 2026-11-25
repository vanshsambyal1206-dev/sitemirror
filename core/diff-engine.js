'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { newContext, settle, describeError } = require('./launcher');
const { ensureDir, pageSlug } = require('./util');

const MAX_COMPARE_HEIGHT = 9000;

/**
 * Fidelity is scored on four signals, not just raw pixel count.
 *
 *   pixel   1 - mismatchedPixels / totalPixels          (pixelmatch)
 *   region  1 - changedTiles / totalTiles               (32x32 structure grid)
 *   text    share of the live page's words present locally
 *   height  1 - |liveHeight - localHeight| / max(...)
 *
 * A plain pixel ratio under-reports real loss: three dark cards on a dark page
 * differ in almost no pixels, so a vanished content block would still score
 * ~99%. The region and text signals catch that, and the report shows every
 * component so the number is auditable rather than magic.
 */
const FIDELITY_WEIGHTS = { pixel: 0.3, region: 0.35, text: 0.25, height: 0.1 };
const REGION_TILE = 32;
const REGION_PIXEL_DELTA = 16; // 0-255 per-channel difference that counts as visible
const REGION_TILE_FRACTION = 0.02; // share of a tile that must change to mark it changed

/**
 * Live-vs-local visual comparison.
 *
 * Both sides are rendered by the same browser engine at the same viewport, so
 * antialiasing and font hinting noise cancels out. Anything that still differs
 * is a real capture gap (or genuinely dynamic content the operator masked).
 */
class DiffEngine {
  constructor({ browser, localBrowser = null, manifest, proxyUrl, options = {}, log = () => {} }) {
    this.browser = browser;
    this.localBrowser = localBrowser;
    this.manifest = manifest;
    this.proxyUrl = proxyUrl;
    this.options = {
      maskSelectors: options.maskSelectors || [],
      maskRects: options.maskRects || [],
      threshold: options.threshold ?? 0.12,
      maxPages: options.maxPages ?? Infinity,
      timeout: options.timeout || 30000,
      viewports: options.viewports || [{ name: 'desktop', width: 1920, height: 1080 }],
      pauseAnimations: options.pauseAnimations !== false,
      insecure: !!options.insecure,
    };
    this.log = log;
    this.outDir = path.join(manifest.archiveRoot, 'report', 'diffs');
  }

  async run(pages) {
    await ensureDir(this.outDir);
    const results = [];
    let count = 0;
    for (const page of pages) {
      if (count >= this.options.maxPages) break;
      if (page.status !== 'captured') continue;
      count++;
      const result = { url: page.url, slug: page.slug, viewports: {}, average: null };
      for (const vp of this.options.viewports) {
        try {
          const vs = await this.compareOne(page, vp);
          result.viewports[vp.name] = vs;
        } catch (err) {
          result.viewports[vp.name] = {
            similarity: null,
            error: describeError(err),
          };
        }
        this.log(`  diff · ${shorten(page.url)} @ ${vp.name} → ${formatScore(result.viewports[vp.name])}`);
      }
      const scores = Object.values(result.viewports)
        .map((v) => v.similarity)
        .filter((n) => typeof n === 'number');
      result.average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      results.push(result);
    }
    return results;
  }

  async compareOne(pageEntry, vp) {
    const live = await this.captureSide(pageEntry.url, vp, { local: false });
    let mode = pageEntry.documentMode || 'raw';
    let local = await this.captureSide(pageEntry.url, vp, { local: true, mode });
    let cmp = this.compare(live.png, local.png);
    let fidelity = this.measure(live, local, cmp);

    // If replaying the site's own HTML+JS does not reproduce the page, try the
    // post-hydration DOM snapshot — and keep it only when it measurably scores
    // better. The trigger looks at structure and text, not just pixels, so a
    // missing content block cannot slip through on a low-contrast layout.
    const rawLooksWrong =
      mode === 'raw' &&
      pageEntry.rawFile &&
      (fidelity.pixel < 0.9 || fidelity.region < 0.96 || fidelity.textCoverage < 0.88);

    if (rawLooksWrong) {
      const alt = await this.captureSide(pageEntry.url, vp, { local: true, mode: 'snapshot' });
      const altCmp = this.compare(live.png, alt.png);
      const altFidelity = this.measure(live, alt, altCmp);
      if (altFidelity.score > fidelity.score + 0.01) {
        mode = 'snapshot';
        local = alt;
        cmp = altCmp;
        fidelity = altFidelity;
      }
    }

    const baseName = `${pageEntry.slug.replace(/\.html$/i, '')}-${vp.name}`;
    const liveFile = `report/diffs/${baseName}-live.png`;
    const localFile = `report/diffs/${baseName}-local.png`;
    const diffFile = `report/diffs/${baseName}-diff.png`;

    await fsp.writeFile(path.join(this.manifest.archiveRoot, liveFile), live.png);
    await fsp.writeFile(path.join(this.manifest.archiveRoot, localFile), local.png);

    const diffPng = new PNG({ width: cmp.width, height: cmp.height });
    cmp.diffImage.copy(diffPng.data);
    await fsp.writeFile(path.join(this.manifest.archiveRoot, diffFile), PNG.sync.write(diffPng));

    return {
      similarity: fidelity.score,
      fidelity,
      mismatchPixels: cmp.mismatch,
      totalPixels: cmp.width * cmp.height,
      width: cmp.width,
      height: cmp.height,
      liveHeight: live.height,
      localHeight: local.height,
      heightDeltaPct: fidelity.height === 1 ? 0 : 1 - fidelity.height,
      documentMode: mode,
      liveImage: liveFile,
      localImage: localFile,
      diffImage: diffFile,
      liveConsoleErrors: live.consoleErrors,
      localConsoleErrors: local.consoleErrors,
      localMisses: local.missCount,
    };
  }

  /** Blend the four signals into one explainable score. */
  measure(live, local, cmp) {
    const pixel = cmp.similarity;
    const region = cmp.regionSimilarity;
    const liveTokens = tokenize(live.text);
    const localTokens = tokenize(local.text);
    const overlap = multisetIntersection(liveTokens, localTokens);
    const textCoverage = liveTokens.length ? overlap / liveTokens.length : 1;
    const textSimilarity = liveTokens.length + localTokens.length
      ? (2 * overlap) / (liveTokens.length + localTokens.length)
      : 1;
    const maxHeight = Math.max(live.height, local.height, 1);
    const height = 1 - Math.abs(live.height - local.height) / maxHeight;

    const score =
      FIDELITY_WEIGHTS.pixel * pixel +
      FIDELITY_WEIGHTS.region * region +
      FIDELITY_WEIGHTS.text * textCoverage +
      FIDELITY_WEIGHTS.height * height;

    return {
      score,
      pixel,
      region,
      textCoverage,
      textSimilarity,
      height,
      liveTextChars: (live.text || '').length,
      localTextChars: (local.text || '').length,
      weights: FIDELITY_WEIGHTS,
    };
  }

  compare(bufA, bufB) {
    return comparePng(bufA, bufB, {
      threshold: this.options.threshold,
      maskRects: this.options.maskRects,
    });
  }

  async captureSide(url, vp, { local, mode = 'raw' }) {
    // Replay must use the browser launched with a browser-level proxy: Chromium
    // ignores context-level proxies for WebSockets, which would let a replay
    // reach the live backend and score as faithful.
    const browser = local ? this.localBrowser || this.browser : this.browser;
    const context = await newContext(browser, {
      viewport: vp,
      proxy: local && !this.localBrowser ? { server: this.proxyUrl } : null,
      ignoreHTTPSErrors: local || this.options.insecure,
      serviceWorkers: local ? 'block' : 'allow',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    if (local) await context.setExtraHTTPHeaders({ 'x-sitemirror-doc-mode': mode }).catch(() => {});
    const consoleErrors = [];
    const missCount = { value: 0 };

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text().slice(0, 300));
        if (consoleErrors.length > 40) consoleErrors.shift();
      }
    });
    if (local) {
      page.on('requestfailed', () => {
        missCount.value++;
      });
      page.on('response', (res) => {
        if (res.status() === 404) missCount.value++;
      });
    }

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.timeout });
      await settle(page, { timeout: this.options.timeout, quiet: 900 });
      if (this.options.pauseAnimations) {
        await page
          .evaluate(() => {
            try {
              document.getAnimations().forEach((a) => {
                try {
                  a.pause();
                } catch {
                  /* ignore */
                }
              });
            } catch {
              /* ignore */
            }
            const vids = document.querySelectorAll('video');
            vids.forEach((v) => {
              try {
                v.pause();
                v.currentTime = 0;
              } catch {
                /* ignore */
              }
            });
          })
          .catch(() => {});
        await page.waitForTimeout(400);
      }

      const metrics = await page
        .evaluate(() => ({
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
          text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 250000),
        }))
        .catch(() => ({ height: vp.height, width: vp.width, text: '' }));

      const shotOptions = {
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        timeout: this.options.timeout,
      };
      if (this.options.maskSelectors.length) {
        const locators = [];
        for (const sel of this.options.maskSelectors) {
          try {
            const loc = page.locator(sel);
            if ((await loc.count()) > 0) locators.push(loc.first());
          } catch {
            /* selector not present on this page */
          }
        }
        if (locators.length) {
          shotOptions.mask = locators.slice(0, 30);
          shotOptions.maskColor = '#ff00ff';
        }
      }

      const png = await page.screenshot(shotOptions);
      return { png, height: metrics.height, text: metrics.text, consoleErrors, missCount: missCount.value };
    } finally {
      await context.close().catch(() => {});
    }
  }
}

function comparePng(bufA, bufB, { threshold = 0.12, maskRects = [] } = {}) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height, MAX_COMPARE_HEIGHT);
  if (width === 0 || height === 0) {
    return { similarity: 0, regionSimilarity: 0, mismatch: 0, width: 0, height: 0, diffImage: Buffer.alloc(0) };
  }

  const dataA = cropPng(a, width, height);
  const dataB = cropPng(b, width, height);

  // Paint explicit mask rectangles the same flat colour on both sides.
  for (const rect of maskRects) {
    paintRect(dataA, width, height, rect, [255, 0, 255, 255]);
    paintRect(dataB, width, height, rect, [255, 0, 255, 255]);
  }

  const diff = new PNG({ width, height });
  const mismatch = pixelmatch(dataA, dataB, diff.data, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.55,
    aaColor: [255, 220, 0],
    diffColor: [255, 60, 90],
    diffColorAlt: [60, 200, 255],
  });
  return {
    similarity: 1 - mismatch / (width * height),
    regionSimilarity: regionSimilarity(dataA, dataB, width, height),
    mismatch,
    width,
    height,
    diffImage: diff.data,
  };
}

/**
 * Structural similarity: divide the frame into tiles and count how many contain
 * a perceptible change. A block of content that disappears changes a whole band
 * of tiles even when its colour is close to the page background.
 */
function regionSimilarity(dataA, dataB, width, height) {
  let changed = 0;
  let total = 0;
  for (let ty = 0; ty < height; ty += REGION_TILE) {
    const th = Math.min(REGION_TILE, height - ty);
    for (let tx = 0; tx < width; tx += REGION_TILE) {
      const tw = Math.min(REGION_TILE, width - tx);
      const area = tw * th;
      let differing = 0;
      for (let y = ty; y < ty + th; y++) {
        let i = (y * width + tx) * 4;
        for (let x = 0; x < tw; x++, i += 4) {
          if (
            Math.abs(dataA[i] - dataB[i]) > REGION_PIXEL_DELTA ||
            Math.abs(dataA[i + 1] - dataB[i + 1]) > REGION_PIXEL_DELTA ||
            Math.abs(dataA[i + 2] - dataB[i + 2]) > REGION_PIXEL_DELTA ||
            Math.abs(dataA[i + 3] - dataB[i + 3]) > REGION_PIXEL_DELTA
          ) {
            differing++;
          }
        }
      }
      total++;
      if (differing / area >= REGION_TILE_FRACTION) changed++;
    }
  }
  return total ? 1 - changed / total : 1;
}

function tokenize(text) {
  const match = String(text || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return match || [];
}

function multisetIntersection(a, b) {
  const counts = new Map();
  for (const token of b) counts.set(token, (counts.get(token) || 0) + 1);
  let hit = 0;
  for (const token of a) {
    const remaining = counts.get(token) || 0;
    if (remaining > 0) {
      hit++;
      counts.set(token, remaining - 1);
    }
  }
  return hit;
}

function cropPng(png, width, height) {
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    png.data.copy(out, y * width * 4, y * png.width * 4, y * png.width * 4 + width * 4);
  }
  return out;
}

function paintRect(data, width, height, rect, rgba) {
  const x0 = Math.max(0, Math.floor(rect.x || 0));
  const y0 = Math.max(0, Math.floor(rect.y || 0));
  const x1 = Math.min(width, Math.floor((rect.x || 0) + (rect.width || 0)));
  const y1 = Math.min(height, Math.floor((rect.y || 0) + (rect.height || 0)));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      data[i] = rgba[0];
      data[i + 1] = rgba[1];
      data[i + 2] = rgba[2];
      data[i + 3] = rgba[3];
    }
  }
}

function formatScore(v) {
  if (!v || v.similarity === null || v.similarity === undefined) return v && v.error ? `failed (${v.error})` : 'failed';
  return `${(v.similarity * 100).toFixed(1)}%`;
}

function shorten(url) {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    return `${u.host}${p === '/' ? '' : p}`.slice(0, 72);
  } catch {
    return String(url).slice(0, 72);
  }
}

module.exports = { DiffEngine, comparePng, pageSlug };
