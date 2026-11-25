'use strict';

const { chromium } = require('playwright');

const VIEWPORT_PRESETS = {
  desktop: { width: 1920, height: 1080 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 667 },
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Resolve the --viewport flag into a list of {name, width, height}.
 * Accepts "desktop", "desktop,tablet", or "1440x900".
 */
function resolveViewports(spec) {
  if (!spec || spec === 'default') {
    return Object.entries(VIEWPORT_PRESETS).map(([name, size]) => ({ name, ...size }));
  }
  const out = [];
  const seen = new Set();
  for (const raw of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (VIEWPORT_PRESETS[raw]) {
      if (!seen.has(raw)) {
        seen.add(raw);
        out.push({ name: raw, ...VIEWPORT_PRESETS[raw] });
      }
      continue;
    }
    const m = /^(\d{2,5})x(\d{2,5})$/i.exec(raw);
    if (m) {
      const name = `${m[1]}x${m[2]}`;
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, width: Number(m[1]), height: Number(m[2]) });
      }
    }
  }
  return out.length ? out : resolveViewports('default');
}

/**
 * Launch a standard Playwright Chromium. No stealth patches, no fingerprint
 * spoofing, no automation-signal masking — the spec requires the browser to be
 * a plain, honest automated Chromium.
 *
 * `proxy` is set at browser level on purpose: Chromium ignores a context-level
 * proxy for WebSocket connections, so a replay browser would silently open live
 * sockets. A browser-level proxy covers HTTP, HTTPS and WS alike.
 */
async function launchBrowser({ headless = true, proxy = null, ignoreCertErrors = false } = {}) {
  const args = [
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
  // Chromium validates proxied TLS below the browser context, so context-level
  // ignoreHTTPSErrors does not cover a MITM replay. The replay browser only ever
  // talks to the archive's own certificate authority, so this is scoped to it.
  if (ignoreCertErrors) args.push('--ignore-certificate-errors');
  const browser = await chromium.launch({
    headless,
    ...(proxy ? { proxy } : {}),
    args,
  });
  return browser;
}

/**
 * Create a browser context.
 * proxy: { server: 'http://127.0.0.1:1234' } for mirror playback.
 */
async function newContext(
  browser,
  { viewport, proxy = null, ignoreHTTPSErrors = false, reducedMotion = 'no-preference', serviceWorkers = 'allow' },
) {
  const options = {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    userAgent: DEFAULT_UA,
    locale: 'en-US',
    timezoneId: 'UTC',
    ignoreHTTPSErrors,
    colorScheme: 'light',
    reducedMotion,
    serviceWorkers,
  };
  if (proxy) options.proxy = proxy;
  const context = await browser.newContext(options);
  await context.addInitScript(routeSpySource);
  return context;
}

/**
 * Records SPA client-side navigation (pushState / replaceState / popstate) so the
 * crawler can discover routes that never hit the server. This is an observer on
 * the page's own history API, not an evasion technique.
 */
function routeSpySource() {
  if (window.top !== window) return;
  try {
    Object.defineProperty(window, '__mirrorRouteLog', {
      value: [],
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch {
    window.__mirrorRouteLog = [];
  }
  const push = (value) => {
    try {
      const abs = new URL(value, location.href).href;
      if (!window.__mirrorRouteLog.includes(abs)) window.__mirrorRouteLog.push(abs);
    } catch {
      /* ignore */
    }
  };
  const wrap = (fn) =>
    function (...args) {
      try {
        push(args[2] !== undefined ? args[2] : location.href);
      } catch {
        /* ignore */
      }
      return fn.apply(this, args);
    };
  if (window.history && window.history.pushState) {
    window.history.pushState = wrap(window.history.pushState);
    window.history.replaceState = wrap(window.history.replaceState);
  }
  window.addEventListener('popstate', () => push(location.href));
  window.addEventListener('hashchange', () => push(location.href));
}

/** Scroll the page to the bottom in steps to trigger IntersectionObserver / lazy loading. */
async function autoScroll(page, { step = 300, pause = 55, maxMs = 20000 } = {}) {
  try {
    return await page.evaluate(
      async ({ step, pause, maxMs }) => {
        const started = Date.now();
        let lastTotal = document.documentElement.scrollHeight;
        let stable = 0;
        while (Date.now() - started < maxMs) {
          window.scrollBy(0, step);
          await new Promise((r) => setTimeout(r, pause));
          const total = document.documentElement.scrollHeight;
          const atBottom = window.scrollY + window.innerHeight >= total - 2;
          if (atBottom) {
            stable = total === lastTotal ? stable + 1 : 0;
            if (stable >= 3) break;
            await new Promise((r) => setTimeout(r, 300));
          }
          lastTotal = total;
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 120));
        return document.documentElement.scrollHeight;
      },
      { step, pause, maxMs },
    );
  } catch {
    return null;
  }
}

/**
 * Wait for the page to be as settled as it is going to get:
 * load → networkidle → auto-scroll → networkidle again.
 */
async function settle(page, { timeout = 30000, scroll = true, quiet = 1200 } = {}) {
  const deadline = Date.now() + timeout;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.max(5000, timeout / 2) });
  } catch {
    /* keep going — a partial DOM is still worth capturing */
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(15000, Math.max(4000, timeout / 2)) });
  } catch {
    /* networkidle is best-effort by design */
  }
  if (scroll) {
    await autoScroll(page, { maxMs: Math.min(20000, Math.max(5000, timeout / 2)) });
    await page.waitForTimeout(quiet);
    try {
      await page.waitForLoadState('networkidle', { timeout: 6000 });
    } catch {
      /* ignore */
    }
  }
  const remaining = deadline - Date.now();
  if (remaining > 500) await page.waitForTimeout(Math.min(remaining, 800));
}

