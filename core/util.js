'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };

/** Normalize a URL for dedupe: no hash, lowercase host, no default port, trailing slash kept. */
function normalizeUrl(input, base) {
  let u;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if (DEFAULT_PORTS[u.protocol] === u.port) u.port = '';
  return u.toString();
}

/** Origin + pathname, no query. Used as a second-tier manifest lookup key. */
function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function sha1(str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

function shortHash(str, len = 8) {
  return sha1(str).slice(0, len);
}

const EXT_BY_MIME = {
  'text/html': '.html',
  'text/plain': '.txt',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/x-javascript': '.js',
  'application/json': '.json',
  'application/ld+json': '.json',
  'application/manifest+json': '.webmanifest',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'application/x-font-woff': '.woff',
  'application/vnd.ms-fontobject': '.eot',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'model/gltf-binary': '.glb',
  'model/gltf+json': '.gltf',
  'application/octet-stream': '.bin',
  'application/wasm': '.wasm',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
};

const MIME_BY_EXT = Object.entries(EXT_BY_MIME).reduce((acc, [mime, ext]) => {
  if (!acc[ext]) acc[ext] = mime;
  return acc;
}, {});

function extFromMime(contentType) {
  if (!contentType) return '';
  const mime = contentType.split(';')[0].trim().toLowerCase();
  return EXT_BY_MIME[mime] || '';
}

function mimeFromExt(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function extFromUrlPath(url) {
  try {
    const p = new URL(url).pathname;
    const ext = path.extname(p).toLowerCase();
    if (ext && ext.length <= 12 && /^\.[a-z0-9]+$/i.test(ext)) return ext;
  } catch {
    /* ignore */
  }
  return '';
}

/** Classify a captured response into one of the archive asset buckets. */
function assetKind(contentType, url) {
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  const pathname = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const ext = path.extname(pathname);

  if (mime.includes('css') || ext === '.css') return 'css';
  if (mime.includes('javascript') || mime.includes('ecmascript') || ['.js', '.mjs', '.cjs'].includes(ext)) return 'js';
  if (mime.startsWith('font/') || mime.includes('font-woff') || ['.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext)) return 'fonts';
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp'].includes(ext)) return 'images';
  if (mime.startsWith('video/') || mime.startsWith('audio/') || ['.mp4', '.webm', '.mov', '.mp3', '.ogg', '.wav', '.m4a'].includes(ext)) return 'video';
  if (['.glb', '.gltf', '.bin', '.hdr', '.exr', '.ktx2', '.drc'].includes(ext) || mime.includes('gltf')) return 'models';
  if (['.lottie', '.bodymovin'].includes(ext) || /lottie|bodymovin|animation/i.test(pathname)) return 'animations';
  if (mime.includes('wasm') || ext === '.wasm') return 'wasm';
  if (mime.includes('json') || ext === '.json' || ext === '.webmanifest') return 'data';
  if (mime.includes('html') || ext === '.html') return 'documents';
  return 'other';
}

function sanitizeFilename(name, max = 60) {
  const cleaned = String(name)
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, max) || 'file';
}

/** Deterministic, readable archive path for an asset. */
function assetLocalPath(url, contentType) {
  const kind = assetKind(contentType, url);
  let base = 'asset';
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    base = sanitizeFilename(decodeURIComponentSafe(last));
  } catch {
    /* ignore */
  }
  let ext = extFromUrlPath(url) || extFromMime(contentType);
  // Keep a sane extension when the URL is opaque (e.g. /api/image?id=3 → .png from content-type).
  if (!path.extname(base)) base += ext || '';
  else if (!ext) ext = path.extname(base);
  const dir = path.posix.join('assets', kind);
  return `${dir}/${shortHash(url)}-${base}`;
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Human path → page filename at archive root. */
function pageSlug(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'index.html';
  }
  let p = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!p) return 'index.html';
  p = decodeURIComponentSafe(p);
  const parts = p.split('/').map((s) => sanitizeFilename(s, 48));
  let slug = parts.join('-');
  if (u.search && u.search.length > 1) slug += '-' + shortHash(u.search, 6);
  if (!slug.toLowerCase().endsWith('.html')) slug += '.html';
  return slug;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fileExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isProbablyHtml(contentType, url) {
  if (contentType && contentType.split(';')[0].trim().toLowerCase() === 'text/html') return true;
  if (!contentType) {
    const ext = extFromUrlPath(url);
    return ext === '' || ext === '.html' || ext === '.htm';
  }
  return false;
}

/** URLs that must never enter the crawl queue. */
function isSkippableUrl(url) {
  if (!url) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (!/^https?:$/.test(u.protocol)) return true;
  const p = u.pathname;
  if (/\.(pdf|zip|rar|7z|exe|dmg|msi|apk|iso|dmg|tar|gz|mp4|mp3|wav|avi|mov|webm|glb|gltf|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|wasm)$/i.test(p)) return true;
  if (/^\/(wp-admin|wp-login\.php|wp-json|xmlrpc\.php)/i.test(p) && !/\/wp-json\/wp\/v2\//.test(p)) return true;
  if (/(logout|signout|sign-out|delete|unsubscribe|cart\/remove|checkout\/complete)/i.test(p)) return true;
  return false;
}

/** Strip volatile query params that create infinite crawl loops. */
const VOLATILE_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$|_ga$|ref$|referrer$|sessionid$|phpsessid$|sid$)/i;
function canonicalCrawlUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (VOLATILE_PARAMS.test(k)) continue;
    keep.push([k, v]);
  }
  const sorted = keep.sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  u.search = '';
  for (const [k, v] of sorted) u.searchParams.append(k, v);
  u.hash = '';
  return u.toString();
}

module.exports = {
  normalizeUrl,
  canonicalCrawlUrl,
  pathKey,
  originOf,
  hostOf,
  sha1,
  shortHash,
  assetKind,
  assetLocalPath,
  pageSlug,
  extFromMime,
  extFromUrlPath,
  mimeFromExt,
  sanitizeFilename,
  ensureDir,
  writeJson,
  readJson,
  fileExists,
  humanBytes,
  sleep,
  isProbablyHtml,
  isSkippableUrl,
  decodeURIComponentSafe,
};
