import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

const getAudio = (id: string) => `window.__canvasE2E.getOsrAudio(${JSON.stringify(id)})`

/**
 * @preview — the URL-bar audio control (4A volume) end-to-end on a real OSR board.
 * The control renders only while the page plays media; OSR headless rarely fires
 * media-started-playing, so we force the `audible` flag via the e2e seam, then drive the REAL DOM:
 * the speaker button opens a popover whose mute toggle + 0–100% slider write the ephemeral store
 * (and round-trip through the real setOsrMuted / setOsrVolume IPC without throwing).
 */
test.describe('@preview Browser audio volume control', () => {
  test('speaker opens popover; mute toggles; slider sets volume', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

    // The control is hidden until the page is "audible" — absent at rest.
    await expect(page.getByRole('button', { name: 'Audio volume' })).toHaveCount(0)

    // Force the audible flag (stands in for media-started-playing) → the speaker appears.
    await evalIn(page, `window.__canvasE2E.setOsrAudible(${JSON.stringify(id)}, true)`)
    const speaker = page.getByRole('button', { name: 'Audio volume' })
    await expect(speaker, 'speaker appears once audible').toBeVisible()

    // Popover is closed until the speaker is clicked (the signed-off interaction).
    await expect(page.locator('[data-test="bb-vol-popover"]')).toHaveCount(0)
    await speaker.click()
    await expect(page.locator('[data-test="bb-vol-popover"]'), 'click opens popover').toBeVisible()
    await expect(page.locator('[data-test="bb-vol-slider"]')).toBeVisible()

    // Default level is full, not muted.
    expect(await evalIn(page, getAudio(id))).toEqual({ muted: false, volume: 1 })

    // Mute toggle (inside the popover) flips the ephemeral mute + round-trips the real IPC.
    await page.locator('[data-test="bb-vol-mute"]').click()
    expect((await evalIn<{ muted: boolean }>(page, getAudio(id))).muted, 'mute on').toBe(true)
    await page.locator('[data-test="bb-vol-mute"]').click()
    expect((await evalIn<{ muted: boolean }>(page, getAudio(id))).muted, 'mute off').toBe(false)

    // The slider drives volume through the real onChange → store → setOsrVolume IPC.
    const slider = page.locator('[data-test="bb-vol-slider"]')
    await slider.focus()
    await page.keyboard.press('Home') // range min → 0%
    expect((await evalIn<{ volume: number }>(page, getAudio(id))).volume, 'slider Home → 0').toBe(0)
    await page.keyboard.press('End') // range max → 100%
    expect((await evalIn<{ volume: number }>(page, getAudio(id))).volume, 'slider End → 1').toBe(1)
  })
})
