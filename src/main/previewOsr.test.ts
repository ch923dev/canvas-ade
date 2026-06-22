import { describe, it, expect, vi } from 'vitest'
import {
  applyOsrInitialLoad,
  applyOsrPaint,
  clampOsrDirty,
  osrPaintRect,
  applyOsrEdit,
  applyOsrIme
} from './previewOsr'
import { sanitizeOsrSize, applyOsrSize } from './previewOsrSizing'
import { scaleOsrInputEvent } from './previewOsrInput'

// BUG-005: in OSR mode, ensureOsr used `if (isAllowedPreviewUrl(url)) wc.loadURL(url)` with NO
// else, so a blocked (non-http(s)) scheme skipped the load AND emitted no lifecycle event ->
// useOffscreenPreview stayed on 'connecting' forever and leaked an idle offscreen renderer. The
// fix: applyOsrInitialLoad — the exact gate ensureOsr now calls — latches `failed` and emits a
// synthetic did-fail-load (errorCode -1, 'blocked scheme') on the rejected branch, so the renderer
// transitions to 'load-failed'. These drive the REAL gate (no faked status).
describe('applyOsrInitialLoad (BUG-005 blocked-scheme terminal failure)', () => {
  it('loads an allowed http(s) url and emits NO failure', () => {
    const e = { failed: false }
    const load = vi.fn()
    const emit = vi.fn()
    applyOsrInitialLoad('b1', 'http://localhost:5173/app', e, load, emit)
    expect(load).toHaveBeenCalledWith('http://localhost:5173/app')
    expect(emit).not.toHaveBeenCalled()
    expect(e.failed).toBe(false)
  })

  it('latches failed + emits a synthetic did-fail-load for a blocked scheme (no load)', () => {
    const e = { failed: false }
    const load = vi.fn()
    const emit = vi.fn()
    applyOsrInitialLoad('b2', 'file:///C:/Windows/win.ini', e, load, emit)
    // The bug: without the else-branch, neither of these would happen and the renderer hangs.
    expect(load).not.toHaveBeenCalled()
    expect(e.failed).toBe(true)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      id: 'b2',
      type: 'did-fail-load',
      url: 'file:///C:/Windows/win.ini',
      errorCode: -1,
      errorDescription: 'blocked scheme'
    })
  })

  it('treats data: and a non-URL string as blocked-scheme failures too', () => {
    for (const bad of ['data:text/html,<h1>x</h1>', 'not a url', '']) {
      const e = { failed: false }
      const load = vi.fn()
      const emit = vi.fn()
      applyOsrInitialLoad('b3', bad, e, load, emit)
      expect(load).not.toHaveBeenCalled()
      expect(e.failed).toBe(true)
      expect(emit).toHaveBeenCalledTimes(1)
      expect(emit.mock.calls[0][0]).toMatchObject({
        type: 'did-fail-load',
        url: bad,
        errorCode: -1,
        errorDescription: 'blocked scheme'
      })
    }
  })
})

// OS-3 Phase 1 (M1 supersample + M4 logical reflow). The Electron wiring (BrowserWindow /
// setContentSize against a real offscreen surface) is verified by the manual dev check + the
// @preview e2e; these unit tests cover the two pieces with branching LOGIC: the renderer-input
// sanitize boundary and the no-op-guarded apply. Both pure exports import clean in the node
// tier (the electron value-imports in previewOsr.ts are unused at module-eval time).

