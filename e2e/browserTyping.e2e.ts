import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication } from '@playwright/test'

// Regression for the "clicks work, typing doesn't" OSR Browser-board bug: React Flow focuses the
// `.react-flow__node` wrapper on a canvas click, stealing DOM focus from the hidden `.bb-ime-proxy`
// textarea → keystrokes routed to the node (not the page) and the page's CDP focus-emulation dropped.
// The MAIN-side `Input.insertText` path was always fine; the defect was purely renderer focus. This
// drives a REAL click + REAL keystrokes into a Browser board pointed at a real <input> and asserts
// the text lands in the offscreen page — the end-to-end assertion the prior emit-level unit test lacked.

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>init</title>
<style>html,body{margin:0;height:100%}#t{width:100%;height:100%;font-size:40px;box-sizing:border-box}</style>
</head><body>
<input id="t" autofocus placeholder="type here" />
<script>
  var t = document.getElementById('t');
  t.addEventListener('input', function(){ document.title = 'VAL:' + t.value; });
</script></body></html>`

const runtimeStatus = (id: string, status: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(status)}; })()`

/** Read the offscreen preview page's focus + field value from MAIN (the hidden window is in MAIN). */
function readOsrField(app: ElectronApplication, urlPrefix: string): Promise<string | null> {
  return app.evaluate(async ({ BrowserWindow }, prefix) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        const u = w.webContents.getURL()
        if (u && u.startsWith(prefix)) {
          return (await w.webContents.executeJavaScript(
            `JSON.stringify({val: (document.activeElement && 'value' in document.activeElement) ? document.activeElement.value : null, hasFocus: document.hasFocus()})`
          )) as string
        }
      } catch {
        /* window busy */
      }
    }
    return null
  }, urlPrefix)
}

test.describe('@preview browser typing (OSR keyboard → offscreen page)', () => {
  let server: Server
  let url = ''

  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  })

  test.afterAll(() => server?.close())

  test('a canvas click keeps the proxy focused and real typing lands in the page', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'browser', { url, viewport: 'desktop' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000), 'connected').toBe(true)
    await page.waitForTimeout(500) // let the first frame paint

    // Click the live canvas (the <input> fills the page, so the click lands on it).
    await page
      .locator('.bb-live')
      .first()
      .click({ position: { x: 60, y: 40 } })
    await page.waitForTimeout(200)

    // Regression guard #1: the click must NOT leave focus on the React Flow node — it must land on
    // the IME proxy, else keystrokes never reach the page.
    const activeClass = await evalIn<string>(
      page,
      `(document.activeElement && document.activeElement.className) || ''`
    )
    expect(activeClass, 'proxy keeps focus after a canvas click').toContain('bb-ime-proxy')

    // Regression guard #2: the offscreen page's focus-emulation must survive the click.
    const afterClick = JSON.parse((await readOsrField(electronApp, url)) ?? '{}')
    expect(afterClick.hasFocus, 'offscreen page stays focus-emulated after click').toBe(true)

    // The real assertion: typed text lands in the focused field of the offscreen page.
    await page.keyboard.type('hello world', { delay: 30 })
    await page.waitForTimeout(300)
    const afterType = JSON.parse((await readOsrField(electronApp, url)) ?? '{}')
    expect(afterType.val, 'typed text reached the offscreen page input').toBe('hello world')
  })
})
