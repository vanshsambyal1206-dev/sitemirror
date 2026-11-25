'use strict';

const { normalizeUrl, assetKind } = require('./util');

/**
 * Per-page network interceptor. Captures every response body that Playwright can
 * hand over, records failures with a reason, and logs WebSocket lifetime.
 */
class Interceptor {
  constructor({ manifest, writer, pageUrl, options = {} }) {
    this.manifest = manifest;
    this.writer = writer;
    this.pageUrl = pageUrl;
    this.maxAssetBytes = options.maxAssetBytes || 64 * 1024 * 1024;
    this.captureApiBodies = options.captureApiBodies !== false;
    this.pending = new Set();
    this.seen = new Map(); // url -> entry
    this.pageRequests = new Set();
    this.pageFailures = [];
    this.apiSamples = [];
    this.writes = [];
    this.wasm = [];
    this.ws = [];
    this.stats = { requests: 0, saved: 0, failed: 0, skipped: 0, bytes: 0 };
    this.attached = new Set();
  }

  attach(page) {
    if (this.attached.has(page)) return;
    this.attached.add(page);

    page.on('request', (req) => this.onRequest(req));
    page.on('response', (res) => {
      const task = this.onResponse(res).catch(() => null);
      this.pending.add(task);
      task.finally(() => this.pending.delete(task));
    });
    page.on('requestfailed', (req) => this.onRequestFailed(req));
    page.on('websocket', (ws) => this.onWebSocket(ws));
  }

  /** Attach to popups spawned by the page too. */
  attachContext(context) {
    context.on('page', (p) => this.attach(p));
  }

  onRequest(req) {
    this.stats.requests++;
    const url = normalizeUrl(req.url());
    if (!url) return;
    this.pageRequests.add(url);
  }

  onRequestFailed(req) {
    const url = normalizeUrl(req.url());
    if (!url) return;
    const reason = req.failure() ? req.failure().errorText : 'request failed';
    const entry = {
      url,
      ok: false,
      error: mapFailureReason(reason),
      rawError: reason,
      resourceType: req.resourceType(),
      status: 0,
      page: this.pageUrl,
    };
    this.recordFailure(entry);
  }

  recordFailure(entry) {
    this.pageFailures.push(entry);
    this.stats.failed++;
    this.manifest.addAsset({ ...entry, ok: false });
    this.manifest.addFailure({
      url: entry.url,
      page: this.pageUrl,
      reason: entry.error,
      rawError: entry.rawError,
      resourceType: entry.resourceType,
    });
  }

  async onResponse(res) {
    const request = res.request();
    const rawUrl = res.url();
    const url = normalizeUrl(rawUrl);
    if (!url) return;

    const resourceType = request.resourceType();
    const isApi = resourceType === 'xhr' || resourceType === 'fetch';
    if (isApi && !this.captureApiBodies) return;

    const status = res.status();
    const headers = res.headers();
    const contentType = headers['content-type'] || '';
    const key = `${isApi ? request.method() : 'GET'} ${url}`;
    if (this.seen.has(key)) {
      const prior = this.seen.get(key);
      prior.hits = (prior.hits || 1) + 1;
      return;
    }
    this.seen.set(key, { status });

    // Redirects and 204/304 have no body by definition.
    if (status >= 300 && status < 400) return;
    if (status === 204 || status === 304) return;

    // HTML documents are captured as rendered DOM by the page writer. Storing
    // the raw server response as an "asset" would let auth-walled or failed
    // pages leak back through the asset index, so documents are metadata only.
    if (resourceType === 'document') {
      this.seen.set(key, { status, document: true });
      return;
    }

    // Write requests cannot be replayed by a static archive. Answering a later
    // POST with a stored response body would fake a working API, so writes are
    // recorded as evidence (and sampled for the dynamic-content check) but are
    // never indexed as assets.
    if (isApi && request.method() !== 'GET' && request.method() !== 'HEAD') {
      let sample = null;
      try {
        const body = await res.body();
        if (body && body.length) sample = body.subarray(0, 4000).toString('utf8');
      } catch {
        /* body may already be gone; the request is still evidence */
      }
      const record = {
        url,
        method: request.method(),
        status,
        contentType,
        page: this.pageUrl,
        at: new Date().toISOString(),
      };
      this.writes.push(record);
      this.manifest.addWrite(record);
      if (sample && this.apiSamples.length < 40) this.apiSamples.push({ url, body: sample });
      this.seen.set(key, { status, write: true });
      return;
    }

    // An error response from the origin is not an asset. Record it as an
    // origin-side failure (excluded from the mirror's completeness score) and
    // do not store the error page as if it were the real resource.
    if (status >= 400) {
      const entry = {
        url,
        ok: false,
        origin: true,
        error: `HTTP ${status}`,
        rawError: `origin returned ${status}`,
        resourceType,
        status,
        contentType,
        page: this.pageUrl,
      };
      this.seen.set(key, entry);
      this.pageFailures.push(entry);
      this.stats.failed++;
      this.manifest.addAsset(entry);
      this.manifest.addFailure({ url, page: this.pageUrl, reason: entry.error, resourceType, origin: true });
      return;
    }

    const declaredLength = Number(headers['content-length'] || 0);
    if (declaredLength && declaredLength > this.maxAssetBytes) {
      const entry = {
        url,
        ok: false,
        error: `exceeds size limit (${declaredLength} bytes)`,
        resourceType,
        status,
        contentType,
        page: this.pageUrl,
      };
      this.seen.set(key, entry);
      this.stats.skipped++;
      this.manifest.addAsset(entry);
      this.manifest.addFailure({ url, page: this.pageUrl, reason: entry.error, resourceType });
      return;
    }

    let body;
    try {
      body = await res.body();
    } catch (err) {
      const reason = mapFailureReason(err && err.message ? err.message : String(err));
      const entry = {
        url,
        ok: false,
        error: reason,
        rawError: err && err.message ? err.message : String(err),
        resourceType,
        status,
        contentType,
        page: this.pageUrl,
      };
      this.pageFailures.push(entry);
      this.stats.failed++;
      this.manifest.addAsset(entry);
      this.manifest.addFailure({ url, page: this.pageUrl, reason, resourceType });
      return;
    }

    if (!body || body.length === 0) {
      this.seen.set(key, { status, empty: true });
      return;
    }
    if (body.length > this.maxAssetBytes) {
      const entry = {
        url,
        ok: false,
        error: `exceeds size limit (${body.length} bytes)`,
        resourceType,
        status,
        contentType,
        page: this.pageUrl,
      };
      this.stats.skipped++;
      this.manifest.addAsset(entry);
      this.manifest.addFailure({ url, page: this.pageUrl, reason: entry.error, resourceType });
      return;
    }

    const kind = assetKind(contentType, url);
    if (kind === 'wasm') {
      this.manifest.addWasm(url);
      if (!this.wasm.includes(url)) this.wasm.push(url);
    }

    const saved = await this.writer.saveAsset({ url, body, contentType, kind });
    const entry = {
      url,
      ok: true,
      file: saved.file,
      kind,
      contentType,
      status,
      size: body.length,
      resourceType,
      page: this.pageUrl,
      ephemeral: isApi && request.method() !== 'GET',
      method: request.method(),
      headers: pickHeaders(headers),
    };
    this.seen.set(key, entry);
    this.manifest.addAsset(entry);
    this.stats.saved++;
    this.stats.bytes += body.length;

    // Keep a bounded text sample of API payloads for the dynamic-content check.
    if (isApi && this.apiSamples.length < 40) {
      const ctLower = contentType.toLowerCase();
      const head = body.subarray(0, 2).toString('utf8');
      if (ctLower.includes('json') || ctLower.includes('text') || head === '{[' || head === '{"' || head === '[{') {
        this.apiSamples.push({ url, body: body.subarray(0, 4000).toString('utf8') });
      }
    }
  }

