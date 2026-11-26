'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { Manifest } = require('./manifest');
const { normalizeUrl, pageSlug, sanitizeFilename, shortHash, ensureDir, readJson } = require('./util');

/**
 * Static export.
 *
 * The replay archive keeps every URL untouched and depends on the archive proxy
 * to answer requests for the original hostnames. That is what makes offline
 * replay faithful, but it also means the folder cannot be dropped on a plain
 * web server. This module writes a second, portable tree:
 *
 *   - raw server HTML when it won, rendered DOM only when the diff proved the
 *     snapshot renders better;
 *   - every captured reference rewritten to a relative path inside the export;
 *   - assets copied (or hardlinked) once, at their archive paths;
 *   - pages at pretty paths (`/about` → `about/index.html`) by default;
 *   - an honest EXPORT-NOTES.md listing every reference that still points at
 *     the live site.
 *
 * It reads only the archive and manifest.json. No browser, no network.
 */

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext']);
const SKIP_SCHEMES = /^(?:data|blob|mailto|tel|javascript|about|chrome|chrome-extension|file|ftp):/i;
const LINK_RELS = new Set([
  'stylesheet',
  'icon',
  'shortcut icon',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'manifest',
  'preload',
  'prefetch',
  'modulepreload',
]);
const META_IMAGE_KEYS = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
  'msapplication-tileimage',
]);

async function exportStatic({
  archiveRoot,
  outDir,
  layout = 'pretty',
  link = false,
  pages = null,
  overwrite = true,
  log = () => {},
} = {}) {
  const started = Date.now();
  if (!archiveRoot) throw new Error('exportStatic: archiveRoot is required');
  const manifestPath = path.join(archiveRoot, 'manifest.json');
  const json = await readJson(manifestPath);
  if (!json) throw new Error(`exportStatic: no manifest.json in ${archiveRoot}`);

  const manifest = Manifest.fromJSON(json, archiveRoot);
  const target = path.resolve(outDir || path.join(archiveRoot, '_static'));
  await ensureDir(target);

  const ctx = {
    manifest,
    archiveRoot,
    target,
    layout: layout === 'flat' ? 'flat' : 'pretty',
    link: !!link,
    overwrite: overwrite !== false,
    log,
    used: new Set(),
    byUrl: new Map(),
    pageOut: new Map(),
    currentPageUrl: '',
    currentOutRel: '',
    unresolved: [],
    unresolvedSeen: new Set(),
    stats: { rewritten: 0, assets: 0, pages: 0, bytes: 0, cssRewritten: 0 },
  };

  assignOutputs(ctx);
  log(`export: ${ctx.pageOut.size} page(s) → ${target}`);

  await exportAssets(ctx);
  await exportPages(ctx, pages);

  const report = buildReport(ctx, json, started);
  const written = await finalizeExport({ outDir: target, report });

  return {
    outDir: target,
    sourceArchive: report.sourceArchive,
    rootUrl: report.rootUrl,
    layout: report.layout,
    generatedAt: report.generatedAt,
    pages: report.pages,
    assets: report.assets,
    cssRewritten: report.cssRewritten,
    rewritten: report.rewritten,
    unresolved: report.unresolved.length,
    unresolvedRefs: report.unresolved,
    bytes: report.bytes,
    durationMs: report.durationMs,
    notesPath: written.notesPath,
    reportPath: written.reportPath,
  };
}

/**
 * Write EXPORT-NOTES.md and export-report.json from a finished summary.
 *
 * Exported so a partial re-export (after the visual diff flips a page's
 * document strategy) can merge its counts into the first pass and then rewrite
 * the report once, instead of leaving the partial pass's numbers on disk.
 */
