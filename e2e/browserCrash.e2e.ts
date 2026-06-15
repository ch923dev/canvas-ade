/**
 * D2-C / OS-3 Phase 5: crashed-preview recovery on the OSR engine. Drives the REAL
 * render-process-gone path — SIGKILL on the offscreen window's renderer OS process via
 * debugCrashOsr (Chromium's forcefullyCrashRenderer is a silent no-op under some container
 * kernels — the 2026-06-13 Linux-leg finding; see previewOsr.ts) — and asserts:
 *  1. the board surfaces `crashed` (status word + Reload CTA) instead of freezing
 *     silently (the audit §3.4 Medium-High finding);
 *  2. the Reload CTA relaunches the renderer and the board reconnects.
 * The CTA click is a real Playwright click on the HTML state layer (the crashed state
 * layer renders over the cleared canvas, so the HTML CTA is genuinely hittable).
 *
 * Renderer state is read via structured-arg page.evaluate (the preview-align
 * pattern): the board id/status flow as DATA, never interpolated into an eval'd
 * code string (CodeQL js/bad-code-sanitization — a JSON.stringify'd value embedded
 * in code can still break out via U+2028/U+2029).
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { mainCall, seed } from './helpers'

const runtimeStatus = (page: Page, id: string, status: string): Promise<boolean> =>
  page.evaluate(
    (a) => {
      const r = (globalThis as any).__canvasE2E.getRuntime(a.id)
      return !!r && r.status === a.status
    },
    { id, status }
  )

const fitView = (page: Page, id: string): Promise<void> =>
  page.evaluate((id) => (globalThis as any).__canvasE2E.fitView(id), id)

const pollTrue = async (fn: () => Promise<boolean>, timeout: number): Promise<boolean> => {
  try {
    await expect.poll(fn, { timeout }).toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@preview browser board — crashed preview recovery (D2-C)', () => {
  test('render-process-gone → crashed state + Reload CTA reconnects', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await fitView(page, id)
    expect(
      await pollTrue(() => runtimeStatus(page, id, 'connected'), 10_000),
      'connects first'
    ).toBe(true)
    // Kill the OSR preview's renderer process for real (SIGKILL the offscreen window's pid).
    const crashed = await mainCall<boolean>(electronApp, 'crashOsr', id)
    expect(crashed, 'crashOsr found the live OSR window').toBe(true)
    expect(
      await pollTrue(() => runtimeStatus(page, id, 'crashed'), 10_000),
      'board surfaces crashed (no silent freeze)'
    ).toBe(true)

    // The HTML state layer is hittable (main hid the dead native layer on crash).
    await expect(page.locator('.bb-conn-word')).toHaveText('crashed')
    const cta = page.locator('.bb-reload-btn')
    await expect(cta).toBeVisible()
    await cta.click()

    expect(
      await pollTrue(() => runtimeStatus(page, id, 'connected'), 15_000),
      'Reload CTA relaunches the renderer and reconnects'
    ).toBe(true)
  })
})
