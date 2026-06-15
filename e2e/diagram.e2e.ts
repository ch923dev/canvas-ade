import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @planning Mermaid Diagram element (v11 / S4) — the real-app integration jsdom CANNOT prove: a
 * `diagram` element with no svgCache must drive the HIDDEN MAIN render worker (a real Chromium
 * BrowserWindow with scoped `unsafe-eval`), get back sanitized SVG, and display it as an inert
 * `<img>` blob. jsdom stubs `getComputedTextLength`/`getBBox` to 0, so Mermaid layout only works in
 * a real browser — exactly why the worker exists and why this is an e2e, not a unit test.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids/source flow as DATA, never
 * interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
 */

/** Seed a planning board carrying one un-rendered diagram element (svgCache absent → must render). */
async function seedDiagram(page: Page, source: string): Promise<string> {
  const id = await seed(page, 'planning')
  await page.evaluate(
    ({ boardId, src }) => {
      ;(globalThis as any).__canvasE2E.patchBoard(boardId, {
        elements: [
          {
            id: 'dg-1',
            kind: 'diagram',
            x: 40,
            y: 40,
            w: 320,
            h: 220,
            source: src,
            engine: 'mermaid'
          }
        ]
      })
    },
    { boardId: id, src: source }
  )
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(300)
  return id
}

test.describe('@planning diagram element (real Mermaid worker)', () => {
  test('renders a flowchart source to an inert SVG <img> via the hidden worker', async ({
    page
  }) => {
    await seedDiagram(page, 'graph TD\n  A[Plan] --> B[Build]\n  B --> C[Verify]')

    // The worker spawns a BrowserWindow + loads Mermaid on first render — allow a generous budget.
    const img = page.locator('.pl-diagram img')
    await expect(img).toBeVisible({ timeout: 20000 })
    // Displayed as a blob: object URL (CSP img-src blob:) — never an inline data: or remote URL.
    await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 20000 })
    // The error fallback must NOT be showing for a valid source.
    await expect(page.locator('.pl-diagram-state')).toHaveCount(0)

    await page.screenshot({ path: 'test-results/diagram-flowchart.png' })
  })

  test('shows an inline parse error for an invalid source (no crash)', async ({ page }) => {
    await seedDiagram(page, 'graph TD\n  A --> ((((')
    // A bad source resolves to the error state, not a thrown render / blank img.
    await expect(page.locator('.pl-diagram-state')).toContainText(/error/i, { timeout: 20000 })
    await expect(page.locator('.pl-diagram img')).toHaveCount(0)
  })
})