  onWebSocket(ws) {
    const url = ws.url();
    const record = { url, openedAt: new Date().toISOString(), messages: 0, closedAt: null };
    this.ws.push(record);
    this.manifest.addWs(record);
    ws.on('framesent', () => {
      record.messages++;
    });
    ws.on('framereceived', () => {
      record.messages++;
    });
    ws.on('close', () => {
      record.closedAt = new Date().toISOString();
      this.manifest.addWs(record);
    });
  }

  async drain() {
    // Two passes: responses often trigger new requests while bodies resolve.
    for (let i = 0; i < 3; i++) {
      if (this.pending.size === 0) break;
      await Promise.allSettled([...this.pending]);
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  summary() {
    const unique = new Set(this.pageRequests);
    return {
      page: this.pageUrl,
      requested: unique.size,
      saved: this.stats.saved,
      failed: unique.size > 0 ? Math.max(0, this.pageFailures.length) : this.stats.failed,
      bytes: this.stats.bytes,
      failures: this.pageFailures.map((f) => ({
        url: f.url,
        reason: f.error,
        resourceType: f.resourceType,
        status: f.status,
        origin: !!f.origin,
      })),
      websockets: this.ws.map((w) => ({ url: w.url, messages: w.messages })),
      writes: this.writes.map((w) => ({ url: w.url, method: w.method, status: w.status })),
      wasm: this.wasm.slice(),
    };
  }
}

function pickHeaders(headers) {
  const out = {};
  const keep = [
    'content-type',
    'content-encoding',
    'cache-control',
    'etag',
    'last-modified',
    'access-control-allow-origin',
    'cross-origin-resource-policy',
    'cross-origin-embedder-policy',
  ];
  for (const k of keep) if (headers[k] !== undefined) out[k] = headers[k];
  return out;
}

function mapFailureReason(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('cors') || s.includes('cross-origin')) return 'CORS blocked';
  if (s.includes('net::err_aborted') || s.includes('aborted')) return 'aborted';
  if (s.includes('net::err_name_not_resolved')) return 'DNS failure';
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';
  if (s.includes('net::err_connection_refused')) return 'connection refused';
  if (s.includes('net::err_cert')) return 'TLS certificate error';
  if (s.includes('net::err_failed')) return 'network error';
  if (s.includes('no resource with given identifier') || s.includes('unavailable')) return 'body unavailable';
  if (s.includes('target closed') || s.includes('page closed')) return 'page closed before body';
  return String(raw || 'unknown').slice(0, 120);
}

module.exports = { Interceptor, mapFailureReason };
