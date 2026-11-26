'use strict';

const path = require('path');
const { normalizeUrl, pathKey, hostOf } = require('./util');

/**
 * Manifest: the single source of truth for what was captured and where it lives.
 * Every consumer (proxy, local server, diff engine, report) reads from here.
 */
class Manifest {
  constructor({ rootUrl, site }) {
    this.version = 1;
    this.generatedAt = new Date().toISOString();
    this.rootUrl = rootUrl;
    this.site = site;
    this.pages = [];
    this.assets = [];
    this.websockets = [];
    this.failures = [];
    this.writes = [];
    this.wasmModules = [];
    this.archiveRoot = null;
    this.spaMode = false;
    this.index = { byUrl: new Map(), byPathKey: new Map(), byPathname: new Map(), pagesByUrl: new Map() };
    // Identity maps kept alongside the lookup indexes so every add is O(1)
    // instead of a linear scan plus a full index rebuild.
    this.pageSet = new Set();
    this.pageByUrl = new Map();
    this.assetByUrl = new Map();
  }

  setArchiveRoot(dir) {
    this.archiveRoot = dir;
  }

  addPage(entry) {
    const url = normalizeUrl(entry.url);
    if (!url) return null;
    const existing = this.pageByUrl.get(url);
    if (existing) return existing;
    const page = { url, ...entry, url };
    page.url = url;
    this.pages.push(page);
    this.pageByUrl.set(url, page);
    this.pageSet.add(page);
    this.indexPage(page);
    return page;
  }

  addAsset(entry) {
    const url = normalizeUrl(entry.url);
    if (!url) return null;
    const existing = this.assetByUrl.get(url);
    if (existing) {
      if (!existing.ok && entry.ok) {
        Object.assign(existing, entry, { url });
        this.indexAsset(existing);
      }
      return existing;
    }
    const asset = { ...entry, url };
    this.assets.push(asset);
    this.assetByUrl.set(url, asset);
    if (asset.ok) this.indexAsset(asset);
    return asset;
  }

  /** Add one captured page to the lookup indexes (pages always win over assets). */
  indexPage(page) {
    if (!page.file || page.status !== 'captured') return;
    this.index.pagesByUrl.set(page.url, page);
    this.index.byUrl.set(page.url, page);
    const pk = pathKey(page.url);
    if (pk) this.index.byPathKey.set(pk, page);
  }

  /** Add one successful asset to the lookup indexes without rebuilding them. */
  indexAsset(asset) {
    if (!this.index.byUrl.has(asset.url)) this.index.byUrl.set(asset.url, asset);
    const pk = pathKey(asset.url);
    if (pk && !this.index.byPathKey.has(pk)) this.index.byPathKey.set(pk, asset);
    try {
      const pn = new URL(asset.url).pathname;
      const hit = this.index.byPathname.get(pn);
      if (!hit) this.index.byPathname.set(pn, asset);
      else if (Array.isArray(hit)) hit.push(asset);
      else this.index.byPathname.set(pn, [hit, asset]);
    } catch {
      /* opaque URL — no pathname index */
    }
  }

  addWs(entry) {
    const url = normalizeUrl(entry.url) || entry.url;
    const existing = this.websockets.find((w) => w.url === url);
    if (existing) {
      existing.closedAt = entry.closedAt || existing.closedAt;
      existing.messages = Math.max(existing.messages || 0, entry.messages || 0);
      return existing;
    }
    const ws = { url, ...entry };
    this.websockets.push(ws);
    return ws;
  }

  addFailure(entry) {
    this.failures.push({ ...entry, at: new Date().toISOString() });
  }

  /** Non-idempotent requests observed on the live site: evidence, never replayable. */
  addWrite(entry) {
    const url = normalizeUrl(entry.url) || entry.url;
    const existing = this.writes.find((w) => w.url === url && w.method === entry.method);
    if (existing) {
      existing.count = (existing.count || 1) + 1;
      existing.lastStatus = entry.status;
      return existing;
    }
    const record = { ...entry, url, count: 1, lastStatus: entry.status };
    this.writes.push(record);
    return record;
  }

  addWasm(url) {
    const u = normalizeUrl(url) || url;
    if (!this.wasmModules.includes(u)) this.wasmModules.push(u);
  }