describe('sanitizeOsrSize', () => {
  it('rounds logical dims and passes a valid size through', () => {
    expect(sanitizeOsrSize({ logicalW: 390.4, logicalH: 844.6, supersample: 2 })).toEqual({
      logicalW: 390,
      logicalH: 845,
      supersample: 2
    })
  })
  it('falls back to the default surface on non-finite / non-positive dims', () => {
    expect(sanitizeOsrSize({ logicalW: 0, logicalH: -5, supersample: NaN })).toEqual({
      logicalW: 1280,
      logicalH: 800,
      supersample: 1
    })
  })
  it('hard-caps supersample at 4 (above the renderer M1 cap) and floors at 1', () => {
    expect(sanitizeOsrSize({ logicalW: 1280, logicalH: 800, supersample: 99 }).supersample).toBe(4)
    expect(sanitizeOsrSize({ logicalW: 1280, logicalH: 800, supersample: 0.2 }).supersample).toBe(1)
    // Infinity is non-finite → falls back to 1 (the finite guard fires before the clamp).
    expect(
      sanitizeOsrSize({ logicalW: 1280, logicalH: 800, supersample: Infinity }).supersample
    ).toBe(1)
  })
  it('hard-caps each logical dimension at 4096px (GPU texture sanity, even at S=4)', () => {
    const s = sanitizeOsrSize({ logicalW: 99999, logicalH: 8000, supersample: 2 })
    expect(s.logicalW).toBe(4096)
    expect(s.logicalH).toBe(4096)
  })
})

/** A structural OsrResizeTarget + spies — applyOsrSize drives this without a real BrowserWindow.
 *  Spies are typed so they satisfy the target's exact method signatures under TS strict. */
function mkWin() {
  const setContentSize = vi.fn<(width: number, height: number) => void>()
  const setZoomFactor = vi.fn<(factor: number) => void>()
  const invalidate = vi.fn<() => void>()
  const win = { setContentSize, webContents: { setZoomFactor, invalidate } }
  return { win, setContentSize, setZoomFactor, invalidate }
}

describe('applyOsrSize', () => {
  it('sets the physical surface (logical·S), the zoom factor (S), invalidates, and updates state', () => {
    const { win, setContentSize, setZoomFactor, invalidate } = mkWin()
    const state = { logicalW: 1280, logicalH: 800, superSample: 1 }
    applyOsrSize(win, state, { logicalW: 390, logicalH: 844, supersample: 2 })
    expect(setContentSize).toHaveBeenCalledWith(780, 1688) // 390·2 × 844·2
    expect(setZoomFactor).toHaveBeenCalledWith(2)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(state).toMatchObject({ logicalW: 390, logicalH: 844, superSample: 2 })
  })

  it('no-op-guards an identical size (no second relayout) and reports resized=false', () => {
    const { win, setContentSize } = mkWin()
    const state = { logicalW: 1280, logicalH: 800, superSample: 1 }
    const size = { logicalW: 390, logicalH: 844, supersample: 2 }
    expect(applyOsrSize(win, state, size)).toBe(true) // first apply changed the surface
    expect(applyOsrSize(win, state, size)).toBe(false) // identical → no-op
    expect(setContentSize).toHaveBeenCalledTimes(1)
  })

  it('re-applies on a genuine size change (e.g. supersample bump on zoom-in)', () => {
    const { win, setContentSize } = mkWin()
    const state = { logicalW: 1280, logicalH: 800, superSample: 1 }
    applyOsrSize(win, state, { logicalW: 1280, logicalH: 800, supersample: 1 })
    applyOsrSize(win, state, { logicalW: 1280, logicalH: 800, supersample: 2 })
    expect(setContentSize).toHaveBeenCalledTimes(2)
    expect(setContentSize).toHaveBeenLastCalledWith(2560, 1600)
  })

  it('keeps superSample current even when the key no-ops (it is the applyZoom re-apply source)', () => {
    const { win } = mkWin()
    const state = { logicalW: 390, logicalH: 844, superSample: 99, sizeKey: '390x844@2' }
    applyOsrSize(win, state, { logicalW: 390, logicalH: 844, supersample: 2 })
    expect(state.superSample).toBe(2) // refreshed despite the no-op early-return
  })
})

// OS-3 Phase 2 (M2 / 2A) — visibility paint-gating. applyOsrPaint drives a structural target
// (start/stop/invalidate spies) so the gating logic is testable without a real BrowserWindow.
function mkPaintWin() {
  const startPainting = vi.fn<() => void>()
  const stopPainting = vi.fn<() => void>()
  const invalidate = vi.fn<() => void>()
  const win = { webContents: { startPainting, stopPainting, invalidate } }
  return { win, startPainting, stopPainting, invalidate }
}

