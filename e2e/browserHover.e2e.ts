import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import { createServer, type Server } from 'node:http'
import type { ElectronApplication, Page } from '@playwright/test'

// Regression for the OSR Browser-board HOVER-MISALIGNMENT bug: the renderer forwards pointer coords
// in page-logical CSS px, but the offscreen window is sized to logical·S with page zoom S (the M1
// supersample), so `sendInputEvent` coords must be scaled by S into the widget's space. Before the
// fix MAIN forwarded them unscaled → the page hit-tested at (x/S, y/S), i.e. up-and-left of the real
// cursor, worsening with distance from the top-left (the "hover lands on something else" report).
//
// This pins the END-TO-END contract deterministically: it forces S=2 via the REAL resize IPC, sends a
// known LOGICAL coordinate via the REAL input IPC, and reads back where the offscreen page recorded
// the cursor. With the fix the page sees the logical coord; before it, half of it. (Unit coverage of
// the scaling math itself is `scaleOsrInputEvent` in src/main/previewOsr.test.ts.)

// A full-viewport page that records the last mousemove position (CSS px) the page received.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>hover</title>
<style>html,body{margin:0;height:100%;width:100%}#pad{width:100%;height:100%}</style>
</head><body><div id="pad"></div>
<script>
  window.__m = null;
  document.addEventListener('mousemove', function (e) { window.__m = { x: e.clientX, y: e.clientY }; });
</script></body></html>`

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

/** Read the offscreen preview page's last-recorded mousemove position (the page runs in MAIN). */
function readOsrMove(
  app: ElectronApplication,
  urlPrefix: string
): Promise<{ x: number; y: number } | null> {
  return app
    .evaluate(async ({ BrowserWindow }, prefix) => {
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          const u = w.webContents.getURL()
          if (u && u.startsWith(prefix)) {
            return (await w.webContents.executeJavaScript('JSON.stringify(window.__m)')) as string
          }
        } catch {
          /* window busy */
        }
      }
      return null
    }, urlPrefix)
    .then((s) => (s ? (JSON.parse(s) as { x: number; y: number }) : null))
}

test.describe('@preview browser hover alignment (OSR pointer → offscreen page)', () => {
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

  test('a forwarded pointer lands under the cursor at supersample 2 (not up-left)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'browser', { url, viewport: 'desktop' }) // desktop preset = 1280×800
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await waitForStatus(page, id, 'connected', 12_000)
    await page.waitForTimeout(500) // let the first frame paint + any zoom-settle land

    // Force supersample = 2 via the REAL resize IPC — deterministic, independent of camera/DPR. This
    // is exactly what `applyOsrSize` does: setContentSize(1280·2 × 800·2) + setZoomFactor(2). After it
    // the page still lays out at 1280×800 CSS px, so a logical coord is still in [0,1280]×[0,800].
    // (String `evalIn` like the other `window.api.*` probes — typed `page.evaluate` would need the DOM
    // `window` global the e2e tsconfig omits.)
    await evalIn(
      page,
      `window.api.resizeOsr(${JSON.stringify(id)}, { logicalW: 1280, logicalH: 800, supersample: 2 })`
    )
    await page.waitForTimeout(250) // let setContentSize + setZoomFactor + relayout settle

    // Send a known LOGICAL coordinate straight through the real input IPC (bypassing the renderer's
    // canvas-rect mapping so the test pins the MAIN-side scaling contract, not the rect math).
    const LX = 400
    const LY = 300
    await evalIn(
      page,
      `window.api.sendOsrInput(${JSON.stringify(id)}, { type: 'mouseMove', x: ${LX}, y: ${LY}, modifiers: [] })`
    )

    // The offscreen page recorded where IT thinks the cursor is (CSS px). With the fix this equals the
    // logical coord we sent; the pre-fix bug recorded (200,150) — half, the misaligned hover.
    const got = await expect
      .poll(() => readOsrMove(electronApp, url), {
        timeout: 4_000,
        message: 'offscreen page receives the forwarded mousemove'
      })
      .not.toBeNull()
      .then(() => readOsrMove(electronApp, url))

    expect(got, 'page received a mousemove').not.toBeNull()
    // Allow ±2px for integer rounding of the S transform; reject the pre-fix half-coordinate.
    expect(
      Math.abs(got!.x - LX),
      `hover X under cursor (got ${got!.x}, want ${LX})`
    ).toBeLessThanOrEqual(2)
    expect(
      Math.abs(got!.y - LY),
      `hover Y under cursor (got ${got!.y}, want ${LY})`
    ).toBeLessThanOrEqual(2)
  })
})