/** Read routes observed by the history spy. */
async function readRouteLog(page) {
  try {
    return await page.evaluate(() => (Array.isArray(window.__mirrorRouteLog) ? window.__mirrorRouteLog.slice() : []));
  } catch {
    return [];
  }
}

/** Internal links currently rendered in the DOM (works for JS-rendered navs). */
async function extractLinks(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = a.getAttribute('href');
        if (!href) continue;
        if (/^(javascript:|mailto:|tel:|sms:|data:|blob:)/i.test(href)) continue;
        try {
          out.push({ url: new URL(href, location.href).href, text: (a.textContent || '').trim().slice(0, 80) });
        } catch {
          /* ignore */
        }
      }
      return out;
    });
  } catch {
    return [];
  }
}

/** Short, safe description of why a navigation failed. */
function describeError(err) {
  const msg = (err && err.message ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  if (/net::ERR_NAME_NOT_RESOLVED/i.test(msg)) return 'DNS failure';
  if (/net::ERR_CONNECTION_REFUSED/i.test(msg)) return 'connection refused';
  if (/net::ERR_CONNECTION_TIMED_OUT|Timeout/i.test(msg)) return 'timeout';
  if (/net::ERR_CERT/i.test(msg)) return 'TLS certificate error';
  if (/net::ERR_ABORTED/i.test(msg)) return 'navigation aborted';
  if (/403/.test(msg)) return 'HTTP 403';
  return msg.slice(0, 160);
}

function isBotChallenge(status, headers = {}) {
  const server = String(headers['server'] || '').toLowerCase();
  const mitigated = String(headers['cf-mitigated'] || '').toLowerCase();
  if (mitigated === 'challenge') return 'Cloudflare challenge';
  if (server.includes('cloudflare') && (status === 403 || status === 503)) return 'Cloudflare block';
  if (headers['x-datadome'] || headers['x-dd-b']) return 'DataDome block';
  if (headers['x-px'] || headers['x-perimeterx']) return 'PerimeterX block';
  if (status === 429) return 'rate limited (429)';
  return null;
}

module.exports = {
  VIEWPORT_PRESETS,
  DEFAULT_UA,
  resolveViewports,
  launchBrowser,
  newContext,
  settle,
  autoScroll,
  readRouteLog,
  extractLinks,
  describeError,
  isBotChallenge,
  routeSpySource,
};
