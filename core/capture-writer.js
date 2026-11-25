'use strict';

const path = require('path');
const fsp = require('fs').promises;
const { ensureDir, assetLocalPath, pageSlug } = require('./util');

/**
 * All disk writes go through here. Files are content-addressed by URL hash so
 * repeat requests for the same asset are idempotent.
 */
class CaptureWriter {
  constructor({ archiveRoot }) {
    this.archiveRoot = archiveRoot || process.cwd();
    this.paths = new Map(); // relPath -> url
    this.bytes = 0;
    this.files = 0;
  }

  async writeBuffer(relPath, buffer) {
    const abs = path.join(this.archiveRoot, relPath);
    await ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, buffer);
    this.bytes += buffer.length;
    this.files++;
    return abs;
  }

  async writeText(relPath, text) {
    return this.writeBuffer(relPath, Buffer.from(text, 'utf8'));
  }

  uniquePath(relPath, url) {
    const existing = this.paths.get(relPath);
    if (!existing || existing === url) {
      this.paths.set(relPath, url);
      return relPath;
    }
    const ext = path.extname(relPath);
    const stem = relPath.slice(0, relPath.length - ext.length);
    let i = 2;
    let candidate = `${stem}-${i}${ext}`;
    while (this.paths.has(candidate) && this.paths.get(candidate) !== url) {
      i++;
      candidate = `${stem}-${i}${ext}`;
    }
    this.paths.set(candidate, url);
    return candidate;
  }

  async saveAsset({ url, body, contentType, kind }) {
    const rel = this.uniquePath(assetLocalPath(url, contentType), url);
    await this.writeBuffer(rel, body);
    return { file: rel, bytes: body.length, kind };
  }

  /** Save the rendered DOM for a page. `html` is page.content(). */
  async savePage({ url, html, extraMeta = {} }) {
    const rel = this.uniquePath(pageSlug(url), url);
    const annotated = annotateHtml(html, url, extraMeta);
    await this.writeText(rel, annotated);
    return { file: rel };
  }

  async saveArtifact(relPath, buffer) {
    return this.writeBuffer(relPath, buffer);
  }

  async saveJson(relPath, value) {
    return this.writeText(relPath, JSON.stringify(value, null, 2));
  }
}

function annotateHtml(html, url, meta) {
  const banner = [
    '<!--',
    '  Captured by sitemirror — a public, frontend-only archive.',
    `  Source: ${url}`,
    `  Captured: ${new Date().toISOString()}`,
    meta && meta.viewport ? `  Viewport: ${meta.viewport}` : null,
    '  Assets are served by the local mirror proxy; URLs are intentionally unmodified.',
    '-->',
  ]
    .filter(Boolean)
    .join('\n');

  let out = html;
  const headIdx = out.search(/<head[^>]*>/i);
  if (headIdx >= 0) {
    const insertAt = out.indexOf('>', headIdx) + 1;
    const metaTag = `\n<meta name="sitemirror-source" content="${escapeAttr(url)}">`;
    out = out.slice(0, insertAt) + metaTag + '\n' + banner + out.slice(insertAt);
  } else {
    out = banner + '\n' + out;
  }
  return out;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

module.exports = { CaptureWriter, annotateHtml };
