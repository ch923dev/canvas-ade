import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from '@playwright/test'

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

/** Wait until a board's preview runtime reaches `status` (typed `page.evaluate` arg — no eval). */
function waitForStatus(page: Page, id: string, status: string, timeoutMs: number): Promise<void> {
  return expect
    .poll(
      () =>
        page.evaluate(
          ({ bid, want }) => {
            const api = (
              globalThis as unknown as {
                __canvasE2E: { getRuntime(boardId: string): { status?: string } | null }
              }
            ).__canvasE2E
            const r = api.getRuntime(bid)
            return !!r && r.status === want
          },
          { bid: id, want: status }
        ),
      { timeout: timeoutMs, message: `board ${id} reaches ${status}` }
    )
    .toBe(true)
}

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
    await waitForStatus(page, id, 'connected', 12_000)
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

  test('FULL VIEW: the canvas suppresses the focus-fixup that broke typing', async ({ page }) => {
    // Full-view regression: the live subtree is portaled into the modal host, which has NO focusable
    // ancestor between the canvas and <body>. The browser's native mousedown "focus fixup" therefore
    // moved focus to <body> (instead of the .react-flow__node wrapper that exists on-canvas), blurring
    // the hidden IME proxy → keystrokes stopped reaching the page. The fix preventDefault()s the
    // canvas mousedown so that fixup never runs and the proxy keeps focus. We assert that mechanism
    // directly: a cancelable mousedown on the relocated canvas is prevented. (The full click→focus→type
    // path is covered by the normal-view test above on a painted canvas; the OSR bitmap is not reliably
    // painted under headless full view, so a real click there is environment-fragile.)
    const id = await seed(page, 'browser', { url, viewport: 'desktop' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await waitForStatus(page, id, 'connected', 12_000)

    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(id)})`)
    await expect(page.locator('.fullview-scrim .fullview-frame')).toBeVisible()
    await expect(page.locator('.fullview-host .bb-live')).toHaveCount(1)
    await expect(page.locator('.fullview-host .bb-ime-proxy')).toHaveCount(1)
    await page.waitForTimeout(300) // let the open tween settle so listeners are attached

    // A cancelable mousedown on the relocated canvas must be prevented (defaultPrevented) — that is
    // the suppression of the focus-fixup that keeps the proxy focused. `dispatchEvent` returns false
    // when a listener called preventDefault().
    const verdict = await evalIn<string>(
      page,
      `(() => {
        const c = document.querySelector('.fullview-host .bb-live')
        if (!c) return 'no-canvas'
        const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
        return c.dispatchEvent(ev) ? 'fixup-not-suppressed' : 'fixup-suppressed'
      })()`
    )
    expect(verdict, 'canvas mousedown is preventDefault-ed in full view').toBe('fixup-suppressed')

    await evalIn(page, `window.__canvasE2E.closeFullViewAnimated()`)
  })
})