describe('applyOsrPaint', () => {
  it('freezes (true→false): stopPainting, no invalidate, state cleared', () => {
    const { win, startPainting, stopPainting, invalidate } = mkPaintWin()
    const state = { painting: true }
    applyOsrPaint(win, state, false)
    expect(stopPainting).toHaveBeenCalledTimes(1)
    expect(startPainting).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    expect(state.painting).toBe(false)
  })

  it('resumes (false→true): startPainting + invalidate (no stale pre-freeze frame), state set', () => {
    const { win, startPainting, stopPainting, invalidate } = mkPaintWin()
    const state = { painting: false }
    applyOsrPaint(win, state, true)
    expect(startPainting).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(stopPainting).not.toHaveBeenCalled()
    expect(state.painting).toBe(true)
  })

  it('is idempotent — a redundant set to the current state is a no-op', () => {
    const { win, startPainting, stopPainting } = mkPaintWin()
    const state = { painting: true }
    applyOsrPaint(win, state, true) // already painting
    applyOsrPaint(win, state, true)
    expect(startPainting).not.toHaveBeenCalled()
    expect(stopPainting).not.toHaveBeenCalled()
  })
})

describe('clampOsrDirty', () => {
  const full = { width: 800, height: 600 }
  it('passes a fully-in-bounds rect through (rounded)', () => {
    expect(clampOsrDirty({ x: 10, y: 20, width: 100, height: 50 }, full)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50
    })
  })
  it('clamps a rect that overflows the frame to the remaining size', () => {
    expect(clampOsrDirty({ x: 700, y: 500, width: 400, height: 400 }, full)).toEqual({
      x: 700,
      y: 500,
      width: 100, // 800 - 700
      height: 100 // 600 - 500
    })
  })
  it('returns a zero-size rect for an origin past the frame (fully clipped)', () => {
    const r = clampOsrDirty({ x: 900, y: 700, width: 50, height: 50 }, full)
    expect(r.width).toBe(0)
    expect(r.height).toBe(0)
  })
  it('floors the offset and ceils the size (no sub-pixel crop that drops a row)', () => {
    expect(clampOsrDirty({ x: 10.9, y: 20.1, width: 30.2, height: 40.8 }, full)).toEqual({
      x: 10,
      y: 20,
      width: 31,
      height: 41
    })
  })
})

describe('osrPaintRect (2C — crop the device-px dirty rect at any supersample, SLICE-005)', () => {
  const full = { width: 800, height: 600 }
  const dirty = { x: 100, y: 50, width: 200, height: 150 }

  it('honors the (clamped) dirty rect at supersample 1', () => {
    expect(osrPaintRect(dirty, full, 1)).toEqual(dirty)
  })

  it('crops the dirty rect at supersample 2 (dirtyRect is device-px == image space — probe-verified)', () => {
    expect(osrPaintRect(dirty, full, 2)).toEqual(dirty)
  })

  it('crops at fractional supersample too (e.g. 1.5)', () => {
    expect(osrPaintRect(dirty, full, 1.5)).toEqual(dirty)
  })

  it('still clamps an out-of-bounds dirty rect at S=1', () => {
    expect(osrPaintRect({ x: 700, y: 500, width: 400, height: 400 }, full, 1)).toEqual({
      x: 700,
      y: 500,
      width: 100,
      height: 100
    })
  })
})

// OS-3 Phase 3 / 3C — clipboard verbs routed to the WebContents' own edit methods.
function mkEditWin() {
  const copy = vi.fn<() => void>()
  const cut = vi.fn<() => void>()
  const paste = vi.fn<() => void>()
  const selectAll = vi.fn<() => void>()
  return { wc: { copy, cut, paste, selectAll }, copy, cut, paste, selectAll }
}

