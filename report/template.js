'use strict';

/**
 * Renders the single-file HTML report. No external assets, no fonts, no CDN —
 * the report itself must work offline, from disk, forever.
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function scoreColor(n) {
  if (n === null || n === undefined) return 'muted';
  if (n >= 0.9) return 'green';
  if (n >= 0.7) return 'yellow';
  return 'red';
}

function pill(status, label, detail) {
  const map = { green: 'ok', yellow: 'warn', red: 'bad' };
  const cls = map[status] || 'muted';
  return `<span class="pill ${cls}" title="${esc(detail || '')}">${esc(label)}</span>`;
}

function shortUrl(url, max = 68) {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    const s = `${u.host}${p === '/' ? '' : p}`;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return url;
  }
}

function render(data) {
  const s = data.summary;
  const overall = s.overall;
  const ringDeg = overall === null ? 0 : Math.round(overall * 360);
  const issuePages = data.pages.filter((p) => p.hasIssues).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mirror report — ${esc(data.site.domain)}</title>
<style>
  :root{
    --bg:#0b0d10; --panel:#12151a; --panel-2:#0f1216; --line:#232830; --line-soft:#1b2027;
    --txt:#e7e9ee; --muted:#8b95a5; --muted-2:#6b7484;
    --green:#3ddc97; --yellow:#ffc857; --red:#ff6b6b; --blue:#8ab4ff;
    color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);
    font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased}
  a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
  .wrap{max-width:1240px;margin:0 auto;padding:36px 28px 90px}
  header.top{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;
    padding-bottom:22px;border-bottom:1px solid var(--line);margin-bottom:28px}
  .kicker{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.13em;text-transform:uppercase;color:var(--muted-2)}
  h1{margin:8px 0 6px;font-size:27px;letter-spacing:-.02em;font-weight:650}
  .sub{color:var(--muted);font-size:13px}
  .sub code{font:12px ui-monospace,monospace;color:#c6cedb}

  .hero{display:grid;grid-template-columns:auto 1fr;gap:30px;align-items:center;
    background:linear-gradient(180deg,#14181e,#101317);border:1px solid var(--line);border-radius:16px;padding:26px 30px;margin-bottom:24px}
  .ring{--val:${ringDeg}deg;width:132px;height:132px;border-radius:50%;flex:none;position:relative;
    background:conic-gradient(var(--${scoreColor(overall)}) var(--val), #1c222a 0deg)}
  .ring::after{content:"";position:absolute;inset:11px;border-radius:50%;background:#0f1216;border:1px solid var(--line-soft)}
  .ring .num{position:absolute;inset:0;display:grid;place-content:center;text-align:center;z-index:1}
  .ring .num b{font-size:31px;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
  .ring .num span{display:block;font:600 9.5px/1 ui-monospace,monospace;letter-spacing:.13em;color:var(--muted-2);margin-top:7px;text-transform:uppercase}
  .hero-copy h2{margin:0 0 6px;font-size:17px;font-weight:600}
  .hero-copy p{margin:0 0 14px;color:var(--muted);max-width:64ch}
  .bars{display:grid;gap:9px;max-width:520px}
  .bar{display:grid;grid-template-columns:118px 1fr 58px;gap:12px;align-items:center;font-size:12.5px;color:var(--muted)}
  .track{height:6px;border-radius:99px;background:#1c222a;overflow:hidden}
  .fill{height:100%;border-radius:99px}
  .fill.green{background:var(--green)} .fill.yellow{background:var(--yellow)} .fill.red{background:var(--red)} .fill.muted{background:#3a4250}
  .bar b{text-align:right;color:var(--txt);font-variant-numeric:tabular-nums;font-weight:600}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:30px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:15px 17px}
  .card .lbl{font:600 10px/1 ui-monospace,monospace;letter-spacing:.11em;text-transform:uppercase;color:var(--muted-2);margin-bottom:9px}
  .card .big{font-size:21px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .card .hint{font-size:12px;color:var(--muted);margin-top:4px}

  h3.section{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted-2);
    font-family:ui-monospace,monospace;margin:34px 0 12px;display:flex;align-items:center;gap:10px}
  h3.section::after{content:"";flex:1;height:1px;background:var(--line)}

  .banner{border:1px solid rgba(255,200,87,.35);background:rgba(255,200,87,.07);border-radius:12px;padding:14px 17px;margin-bottom:18px;font-size:13px;color:#f3d99a}
  .banner b{color:#ffdd9e}

  .toolbar{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
  .btn{background:#151a20;border:1px solid var(--line);color:var(--muted);border-radius:8px;
    padding:6px 11px;font-size:12.5px;cursor:pointer;font-family:inherit}
  .btn[aria-pressed="true"]{background:#1d2530;border-color:#33404f;color:var(--txt)}
  .toolbar .spacer{flex:1}
  .toolbar .count{font-size:12px;color:var(--muted-2);font-family:ui-monospace,monospace}

  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{text-align:left;font:600 10px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;
    color:var(--muted-2);padding:0 12px 9px;border-bottom:1px solid var(--line);white-space:nowrap}
  tbody td{padding:11px 12px;border-bottom:1px solid var(--line-soft);vertical-align:top}
  tbody tr:hover{background:#101419}
  td.url{max-width:400px}
  td.url .u{font:12.5px/1.45 ui-monospace,monospace;color:#cdd5e2;word-break:break-all}
  td.url .t{font-size:12px;color:var(--muted-2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pills{display:flex;gap:5px;flex-wrap:wrap;max-width:210px}
  .pill{display:inline-block;font:600 10px/1 ui-monospace,monospace;letter-spacing:.04em;padding:5px 7px;border-radius:999px;
    border:1px solid transparent;white-space:nowrap;cursor:default}
  .pill.ok{color:var(--green);background:rgba(61,220,151,.09);border-color:rgba(61,220,151,.28)}
  .pill.warn{color:var(--yellow);background:rgba(255,200,87,.09);border-color:rgba(255,200,87,.28)}
  .pill.bad{color:var(--red);background:rgba(255,107,107,.09);border-color:rgba(255,107,107,.3)}
  .pill.muted{color:var(--muted-2);background:#151a20;border-color:var(--line)}

  .sim{display:flex;align-items:center;gap:8px;min-width:120px}
  .sim .v{font-variant-numeric:tabular-nums;font-weight:600;font-size:12.5px;width:46px}
  .sim .track{width:64px}
  .vp{font:10px ui-monospace,monospace;color:var(--muted-2)}
  .vp-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}

  details{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:0;overflow:hidden;margin-bottom:10px}
  details summary{cursor:pointer;padding:14px 17px;font-size:13px;font-weight:600;list-style:none;display:flex;gap:10px;align-items:center}
  details summary::-webkit-details-marker{display:none}
  details summary .chev{color:var(--muted-2);font-family:ui-monospace,monospace;font-size:11px}
  details[open] summary{border-bottom:1px solid var(--line)}
  details .body{padding:14px 17px}
  .kv{display:grid;grid-template-columns:170px 1fr;gap:6px 16px;font-size:12.5px}
  .kv dt{color:var(--muted-2);font-family:ui-monospace,monospace;font-size:11.5px}
  .kv dd{margin:0;color:#c6cedb;word-break:break-word}
  .reason{display:inline-flex;gap:8px;align-items:center;margin:0 14px 8px 0;font-size:12.5px;color:var(--muted)}
  .reason b{color:var(--txt);font-variant-numeric:tabular-nums}
  .mono{font:12px/1.5 ui-monospace,monospace;color:#c6cedb;word-break:break-all}
  .muted{color:var(--muted)}
  .thumbs{display:flex;gap:8px;flex-wrap:wrap}
  .thumbs a{display:block;border:1px solid var(--line);border-radius:8px;overflow:hidden;width:150px;background:#0b0d10}
  .thumbs img{display:block;width:100%;height:88px;object-fit:cover;object-position:top}
  .thumbs span{display:block;font:10px ui-monospace,monospace;color:var(--muted-2);padding:5px 7px}

  ul.limits{margin:0;padding-left:20px;color:var(--muted);font-size:13px}
  ul.limits li{margin-bottom:7px}
  footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted-2);font-size:12px;
    display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .hidden{display:none!important}
  @media(max-width:820px){.hero{grid-template-columns:1fr}.ring{margin:0 auto}td.url{max-width:220px}}
</style>
</head>
<body>
<div class="wrap">

<header class="top">
  <div>
    <div class="kicker">Site mirror · capture report</div>
    <h1>${esc(data.site.domain)}</h1>
    <div class="sub">Source <a href="${esc(data.site.rootUrl)}" target="_blank" rel="noreferrer">${esc(shortUrl(data.site.rootUrl, 80))}</a>
      · captured ${esc(data.site.capturedAt)} · ${esc(data.site.durationLabel)}
      ${data.site.spaMode ? ' · <span class="mono">SPA routing</span>' : ''}</div>
  </div>
  <div class="sub" style="text-align:right">
    <div><a href="../index.html">Open mirror root</a></div>
    <div><a href="../manifest.json">manifest.json</a></div>
    <div><a href="report.json">report.json</a></div>
  </div>
</header>

${data.site.blocked ? `<div class="banner"><b>Capture stopped early:</b> ${esc(data.site.blocked.reason)} at <span class="mono">${esc(shortUrl(data.site.blocked.url))}</span>. The tool does not attempt to defeat bot protection — this is the honest result.</div>` : ''}
${data.notes && data.notes.length ? `<div class="banner">${data.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : ''}

<section class="hero">
  <div class="ring" role="img" aria-label="Overall completeness ${overall === null ? 'unknown' : pct(overall)}">
    <div class="num"><b>${overall === null ? '—' : Math.round(overall * 100) + '%'}</b><span>completeness</span></div>
  </div>
  <div class="hero-copy">
    <h2>${esc(verdict(overall, issuePages))}</h2>
    <p>${esc(summarySentence(data))}</p>
    <div class="bars">
      ${bar('Page capture', s.capture.ratio, `${s.capture.captured}/${s.capture.capturable}`)}
      ${bar('Asset capture', s.assets.ratio, `${s.assets.saved}/${s.assets.total}`)}
      ${bar('Visual fidelity', s.visual.score, s.visual.score === null ? 'not run' : pct(s.visual.score))}
    </div>
    <div class="muted" style="margin-top:10px;font-size:11.5px">
      Fidelity blends pixel, region, text and height agreement so a missing block cannot hide in a low-contrast layout.
    </div>
  </div>
</section>

<div class="cards">
  <div class="card"><div class="lbl">Pages captured</div><div class="big">${s.capture.captured}</div>
    <div class="hint">${s.capture.skipped} auth-walled · ${s.capture.failed} failed</div></div>
  <div class="card"><div class="lbl">Assets saved</div><div class="big">${s.assets.saved}</div>
    <div class="hint">${s.assets.failed} failed · ${esc(data.site.assetSize)}</div></div>
  <div class="card"><div class="lbl">Visual match</div><div class="big">${s.visual.score === null ? '—' : pct(s.visual.score)}</div>
    <div class="hint">${s.visual.pagesCovered} pages × ${s.visual.viewportCount} viewports</div></div>
  <div class="card"><div class="lbl">Live dependencies</div><div class="big">${data.websockets.length + data.wasm.length}</div>
    <div class="hint">${data.websockets.length} WebSocket · ${data.wasm.length} WASM</div></div>
</div>

<h3 class="section">Pages</h3>
<div class="toolbar">
  <button class="btn" data-filter="all" aria-pressed="true">All <span class="count">${data.pages.length}</span></button>
  <button class="btn" data-filter="issues" aria-pressed="false">Issues only <span class="count">${issuePages}</span></button>
  <div class="spacer"></div>
  <div class="count">green = fully captured · yellow = degraded · red = not captured</div>
</div>
<table id="pages">
  <thead><tr>
    <th style="width:38%">Page</th><th>Status</th><th>Checks</th><th>Visual similarity</th><th>Evidence</th>
  </tr></thead>
  <tbody>
  ${data.pages.map((p) => pageRow(p)).join('\n')}
  </tbody>
</table>

${data.assetFailures.length ? `
<h3 class="section">Asset failures (${data.assetFailures.length})</h3>
<details>
  <summary><span class="chev">▸</span> Grouped by reason</summary>
  <div class="body">
    ${Object.entries(data.assetFailuresByReason)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `<span class="reason"><b>${n}</b> ${esc(r)}</span>`)
      .join('')}
  </div>
</details>
<details>
  <summary><span class="chev">▸</span> Failed URLs (showing ${Math.min(data.assetFailures.length, 120)} of ${data.assetFailures.length})</summary>
  <div class="body">
    <table><tbody>
    ${data.assetFailures
      .slice(0, 120)
      .map(
        (f) => `<tr><td class="url"><div class="u">${esc(shortUrl(f.url, 90))}</div>
          <div class="t">${esc(f.page ? shortUrl(f.page, 60) : '')}${f.resourceType ? ' · ' + esc(f.resourceType) : ''}</div></td>
          <td style="width:180px">${pill(f.severity || 'yellow', f.origin ? `${f.reason} · live site` : f.reason, f.rawError || '')}</td></tr>`,
      )
      .join('')}
    </tbody></table>
  </div>
</details>` : ''}

${data.websockets.length ? `
<h3 class="section">Live backend dependencies</h3>
<details open>
  <summary><span class="chev">▾</span> WebSocket endpoints (${data.websockets.length})</summary>
  <div class="body">
    <dl class="kv">
      ${data.websockets.map((w) => `<dt>${esc(w.messages || 0)} msg</dt><dd class="mono">${esc(w.url)}</dd>`).join('')}
    </dl>
    <p class="muted" style="margin:12px 0 0;font-size:12.5px">These streams are not replayed. Anything rendered from them will be missing or frozen in the local copy.</p>
  </div>
</details>` : ''}

${data.writes && data.writes.length ? `
<h3 class="section">Non-replayable requests</h3>
<details>
  <summary><span class="chev">▸</span> ${data.writes.length} write request${data.writes.length === 1 ? '' : 's'} observed on the live site</summary>
  <div class="body">
    <table><tbody>
      ${data.writes
        .slice(0, 60)
        .map(
          (w) => `<tr><td style="width:78px"><span class="pill muted">${esc(w.method)}</span></td>
            <td class="url"><div class="u">${esc(shortUrl(w.url, 90))}</div>
            <div class="t">${esc(w.page ? shortUrl(w.page, 60) : '')} · HTTP ${esc(w.status)}${w.count > 1 ? ` · ×${esc(w.count)}` : ''}</div></td></tr>`,
        )
        .join('')}
    </tbody></table>
    <p class="muted" style="margin:12px 0 0;font-size:12.5px">A static archive answers these with <code>405</code>. Their responses are deliberately not stored: replaying a POST body would fake a working API.</p>
  </div>
</details>` : ''}

<h3 class="section">What this mirror cannot do</h3>
<ul class="limits">
  <li><b>Authenticated content is out of scope.</b> Pages behind a login are detected and skipped, never forced.</li>
  <li><b>Live data is a snapshot, not a feed.</b> Prices, feeds, stock counters and personalized content will be stale or absent.</li>
  <li><b>WebSocket / server-compute features do not run offline.</b> They are flagged above, not faked.</li>
  <li><b>Bot-protected sites may not load at all.</b> That is recorded as a capture failure, and no evasion is attempted.</li>
  <li><b>Cross-browser pixel differences are noise.</b> Live and local are rendered by the same engine to keep the score honest.</li>
</ul>

<footer>
  <div>sitemirror · frontend-only archive · public content only</div>
  <div class="mono">${esc(data.site.generatedAt)}</div>
</footer>
</div>

<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#pages tbody tr'));
  var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-filter]'));
  var active = 'all';
  function apply() {
    rows.forEach(function (tr) {
      var show = active === 'all' || tr.getAttribute('data-issues') === '1';
      tr.classList.toggle('hidden', !show);
    });
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      active = b.getAttribute('data-filter');
      buttons.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      apply();
    });
  });
})();
</script>
</body>
</html>`;
}

function bar(label, ratio, valueText) {
  const cls = scoreColor(ratio);
  const width = ratio === null || ratio === undefined ? 0 : Math.max(1, Math.round(ratio * 100));
  return `<div class="bar"><span>${esc(label)}</span>
    <div class="track"><div class="fill ${cls}" style="width:${width}%"></div></div>
    <b>${esc(valueText)}</b></div>`;
}

function pageRow(p) {
  const statusPill =
    p.status === 'captured'
      ? pill('green', 'captured')
      : p.status === 'skipped'
        ? pill('red', 'skipped · auth')
        : pill('red', 'failed');

  const checks = [
    p.checks.authWall,
    p.checks.dynamicApi,
    p.checks.wasmSocket,
    p.checks.assetCompleteness,
  ]
    .map((c) => (c ? pill(c.status, shortCheck(c.check), c.detail) : ''))
    .join('');

  const sims = Object.entries(p.similarities || {})
    .map(([vp, v]) => {
      const err = p.diffs && p.diffs[vp] && p.diffs[vp].error;
      if (v === null || v === undefined) {
        return `<div class="vp-row" title="${esc(err || 'no comparison for this viewport')}"><span class="vp">${esc(vp)}</span><span class="mono muted">${err ? 'error' : 'n/a'}</span></div>`;
      }
      const f = (p.fidelity || {})[vp];
      const breakdown = f
        ? `pixel ${pct(f.pixel)} · region ${pct(f.region)} · text ${pct(f.textCoverage)} · height ${pct(f.height)}`
        : '';
      return `<div class="vp-row" title="${esc(breakdown)}"><span class="vp">${esc(vp)}</span>
        <div class="sim"><span class="v">${pct(v)}</span>
        <div class="track"><div class="fill ${scoreColor(v)}" style="width:${Math.max(1, Math.round(v * 100))}%"></div></div></div></div>`;
    })
    .join('');

  const thumbs = Object.entries(p.diffs || {})
    .map(
      ([vp, d]) => `<a href="${esc(d.diffImage)}" target="_blank" rel="noreferrer" title="diff · ${esc(vp)}">
        <img loading="lazy" src="${esc(d.localImage)}" alt="">
        <span>${esc(vp)} · diff ↗</span></a>`,
    )
    .join('');

  const href = p.status === 'captured' ? '../' + p.file : null;

  return `<tr data-issues="${p.hasIssues ? '1' : '0'}">
    <td class="url">
      ${
        href
          ? `<a class="u" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(shortUrl(p.url, 74))}</a>`
          : `<div class="u">${esc(shortUrl(p.url, 74))}</div>`
      }
      <div class="t">${esc(p.title || '—')}${p.discoveryMethod ? ' · ' + esc(p.discoveryMethod) : ''}${
        p.status === 'captured' && p.documentMode
          ? ' · ' + (p.documentMode === 'snapshot' ? 'DOM snapshot' : 'HTML replay')
          : ''
      }</div>
    </td>
    <td>${statusPill}</td>
    <td><div class="pills">${checks}</div></td>
    <td>${sims || '<span class="mono muted">—</span>'}</td>
    <td>${thumbs || '<span class="mono muted">—</span>'}</td>
  </tr>`;
}

function shortCheck(name) {
  return (
    {
      'auth-wall': 'auth',
      'dynamic-api': 'dynamic',
      'wasm-socket': 'live',
      'asset-completeness': 'assets',
    }[name] || name
  );
}

function verdict(overall, issues) {
  if (overall === null) return 'Capture finished — no visual comparison was run';
  if (overall >= 0.95) {
    if (!issues) return 'Faithful mirror — nothing material is missing';
    return `Faithful rendering — ${issues} page${issues === 1 ? '' : 's'} still ${
      issues === 1 ? 'depends' : 'depend'
    } on something a static copy cannot replay`;
  }
  if (overall >= 0.85) return issues ? 'Good mirror — a few pages need attention' : 'Good mirror';
  if (overall >= 0.65) return 'Partial mirror — visible gaps in the local copy';
  return 'Incomplete mirror — most of this site does not survive offline';
}

function summarySentence(data) {
  const s = data.summary;
  const bits = [];
  bits.push(`${s.capture.captured} of ${s.capture.total} discovered pages were archived`);
  if (s.capture.skipped)
    bits.push(
      `${s.capture.skipped} ${s.capture.skipped === 1 ? 'was' : 'were'} behind an auth wall and ${
        s.capture.skipped === 1 ? 'was' : 'were'
      } skipped`,
    );
  if (s.assets.failed) bits.push(`${s.assets.failed} of ${s.assets.total} requested assets could not be saved`);
  if (s.visual.score !== null) bits.push(`live and local renders agree to ${pct(s.visual.score)} across ${s.visual.pagesCovered} pages`);
  return `${bits.join(', ')}.`;
}

module.exports = { render };
