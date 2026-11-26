'use strict';

/**
 * Unit tests for the static export rewriters.
 *
 *   node _fixtures/unit-export.js
 *
 * Pure functions only: no browser, no network, no archive on disk.
 */

const assert = require('node:assert/strict');
const { Manifest } = require('../core/manifest');
const { rewriteHtml, rewriteCss, parseTag, pageOutputPath } = require('../core/static-export');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}

/** Minimal export context: a real manifest plus the output map export uses. */
function makeCtx({ pages = [], assets = [], layout = 'pretty' } = {}) {
  const manifest = new Manifest({ rootUrl: 'https://example.test/', site: 'example.test' });
  const byUrl = new Map();
  for (const page of pages) {
    manifest.addPage({ url: page.url, file: page.file, status: 'captured', title: 't' });
    byUrl.set(page.url, { type: 'page', outRel: page.outRel, entry: manifest.pages.at(-1) });
  }
  for (const asset of assets) {
    manifest.addAsset({ url: asset.url, ok: true, file: asset.file, kind: asset.kind || 'other' });
    byUrl.set(asset.url, { type: 'asset', outRel: asset.file, entry: manifest.assets.at(-1) });
  }
  return {
    manifest,
    archiveRoot: '.',
    target: '.',
    layout,
    byUrl,
    used: new Set(),
    pageOut: new Map(pages.map((p) => [p.url, p.outRel])),
    currentPageUrl: '',
    currentOutRel: '',
    unresolved: [],
    unresolvedSeen: new Set(),
    stats: { rewritten: 0, assets: 0, pages: 0, bytes: 0, cssRewritten: 0 },
  };
}

const BASE_CTX = () =>
  makeCtx({
    pages: [
      { url: 'https://example.test/about', file: 'about.html', outRel: 'about/index.html' },
      { url: 'https://example.test/', file: 'index.html', outRel: 'index.html' },
    ],
    assets: [
      { url: 'https://example.test/styles.css', file: 'assets/css/styles.css', kind: 'css' },
      { url: 'https://example.test/img/logo.png', file: 'assets/images/logo.png', kind: 'image' },
    ],
  });

/* ------------------------------------------------------------------- html */

test('html: root-relative and absolute refs become relative', () => {
  const ctx = BASE_CTX();
  const html =
    '<link rel="stylesheet" href="/styles.css">' +
    '<img src="https://example.test/img/logo.png">' +
    '<a href="/about">About</a>';
  const out = rewriteHtml(html, ctx, 'https://example.test/', 'index.html');

  assert.match(out, /href="assets\/css\/styles.css"/);
  assert.match(out, /src="assets\/images\/logo.png"/);
  assert.match(out, /href="about\/"/);
  assert.equal(ctx.unresolved.length, 0);
});

test('html: refs are relative to a nested page', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml('<img src="/img/logo.png">', ctx, 'https://example.test/about', 'about/index.html');
  assert.match(out, /src="\.\.\/assets\/images\/logo.png"/);
});

test('html: srcset candidates are rewritten, descriptors preserved', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml(
    '<img srcset="/img/logo.png 1x, https://example.test/img/logo.png 2x">',
    ctx,
    'https://example.test/',
    'index.html',
  );
  assert.match(out, /srcset="assets\/images\/logo\.png 1x, assets\/images\/logo\.png 2x"/);
});

test('html: inline style and <style> url() are rewritten', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml(
    '<div style="background:url(\'/img/logo.png\')"></div><style>.a{background:url(/img/logo.png)}</style>',
    ctx,
    'https://example.test/',
    'index.html',
  );
  assert.match(out, /style="background:url\('assets\/images\/logo\.png'\)"/);
  assert.match(out, /\.a\{background:url\(assets\/images\/logo\.png\)\}/);
});

test('html: og:image meta content is rewritten', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml(
    '<meta property="og:image" content="/img/logo.png">',
    ctx,
    'https://example.test/',
    'index.html',
  );
  assert.match(out, /content="assets\/images\/logo\.png"/);
});

test('html: uncaptured refs are left untouched and recorded', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml(
    '<a href="/login">Sign in</a><img src="/missing.png">',
    ctx,
    'https://example.test/',
    'index.html',
  );
  assert.match(out, /href="\/login"/);
  assert.match(out, /src="\/missing\.png"/);
  assert.deepEqual(
    ctx.unresolved.map((u) => u.ref).sort(),
    ['/login', '/missing.png'],
  );
});

test('html: data:, mailto:, tel:, # and javascript: are never touched', () => {
  const ctx = BASE_CTX();
  const html =
    '<img src="data:image/png;base64,AAA">' +
    '<a href="mailto:a@b.test">mail</a>' +
    '<a href="tel:+100">call</a>' +
    '<a href="#top">top</a>' +
    '<a href="javascript:void(0)">x</a>';
  const out = rewriteHtml(html, ctx, 'https://example.test/', 'index.html');
  assert.equal(out, html);
  assert.equal(ctx.unresolved.length, 0);
});

