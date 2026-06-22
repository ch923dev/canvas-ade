import { createServer, type Server } from 'node:http'

export interface LocalServer {
  url: string
  port: number
  close: () => void
}

// Responsive on purpose (1-E): three breakpoints so a Browser board held at a
// fixed CSS width (390 / 834 / 1280) visibly reflows — column count, tint, and the
// MODE label all change, and the page prints its own innerWidth so you can confirm
// it equals the preset W (the `setZoomFactor` trick is working when it does).
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>localhost preview</title>
<style>
  :root{--accent:#e06f9c}
  *{box-sizing:border-box}
  html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif;background:#fbe9f0;color:#1b1c1e}
  body{padding:18px;transition:background .15s}
  header{display:flex;align-items:center;gap:10px;margin-bottom:14px}
  .dot{width:10px;height:10px;border-radius:10px;background:var(--accent)}
  .mode{font-size:22px;font-weight:800;letter-spacing:-.02em;color:var(--accent)}
  .mode::after{content:'MOBILE · 1 col'}
  .meta{margin:0 0 14px;color:#6b7076;font-size:13px}
  code{font-family:ui-monospace,monospace;color:var(--accent);font-weight:700}
  .grid{display:grid;gap:10px;grid-template-columns:1fr}
  .tile{background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:10px;padding:16px;font-size:13px;box-shadow:0 8px 24px -18px rgba(0,0,0,.4)}
  @media(min-width:600px){
    body{background:#fdf3e0} :root{--accent:#d08a2c}
    .grid{grid-template-columns:1fr 1fr} .mode::after{content:'TABLET · 2 col'}
  }
  @media(min-width:1024px){
    body{background:#e9f0fd} :root{--accent:#3b6fe0}
    .grid{grid-template-columns:repeat(4,1fr)} .mode::after{content:'DESKTOP · 4 col'}
  }
</style></head>
<body>
  <header><span class="dot"></span><span class="mode"></span></header>
  <p class="meta">CSS width <code id="w"></code> · 127.0.0.1 · <span id="t"></span></p>
  <div class="grid">
    <div class="tile">one</div><div class="tile">two</div>
    <div class="tile">three</div><div class="tile">four</div>
  </div>
<script>
  document.title = 'localhost preview OK';
  const w = document.getElementById('w'), t = document.getElementById('t');
  const sync = () => { w.textContent = window.innerWidth + 'px'; };
  sync(); window.addEventListener('resize', sync);
  setInterval(() => { t.textContent = new Date().toLocaleTimeString(); }, 1000);
  console.log('LOCAL_PAGE_OK');
</script></body></html>`

// IDLE (static) page — paints ONCE on load, then NEVER repaints (no setInterval, no animation,
// no JS-driven mutation). This is the page that exposes the "blank until a resize" OSR paint-
// reliability bug: the default clock PAGE above repaints every second, so a board that came up
// blank would self-heal on the next tick and the defect is structurally invisible to every e2e
// that uses it. A genuinely idle page is the only deterministic way to observe "did the first
// frame stick?". Two visually distinct blocks so osrCanvasNonBlank's non-uniform test passes once
// a real frame lands.
const STATIC_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>static idle preview</title>
<style>
  html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}
  body{background:#101418;color:#e9f0fd;padding:24px}
  h1{margin:0 0 16px;font-size:28px;color:#4f8cff}
  .panel{background:#1b2330;border:1px solid #2a3545;border-radius:12px;padding:20px;font-size:15px}
  .bar{height:48px;margin-top:16px;border-radius:8px;background:#4f8cff}
</style></head>
<body>
  <h1>Static idle page</h1>
  <div class="panel">This page paints once and never repaints — no timers, no animation.</div>
  <div class="bar"></div>
<script>document.title = 'static idle preview OK'; console.log('STATIC_PAGE_OK');</script>
</body></html>`

/** Tiny loopback HTTP server so the WebContentsView smoke works in dev AND in
 *  the packaged build (no Vite dev server to depend on). */
export function startLocalServer(): Promise<LocalServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // `/static` (and `/static2`) serve the IDLE page (paints once, never repaints) — the page
      // that surfaces the OSR "blank until resize" paint-reliability bug. Everything else keeps the
      // existing clock page so the rest of the suite is unchanged. `/static2` is byte-identical;
      // it exists so a test can navigate board → 2nd idle URL and re-test the post-nav first paint.
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/static' || path === '/static2') {
        res.end(STATIC_PAGE)
        return
      }
      res.end(PAGE)
    })
    // Without this, a listen() failure (EACCES from an AV/firewall loopback-bind
    // denial, EMFILE/ENFILE under fd exhaustion, ENETDOWN) is re-thrown by Node as
    // an uncaughtException and tears the app down at startup. Reject instead so the
    // caller can surface a diagnostic / degrade gracefully.
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      // BUG-027: keep a permanent 'error' handler for accept-time failures (EMFILE/ENFILE)
      // that arrive after listen() succeeds. Without it, an 'error' event with no listener
      // throws synchronously into the uncaughtException sink -> crashShutdown(1) -> app.exit(1),
      // killing all live PTY sessions. Log and degrade instead.
      server.on('error', (err: Error) => {
        console.error('[localServer] accept error (continuing):', err)
      })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () => server.close()
      })
    })
  })
}
