import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'

// v15 wide-desktop presets (1440p / 4K) + the Candidate-B viewport control: Mobile · Tablet icon
// segments plus a Desktop-size DROPDOWN (the shared Menu shell) listing Desktop / 1440p / 4K. This
// drives the REAL control end-to-end — click the dropdown, pick a size, and assert BOTH the persisted
// board.viewport (store seam) AND the URL-bar `W × H` readout (the render path through VIEWPORT_PRESETS).
// Unit coverage of the preset table / cycle / schema clamp lives in browserLayout/osrSizing/boardSchema
// tests; this pins the wiring the units can't see.

/** Read the seeded board's current viewport off the e2e store seam. */
function readViewport(page: import('@playwright/test').Page, id: string): Promise<string | null> {
  return evalIn<string | null>(
    page,
    `(() => { const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(
      id
    )}); return b ? b.viewport : null })()`
  )
}

test.describe('@preview browser viewport control (1440p / 4K desktop-size dropdown)', () => {
  test('selecting 4K / 1440p from the dropdown updates the board + the W×H readout', async ({
    page
  }) => {
    const id = await seed(page, 'browser', { url: 'http://127.0.0.1:9/', viewport: 'desktop' })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

    // The control: Mobile + Tablet icon segments and the Desktop-size dropdown trigger.
    await expect(page.getByTitle('Mobile')).toBeVisible()
    await expect(page.getByTitle('Tablet')).toBeVisible()
    const tier = page.getByTitle('Desktop size')
    await expect(tier).toBeVisible()
    // Seeded desktop → the URL-bar dims readout shows the desktop CSS box.
    await expect(page.locator('.bb-dims')).toHaveText('1280 × 800')

    // Open the dropdown → the three desktop sizes are listed as radio rows.
    await tier.click()
    await expect(page.getByRole('menuitemradio', { name: /Desktop/ })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /1440p/ })).toBeVisible()
    await expect(page.getByRole('menuitemradio', { name: /4K/ })).toBeVisible()

    // Pick 4K → board persists `uhd` and the readout reflows to the 4K CSS box.
    await page.getByRole('menuitemradio', { name: /4K/ }).click()
    await expect.poll(() => readViewport(page, id)).toBe('uhd')
    await expect(page.locator('.bb-dims')).toHaveText('3840 × 2160')

    // Pick 1440p → board persists `qhd` and the readout reflows again.
    await tier.click()
    await page.getByRole('menuitemradio', { name: /1440p/ }).click()
    await expect.poll(() => readViewport(page, id)).toBe('qhd')
    await expect(page.locator('.bb-dims')).toHaveText('2560 × 1440')
  })
})
