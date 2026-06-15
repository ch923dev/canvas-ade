import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * D4-C wayfinding minimap — the real-input slivers jsdom can't prove:
 *  - the bare `m` chord arriving through the real OS path into the window keymap
 *    (and the sticky localStorage round-trip behind it),
 *  - click-to-jump on a REAL minimap node rect (svg hit-testing + the RF pointer
 *    plumbing; the synthetic-handler contract is pinned in MinimapIsland.test.tsx),
 *  - ADR 0002: a live native preview overlapping the island demotes to its snapshot
 *    while the minimap is visible and reattaches when it hides,
 *  - Esc layering: the minimap is persistent chrome, NOT an Esc layer — full view
 *    still exits on the first Esc with the island up, and the island survives it.
 * Sticky-state isolation: e2eHooks.reset() hides the minimap + clears the
 * localStorage key before EVERY test (persistent-userData self-ratchet class), so
 * each test below starts from the shipped first-run default (hidden).
 */
const minimap = (page: Page) => page.locator('.react-flow__minimap')
const stickyKey = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const g = globalThis as unknown as {
      localStorage: { getItem: (k: string) => string | null }
    }
    return g.localStorage.getItem('ca.canvas.minimapVisible')
  })

test.describe('@chrome D4-C wayfinding minimap (real OS input)', () => {
  test('bare M toggles the island and the choice persists (localStorage)', async ({ page }) => {
    await seed(page, 'planning')
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(200)
    await expect(minimap(page)).toHaveCount(0) // first-run default: hidden

    await page.keyboard.press('m')
    await expect(minimap(page)).toBeVisible()
    expect(await stickyKey(page)).toBe('1') // remembered across sessions

    await page.keyboard.press('m')
    await expect(minimap(page)).toHaveCount(0)
    expect(await stickyKey(page)).toBe('0')
  })

  test('the palette verb toggles it too (Ctrl+K → "Toggle minimap")', async ({ page }) => {
    await seed(page, 'planning')
    await page.keyboard.press('Control+k')
    await expect(page.locator('[data-test=command-palette]')).toBeVisible()
    await page.keyboard.type('minimap')
    await expect(page.locator('[data-test=palette-row-toggle-minimap]')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-test=command-palette]')).toHaveCount(0)
    await expect(minimap(page)).toBeVisible()
  })

  test('clicking a board rect in the minimap jumps the camera to that board', async ({ page }) => {
    // Two planning boards far apart; camera parked on A so B starts off-screen.
    const a = await seed(page, 'planning')
    const b = await seed(page, 'planning', { x: 4000, y: 2400 })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(a)})`)
    await page.waitForTimeout(300)

    await page.keyboard.press('m')
    await expect(minimap(page)).toBeVisible()
    // Let the island's 120ms entrance fade fully settle before measuring/clicking —
    // a click raced into the fade is what Playwright's "element is not stable"
    // retries were absorbing (the matrix first-try flake window).
    await page.waitForTimeout(200)
    const rects = page.locator('.react-flow__minimap-node')
    await expect(rects).toHaveCount(2)
    // B is the bottom-right board, so its minimap rect is the further-right one —
    // identify by geometry (minimap nodes carry no data-id), then REAL-click it.
    const box0 = await rects.nth(0).boundingBox()
    const box1 = await rects.nth(1).boundingBox()
    if (!box0 || !box1) throw new Error('minimap node rects not measurable')
    const target = box0.x > box1.x ? rects.nth(0) : rects.nth(1)
    await target.click()

    // The jump is the D4-B focus path: B becomes the selection and the camera
    // fits it — B's center lands near the pane center (tolerance covers the fit
    // padding + the settled-zoom snap re-anchor).
    await expect
      .poll(() => evalIn<string[]>(page, `window.__canvasE2E.getSelection()`))
      .toEqual([b])
    await expect
      .poll(async () => {
        return page.evaluate((boardId) => {
          const g = globalThis as unknown as {
            innerWidth: number
            innerHeight: number
            __canvasE2E: {
              getBoards: () => { id: string; x: number; y: number; w: number; h: number }[]
              getViewport: () => { x: number; y: number; zoom: number }
            }
          }
          const board = g.__canvasE2E.getBoards().find((bd) => bd.id === boardId)
          if (!board) return Number.POSITIVE_INFINITY
          const vp = g.__canvasE2E.getViewport()
          const cx = (board.x + board.w / 2) * vp.zoom + vp.x
          const cy = (board.y + board.h / 2) * vp.zoom + vp.y
          return Math.hypot(cx - g.innerWidth / 2, cy - g.innerHeight / 2)
        }, b)
      })
      .toBeLessThan(160)
  })

  // (The "live native preview overlapping the island demotes (ADR 0002)" test was dropped in OS-3
  // Phase 5: OSR is the default engine and its canvas clips/z-orders like any DOM node — there is
  // no native view that paints over the island to occlusion-demote.)

  test('Esc layering: the minimap is not a layer — full view exits on the FIRST Esc', async ({
    page
  }) => {
    const id = await seed(page, 'browser') // URL-less → full view is plain HTML
    await page.keyboard.press('m')
    await expect(minimap(page)).toBeVisible()

    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(id)})`)
    await expect(page.locator('.fullview-scrim')).toBeVisible()
    await page.waitForTimeout(250)

    await page.keyboard.press('Escape')
    await expect(page.locator('.fullview-scrim')).toHaveCount(0)
    // …and the island survived the whole sequence (persistent chrome, not a layer).
    await expect(minimap(page)).toBeVisible()
  })
})
