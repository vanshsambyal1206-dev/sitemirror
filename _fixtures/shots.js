const path = require('path');
const { chromium } = require('playwright');
const { Manifest } = require('../core/manifest');
const { MirrorProxy } = require('../core/proxy');
const { PreviewServer } = require('../core/server');
const { readJson } = require('../core/util');

(async () => {
  const dir = path.resolve('_test-archive/127.0.0.1_8741');
  const m = Manifest.fromJSON(await readJson(path.join(dir, 'manifest.json')), dir);
  const proxy = new MirrorProxy({ manifest: m, options: {} });
  await proxy.start();
  const server = new PreviewServer({ manifest: m, proxy });
  const info = await server.start();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(info.url + '/__report/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '_fixtures/report-shot.png', fullPage: true });
  await page.goto(info.url + '/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: '_fixtures/local-root-shot.png' });
  console.log('report + local screenshots saved');
  await browser.close();
  await server.stop();
  await proxy.stop();
})();
