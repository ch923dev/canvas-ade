import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, mainCall, pollCall, seed } from './helpers'

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

// OS-3 Phase 5: the OSR replacement for the native `captureView → {empty}` probe — proves the
// offscreen frame actually reached the visible DOM <canvas> (reads its pixels in-renderer).
const pollNonBlank = (page: Page, id: string, timeoutMs: number): Promise<boolean> =>
  pollCall(page, [{ m: 'osrCanvasNonBlank', a: [id] }], timeoutMs)

test.describe('@preview browser preview (OSR offscreen → canvas — real instance)', () => {
  test('connects + the OSR <canvas> paints a real (non-blank) frame', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await callE2E(page, { m: 'fitView', a: [id] })
    const connected = await pollStatus(page, id, 'connected', 10_000)
    expect(connected, 'browser reaches connected').toBe(true)
    // The offscreen frame must land on the visible canvas (the regression surface OSR adds).
    // Poll, not single-shot — the first paint arrives a beat after `connected`.
    const painted = await pollNonBlank(page, id, 8000)
    expect(painted, 'OSR canvas painted a non-blank frame').toBe(true)
  })

  test('refused URL ends as load-failed (not connected)', async ({ page }) => {
    const id = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await page.waitForTimeout(150)
    await callE2E(page, { m: 'fitView', a: [id] })
    const failed = await pollStatus(page, id, 'load-failed', 12_000)
    expect(failed, 'refused URL → load-failed').toBe(true)
  })
})