async function finalizeExport({ outDir, report, recountBytes = false }) {
  const target = path.resolve(outDir);
  let bytes = report.bytes;
  if (recountBytes) bytes = await directoryBytes(target, new Set(['export-report.json']));
  const { unresolvedRefs, ...rest } = report;
  const finalReport = { ...rest, bytes };
  const notesPath = path.join(target, 'EXPORT-NOTES.md');
  const reportPath = path.join(target, 'export-report.json');
  await fsp.writeFile(notesPath, renderNotes(finalReport), 'utf8');
  await fsp.writeFile(reportPath, JSON.stringify(finalReport, null, 2), 'utf8');
  return { notesPath, reportPath, bytes };
}

async function directoryBytes(dir, skip = new Set()) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full, skip);
    else {
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) total += stat.size;
    }
  }
  return total;
}

/* ------------------------------------------------------------------ layout */

function assignOutputs(ctx) {
  for (const page of ctx.manifest.pages) {
    if (page.status !== 'captured' || !page.file) continue;
    const outRel = pageOutputPath(ctx, page.url);
    ctx.pageOut.set(page.url, outRel);
    ctx.byUrl.set(page.url, { type: 'page', outRel, entry: page });
  }
  for (const asset of ctx.manifest.assets) {
    if (!asset.ok || !asset.file) continue;
    if (!ctx.byUrl.has(asset.url)) {
      ctx.byUrl.set(asset.url, { type: 'asset', outRel: asset.file, entry: asset });
    }
  }
}

function pageOutputPath(ctx, url) {
  let rel;
  if (ctx.layout === 'flat') {
    rel = pageSlug(url);
  } else {
    let u;
    try {
      u = new URL(url);
    } catch {
      return uniquePath(ctx.used, 'index.html');
    }
    const pathname = decodeURIComponentSafe(u.pathname).replace(/^\/+|\/+$/g, '');
    if (!pathname) return uniquePath(ctx.used, 'index.html');

    const segs = pathname
      .split('/')
      .map((s) => sanitizeFilename(s, 64))
      .filter(Boolean);
    if (!segs.length) return uniquePath(ctx.used, 'index.html');

    if (u.search && u.search.length > 1) {
      segs[segs.length - 1] += `-${shortHash(u.search, 6)}`;
    }
    const last = segs[segs.length - 1];
    if (/\.html?$/i.test(last)) {
      rel = segs.join('/');
    } else {
      segs.push('index.html');
      rel = segs.join('/');
    }
  }
  return uniquePath(ctx.used, rel);
}