describe('applyOsrEdit', () => {
  it('maps each verb to the matching WebContents method', () => {
    const { wc, copy, cut, paste, selectAll } = mkEditWin()
    expect(applyOsrEdit(wc, 'copy')).toBe(true)
    expect(applyOsrEdit(wc, 'cut')).toBe(true)
    expect(applyOsrEdit(wc, 'paste')).toBe(true)
    expect(applyOsrEdit(wc, 'selectAll')).toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(cut).toHaveBeenCalledTimes(1)
    expect(paste).toHaveBeenCalledTimes(1)
    expect(selectAll).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an unknown/forged verb (returns false, calls nothing)', () => {
    const { wc, copy, cut, paste, selectAll } = mkEditWin()
    expect(applyOsrEdit(wc, 'rm -rf')).toBe(false)
    expect(applyOsrEdit(wc, '')).toBe(false)
    expect(copy).not.toHaveBeenCalled()
    expect(cut).not.toHaveBeenCalled()
    expect(paste).not.toHaveBeenCalled()
    expect(selectAll).not.toHaveBeenCalled()
  })
})

// OS-3 Phase 3 / 3A+3B — text commit + IME composition over the attached CDP debugger, with a
// sendInputEvent char fallback when the debugger is detached.
function mkImeWin(attached: boolean) {
  const sendCommand = vi.fn<(m: string, p?: Record<string, unknown>) => Promise<unknown>>(() =>
    Promise.resolve()
  )
  const sendInputEvent = vi.fn<(event: unknown) => void>()
  const wc = {
    debugger: { isAttached: () => attached, sendCommand },
    sendInputEvent
  }
  return { wc, sendCommand, sendInputEvent }
}

describe('applyOsrIme', () => {
  it('commit → Input.insertText over CDP (no fallback)', () => {
    const { wc, sendCommand, sendInputEvent } = mkImeWin(true)
    applyOsrIme(wc, 'commit', 'é')
    expect(sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'é' })
    expect(sendInputEvent).not.toHaveBeenCalled()
  })

  it('compose → Input.imeSetComposition with a collapsed caret at the end', () => {
    const { wc, sendCommand, sendInputEvent } = mkImeWin(true)
    applyOsrIme(wc, 'compose', '你好')
    expect(sendCommand).toHaveBeenCalledWith('Input.imeSetComposition', {
      text: '你好',
      selectionStart: 2,
      selectionEnd: 2
    })
    expect(sendInputEvent).not.toHaveBeenCalled()
  })

  it('commit falls back to per-code-point char events when the debugger is detached', () => {
    const { wc, sendCommand, sendInputEvent } = mkImeWin(false)
    applyOsrIme(wc, 'commit', 'ab')
    expect(sendCommand).not.toHaveBeenCalled()
    expect(sendInputEvent).toHaveBeenCalledTimes(2)
    expect(sendInputEvent).toHaveBeenNthCalledWith(1, { type: 'char', keyCode: 'a' })
    expect(sendInputEvent).toHaveBeenNthCalledWith(2, { type: 'char', keyCode: 'b' })
  })

  it('compose is a silent no-op when the debugger is detached (no fallback, no throw)', () => {
    const { wc, sendCommand, sendInputEvent } = mkImeWin(false)
    expect(() => applyOsrIme(wc, 'compose', 'wo')).not.toThrow()
    expect(sendCommand).not.toHaveBeenCalled()
    expect(sendInputEvent).not.toHaveBeenCalled()
  })

  it('iterates by code point (astral emoji stays one unit) in the fallback', () => {
    const { wc, sendInputEvent } = mkImeWin(false)
    applyOsrIme(wc, 'commit', '😀')
    // for…of over a string yields whole code points, so a surrogate pair is ONE char event.
    expect(sendInputEvent).toHaveBeenCalledTimes(1)
    expect(sendInputEvent).toHaveBeenCalledWith({ type: 'char', keyCode: '😀' })
  })

  it('commit falls back to char events when CDP insertText REJECTS async (attached)', async () => {
    const sendInputEvent = vi.fn<(event: unknown) => void>()
    const sendCommand = vi.fn(() => Promise.reject(new Error('detached mid-call')))
    const wc = { debugger: { isAttached: () => true, sendCommand }, sendInputEvent }
    applyOsrIme(wc, 'commit', 'ab')
    expect(sendCommand).toHaveBeenCalledWith('Input.insertText', { text: 'ab' })
    expect(sendInputEvent).not.toHaveBeenCalled() // fallback runs on the rejection microtask
    await Promise.resolve()
    await Promise.resolve()
    expect(sendInputEvent).toHaveBeenCalledTimes(2)
    expect(sendInputEvent).toHaveBeenNthCalledWith(1, { type: 'char', keyCode: 'a' })
  })

  it('compose does NOT char-fall-back on an async rejection (best-effort only)', async () => {
    const sendInputEvent = vi.fn<(event: unknown) => void>()
    const sendCommand = vi.fn(() => Promise.reject(new Error('no composition')))
    const wc = { debugger: { isAttached: () => true, sendCommand }, sendInputEvent }
    applyOsrIme(wc, 'compose', 'ni')
    await Promise.resolve()
    await Promise.resolve()
    expect(sendInputEvent).not.toHaveBeenCalled()
  })
})

