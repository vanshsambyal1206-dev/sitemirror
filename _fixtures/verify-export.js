'use strict';

/**
 * Static export verifier.
 *
 *   node _fixtures/verify-export.js <archive-dir>
 *
 * Serves `<archive>/_static` with a plain static file server — no manifest, no
 * replay proxy, no live origin — and asserts the export actually works as a
 * deployable site: pages resolve, CSS/images/scripts resolve relatively, the
 * client-rendered page keeps its inert snapshot, and the only broken links are
 * the ones EXPORT-NOTES.md documents.
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function startStaticServer(root) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://static.local');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('bad path');
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      res.writeHead(404).end('not found');
      return;
    }
    if (stat.isDirectory()) {
      try {
        stat = await fsp.stat(path.join(file, 'index.html'));
      } catch {
        res.writeHead(404).end('not found');
        return;
      }
      return sendFile(res, path.join(file, 'index.html'));
    }
    return sendFile(res, file);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function sendFile(res, file) {
  const body = await fsp.readFile(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'content-length': body.length });
  res.end(body);
}

function httpGet(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Local (non-absolute) references in one HTML document. */
function htmlRefs(html) {
  const refs = [];
  const attr = /\b(?:href|src|poster|data)\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = attr.exec(html))) refs.push(m[1]);
  const srcset = /\b(?:srcset|imagesrcset)\s*=\s*"([^"]*)"/gi;
  while ((m = srcset.exec(html))) {
    for (const part of m[1].split(',')) {
      const u = part.trim().split(/\s+/)[0];
      if (u) refs.push(u);
    }
  }
  const inline = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  while ((m = inline.exec(html))) refs.push(m[2]);
  return refs;
}

function cssRefs(css) {
  const refs = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(css))) refs.push(m[2]);
  return refs;
}

function isLocalRef(ref) {
  const v = ref.trim();
  if (!v || v.startsWith('#')) return false;
  if (/^(?:data|blob|mailto|tel|javascript|about|chrome|file|ftp):/i.test(v)) return false;
  if (/^https?:/i.test(v) || v.startsWith('//')) return false;
  return true;
}

function resolveLocal(basePath, ref) {
  try {
    return new URL(ref, `http://static.local${basePath}`).pathname;
  } catch {
    return null;
  }
}

