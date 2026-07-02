import { test, expect } from './fixtures'
import { evalIn, mainCall, seed, selectForInspector } from './helpers'

const getAudio = (id: string) => `window.__canvasE2E.getOsrAudio(${JSON.stringify(id)})`

/**
 * @preview — the preview audio control (4A volume) end-to-end on a real OSR board, driven through
 * the Board Inspector's Preview section (P5 removed the URL-bar speaker popover). The Mute/Volume
 * rows render only while the page plays media; OSR headless rarely fires media-started-playing, so
 * we force the `audible` flag via the e2e seam, then drive the REAL DOM: the mute switch + the
 * 0–100% slider write the ephemeral store (and round-trip through the real setOsrMuted /
 * setOsrVolume IPC without throwing).
 */
test.describe('@preview Browser audio volume control', () => {
  test('audible reveals the Inspector rows; mute toggles; slider sets volume', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await selectForInspector(page, id)

    const inspector = page.locator('[data-test="board-inspector"]')
    const mute = inspector.getByRole('switch', { name: 'Mute preview audio' })
    const slider = inspector.locator('[aria-label="Preview volume"]')

    // The rows are hidden until the page is "audible" — absent at rest.
    await expect(mute).toHaveCount(0)
    await expect(slider).toHaveCount(0)

    // Force the audible flag (stands in for media-started-playing) → the rows appear.
    await evalIn(page, `window.__canvasE2E.setOsrAudible(${JSON.stringify(id)}, true)`)
    await expect(mute, 'mute switch appears once audible').toBeVisible()
    await expect(slider, 'volume slider appears once audible').toBeVisible()

    // Default level is full, not muted.
    expect(await evalIn(page, getAudio(id))).toEqual({ muted: false, volume: 1 })

    // Mute switch flips the ephemeral mute + round-trips the real IPC.
    await mute.click()
    expect((await evalIn<{ muted: boolean }>(page, getAudio(id))).muted, 'mute on').toBe(true)
    await mute.click()
    expect((await evalIn<{ muted: boolean }>(page, getAudio(id))).muted, 'mute off').toBe(false)

    // The slider drives volume through the real onChange → store → setOsrVolume IPC; the visible
    // readout (P5-D6) tracks it.
    await slider.focus()
    await page.keyboard.press('Home') // range min → 0%
    expect((await evalIn<{ volume: number }>(page, getAudio(id))).volume, 'slider Home → 0').toBe(0)
    await expect(inspector.locator('.ca-inspector-slider-val')).toHaveText('0%')
    await page.keyboard.press('End') // range max → 100%
    expect((await evalIn<{ volume: number }>(page, getAudio(id))).volume, 'slider End → 1').toBe(1)
    await expect(inspector.locator('.ca-inspector-slider-val')).toHaveText('100%')
  })
})
