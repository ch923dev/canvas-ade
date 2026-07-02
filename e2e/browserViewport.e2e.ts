import { test, expect } from './fixtures'
import { seed, selectForInspector } from './helpers'

// v15 wide-desktop presets (1440p / 4K), driven through the Board Inspector's Viewport section
// (P5 removed the on-board Candidate-B control): the Device-class segmented (Mobile · Tablet ·
// Desktop) plus the desktop-tier Size segmented (1280 / 1440p / 4K). This drives the REAL control
// end-to-end — select the board, click a size segment, and assert BOTH the persisted board.viewport
// (store seam) AND the URL-bar `W × H` readout (the render path through VIEWPORT_PRESETS).
// Unit coverage of the preset table / cycle / schema clamp lives in browserLayout/osrSizing/boardSchema
// tests; this pins the wiring the units can't see.

/**
 * Read the seeded board's current viewport off the e2e store seam. Pass the id as a STRUCTURED ARG
 * to page.evaluate — never interpolate a page-returned value into eval'd source (CodeQL
 * js/bad-code-sanitization; mirrors da2a1d1c's structured-arg fix).
 */
function readViewport(page: import('@playwright/test').Page, id: string): Promise<string | null> {
  return page.evaluate((a) => {
    const g = globalThis as unknown as {
      __canvasE2E: { getBoards(): Array<{ id: string; viewport?: string }> }
    }
    return g.__canvasE2E.getBoards().find((b) => b.id === a)?.viewport ?? null
  }, id)
}

test.describe('@preview browser viewport control (1440p / 4K desktop sizes via the Inspector)', () => {
  test('selecting 4K / 1440p from the Size segmented updates the board + the W×H readout', async ({
    page
  }) => {
    const id = await seed(page, 'browser', { url: 'http://127.0.0.1:9/', viewport: 'desktop' })
    await page.waitForTimeout(150)
    // Structured arg (not interpolated) — same CodeQL-safe pattern as readViewport.
    await page.evaluate((a) => {
      const g = globalThis as unknown as { __canvasE2E: { fitView(id: string): void } }
      g.__canvasE2E.fitView(a)
    }, id)
    await selectForInspector(page, id)

    // The Inspector's Viewport section: the Device-class radios + (desktop tier) the Size radios.
    const inspector = page.locator('[data-test="board-inspector"]')
    const deviceGroup = inspector.locator('[aria-label="Device class"]')
    await expect(deviceGroup.getByRole('radio', { name: 'Mobile' })).toBeVisible()
    await expect(deviceGroup.getByRole('radio', { name: 'Tablet' })).toBeVisible()
    const sizeGroup = inspector.locator('[aria-label="Desktop size"]')
    await expect(sizeGroup).toBeVisible()
    // Seeded desktop → the URL-bar dims readout shows the desktop CSS box.
    await expect(page.locator('.bb-dims')).toHaveText('1280 × 800')

    // The three desktop sizes render as radio segments.
    await expect(sizeGroup.getByRole('radio', { name: '1280' })).toBeVisible()
    await expect(sizeGroup.getByRole('radio', { name: '1440p' })).toBeVisible()
    await expect(sizeGroup.getByRole('radio', { name: '4K' })).toBeVisible()

    // Pick 4K → board persists `uhd` and the readout reflows to the 4K CSS box.
    await sizeGroup.getByRole('radio', { name: '4K' }).click()
    await expect.poll(() => readViewport(page, id)).toBe('uhd')
    await expect(page.locator('.bb-dims')).toHaveText('3840 × 2160')

    // Pick 1440p → board persists `qhd` and the readout reflows again.
    await sizeGroup.getByRole('radio', { name: '1440p' }).click()
    await expect.poll(() => readViewport(page, id)).toBe('qhd')
    await expect(page.locator('.bb-dims')).toHaveText('2560 × 1440')
  })
})
