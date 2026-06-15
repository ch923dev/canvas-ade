import { describe, it, expect, vi } from 'vitest'
import { applyOsrInitialLoad, sanitizeOsrSize, applyOsrSize } from './previewOsr'

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
