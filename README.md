# sitemirror

A public, frontend-only website mirror that tells the truth about what it could not copy.

Most archivers silently produce a broken copy: half the images missing, a blank shell where
a feed used to be, a login page saved as if it were content. `sitemirror` crawls a site,
captures every page and asset it is allowed to see, replays it offline **without rewriting a
single URL**, writes a **portable static copy** you can deploy anywhere, and — only if you ask
for it — renders the live and local versions side by side and reports the gap with evidence.

```bash
npm install
npx playwright install chromium

node bin/sitemirror.js
```

That opens an interactive terminal wizard: paste the site address, choose where the archive
lives, pick how hard the mirror should work, review the run, launch. Capture then runs under a
live pipeline dashboard, and the results screen gives you the mirror, the report and the replay
proxy.

```
  █████ █████ █████ █████ █   █ █████ ████  ████  █████ ████
  █       █     █   █     ██ ██   █   █   █ █   █ █   █ █   █
  █████   █     █   ████  █ █ █   █   ████  ████  █   █ ████
      █   █     █   █     █   █   █   █  █  █  █  █   █ █  █
  █████ █████   █   █████ █   █ █████ █   █ █   █ █████ █   █
  OFFLINE MIRROR ENGINE  ·  public surfaces only                  v1.0.0
  ──────────────────────────────────────────────────────────────────────

  ✔ TARGET   ▸ OUTPUT   ○ PROFILE   ○ REVIEW
  ──────────────────────────────────────────────────────────────────────

  STEP 02 / 04   ·   OUTPUT

  Where the archive should live.
  The site gets its own subfolder inside this root.

  ╭─ OUTPUT ROOT ───────────────────────────────────────────────────────╮
  │ ❯ ./archive                                                         │
  ╰─────────────────────────────────────────────────────────────────────╯
  ✔ ~/archive  ·  18.2 GB free

  ──────────────────────────────────────────────────────────────────────
  ⏎ continue     esc back     ctrl+c abort
```

Non-interactive use is unchanged — pass a URL and it still runs, now with the dashboard. For
scripts, CI and pipes, `--plain` restores the original line-by-line output:

```bash
node bin/sitemirror.js https://example.com --out ./archive --plain
```

## Terminal UI

The UI is a zero-dependency ANSI renderer (`core/tui/`). It draws into the terminal's alternate
screen and restores your scrollback on exit, so it never pollutes the shell. Colour degrades
truecolor → 256 → 16 → mono automatically, and glyphs fall back to ASCII on terminals that
cannot be trusted with box drawing.

| Screen | What it does |
|---|---|
| **TARGET** | Paste the site address. `https://` is assumed, the host is validated live, and the archive folder it implies is previewed. |
| **OUTPUT** | Archive root, with `~` shortening and free space on the target volume. |
| **PROFILE** | `RECON` (12 pages, desktop, no diff) · `STANDARD` (40 pages, 3 viewports, static export) · `DEEP` (120 pages) · `CUSTOM`. |
| **OPTIONS** | Only for `CUSTOM`: page cap, politeness delay, viewports, static export, visual diff, click-nav, robots, open-on-finish, headed browser, live fallback, TLS. |
| **REVIEW** | The exact run configuration before anything starts, then a filled `LAUNCH MIRROR` button. |
| **DASHBOARD** | Seven-phase pipeline (crawl → capture → prepare → export → diff → report → serve) with spinner, capture progress bar, live counters, elapsed clock and an activity feed. |
| **RESULTS** | Overall score bar, capture/asset breakdown, archive path, static export path, and the live mirror, report and replay URLs. |
| **ERROR** | The failure, wrapped to width, plus the flags that usually fix it. |

### Keys

| Key | Action |
|---|---|
| `↑` `↓` | Move between options |
| `←` `→` | Change a value |
| `space` | Toggle a switch |
| `⏎` | Confirm / launch / open report |
| `esc` | Back one step (or quit on the first step) |
| `c` | Copy the report URL to the clipboard (results screen) |
| `q` | Stop the servers and exit (results screen) |
| `ctrl+c` | Abort at any point — servers and the capture browser are shut down |

