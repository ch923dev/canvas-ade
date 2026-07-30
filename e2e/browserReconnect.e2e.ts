import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, seed } from './helpers'
import { createServer, type Server } from 'http'
import { once } from 'events'

/** The board's preview runtime, read as a VALUE (the id crosses as a real arg, never spliced). */
const runtimeOf = (page: Page, id: string): Promise<{ status: string } | null> =>
  callE2E<{ status: string } | null>(page, { m: 'getRuntime', a: [id] })

/** Poll until the runtime reaches `status` — the comparison runs HERE in Node, so neither the
 *  seeded id nor the wanted status ever enters page code. Same boolean contract as `pollEval`. */
async function pollStatus(
  page: Page,
  id: string,
  status: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(async () => (await runtimeOf(page, id))?.status === status, { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const addr = s.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

test.describe('@preview browser board — auto-reconnect', () => {
  test('a refused board auto-connects once the dev server comes up', async ({ page }) => {
    const port = await freePort()
    const url = `http://127.0.0.1:${port}/`
    const id = await seed(page, 'browser', { url, viewport: 'desktop' })
    await page.waitForTimeout(150)
    await callE2E(page, { m: 'fitView', a: [id] })

    const failed = await pollStatus(page, id, 'load-failed', 12_000)
    expect(failed, 'reaches load-failed while nothing is listening').toBe(true)

    // Now start a server on that exact port — the engine should auto-reload + connect.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>up</title><h1>up</h1>')
    })
    server.listen(port, '127.0.0.1')
    await once(server, 'listening')
    try {
      const connected = await pollStatus(page, id, 'connected', 20_000)
      expect(connected, 'auto-reconnects without a manual reload').toBe(true)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
