// scripts/serve-local-feed.mjs
/**
 * Loopback-only static server for the PERSONAL local update feed (dev-only channel — see
 * docs/contributing/releasing.md › Local update channel and src/main/localUpdateFeed.ts).
 *
 * Serves the flat feed dir (latest.yml + installer + .blockmap + updates.json) over plain
 * HTTP on 127.0.0.1. Deliberately minimal:
 *   • binds 127.0.0.1 EXPLICITLY — never 0.0.0.0; LAN peers must not even read the feed.
 *   • flat-dir only: the request path is reduced to its basename, so traversal is impossible.
 *   • GET/HEAD only; no Range support — electron-updater's differential download then falls
 *     back to a full download, which is instant on loopback anyway.
 *
 * Usually spawned (detached) by scripts/release-local.mjs when the port is dead; can also be
 * run by hand:  node scripts/serve-local-feed.mjs
 * Env: EXPANSE_LOCAL_FEED_DIR (default C:\expanse\local-feed) · EXPANSE_LOCAL_FEED_PORT (8090).
 */
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join, basename, extname } from 'node:path'

const dir = process.env.EXPANSE_LOCAL_FEED_DIR ?? 'C:\\expanse\\local-feed'
const port = Number(process.env.EXPANSE_LOCAL_FEED_PORT ?? 8090)

const TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream'
}

createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  // basename() flattens any ../ or subpath attempt — the feed dir is flat by construction.
  const name = basename(decodeURIComponent((req.url ?? '/').split('?')[0]))
  const path = join(dir, name)
  let st
  try {
    st = statSync(path)
  } catch {
    res.writeHead(404).end()
    return
  }
  if (!st.isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'content-length': st.size,
    'content-type': TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(path).pipe(res)
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`[local-feed] serving ${dir} on http://127.0.0.1:${port}/\n`)
})
