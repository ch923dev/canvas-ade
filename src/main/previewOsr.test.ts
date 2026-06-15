import { describe, it, expect, vi } from 'vitest'
import {
  applyOsrInitialLoad,
  sanitizeOsrSize,
  applyOsrSize,
  applyOsrPaint,
  clampOsrDirty,
  osrPaintRect,
  applyOsrEdit,
  applyOsrIme
} from './previewOsr'

// BUG-005: in OSR mode, ensureOsr used `if (isAllowedPreviewUrl(url)) wc.loadURL(url)` with NO
// else, so a blocked (non-http(s)) scheme skipped the load AND emitted no lifecycle event ->
// useOffscreenPreview stayed on 'connecting' forever and leaked an idle offscreen renderer. The
// native path (preview.ts preview:open / preview:navigate) emits a synthetic did-fail-load
// (errorCode -1, 'blocked scheme') on the rejected branch; applyOsrInitialLoad — the exact gate
// ensureOsr now calls — must mirror it. These drive the REAL gate (no faked status).
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

  it('no-op-guards an identical size (no second relayout)', () => {
    const { win, setContentSize } = mkWin()
    const state = { logicalW: 1280, logicalH: 800, superSample: 1 }
    const size = { logicalW: 390, logicalH: 844, supersample: 2 }
    applyOsrSize(win, state, size)
    applyOsrSize(win, state, size)
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

describe('osrPaintRect (2C hardening — crop only at supersample 1)', () => {
  const full = { width: 800, height: 600 }
  const dirty = { x: 100, y: 50, width: 200, height: 150 }

  it('honors the (clamped) dirty rect at supersample 1', () => {
    expect(osrPaintRect(dirty, full, 1)).toEqual(dirty)
  })

  it('returns the WHOLE frame at supersample 2 (no crop → no DIP/device misalignment)', () => {
    expect(osrPaintRect(dirty, full, 2)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('returns the whole frame for any S != 1 (e.g. fractional 1.5)', () => {
    expect(osrPaintRect(dirty, full, 1.5)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
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
})
