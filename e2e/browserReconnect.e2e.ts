import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'
import { createServer, type Server } from 'http'
import { once } from 'events'

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const addr = s.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

test.describe('browser board — auto-reconnect', () => {
  test('a refused board auto-connects once the dev server comes up', async ({ page }) => {
    const port = await freePort()
    const url = `http://127.0.0.1:${port}/`
    const id = await seed(page, 'browser', { url, viewport: 'desktop' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

    const failed = await pollEval(page, runtimeStatus(id, 'load-failed'), 12_000)
    expect(failed, 'reaches load-failed while nothing is listening').toBe(true)

    // Now start a server on that exact port — the engine should auto-reload + connect.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>up</title><h1>up</h1>')
    })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    try {
      const connected = await pollEval(page, runtimeStatus(id, 'connected'), 20_000)
      expect(connected, 'auto-reconnects without a manual reload').toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