function uniquePath(used, rel) {
  if (!used.has(rel)) {
    used.add(rel);
    return rel;
  }
  const ext = path.posix.extname(rel);
  const stem = rel.slice(0, rel.length - ext.length);
  let i = 2;
  let candidate = `${stem}-${i}${ext}`;
  while (used.has(candidate)) {
    i++;
    candidate = `${stem}-${i}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/* ------------------------------------------------------------------ assets */

async function exportAssets(ctx) {
  // Assets are independent files. A small worker pool keeps the export I/O
  // bound instead of paying one round-trip per file, without exhausting
  // handles on large archives.
  await mapLimit(ctx.manifest.assets, 8, async (asset) => {
    if (!asset.ok || !asset.file) return;
    const src = path.join(ctx.archiveRoot, asset.file);
    const dest = path.join(ctx.target, asset.file);
    await ensureDir(path.dirname(dest));

    if (isCss(asset)) {
      // CSS rewriting is page-independent, so a partial re-export can leave
      // already-written stylesheets alone instead of rewriting every one.
      if (!ctx.overwrite && (await exists(dest))) {
        ctx.stats.assets++;
        return;
      }
      const css = await fsp.readFile(src, 'utf8');
      const rewritten = rewriteCss(css, ctx, asset.url, asset.file);
      await fsp.writeFile(dest, rewritten, 'utf8');
      ctx.stats.cssRewritten++;
      ctx.stats.bytes += Buffer.byteLength(rewritten);
    } else {
      if (!ctx.overwrite && (await exists(dest))) {
        ctx.stats.assets++;
        return;
      }
      const ok = ctx.link ? await tryLink(src, dest) : false;
      if (!ok) await fsp.copyFile(src, dest);
      const stat = await fsp.stat(dest).catch(() => null);
      ctx.stats.bytes += stat ? stat.size : asset.size || 0;
    }
    ctx.stats.assets++;
  });
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function exportPages(ctx, onlyPages) {
  const filter = Array.isArray(onlyPages) && onlyPages.length ? new Set(onlyPages) : null;
  for (const page of ctx.manifest.pages) {
    if (page.status !== 'captured' || !page.file) continue;
    if (filter && !filter.has(page.url)) continue;
    const outRel = ctx.pageOut.get(page.url);
    if (!outRel) continue;

    const rawPath = page.rawFile ? path.join(ctx.archiveRoot, page.rawFile) : null;
    const useRaw = page.documentMode !== 'snapshot' && rawPath && (await exists(rawPath));
    const src = useRaw ? rawPath : path.join(ctx.archiveRoot, page.file);
    let html = await fsp.readFile(src, 'utf8');
    // A captured DOM replayed with its own scripts re-hydrates over the captured
    // content. The proxy serves snapshots with script-src 'none'; a static file
    // needs the same guarantee in-document.
    if (!useRaw) html = injectInertCsp(html);
    const rewritten = rewriteHtml(html, ctx, page.url, outRel);

    const dest = path.join(ctx.target, outRel);
    await ensureDir(path.dirname(dest));
    await fsp.writeFile(dest, rewritten, 'utf8');
    ctx.stats.pages++;
    ctx.stats.bytes += Buffer.byteLength(rewritten);
  }
}

function injectInertCsp(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'">`;
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return meta + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + meta + html.slice(at);
}

function isCss(asset) {
  return asset.kind === 'css' || /\.css$/i.test(asset.file || '') || /text\/css/i.test(asset.contentType || '');
}

async function tryLink(src, dest) {
  try {
    await fsp.link(src, dest);
    return true;
  } catch {
    return false;
  }
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- html */

function rewriteHtml(html, ctx, pageUrl, pageOutRel) {
  ctx.currentPageUrl = pageUrl;
  ctx.currentOutRel = pageOutRel;

  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end < 0 ? html.length : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    if (html.startsWith('<![CDATA[', lt)) {
      const end = html.indexOf(']]>', lt + 9);
      const stop = end < 0 ? html.length : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?' || html[lt + 1] === '/') {
      const end = html.indexOf('>', lt);
      const stop = end < 0 ? html.length : end + 1;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    const tag = parseTag(html, lt);
    if (!tag) {
      out += '<';
      i = lt + 1;
      continue;
    }

    // A <base> tag would make every rewritten relative reference resolve
    // somewhere else. The export is self-contained, so drop it.
    if (tag.name === 'base') {
      i = tag.end;
      continue;
    }

    out += rewriteTag(html, tag, ctx, pageUrl, pageOutRel);
    i = tag.end;

    if (!tag.selfClosing && RAW_TEXT.has(tag.name)) {
      const close = findClosingTag(html, i, tag.name);
      const content = html.slice(i, close.start);
      if (tag.name === 'style') {
        out += rewriteCss(content, ctx, pageUrl, pageOutRel);
      } else {
        out += content;
      }
      out += close.text;
      i = close.end;
    }
  }
  return out;
}

function parseTag(html, start) {
  let i = start + 1;
  const nameStart = i;
  while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i])) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs = [];
  let selfClosing = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] === '>') {
      i++;
      break;
    }
    if (html[i] === '/' && html[i + 1] === '>') {
      selfClosing = true;
      i += 2;
      break;
    }
    if (html[i] === '/') {
      i++;
      continue;
    }

    const attrStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
    const rawName = html.slice(attrStart, i);
    if (!rawName) {
      i++;
      continue;
    }
    while (i < html.length && /\s/.test(html[i])) i++;

    let valueStart = -1;
    let valueEnd = -1;
    let quote = '';
    if (html[i] === '=') {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      if (html[i] === '"' || html[i] === "'") {
        quote = html[i];
        i++;
        valueStart = i;
        const close = html.indexOf(quote, i);
        valueEnd = close < 0 ? html.length : close;
        i = close < 0 ? html.length : close + 1;
      } else {
        valueStart = i;
        while (i < html.length && !/[\s>]/.test(html[i])) i++;
        valueEnd = i;
      }
    }
    attrs.push({ name: rawName.toLowerCase(), rawName, valueStart, valueEnd, quote });
  }

  return { name, attrs, start, end: i, selfClosing };
}

