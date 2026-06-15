import { test, expect } from './fixtures'
import { mainCall, seed } from './helpers'
import type { Page } from '@playwright/test'

// Probe the renderer by passing values as ARGS to page.evaluate (function + arg are
// serialized separately) rather than interpolating them into an eval'd code string —
// the latter is flagged js/bad-code-sanitization (a JSON.stringify'd value embedded in
// code can still break out via U+2028/U+2029). Mirrors preview-align.e2e.ts (#82).
const callHook = (page: Page, method: string, ...args: unknown[]): Promise<void> =>
  page.evaluate(({ method, args }) => (globalThis as any).__canvasE2E[method](...args), {
    method,
    args
  })
const runtimeStatus = (page: Page, id: string, status: string): Promise<boolean> =>
  page.evaluate(
    (a) => {
      const r = (globalThis as any).__canvasE2E.getRuntime(a.id)
      return !!r && r.status === a.status
    },
    { id, status }
  )
const pollTrue = async (fn: () => Promise<boolean>, timeout: number): Promise<boolean> => {
  try {
    await expect.poll(fn, { timeout }).toBe(true)
    return true
  } catch {
    return false
  }
}

/**
 * E2 (evidence capture), OS-3 Phase 5: a Browser board now renders via the OSR offscreen window
 * (the default engine). `captureOsrToFile` is the MAIN-side `capturePage → disk` primitive for the
 * offscreen window's full-resolution last frame; this proves it end to end. It is also the same
 * capturePage path the user-facing OSR screenshot uses, so a green run on both legs is evidence the
 * screenshot feature captures non-blank on each OS.
 */
test.describe('@core e2e evidence — OSR-window PNG to disk (captureOsrToFile)', () => {
  test('writes a non-blank PNG of a live browser board to disk', async ({ page, electronApp }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'evid-', 'evidence')
    try {
      const url = await mainCall<string>(electronApp, 'localUrl')
      const id = await seed(page, 'browser', { url })
      await page.waitForTimeout(150)
      await callHook(page, 'fitView', id)
      expect(
        await pollTrue(() => runtimeStatus(page, id, 'connected'), 10_000),
        'browser connected'
      ).toBe(true)
      // The visible OSR <canvas> going non-blank proves frames are flowing from the offscreen
      // window before we capturePage it (rather than a fixed sleep).
      expect(
        await pollTrue(
          () => page.evaluate((bid) => (globalThis as any).__canvasE2E.osrCanvasNonBlank(bid), id),
          8000
        ),
        'OSR painted before capture'
      ).toBe(true)

      const pngPath = await mainCall<string>(electronApp, 'joinPath', tmp, 'browser-board.png')
      const wrote = await mainCall<boolean>(electronApp, 'captureOsrToFile', id, pngPath)
      expect(wrote, 'captureOsrToFile reported a non-blank write').toBe(true)
      expect(
        await mainCall<boolean>(electronApp, 'fileExists', pngPath),
        'PNG landed on disk'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('returns false (no write) for an unknown board id', async ({ electronApp }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'evid-', 'evidence')
    try {
      const pngPath = await mainCall<string>(electronApp, 'joinPath', tmp, 'nope.png')
      const wrote = await mainCall<boolean>(
        electronApp,
        'captureOsrToFile',
        'no-such-board',
        pngPath
      )
      expect(wrote, 'no OSR window → false').toBe(false)
      expect(await mainCall<boolean>(electronApp, 'fileExists', pngPath), 'nothing written').toBe(
        false
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