The wizard is the default whenever both stdin and stdout are TTYs. It is skipped automatically
for pipes, CI and `--plain`.

## What it does

1. **Crawl** — respects `robots.txt`, rate-limits, follows links and SPA history routes.
2. **Capture** — every response body Playwright can hand over, into `assets/{css,js,fonts,images,video,models}`.
3. **Replay** — a real MITM proxy serves the archive for the *original hostnames*, so absolute
   and runtime-constructed URLs keep working. No regex rewriting, anywhere.
4. **Diagnose** — auth walls, dynamic/session data, WebSocket and WASM dependencies, asset failures.
5. **Export** — a portable static tree (`_static/`) with every captured reference rewritten to a
   relative path. No manifest, no proxy, no live site required.
6. **Compare** *(optional, last)* — live vs local screenshot diff at three viewports, with masking.
   Opt in with `--diff`; it runs only after capture, export and report work is done.
7. **Report** — `report.json`, a self-contained `report.html`, and diff images.
8. **Serve** — a local preview server with the report mounted at `/__report`.

## Output

```
archive/<domain>/
├── index.html                  # pages at their slug
├── about.html
├── _raw/                       # original server HTML (raw replay)
├── assets/
│   ├── css/  js/  fonts/  images/  video/  models/  data/
├── _static/                    # portable export — deploy this folder as-is
│   ├── index.html              # pretty layout: /about → about/index.html
│   ├── about/index.html
│   ├── assets/                 # rewritten CSS, copied assets
│   ├── EXPORT-NOTES.md         # every reference that still points at the live site
│   └── export-report.json
├── .sitemirror/                # local CA + cert cache — never served over HTTP
├── manifest.json
└── report/
    ├── report.json
    ├── report.html
    ├── diffs/                  # live / local / diff PNGs per page per viewport
    └── screenshots/            # per-viewport captures
```

## Three ways to view a mirror

**Static export (deployable)** — `_static/` is a plain folder: no manifest, no proxy, no live
site. Serve it with `python -m http.server`, nginx, Apache, Netlify, Vercel or S3.

**Preview server** — `http://127.0.0.1:<port>` serves captured pages by path. Fast, but
absolute URLs to the original host still point at the internet.

**Archive proxy (exact replay)** — point a browser at the local proxy and open the *original*
URL. Every request is answered from the archive; uncaptured URLs get an honest 404 (or pass
through with `--allow-live-fallback`). This is what makes `fetch('/api/x')`, CDN subdomains and
runtime-built URLs resolve offline.

```bash
# Option A: proxy auto-config (Firefox, Chrome via system proxy settings)
open http://127.0.0.1:<port>/__proxy.pac

# Option B: set an HTTP/HTTPS proxy manually
#   host 127.0.0.1, port shown in the CLI output, "use for all protocols"

# Trust the local CA so HTTPS replay does not warn (or use a browser profile that trusts it)
curl -o sitemirror-ca.crt http://127.0.0.1:<port>/__ca.crt
```

The CA is generated per archive, lives in `.sitemirror/`, and its private key is never exposed
by the HTTP server. Delete the folder to revoke it.

## Static export

The replay archive deliberately keeps every URL untouched, which is why it needs its proxy.
The static export is the opposite trade: every captured reference is rewritten to a relative
path so the folder works on any hostname.

```bash
# Written automatically after capture (skip with --no-export)
node bin/sitemirror.js https://example.com --out ./archive

# Or re-export an existing archive, any time
node bin/sitemirror.js export ./archive/example.com
node bin/sitemirror.js export ./archive/example.com --layout flat --out ./deploy
```