function rewriteTag(html, tag, ctx, pageUrl, pageOutRel) {
  const replacements = [];
  const getAttr = (name) => tag.attrs.find((a) => a.name === name);
  const attrValue = (name) => {
    const a = getAttr(name);
    if (!a || a.valueStart < 0) return '';
    return html.slice(a.valueStart, a.valueEnd);
  };

  const metaKey = (attrValue('property') || attrValue('name') || '').toLowerCase();
  const rel = attrValue('rel').toLowerCase().replace(/\s+/g, ' ').trim();

  for (const attr of tag.attrs) {
    if (attr.valueStart < 0) continue;
    const value = html.slice(attr.valueStart, attr.valueEnd);
    let next = null;

    if (attr.name === 'style') {
      next = rewriteCss(value, ctx, pageUrl, pageOutRel);
    } else if (attr.name === 'srcset' || attr.name === 'imagesrcset') {
      next = rewriteSrcset(value, ctx, pageUrl, pageOutRel);
    } else if (attr.name === 'content') {
      if (tag.name === 'meta' && META_IMAGE_KEYS.has(metaKey)) {
        next = rewriteOne(value, ctx, pageUrl, pageOutRel, { pageLinks: false });
      }
    } else if (attr.name === 'href' || attr.name === 'xlink:href') {
      if (tag.name === 'link' && !LINK_RELS.has(rel)) continue;
      if (tag.name === 'link' && (rel === 'preconnect' || rel === 'dns-prefetch')) continue;
      next = rewriteOne(value, ctx, pageUrl, pageOutRel, { pageLinks: true });
    } else if (
      attr.name === 'src' ||
      attr.name === 'poster' ||
      attr.name === 'data' ||
      attr.name === 'background'
    ) {
      next = rewriteOne(value, ctx, pageUrl, pageOutRel, { pageLinks: false });
    } else if (attr.name === 'action') {
      next = rewriteOne(value, ctx, pageUrl, pageOutRel, { pageLinks: true });
    }

    if (next !== null && next !== value) {
      replacements.push({ start: attr.valueStart, end: attr.valueEnd, value: escapeAttrValue(next, attr.quote) });
      ctx.stats.rewritten++;
    }
  }

  if (!replacements.length) return html.slice(tag.start, tag.end);

  replacements.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = tag.start;
  for (const r of replacements) {
    out += html.slice(cursor, r.start) + r.value;
    cursor = r.end;
  }
  out += html.slice(cursor, tag.end);
  return out;
}

function rewriteSrcset(value, ctx, baseUrl, fromOutRel) {
  if (/data:/i.test(value)) return value;
  const parts = value.split(',');
  let changed = false;
  const out = parts.map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const m = /^(\S+)([\s\S]*)$/.exec(trimmed);
    if (!m) return part;
    const resolved = resolveRef(m[1], ctx, baseUrl, fromOutRel, { pageLinks: false });
    if (!resolved) return part;
    changed = true;
    return `${resolved}${m[2]}`;
  });
  return changed ? out.join(', ') : value;
}

function rewriteOne(value, ctx, baseUrl, fromOutRel, opts) {
  const resolved = resolveRef(value, ctx, baseUrl, fromOutRel, opts);
  return resolved === null ? value : resolved;
}

function findClosingTag(html, from, name) {
  const re = new RegExp(`</${name}\\s*>`, 'i');
  const rest = html.slice(from);
  const m = re.exec(rest);
  if (!m) return { start: html.length, end: html.length, text: '' };
  return { start: from + m.index, end: from + m.index + m[0].length, text: m[0] };
}