test('html: <base> is dropped so relative paths cannot be re-based', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml('<head><base href="https://cdn.example.test/x/"></head>', ctx, 'https://example.test/', 'index.html');
  assert.doesNotMatch(out, /<base/i);
  assert.match(out, /<head><\/head>/);
});

test('html: comments and raw text are preserved verbatim', () => {
  const ctx = BASE_CTX();
  const html = '<!-- <a href="/login">x</a> --><script>var s = "<img src=/missing.png>";</script>';
  const out = rewriteHtml(html, ctx, 'https://example.test/', 'index.html');
  assert.equal(out, html);
  assert.equal(ctx.unresolved.length, 0);
});

test('html: fragments survive a rewrite', () => {
  const ctx = BASE_CTX();
  const out = rewriteHtml('<a href="/about#team">Team</a>', ctx, 'https://example.test/', 'index.html');
  assert.match(out, /href="about\/#team"/);
});

/* -------------------------------------------------------------------- css */

test('css: url(), quoted url() and @import are rewritten', () => {
  const ctx = BASE_CTX();
  const css =
    '@import url("/styles.css");' +
    '@import "https://example.test/styles.css";' +
    '.a{background:url(/img/logo.png)}' +
    ".b{background:url('/img/logo.png')}";
  const out = rewriteCss(css, ctx, 'https://example.test/styles.css', 'assets/css/styles.css');

  assert.match(out, /@import url\("styles\.css"\)/);
  assert.match(out, /@import "styles\.css"/);
  assert.match(out, /\.a\{background:url\(\.\.\/images\/logo\.png\)\}/);
  assert.match(out, /\.b\{background:url\('\.\.\/images\/logo\.png'\)\}/);
});

test('css: strings, comments and data: urls are not rewritten', () => {
  const ctx = BASE_CTX();
  const css =
    '/* url(/img/logo.png) */' +
    '.a{content:"url(/img/logo.png)"}' +
    '.b{background:url(data:image/png;base64,AAA)}';
  const out = rewriteCss(css, ctx, 'https://example.test/styles.css', 'assets/css/styles.css');
  assert.equal(out, css);
  assert.equal(ctx.stats.rewritten, 0);
});

test('css: unrelated url() prefixes are not matched', () => {
  const ctx = BASE_CTX();
  const css = '.a{background:myurl(/img/logo.png)}';
  const out = rewriteCss(css, ctx, 'https://example.test/styles.css', 'assets/css/styles.css');
  assert.equal(out, css);
});

/* ------------------------------------------------------------------ parse */

test('parseTag: quoted > does not end the tag', () => {
  const html = '<div data-x="a>b" class="c">';
  const tag = parseTag(html, 0);
  assert.equal(tag.name, 'div');
  assert.equal(tag.end, html.length);
  assert.equal(tag.attrs.find((a) => a.name === 'data-x').valueStart, html.indexOf('a>b'));
});

test('parseTag: unquoted value and valueless attribute', () => {
  const html = '<input disabled value=on>';
  const tag = parseTag(html, 0);
  assert.equal(tag.attrs.length, 2);
  assert.equal(tag.attrs[0].name, 'disabled');
  assert.equal(tag.attrs[0].valueStart, -1);
  assert.equal(tag.attrs[1].name, 'value');
});

test('parseTag: self-closing slash is recognised', () => {
  const tag = parseTag('<br/>', 0);
  assert.equal(tag.selfClosing, true);
  assert.equal(tag.end, 5);
});

/* ----------------------------------------------------------------- layout */

test('layout: pretty paths use directories, flat uses single files', () => {
  const pretty = makeCtx();
  assert.equal(pageOutputPath(pretty, 'https://example.test/'), 'index.html');
  assert.equal(pageOutputPath(pretty, 'https://example.test/about'), 'about/index.html');
  assert.equal(pageOutputPath(pretty, 'https://example.test/docs/readme.html'), 'docs/readme.html');
  assert.match(pageOutputPath(pretty, 'https://example.test/search?q=x'), /^search-[0-9a-f]{6}\/index\.html$/);

  const flat = makeCtx({ layout: 'flat' });
  assert.equal(pageOutputPath(flat, 'https://example.test/about'), 'about.html');
  assert.equal(pageOutputPath(flat, 'https://example.test/docs/readme.html'), 'docs-readme.html');
});

test('layout: colliding paths get a deterministic suffix', () => {
  const ctx = makeCtx();
  assert.equal(pageOutputPath(ctx, 'https://example.test/about'), 'about/index.html');
  assert.equal(pageOutputPath(ctx, 'http://example.test/about'), 'about/index-2.html');
  assert.equal(pageOutputPath(ctx, 'https://example.test/about/'), 'about/index-3.html');
});

/* ----------------------------------------------------------------- summary */

console.log(`\n${passed}/${passed + failures.length} unit checks passed`);
if (failures.length) process.exitCode = 1;