| Option | Default | Meaning |
|---|---|---|
| `--no-export` | — | Skip the static export entirely |
| `--export-dir <dir>` | `<archive>/_static` | Destination |
| `--export-layout <name>` | `pretty` | `pretty` → `about/index.html`; `flat` → `about.html` |
| `--export-link` | off | Hardlink assets instead of copying (same volume only) |

What gets rewritten:

- `href`, `src`, `poster`, `data`, `action`, `xlink:href` on captured pages and assets;
- `srcset` / `imagesrcset` candidates, descriptors preserved;
- `style="…"` attributes and `<style>` blocks — CSS `url()` and `@import`;
- standalone CSS files, so a stylesheet's own `url()` resolves from its new location;
- `og:image` / `twitter:image` meta content;
- `<base>` is dropped, because it would re-point every relative path.

Every page uses the **raw server HTML** unless the visual diff proved its DOM snapshot renders
better. Snapshot pages get an in-document `script-src 'none'` CSP, matching the proxy's replay
behaviour, so a captured DOM cannot re-hydrate over itself.

Nothing is hidden: `EXPORT-NOTES.md` lists every reference that was never captured and therefore
still points at the live site (a login link, a missing image). The export report at
`export-report.json` carries the same data plus counts and timings.

Deliberate limits: inline scripts are left untouched (runtime-built URLs cannot be rewritten
safely), write requests were never archived, and WebSocket features stay unavailable.

## Scoring

`overall` = 25% page capture + 25% asset capture + 50% visual fidelity.

If the visual comparison could not run — `--diff` was not passed, or every comparison errored —
`overall` is **`null`, not a renormalised 100%**, and the report says so. Capture and asset ratios
are still reported on their own; a mirror that was never compared visually cannot claim
completeness. The visual diff is opt-in precisely because it is the slowest stage, and it runs
after capture and export are already safely on disk.

Two honest exclusions:

- **Auth-walled pages** are removed from the capture denominator — they were never in scope.
- **Origin-side failures** (the live site itself returns 404/500 for a URL) are excluded from the
  asset ratio and shown separately. Those aren't mirror defects.

Per-page **fidelity** blends four signals, because a pixel ratio alone is easy to fool:

| Signal | Weight | What it catches |
|---|---|---|
| `pixel` | 30% | pixelmatch mismatched-pixel ratio — localised colour/layout drift |
| `region` | 35% | 32×32 tile grid; a tile counts as changed when ≥2% of its pixels differ visibly — **a missing content block** |
| `text` | 25% | share of the live page's words present in the local render — missing copy, empty feeds |
| `height` | 10% | full-page height agreement — content lost below the fold |

A dark card grid on a dark page can vanish while costing almost no pixels; the region and text
signals catch that, and every component is written to `report.json` so the number is auditable
rather than magic. Dynamic regions (clocks, ad slots, carousels) can be excluded honestly with
`maskSelectors` / `maskRects` instead of being fudged.

## Replay strategy: raw HTML or DOM snapshot

Each page is stored twice:

- **raw** — the server's original HTML, replayed as-is, so the site's own scripts rebuild the
  page exactly once. This is the default and gives 100% fidelity on normal sites.
- **snapshot** — the post-hydration DOM, for content that only exists after client-side work
  (a feed built from a `POST`, a canvas app, a client-rendered route).

The diff decides per page and per viewport: if raw replay loses structure or text, the snapshot
is rendered and kept **only if it measurably scores better**. The winner is persisted to the
manifest, so every later replay uses it.

Snapshot pages are served with `Content-Security-Policy: script-src 'none'`. Replaying a captured
DOM *with* its scripts re-runs hydration, which typically overwrites the captured content with a
fresh failure state. Inert is the faithful option, and the report labels the page "DOM snapshot".

Write requests (`POST`/`PUT`/`PATCH`/`DELETE`) are **never archived**. A static archive answers
them with `405`, and the report lists them under *Non-replayable requests* — replaying a stored
POST body would fake a working API.