function escapeAttrValue(value, quote) {
  let out = String(value).replace(/&/g, '&amp;');
  if (quote === '"') out = out.replace(/"/g, '&quot;');
  else if (quote === "'") out = out.replace(/'/g, '&#39;');
  return out;
}

/* --------------------------------------------------------------------- css */

function rewriteCss(css, ctx, baseUrl, fromOutRel) {
  let out = '';
  let i = 0;

  while (i < css.length) {
    const ch = css[i];

    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = findStringEnd(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '@' && /^@import\b/i.test(css.slice(i, i + 8))) {
      let j = i + 7;
      out += css.slice(i, j);
      while (j < css.length && /\s/.test(css[j])) {
        out += css[j];
        j++;
      }
      if (/^url\(/i.test(css.slice(j, j + 4))) {
        const token = parseUrlToken(css, j);
        if (token) {
          const resolved = resolveRef(token.value, ctx, baseUrl, fromOutRel, { pageLinks: false });
          out += token.prefix + (resolved === null ? token.value : resolved) + token.suffix;
          if (resolved !== null) ctx.stats.rewritten++;
          j = token.end;
        }
      } else if (css[j] === '"' || css[j] === "'") {
        const end = findStringEnd(css, j);
        const quote = css[j];
        const value = css.slice(j + 1, end - 1);
        const resolved = resolveRef(value, ctx, baseUrl, fromOutRel, { pageLinks: false });
        out += quote + (resolved === null ? value : resolved) + quote;
        if (resolved !== null) ctx.stats.rewritten++;
        j = end;
      }
      i = j;
      continue;
    }

    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(css.slice(i, i + 4)) && isCssBoundary(css, i)) {
      const token = parseUrlToken(css, i);
      if (token) {
        const resolved = resolveRef(token.value, ctx, baseUrl, fromOutRel, { pageLinks: false });
        out += token.prefix + (resolved === null ? token.value : resolved) + token.suffix;
        if (resolved !== null) ctx.stats.rewritten++;
        i = token.end;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function isCssBoundary(css, i) {
  if (i === 0) return true;
  return /[\s:;{},()]/.test(css[i - 1]);
}

function findStringEnd(css, start) {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length) {
    if (css[i] === '\\') {
      i += 2;
      continue;
    }
    if (css[i] === quote) return i + 1;
    i++;
  }
  return css.length;
}

function parseUrlToken(css, start) {
  const m = /^url\(\s*/i.exec(css.slice(start, start + 16));
  if (!m) return null;
  let i = start + m[0].length;
  let quote = '';
  if (css[i] === '"' || css[i] === "'") {
    quote = css[i];
    i++;
  }
  const valueStart = i;
  if (quote) {
    while (i < css.length) {
      if (css[i] === '\\') {
        i += 2;
        continue;
      }
      if (css[i] === quote) break;
      i++;
    }
  } else {
    while (i < css.length && css[i] !== ')') {
      if (css[i] === '\\') i++;
      i++;
    }
  }
  const valueEnd = i;
  if (css[i] === quote) i++;
  while (i < css.length && /\s/.test(css[i])) i++;
  if (css[i] !== ')') return null;
  i++;
  return {
    value: css.slice(valueStart, valueEnd).trim(),
    prefix: css.slice(start, valueStart),
    suffix: css.slice(valueEnd, i),
    end: i,
  };
}

/* ------------------------------------------------------------------ resolve */

function resolveRef(raw, ctx, baseUrl, fromOutRel, { pageLinks = true } = {}) {
  const value = String(raw || '').trim();
  if (!value || value.startsWith('#') || SKIP_SCHEMES.test(value)) return null;

  let abs;
  try {
    abs = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;

  const normalized = normalizeUrl(abs.toString());
  if (!normalized) return null;

  const hit = ctx.manifest.find(normalized);
  if (!hit) {
    noteUnresolved(ctx, value);
    return null;
  }
  const target = ctx.byUrl.get(hit.entry.url);
  if (!target) {
    noteUnresolved(ctx, value);
    return null;
  }

  const rel = relativeHref(fromOutRel, target.outRel, target.type, pageLinks);
  if (rel === null) return null;
  return `${rel}${abs.hash || ''}`;
}

function relativeHref(fromRel, targetRel, targetType, pageLinks) {
  const fromDir = path.posix.dirname(fromRel.split(path.sep).join('/'));
  const to = targetRel.split(path.sep).join('/');

  if (pageLinks && targetType === 'page' && (to === 'index.html' || to.endsWith('/index.html'))) {
    const dir = to === 'index.html' ? '' : to.slice(0, -'/index.html'.length);
    const rel = path.posix.relative(fromDir, dir || '.');
    return rel === '' ? './' : `${rel}/`;
  }

  const rel = path.posix.relative(fromDir, to);
  return rel === '' ? './' : rel;
}

function noteUnresolved(ctx, ref) {
  // Only http(s) references reach here (schemes like data:/mailto: are skipped
  // before resolution), including root-relative ones such as /login.
  const key = `${ctx.currentPageUrl}\u0000${ctx.currentOutRel}\u0000${ref}`;
  if (ctx.unresolvedSeen.has(key)) return;
  ctx.unresolvedSeen.add(key);
  if (ctx.unresolved.length >= 1000) return;
  ctx.unresolved.push({ page: ctx.currentPageUrl, file: ctx.currentOutRel, ref });
}

/* ------------------------------------------------------------------- report */

function buildReport(ctx, manifestJson, started) {
  const durationMs = Date.now() - started;
  return {
    sourceArchive: ctx.archiveRoot,
    rootUrl: manifestJson.rootUrl || '',
    layout: ctx.layout,
    generatedAt: new Date().toISOString(),
    durationMs,
    // The number of pages present in the export, not just the ones written on
    // this pass — a partial re-export must not under-report the site.
    pages: ctx.pageOut.size,
    assets: ctx.stats.assets,
    cssRewritten: ctx.stats.cssRewritten,
    rewritten: ctx.stats.rewritten,
    bytes: ctx.stats.bytes,
    unresolved: ctx.unresolved,
  };
}

function renderNotes(report) {
  const lines = [
    '# Static export',
    '',
    `Source archive: \`${report.sourceArchive}\``,
    `Original site:  ${report.rootUrl}`,
    `Layout:         ${report.layout}`,
    `Generated:      ${report.generatedAt}`,
    '',
    `${report.pages} page(s) · ${report.assets} asset(s) · ${report.rewritten} reference(s) rewritten · ${report.bytes} bytes`,
    '',
    'This folder is a plain static site. Serve it with any web server',
    '(`python -m http.server`, nginx, Apache, Netlify, Vercel, S3, …).',
    '',
  ];

  if (report.unresolved.length) {
    lines.push('## References that still point at the live site');
    lines.push('');
    lines.push('These were never captured, so they cannot be localised honestly.');
    lines.push('They will only work while the original site is reachable.');
    lines.push('');
    for (const item of report.unresolved) {
      lines.push(`- \`${item.ref}\` — in \`${item.file}\` (page ${item.page})`);
    }
    lines.push('');
  } else {
    lines.push('Every captured reference was localised. Nothing points at the live site.');
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- Pages use the raw server HTML unless the visual diff proved the rendered DOM snapshot renders better.');
  lines.push('- Inline scripts are left untouched: runtime-built URLs cannot be rewritten safely.');
  lines.push('- Write requests (POST/PUT/PATCH/DELETE) were never archived and cannot work here.');
  lines.push('- WebSocket-dependent features stay unavailable, by design.');
  lines.push('');
  return lines.join('\n');
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

module.exports = {
  exportStatic,
  finalizeExport,
  rewriteHtml,
  rewriteCss,
  parseTag,
  pageOutputPath,
  resolveRef,
};
