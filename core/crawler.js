'use strict';

const robotsParser = require('robots-parser');
const { newContext, settle, extractLinks, readRouteLog, describeError, isBotChallenge, DEFAULT_UA } = require('./launcher');
const { normalizeUrl, canonicalCrawlUrl, isSkippableUrl, hostOf, sleep } = require('./util');

const DESTRUCTIVE_TEXT = /(delete|remove|logout|log out|sign out|unsubscribe|checkout|buy now|purchase|pay now|place order|submit|send message|download|install|book now)/i;

class Crawler {
  constructor({ browser, rootUrl, options = {}, log = () => {} }) {
    this.browser = browser;
    this.rootUrl = rootUrl;
    this.options = {
      maxPages: options.maxPages || 40,
      delay: options.delay ?? 700,
      respectRobots: options.respectRobots !== false,
      clickNav: options.clickNav !== false,
      clickBudget: options.clickBudget ?? 12,
      maxQueryUrls: options.maxQueryUrls ?? 25,
      timeout: options.timeout || 30000,
      insecure: !!options.insecure,
    };
    this.log = log;
    this.robotCache = new Map();
    this.visited = new Set();
    this.queue = [];
    this.discovered = [];
    this.skipped = [];
    this.notes = [];
    this.spaRoutes = new Set();
    this.apex = null;
    this.queryUrlCount = 0;
    this.blocked = null;
  }

  async init() {
    const rootHost = hostOf(this.rootUrl) || '';
    this.apex = rootHost.replace(/^www\./i, '').toLowerCase();
    if (this.options.respectRobots) await this.loadRobots(this.rootUrl);
  }