WebSockets are **refused**, not tunnelled: an upgrade gets `501`, so a page's socket fails
honestly instead of quietly reaching the live backend. The proxy never forwards an unknown host
to the network while the archive presents itself as offline — that would let a replay load live
assets and look faithful when nothing was archived. Only `--allow-live-fallback` passes misses
through to the origin.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--out <dir>` | `./archive` | Output root |
| `--profile <name>` | `standard` | `recon` \| `standard` \| `deep` preset |
| `--viewport <spec>` | `desktop,tablet,mobile` | Presets or `WxH[,WxH]` |
| `--max-pages <n>` | `40` | Crawl/capture cap |
| `--delay <ms>` | `700` | Politeness delay between pages |
| `--respect-robots <bool>` | `true` | Obey `robots.txt` |
| `--diff` | off | Run the visual comparison (opt-in, always last) |
| `--no-diff` | — | Explicitly skip the visual comparison (the default) |
| `--diff-max-pages <n>` | `10` | Pages to compare visually |
| `--no-export` | — | Skip the portable static export |
| `--export-dir <dir>` | `<archive>/_static` | Static export destination |
| `--export-layout <name>` | `pretty` | `pretty` directories \| `flat` single files |
| `--export-link` | off | Hardlink assets instead of copying (same volume) |
| `--click-nav` / `--no-click-nav` | on | Probe SPA routes by clicking nav controls |
| `--allow-live-fallback` | off | Proxy passes uncaptured URLs to the live network instead of 404 |
| `--insecure` | off | Accept invalid TLS certificates while capturing (self-signed sites) |
| `--headed` | off | Visible capture browser |
| `--port <n>` | auto | Preview server port |
| `--config <file>` | — | JSON: `maskSelectors`, `maskRects`, `viewports`, `diffViewports`, … |
| `--no-open` | — | Don't open browser tabs at the end |
| `--wizard` | — | Open the wizard even when a URL is given |
| `--tui` / `--plain` | auto | Force the interactive UI or the line-by-line output |
| `--ascii` | auto | ASCII glyphs only (also `SITEMIRROR_ASCII=1`) |
| `-v, --version` | — | Print the version |

Environment overrides for the UI: `NO_COLOR` disables colour, `SITEMIRROR_COLOR=none\|16\|256\|truecolor`
forces a depth, `SITEMIRROR_ASCII=1` forces ASCII glyphs.

### Profiles

| Profile | Pages | Viewports | Visual diff | Typical runtime |
|---|---|---|---|---|
| `recon` | 12 | desktop | off | under a minute |
| `standard` | 40 | 3 | off (`--diff` to opt in) | a few minutes |
| `deep` | 120 | 3 | off (`--diff` to opt in) | longer |

A profile is only a starting point — every value can still be overridden by an explicit flag.


Example masking config:

```json
{
  "maskSelectors": [".ad-slot", "[data-clock]", ".carousel"],
  "maskRects": [{ "x": 0, "y": 0, "width": 1920, "height": 72 }],
  "diffMaxPages": 30
}
```

## Tests

The suite runs against a local fixture site, so it needs no network.

```bash
npm test          # boots the fixture, captures it, kills the origin, replays offline
```

Six stages, all automated:

| Stage | What it does |
|---|---|
| 1 | Runs the static-export rewriter unit tests (`_fixtures/unit-export.js`) — HTML attributes, `srcset`, inline CSS, `url()`/`@import`, `<base>`, layout collisions |
| 2 | Starts `_fixtures/serve.js` on a free port — a mini site with CSS/JS/SVG, a POST-built feed, a session API, a WebSocket, a WASM module and an auth-walled login page |
| 3 | Runs the full pipeline (`_fixtures/e2e.js`) into `_test-archive/127.0.0.1_<port>`, with the diff explicitly enabled |
| 4 | Shuts the origin down, then replays the archive (`_fixtures/verify.js`) and asserts 27 invariants |
| 5 | Serves `_static/` with a plain static file server — no manifest, no proxy — and asserts 13 export invariants (`_fixtures/verify-export.js`) |
| 6 | Repeats the pipeline against a **self-signed HTTPS** fixture and asserts the visual comparison actually scores — the proxy's MITM replay path is only exercised over TLS |

The replay invariants prove: original-hostname replay, asset replay, honest 404s, auth-walled
pages not replayed, SPA catch-all, inert snapshots, `405` on writes, POST bodies not replayable
as GET, `501` on WebSockets, port-aware CONNECT matching, path-traversal blocking, CA key never
served, and coherent manifest stats.

The export invariants prove: the homepage and every pretty-layout route resolve, every local
`href`/`src`/`srcset`/CSS `url()` resolves, the client-rendered page keeps its inert DOM
snapshot with a `script-src 'none'` CSP, the auth-walled page is absent, nothing functional
points back at the live origin, the documented unresolved references are the only broken links,
and the report matches the files actually on disk.

Stage 3 also proves the visual diff scores the mirror (~99.8% on the fixture), and stages 4–5
run with the origin unreachable — so a pass cannot be an accident of a live network. Stage 6
exists because Chromium validates proxied certificates below the browser context: without that
regression check the HTTPS path can fail every comparison while still reporting 100%.

Individual stages:

```bash
node _fixtures/unit-export.js          # pure rewriter checks
node _fixtures/serve.js 8741           # terminal 1
node _fixtures/e2e.js                  # terminal 2 → ./_test-archive
node _fixtures/verify.js "_test-archive/127.0.0.1_8741" "http://127.0.0.1:8741"
node _fixtures/verify-export.js "_test-archive/127.0.0.1_8741"
```

The terminal UI has its own offline tooling — no network, no browser for the interface:

```bash
npm run preview       # render every screen to plain text and check the layout
npm run test:tui      # drive wizard → dashboard → results against the fixture
```

## Limits (deliberate, not bugs)

- **Authenticated content is out of scope.** Login walls are detected and skipped, never forced.
- **Live data is a snapshot.** Prices, feeds and personalised content are frozen or absent.
- **WebSocket / server-compute features do not run offline.** They are flagged, not faked.
- **Bot-protected sites may not load.** That is recorded as an honest failure; no evasion is attempted.
- Cross-browser pixel noise is excluded by rendering both sides in the same engine.
- The replay archive needs the preview server or proxy; the static export is relative and
  deployable anywhere, but `file://` still cannot resolve pretty-layout directory links.

