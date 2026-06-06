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
 * E2 (evidence capture): a Browser board is a native WebContentsView that paints ABOVE
 * all HTML, so Playwright's own page.screenshot() is BLANK exactly where the browser
 * board is. The ONLY way to get visual evidence of native-view content is a MAIN-side
 * capturePage → disk. `captureViewToFile` is that primitive; this proves it end to end.
 */
test.describe('e2e evidence — native-view PNG to disk (captureViewToFile)', () => {
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
      await page.waitForTimeout(300) // one paint before capture

      const pngPath = await mainCall<string>(electronApp, 'joinPath', tmp, 'browser-board.png')
      const wrote = await mainCall<boolean>(electronApp, 'captureViewToFile', id, pngPath)
      expect(wrote, 'captureViewToFile reported a non-blank write').toBe(true)
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
        'captureViewToFile',
        'no-such-board',
        pngPath
      )
      expect(wrote, 'no view → false').toBe(false)
      expect(await mainCall<boolean>(electronApp, 'fileExists', pngPath), 'nothing written').toBe(
        false
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
