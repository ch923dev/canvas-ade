import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollCall, seed } from './helpers'

/** The board's preview runtime, read as a VALUE (the id crosses as a real arg, never spliced). */
const runtimeOf = (page: Page, id: string): Promise<{ status: string } | null> =>
  callE2E<{ status: string } | null>(page, { m: 'getRuntime', a: [id] })

/** Poll until the runtime reaches `s` — the comparison runs HERE in Node, so neither the seeded id
 *  nor the wanted status ever enters page code. Same boolean contract as `pollEval`. */
async function pollStatus(page: Page, id: string, s: string, timeoutMs: number): Promise<boolean> {
  try {
    await expect
      .poll(async () => (await runtimeOf(page, id))?.status === s, { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

// OS-3 Phase 5: OSR full-view PORTAL-relocates the live <canvas> subtree into the modal host (it is
// not remounted), so the canvas keeps its 2D context + last frame. The probe finds it wherever it
// currently lives.
const pollNonBlank = (page: Page, id: string, timeoutMs: number): Promise<boolean> =>
  pollCall(page, [{ m: 'osrCanvasNonBlank', a: [id] }], timeoutMs)

/** Poll until a terminal's buffer contains `needle` — the buffer is read as a VALUE and matched in
 *  Node (the id never enters page code). */
async function pollTermIncludes(
  page: Page,
  id: string,
  needle: string,
  timeoutMs: number
): Promise<boolean> {
  const readTerm = (): Promise<string | null> =>
    callE2E<string | null>(page, { m: 'readTerminal', a: [id] })
  try {
    await expect
      .poll(async () => ((await readTerm()) ?? '').includes(needle), { timeout: timeoutMs })
      .toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@preview full view (OSR portal relocation — real instance)', () => {
  test('full-viewing the browser keeps it painting across the portal relocation (no restart)', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await callE2E(page, { m: 'fitView', a: [browserId] })
    expect(await pollStatus(page, browserId, 'connected', 10_000)).toBe(true)
    expect(await pollNonBlank(page, browserId, 8000), 'painting before full view').toBe(true)
    // Enter full view: the live subtree is portaled into the modal, not remounted — so the OSR
    // window is never torn down and the canvas keeps painting. Assert it stays non-blank through
    // the open AND the close (the OSR analogue of the native "same webContents survives" assert).
    await callE2E(page, { m: 'openFullViewAnimated', a: [browserId] })
    await page.waitForTimeout(700)
    expect(await pollNonBlank(page, browserId, 8000), 'still painting in full view').toBe(true)
    await evalIn(page, 'window.__canvasE2E.closeFullViewAnimated()')
    await page.waitForTimeout(700)
    expect(
      await pollNonBlank(page, browserId, 8000),
      'still painting after closing full view'
    ).toBe(true)
  })

  // Regression: full-viewing a board the liveness manager had PAINT-GATED (off-screen / below LOD)
  // showed a blank/frozen modal — the manager has no full-view awareness and entering full view moves
  // neither the camera nor the boards array, so it never resumed the paused offscreen window (and a
  // paused window drops every invalidate(), so no resize could repaint it). The fix forces the
  // full-viewed board alive+painting and re-gates on the fullViewId change. Asserted at the mechanism
  // level via the MAIN `osrPainting` (isPainting) seam — the painted frame itself is not reliably
  // observable headless, but the paint pump's on/off state is.
  test('full-viewing a paint-gated (off-screen) board resumes painting — no blank modal', async ({
    page,
    electronApp
  }) => {
    const paint = (): Promise<boolean | null> =>
      mainCall<boolean | null>(electronApp, 'osrPainting', browserId)
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await callE2E(page, { m: 'fitView', a: [browserId] })
    expect(await pollStatus(page, browserId, 'connected', 10_000)).toBe(true)
    expect(await pollNonBlank(page, browserId, 8000), 'painting while visible').toBe(true)
    expect(await paint(), 'paints while on-screen').toBe(true)

    // Move it far off-screen → the M2 CPU gate pauses the offscreen window (setOsrPaint(false) →
    // MAIN stopPainting), reliably via the boards-ref reconcile trigger.
    await callE2E(page, { m: 'patchBoard', a: [browserId, { x: 100000, y: 100000 }] })
    await expect
      .poll(paint, { timeout: 6000, message: 'off-screen board is paint-gated paused' })
      .toBe(false)

    // Maximize it: shown full-screen in the modal regardless of its canvas-node position, so liveness
    // must force it back to painting. Pre-fix this stayed false → the blank modal.
    await callE2E(page, { m: 'setFullView', a: [browserId] })
    await expect
      .poll(paint, { timeout: 6000, message: 'full view resumes the paint-gated board' })
      .toBe(true)
    await page.waitForTimeout(500)
    expect(await pollNonBlank(page, browserId, 8000), 'modal shows a live frame').toBe(true)

    // Exit: off-screen again → liveness re-pauses it (the gate is RELEASED on exit, not stuck on).
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await expect
      .poll(paint, { timeout: 6000, message: 'exiting full view re-pauses the off-screen board' })
      .toBe(false)
  })

  test('Mobile full view is an aspect-correct letterboxed emulator (not stretched)', async ({
    page
  }) => {
    const planId = await seed(page, 'planning') // any board works; we full-view the browser below
    void planId
    const browserId = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await callE2E(page, { m: 'patchBoard', a: [browserId, { viewport: 'mobile' }] })
    await callE2E(page, { m: 'setFullView', a: [browserId] })
    await page.waitForTimeout(450)
    // The board id crosses into the page as a page.evaluate DATA arg; the selector is assembled
    // page-side from that data (selector strings are data, not code — the #401 idiom).
    const emu = await page.evaluate((id) => {
      const d = (globalThis as any).document
      const frame = d.querySelector(`[data-bb-frame="${id}"]`)
      const stage = frame && frame.closest('.bb-stage')
      if (!frame || !stage) return { found: false, frameRatio: 0, stageRatio: 0, widthFrac: 0 }
      const f = frame.getBoundingClientRect()
      const s = stage.getBoundingClientRect()
      return {
        found: true,
        frameRatio: f.width / f.height,
        stageRatio: s.width / s.height,
        widthFrac: f.width / s.width
      }
    }, browserId)
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    const mobileRatio = 390 / 844
    expect(emu.found, 'device frame found in full view').toBe(true)
    expect(Math.abs(emu.frameRatio - mobileRatio), 'portrait mobile aspect').toBeLessThan(0.06)
    expect(emu.widthFrac, 'letterboxed (narrower than stage)').toBeLessThan(0.9)
    expect(emu.frameRatio, 'frame narrower-ratio than landscape stage').toBeLessThan(emu.stageRatio)
  })

  test('chrome-less frame; Esc from the focused terminal textarea closes + unmounts', async ({
    page
  }) => {
    const termId = await seed(page, 'terminal', { launchCommand: 'echo fullview-close' })
    await pollTermIncludes(page, termId, 'fullview-close', 8000)
    await callE2E(page, { m: 'setFullView', a: [termId] })
    await page.waitForTimeout(400)
    const fvClose = await evalIn<{ frame: boolean; bandGone: boolean; typed: boolean }>(
      page,
      `(() => {
         const ta = document.querySelector('.fullview-host .xterm-helper-textarea');
         if (ta) ta.focus();
         const typing = document.activeElement?.tagName === 'TEXTAREA';
         (ta || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return {
           frame: !!document.querySelector('.fullview-scrim .fullview-frame .fullview-host'),
           bandGone: document.querySelector('.fullview-band') === null,
           typed: typing
         };
       })()`
    )
    await page.waitForTimeout(400)
    const gone = await evalIn<boolean>(page, `document.querySelector('.fullview-scrim') === null`)
    expect(fvClose.frame, 'chrome-less frame mounted').toBe(true)
    expect(fvClose.bandGone, 'no §6.1 band in full view').toBe(true)
    expect(fvClose.typed, 'Escape dispatched from focused TEXTAREA').toBe(true)
    expect(gone, 'modal unmounted after Esc').toBe(true)
  })

  test('stretch FLIP: the frame is position:fixed and settles to the 5vh/5vw full rect', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo stretch' })
    await callE2E(page, { m: 'setFullView', a: [id] })
    await page.waitForTimeout(450) // > FULLVIEW_MS (320) + the overshoot settle
    const m = await evalIn<{ pos: string; wFrac: number; hFrac: number }>(
      page,
      `(() => {
         const f = document.querySelector('.fullview-frame');
         if (!f) return { pos: 'none', wFrac: 0, hFrac: 0 };
         const r = f.getBoundingClientRect();
         return {
           pos: getComputedStyle(f).position,
           wFrac: r.width / window.innerWidth,
           hFrac: r.height / window.innerHeight
         };
       })()`
    )
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(200)
    // position:fixed is what lets the FLIP animate left/top/width/height; the settled frame
    // must reach the 5vh/5vw inset (~90% of the viewport), not stay stuck at the board size.
    expect(m.pos, 'frame is position:fixed (stretch FLIP geometry)').toBe('fixed')
    expect(Math.abs(m.wFrac - 0.9), 'frame settles to ~90vw (5vw inset)').toBeLessThan(0.03)
    expect(Math.abs(m.hFrac - 0.9), 'frame settles to ~90vh (5vh inset)').toBeLessThan(0.03)
  })
})