  async loadRobots(url) {
    const origin = new URL(url).origin;
    if (this.robotCache.has(origin)) return this.robotCache.get(origin);
    let parser = null;
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': DEFAULT_UA, accept: 'text/plain,*/*' },
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      if (res.ok) {
        const text = await res.text();
        parser = robotsParser(`${origin}/robots.txt`, text);
      } else if (res.status === 401 || res.status === 403) {
        parser = null; // no robots.txt available → default allow
      }
    } catch {
      parser = null;
    }
    this.robotCache.set(origin, parser);
    return parser;
  }

  async isAllowed(url) {
    if (!this.options.respectRobots) return true;
    const parser = await this.loadRobots(url);
    if (!parser) return true;
    try {
      return parser.isAllowed(url, DEFAULT_UA) !== false;
    } catch {
      return true;
    }
  }

  async crawlDelayFor(url) {
    let delay = this.options.delay;
    if (!this.options.respectRobots) return delay;
    try {
      const parser = await this.loadRobots(url);
      const d = parser && parser.getCrawlDelay(DEFAULT_UA);
      if (d) delay = Math.max(delay, Math.min(Number(d), 10000));
    } catch {
      /* ignore */
    }
    return delay;
  }

  inScope(url) {
    const host = hostOf(url);
    if (!host) return false;
    const h = host.replace(/^www\./i, '').toLowerCase();
    return h === this.apex || h.endsWith(`.${this.apex}`);
  }

  enqueue(url, method) {
    const canonical = canonicalCrawlUrl(url);
    if (!canonical) return false;
    if (!this.inScope(canonical)) return false;
    if (isSkippableUrl(canonical)) return false;
    if (this.visited.has(canonical)) return false;
    if (this.queue.some((q) => q.url === canonical)) return false;
    if (this.discovered.length + this.queue.length >= this.options.maxPages) return false;

    // Faceted search / calendar-style query explosions are capped, not followed forever.
    if (new URL(canonical).search && this.queryUrlCount >= this.options.maxQueryUrls) {
      this.skipped.push({ url: canonical, reason: 'query-parameter cap reached' });
      return false;
    }
    if (new URL(canonical).search) this.queryUrlCount++;
    this.queue.push({ url: canonical, discoveryMethod: method });
    return true;
  }

  async discover() {
    await this.init();
    this.enqueue(this.rootUrl, 'seed');

    const context = await newContext(this.browser, {
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: !!this.options.insecure,
    });

    try {
      while (this.queue.length > 0 && this.discovered.length < this.options.maxPages && !this.blocked) {
        const item = this.queue.shift();
        if (this.visited.has(item.url)) continue;
        this.visited.add(item.url);

        if (!(await this.isAllowed(item.url))) {
          this.skipped.push({ url: item.url, reason: 'disallowed by robots.txt' });
          continue;
        }

        const delay = await this.crawlDelayFor(item.url);
        if (this.discovered.length > 0) await sleep(delay);

        const result = await this.visit(context, item);
        if (result) {
          this.discovered.push({
            url: result.url,
            discoveryMethod: item.discoveryMethod,
            status: result.status,
            title: result.title,
            spaRoutes: result.spaRoutes,
          });
          for (const [route, method] of result.newRoutes) {
            if (route !== result.url) this.enqueue(route, method);
          }
        }
      }

      if (this.options.clickNav && !this.blocked) {
        await this.probeClickRoutes(context);
      }
    } finally {
      await context.close().catch(() => {});
    }

    return {
      pages: this.discovered,
      skipped: this.skipped,
      notes: this.notes,
      spaRoutes: [...this.spaRoutes],
      spaMode: this.spaRoutes.size > 0,
      blocked: this.blocked,
    };
  }

  async visit(context, item) {
    const page = await context.newPage();
    const newRoutes = new Map();
    let status = null;
    let headers = {};
    try {
      const res = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: this.options.timeout });
      if (res) {
        status = res.status();
        headers = res.headers();
      }
      await settle(page, { timeout: this.options.timeout, quiet: 700 });

      const challenge = status ? isBotChallenge(status, headers) : null;
      if (challenge) {
        this.blocked = { url: item.url, reason: challenge, status };
        this.notes.push(`Bot protection detected at ${item.url} (${challenge}). Capture stops here by design — no evasion attempted.`);
        return { url: item.url, status, title: null, newRoutes, spaRoutes: [] };
      }

      const finalUrl = normalizeUrl(page.url()) || item.url;
      const title = await page.title().catch(() => '');
      const routeLog = await readRouteLog(page);
      for (const route of routeLog) {
        const normalized = normalizeUrl(route);
        if (!normalized || !this.inScope(normalized)) continue;
        this.spaRoutes.add(normalized);
        newRoutes.set(normalized, 'spa-route');
      }

      const links = await extractLinks(page);
      for (const link of links) {
        const n = normalizeUrl(link.url);
        if (!n || !this.inScope(n)) continue;
        newRoutes.set(n, 'link');
      }

      if (finalUrl !== item.url) newRoutes.set(finalUrl, item.discoveryMethod);

      return { url: finalUrl, status, title, newRoutes, spaRoutes: [...this.spaRoutes] };
    } catch (err) {
      const reason = describeError(err);
      if (/403|429|challenge/i.test(reason)) {
        this.blocked = { url: item.url, reason, status };
        this.notes.push(`Capture blocked at ${item.url} (${reason}). No evasion attempted.`);
      } else {
        this.notes.push(`Failed to load ${item.url}: ${reason}`);
      }
      return { url: item.url, status, title: null, newRoutes, spaRoutes: [] };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * SPA navigation probe: click navigation-shaped elements that are NOT plain
   * links (role=link, nav buttons) and record resulting routes. State-changing
   * controls are skipped by text heuristic.
   */
  async probeClickRoutes(context) {
    const page = await context.newPage();
    let candidates = [];
    try {
      await page.goto(this.rootUrl, { waitUntil: 'domcontentloaded', timeout: this.options.timeout });
      await settle(page, { timeout: this.options.timeout, quiet: 600 });
      candidates = await page.evaluate(() => {
        const sel = [
          'nav a:not([href])',
          'nav button',
          'header button',
          '[role="navigation"] button',
          '[role="link"]',
          '[role="menuitem"]',
          '[data-route]',
        ].join(',');
        const out = [];
        const els = Array.from(document.querySelectorAll(sel));
        for (const el of els) {
          const text = (el.textContent || '').trim().slice(0, 60);
          const rect = el.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          if (el.tagName === 'BUTTON' && el.type === 'submit') continue;
          out.push({
            idx: out.length,
            text,
            tag: el.tagName.toLowerCase(),
            aria: el.getAttribute('aria-label') || '',
          });
          if (out.length >= 40) break;
        }
        return out;
      });
    } catch {
      await page.close().catch(() => {});
      return;
    } finally {
      await page.close().catch(() => {});
    }

    const safe = candidates.filter((c) => !DESTRUCTIVE_TEXT.test(`${c.text} ${c.aria}`));
    const budget = Math.min(this.options.clickBudget, safe.length);
    for (let i = 0; i < budget; i++) {
      if (this.discovered.length >= this.options.maxPages) break;
      const candidate = safe[i];
      const probe = await context.newPage();
      try {
        await probe.goto(this.rootUrl, { waitUntil: 'domcontentloaded', timeout: this.options.timeout });
        await settle(probe, { timeout: this.options.timeout, quiet: 500 });
        const clicked = await probe.evaluate(({ idx, tag, text }) => {
          const sel = [
            'nav a:not([href])',
            'nav button',
            'header button',
            '[role="navigation"] button',
            '[role="link"]',
            '[role="menuitem"]',
            '[data-route]',
          ].join(',');
          const els = Array.from(document.querySelectorAll(sel)).filter((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width >= 8 && rect.height >= 8 && !(el.tagName === 'BUTTON' && el.type === 'submit');
          });
          const el = els[idx];
          if (!el) return false;
          el.scrollIntoView({ block: 'center' });
          el.click();
          return true;
        }, candidate);
        if (!clicked) continue;
        await probe.waitForTimeout(1200);
        const afterUrl = normalizeUrl(probe.url());
        const routeLog = await readRouteLog(probe);
        const routes = new Set(routeLog);
        if (afterUrl) routes.add(afterUrl);
        for (const r of routes) {
          const n = normalizeUrl(r);
          if (!n || !this.inScope(n)) continue;
          if (n === normalizeUrl(this.rootUrl)) continue;
          this.spaRoutes.add(n);
          this.enqueue(n, 'spa-route');
        }
      } catch {
        /* a click that fails is just a route we did not find */
      } finally {
        await probe.close().catch(() => {});
      }
      await sleep(Math.min(this.options.delay, 400));
    }
  }
}

module.exports = { Crawler };