  buildIndexes() {
    this.index = { byUrl: new Map(), byPathKey: new Map(), byPathname: new Map(), pagesByUrl: new Map() };
    this.pageSet = new Set();
    this.pageByUrl = new Map();
    this.assetByUrl = new Map();

    for (const page of this.pages) {
      this.pageSet.add(page);
      this.pageByUrl.set(page.url, page);
      // Only pages that actually produced a file are replayable. Skipped
      // (auth-walled) and failed pages stay in the manifest as evidence but are
      // never served as if they had been captured.
      this.indexPage(page);
    }
    for (const asset of this.assets) {
      this.assetByUrl.set(asset.url, asset);
      if (asset.ok) this.indexAsset(asset);
    }
  }

  /**
   * Three-tier lookup:
   *   1. exact URL (query included)
   *   2. origin+pathname (ignores cache-busting query)
   *   3. pathname only (cross-host, for localhost path serving)
   */
  find(url, { pathnameFallback = true } = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    let hit = this.index.pagesByUrl.get(normalized) || this.index.byUrl.get(normalized);
    if (hit) return { type: 'page', entry: hit };

    const pk = pathKey(normalized);
    if (pk) {
      hit = this.index.byPathKey.get(pk);
      if (hit) return { type: this.pageSet.has(hit) ? 'page' : 'asset', entry: hit, matched: 'path' };
    }
    if (!pathnameFallback) return null;
    try {
      const pn = new URL(normalized).pathname;
      hit = this.index.byPathname.get(pn);
      if (hit) {
        if (Array.isArray(hit)) {
          // Prefer the asset from the site's own host.
          const own = hit.find((a) => hostOf(a.url) === hostOf(this.rootUrl)) || hit[0];
          return { type: 'asset', entry: own, matched: 'pathname' };
        }
        return { type: 'asset', entry: hit, matched: 'pathname' };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  absoluteFile(entry) {
    if (!entry || !entry.file) return null;
    return path.join(this.archiveRoot, entry.file);
  }

  hosts() {
    const set = new Set();
    const add = (u) => {
      const h = hostOf(u);
      if (h) set.add(h);
    };
    add(this.rootUrl);
    for (const p of this.pages) add(p.url);
    for (const a of this.assets) if (a.ok) add(a.url);
    return [...set].sort();
  }

  stats() {
    const assetsOk = this.assets.filter((a) => a.ok);
    const assetsFailed = this.assets.filter((a) => !a.ok);
    const pagesOk = this.pages.filter((p) => p.status === 'captured');
    const pagesSkipped = this.pages.filter((p) => p.status === 'skipped');
    const pagesFailed = this.pages.filter((p) => p.status === 'failed');
    return {
      pagesTotal: this.pages.length,
      pagesCaptured: pagesOk.length,
      pagesSkipped: pagesSkipped.length,
      pagesFailed: pagesFailed.length,
      assetsRequested: this.assets.length,
      assetsSaved: assetsOk.length,
      assetsFailed: assetsFailed.length,
      assetsBytes: assetsOk.reduce((n, a) => n + (a.size || 0), 0),
      websockets: this.websockets.length,
      wasmModules: this.wasmModules.length,
    };
  }

  toJSON() {
    return {
      version: this.version,
      generatedAt: this.generatedAt,
      site: this.site,
      rootUrl: this.rootUrl,
      spaMode: this.spaMode,
      stats: this.stats(),
      hosts: this.hosts(),
      pages: this.pages,
      assets: this.assets,
      websockets: this.websockets,
      wasmModules: this.wasmModules,
      failures: this.failures,
      writes: this.writes,
    };
  }

  static fromJSON(json, archiveRoot) {
    const m = new Manifest({ rootUrl: json.rootUrl, site: json.site });
    m.version = json.version || 1;
    m.generatedAt = json.generatedAt;
    m.pages = json.pages || [];
    m.assets = json.assets || [];
    m.websockets = json.websockets || [];
    m.failures = json.failures || [];
    m.writes = json.writes || [];
    m.wasmModules = json.wasmModules || [];
    m.spaMode = !!json.spaMode;
    m.setArchiveRoot(archiveRoot);
    m.buildIndexes();
    return m;
  }
}

module.exports = { Manifest };
