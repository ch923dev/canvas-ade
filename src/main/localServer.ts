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

/** Tiny loopback HTTP server so the WebContentsView smoke works in dev AND in
 *  the packaged build (no Vite dev server to depend on). */
export function startLocalServer(): Promise<LocalServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
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
