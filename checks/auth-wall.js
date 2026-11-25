'use strict';

/**
 * Auth-wall check.
 *
 * The tool never attempts to log in, guess credentials, or lift a session. If a
 * page is gated, it is recorded as "skipped — requires authentication" and left
 * out of the capture.
 */

const LOGIN_URL = /(^|\/)(login|log-in|signin|sign-in|auth|sso|oauth|session|account\/login|users\/sign_in)(\/|\?|$)/i;

function run({ url, finalUrl, status, headers = {}, dom = {} }) {
  const reasons = [];

  if (status === 401) reasons.push('server returned 401 Unauthorized');
  if (status === 403 && !isChallenge(headers)) reasons.push('server returned 403 Forbidden');

  const redirected = finalUrl && url && stripTrailing(finalUrl) !== stripTrailing(url);
  if (redirected && LOGIN_URL.test(new URL(finalUrl).pathname)) {
    reasons.push(`redirected to login flow (${new URL(finalUrl).pathname})`);
  }

  if (dom.hasPasswordField && dom.hasForm && (dom.textLength || 0) < 8000) {
    reasons.push('page is a credential form (password input inside a form)');
  }

  if (dom.title && /^(log ?in|sign ?in|authentication required|access denied)/i.test(dom.title.trim()) && dom.hasPasswordField) {
    reasons.push(`page title indicates a gate ("${dom.title.trim()}")`);
  }

  if (reasons.length === 0) {
    return {
      check: 'auth-wall',
      status: 'green',
      detail: 'publicly reachable without credentials',
      meta: {},
    };
  }

  return {
    check: 'auth-wall',
    status: 'red',
    detail: `skipped — requires authentication (${reasons.join('; ')})`,
    skip: true,
    meta: { reasons },
  };
}

function isChallenge(headers) {
  const h = headers || {};
  if (String(h['cf-mitigated'] || '').toLowerCase() === 'challenge') return true;
  if (h['x-datadome'] || h['x-px']) return true;
  return false;
}

function stripTrailing(s) {
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return s;
  }
}

module.exports = { name: 'auth-wall', run };