// The hover-misalignment fix: the renderer forwards pointer coords in page-logical CSS px, but the
// offscreen window is sized to logical·S with page zoom S (M1 supersample), so sendInputEvent coords
// must be scaled by S into widget space or the page hit-tests at (x/S, y/S) — up-left of the cursor.
describe('scaleOsrInputEvent (OSR hover/click alignment under supersample)', () => {
  it('scales a mouseMove by the supersample so the page hit-tests under the cursor', () => {
    // The exact symptom case: at S=2 the renderer sends logical (400,300); the page un-zooms by 2
    // during hit-test, so the widget coord MUST be (800,600) to land back on CSS (400,300). Before
    // the fix the unscaled (400,300) hit-tested at (200,150) — the misaligned hover.
    expect(scaleOsrInputEvent({ type: 'mouseMove', x: 400, y: 300 }, 2)).toEqual({
      type: 'mouseMove',
      x: 800,
      y: 600
    })
  })

  it('scales mouseDown/mouseUp/contextMenu coords too (click + right-click land correctly)', () => {
    expect(scaleOsrInputEvent({ type: 'mouseDown', x: 100, y: 50, button: 'left' }, 1.5)).toEqual({
      type: 'mouseDown',
      x: 150,
      y: 75,
      button: 'left'
    })
    expect(scaleOsrInputEvent({ type: 'mouseUp', x: 100, y: 50, button: 'left' }, 1.5)).toEqual({
      type: 'mouseUp',
      x: 150,
      y: 75,
      button: 'left'
    })
  })

  it('scales a wheel anchor x/y but NOT its scroll deltas (Blink zoom-applies scrolling itself)', () => {
    expect(
      scaleOsrInputEvent({ type: 'mouseWheel', x: 200, y: 100, deltaX: 0, deltaY: -40 } as never, 2)
    ).toEqual({ type: 'mouseWheel', x: 400, y: 200, deltaX: 0, deltaY: -40 })
  })

  it('rounds to integer widget coordinates (sendInputEvent requires integers)', () => {
    expect(scaleOsrInputEvent({ type: 'mouseMove', x: 101, y: 201 }, 1.25)).toEqual({
      type: 'mouseMove',
      x: 126, // 101 * 1.25 = 126.25 → 126
      y: 251 // 201 * 1.25 = 251.25 → 251
    })
  })

  it('is a pass-through at S=1 (the common zoomed-out / dpr-1 case — no behaviour change)', () => {
    const ev = { type: 'mouseMove', x: 42, y: 7 } as const
    expect(scaleOsrInputEvent(ev, 1)).toBe(ev) // same reference — untouched
  })

  it('never scales keyboard events (no coordinates to misplace)', () => {
    const down = { type: 'keyDown', keyCode: 'Enter' } as const
    const up = { type: 'keyUp', keyCode: 'Enter' } as const
    expect(scaleOsrInputEvent(down, 2)).toBe(down)
    expect(scaleOsrInputEvent(up, 2)).toBe(up)
  })

  it('falls back to a pass-through for a degenerate (0 / NaN / negative) supersample', () => {
    const ev = { type: 'mouseMove', x: 10, y: 20 } as const
    expect(scaleOsrInputEvent(ev, 0)).toBe(ev)
    expect(scaleOsrInputEvent(ev, Number.NaN)).toBe(ev)
    expect(scaleOsrInputEvent(ev, -2)).toBe(ev)
  })
})