async function main() {
  const archiveDir = path.resolve(process.argv[2] || '_test-archive/127.0.0.1_8741');
  const exportDir = path.resolve(process.argv[3] || path.join(archiveDir, '_static'));

  if (!fs.existsSync(exportDir)) throw new Error(`no static export at ${exportDir}`);

  const reportPath = path.join(exportDir, 'export-report.json');
  const report = JSON.parse(await fsp.readFile(reportPath, 'utf8'));
  const notes = await fsp.readFile(path.join(exportDir, 'EXPORT-NOTES.md'), 'utf8');

  // The unresolved references are expected to 404 on a plain server; that is
  // precisely what the notes document. Everything else must resolve.
  const documented = new Set((report.unresolved || []).map((u) => u.ref));

  const server = await startStaticServer(exportDir);
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const root = await httpGet(server.port, '/');
    check(
      'export root serves the homepage',
      root.status === 200 && /Deterministic fixture/.test(root.body),
      `status ${root.status}, ${root.body.length}b`,
    );

    const about = await httpGet(server.port, '/about/');
    check('pretty layout: /about/ resolves', about.status === 200 && /About/i.test(about.body), `status ${about.status}`);

    const gallery = await httpGet(server.port, '/gallery/');
    check('pretty layout: /gallery/ resolves', gallery.status === 200, `status ${gallery.status}`);

    const spa = await httpGet(server.port, '/spa/');
    check(
      'client-rendered page exports its rendered DOM',
      spa.status === 200 && /Rendered on the client/.test(spa.body),
      `status ${spa.status}, ${spa.body.length}b`,
    );
    check(
      'snapshot page is inert in the static export',
      /http-equiv="Content-Security-Policy"[^>]*script-src 'none'/i.test(spa.body),
      'CSP meta present',
    );

    const login = await httpGet(server.port, '/login');
    check('auth-walled page was not exported', login.status === 404, `status ${login.status}`);

    // Walk every local reference in every exported HTML file and require it to
    // resolve, unless it is one of the documented unresolved live references.
    const htmlFiles = [];
    const walk = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.html?$/i.test(entry.name)) htmlFiles.push(full);
      }
    };
    await walk(exportDir);

    const broken = [];
    const checked = new Set();
    for (const file of htmlFiles) {
      const rel = path.relative(exportDir, file).split(path.sep).join('/');
      const basePath = `/${rel}`;
      const html = await fsp.readFile(file, 'utf8');
      for (const ref of htmlRefs(html)) {
        if (!isLocalRef(ref)) continue;
        const target = resolveLocal(basePath, ref);
        if (!target || checked.has(target)) continue;
        checked.add(target);
        const res = await httpGet(server.port, target);
        if (res.status !== 200 && !documented.has(ref) && !documented.has(target)) {
          broken.push(`${rel} → ${ref} (${res.status})`);
        }
      }
    }
    check(
      'every local HTML reference resolves',
      broken.length === 0,
      broken.length ? broken.slice(0, 6).join('; ') : `${checked.size} reference(s) checked`,
    );

    // CSS files must be rewritten too: a stylesheet is fetched by the browser
    // from its own location, so a root-relative url() would 404.
    const cssFiles = [];
    const walkCss = async (dir) => {
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walkCss(full);
        else if (/\.css$/i.test(entry.name)) cssFiles.push(full);
      }
    };
    await walkCss(exportDir);

    const brokenCss = [];
    for (const file of cssFiles) {
      const rel = path.relative(exportDir, file).split(path.sep).join('/');
      const css = await fsp.readFile(file, 'utf8');
      for (const ref of cssRefs(css)) {
        if (!isLocalRef(ref)) continue;
        const target = resolveLocal(`/${rel}`, ref);
        if (!target) continue;
        const res = await httpGet(server.port, target);
        if (res.status !== 200 && !documented.has(ref)) brokenCss.push(`${rel} → ${ref} (${res.status})`);
      }
    }
    check(
      'every CSS url() resolves',
      brokenCss.length === 0,
      brokenCss.length ? brokenCss.slice(0, 6).join('; ') : `${cssFiles.length} stylesheet(s) checked`,
    );

    // Nothing functional may still be hard-wired to the live origin: the export
    // has to work on a hostname that is not the mirrored one. Metadata such as
    // `<meta name="sitemirror-source">` and plain-text provenance comments are
    // not references and are allowed.
    const origin = (report.rootUrl || '').replace(/\/$/, '');
    const originHost = origin ? new URL(origin).host : '';
    const liveRefs = [];
    for (const file of [...htmlFiles, ...cssFiles]) {
      const rel = path.relative(exportDir, file).split(path.sep).join('/');
      const body = await fsp.readFile(file, 'utf8');
      const refs = /\.css$/i.test(file) ? cssRefs(body) : htmlRefs(body);
      for (const ref of refs) {
        const v = ref.trim();
        const abs = v.startsWith('//') ? `http:${v}` : v;
        let u;
        try {
          u = new URL(abs);
        } catch {
          continue;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (originHost && u.host === originHost) liveRefs.push(`${rel} → ${v}`);
      }
    }
    check(
      'no exported reference points at the live origin',
      liveRefs.length === 0,
      liveRefs.length ? liveRefs.slice(0, 6).join('; ') : 'clean',
    );

    check('EXPORT-NOTES.md documents the export', /# Static export/.test(notes), `${notes.length}b`);
    check(
      'unresolved references are documented, not silently rewritten',
      (report.unresolved || []).length === 0 || notes.includes('still point at the live site'),
      `${(report.unresolved || []).length} unresolved`,
    );
    check(
      'export report matches the files on disk',
      report.pages === htmlFiles.length && report.pages > 0,
      `${report.pages} page(s) reported, ${htmlFiles.length} html file(s)`,
    );

    // The archive's replay machinery must not be required at all.
    check('no manifest.json needed to serve the export', !fs.existsSync(path.join(exportDir, 'manifest.json')));
  } finally {
    await server.stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
