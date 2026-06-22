import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const status = (id: string, s: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(s)}; })()`
// OS-3 Phase 5: OSR full-view PORTAL-relocates the live <canvas> subtree into the modal host (it is
// not remounted), so the canvas keeps its 2D context + last frame. A document-wide selector finds
// it wherever it currently lives.
const osrNonBlank = (id: string) => `window.__canvasE2E.osrCanvasNonBlank(${JSON.stringify(id)})`

test.describe('@preview full view (OSR portal relocation — real instance)', () => {
  test('full-viewing the browser keeps it painting across the portal relocation (no restart)', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, status(browserId, 'connected'), 10_000)).toBe(true)
    expect(await pollEval(page, osrNonBlank(browserId), 8000), 'painting before full view').toBe(
      true
    )
    // Enter full view: the live subtree is portaled into the modal, not remounted — so the OSR
    // window is never torn down and the canvas keeps painting. Assert it stays non-blank through
    // the open AND the close (the OSR analogue of the native "same webContents survives" assert).
    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(browserId)})`)
    await page.waitForTimeout(700)
    expect(await pollEval(page, osrNonBlank(browserId), 8000), 'still painting in full view').toBe(
      true
    )
    await evalIn(page, 'window.__canvasE2E.closeFullViewAnimated()')
    await page.waitForTimeout(700)
    expect(
      await pollEval(page, osrNonBlank(browserId), 8000),
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
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, status(browserId, 'connected'), 10_000)).toBe(true)
    expect(await pollEval(page, osrNonBlank(browserId), 8000), 'painting while visible').toBe(true)
    expect(await paint(), 'paints while on-screen').toBe(true)

    // Move it far off-screen → the M2 CPU gate pauses the offscreen window (setOsrPaint(false) →
    // MAIN stopPainting), reliably via the boards-ref reconcile trigger.
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { x: 100000, y: 100000 })`
    )
    await expect
      .poll(paint, { timeout: 6000, message: 'off-screen board is paint-gated paused' })
      .toBe(false)

    // Maximize it: shown full-screen in the modal regardless of its canvas-node position, so liveness
    // must force it back to painting. Pre-fix this stayed false → the blank modal.
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(browserId)})`)
    await expect
      .poll(paint, { timeout: 6000, message: 'full view resumes the paint-gated board' })
      .toBe(true)
    await page.waitForTimeout(500)
    expect(await pollEval(page, osrNonBlank(browserId), 8000), 'modal shows a live frame').toBe(
      true
    )

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
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { viewport: 'mobile' })`
    )
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(browserId)})`)
    await page.waitForTimeout(450)
    const emu = await evalIn<{
      found: boolean
      frameRatio: number
      stageRatio: number
      widthFrac: number
    }>(
      page,
      `(() => {
         const frame = document.querySelector('[data-bb-frame=' + JSON.stringify(${JSON.stringify(browserId)}) + ']');
         const stage = frame && frame.closest('.bb-stage');
         if (!frame || !stage) return { found: false, frameRatio: 0, stageRatio: 0, widthFrac: 0 };
         const f = frame.getBoundingClientRect();
         const s = stage.getBoundingClientRect();
         return { found: true, frameRatio: f.width / f.height, stageRatio: s.width / s.height, widthFrac: f.width / s.width };
       })()`
    )
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
    await pollEval(
      page,
      `(() => { const t = window.__canvasE2E.readTerminal(${JSON.stringify(termId)}); return typeof t === 'string' && t.includes('fullview-close'); })()`,
      8000
    )
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(termId)})`)
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
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
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