## Layout

```
bin/sitemirror.js        CLI dispatch, flags, styled help, plain mode
core/tui/theme.js        palette, gradients, glyph sets, box/rule/bar primitives
core/tui/screen.js       alternate-screen renderer, cursor placement, resize
core/tui/input.js        raw-mode key parser (arrows, home/end, paste, ctrl keys)
core/tui/frames.js       pure frame renderers for wizard, dashboard, results, error
core/tui/index.js        wizard state machine, capture dashboard, results loop
core/crawler.js          link + SPA-route discovery, robots, rate limit
core/launcher.js         Playwright setup, settle/scroll, bot-challenge detection
core/interceptor.js      response capture, failures, API samples, WebSocket log, writes
core/capture-writer.js   page/asset/artifact writers
core/manifest.js         single source of truth + 3-tier URL lookup
core/proxy.js            MITM replay proxy, local CA, PAC, miss policy
core/static-export.js    portable static tree, HTML/CSS reference rewriter
core/diff-engine.js      live-vs-local fidelity (pixel, region, text, height)
core/server.js           preview server + /__report
core/mirror.js           orchestrator
checks/                  auth-wall, dynamic-api, wasm-socket, asset-completeness
report/                  report.json + self-contained report.html
_fixtures/               local site, HTTPS fixture, e2e harness, export unit +
                         export verifier, TUI preview + TUI e2e
```

## Scope

This tool archives **publicly reachable frontend content only**. It does not log in, defeat bot
protection, or capture anything a normal visitor could not already see.
