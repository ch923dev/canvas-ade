import { createServer, type Server } from 'node:http'

export interface LocalServer {
  url: string
  port: number
  close: () => void
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>localhost preview</title>
<style>
  html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#fbfbfa;color:#1b1c1e;display:grid;place-items:center}
  .card{padding:26px 30px;border:1px solid #e6e6e3;border-radius:12px;text-align:center;box-shadow:0 10px 30px -18px rgba(0,0,0,.3)}
  h1{margin:0 0 8px;font-size:20px;font-weight:700;letter-spacing:-.01em}
  p{margin:2px 0;color:#6b7076;font-size:13px}
  .dot{display:inline-block;width:9px;height:9px;border-radius:9px;background:#3ecf8e;margin-right:7px;vertical-align:middle}
  code{font-family:ui-monospace,monospace;color:#3b6fe0}
</style></head>
<body><div class="card">
  <h1><span class="dot"></span>WebContentsView loaded a localhost page</h1>
  <p>Served from <code>127.0.0.1</code> by the Electron main process.</p>
  <p>Canvas ADE — Phase 0 preview smoke · <span id="t"></span></p>
</div>
<script>
  document.title = 'localhost preview OK';
  const t = document.getElementById('t');
  setInterval(() => { t.textContent = new Date().toLocaleTimeString(); }, 1000);
  console.log('LOCAL_PAGE_OK');
</script></body></html>`

/** Tiny loopback HTTP server so the WebContentsView smoke works in dev AND in
 *  the packaged build (no Vite dev server to depend on). */
export function startLocalServer(): Promise<LocalServer> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    server.listen(0, '127.0.0.1', () => {
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
