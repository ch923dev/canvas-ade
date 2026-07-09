import { describe, it, expect, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  applyOsrInitialLoad,
  applyOsrPaint,
  clampOsrDirty,
  osrPaintRect,
  applyOsrEdit,
  applyOsrIme,
  emitOsrRemountState,
  pickOsrEvictions
} from './previewOsr'
import { applyOsrBackground } from './previewOsrBackground'
import { sanitizeOsrSize, applyOsrSize } from './previewOsrSizing'
import { scaleOsrInputEvent } from './previewOsrInput'
import { canEmitToOwner, registerOwnerLifecycle } from './previewOsrOwner'

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
  it('passes the 4K (uhd) preset 3840×2160 through under the 4096 cap (v15)', () => {
    const s = sanitizeOsrSize({ logicalW: 3840, logicalH: 2160, supersample: 2 })
    expect(s.logicalW).toBe(3840)
    expect(s.logicalH).toBe(2160)
    // physical = logical · S = 3840·2 = 7680 ≤ the ~16384 GPU texture limit.
    expect(s.logicalW * s.supersample).toBeLessThanOrEqual(16384)
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
  const setBackgroundThrottling = vi.fn<(allowed: boolean) => void>()
  const win = {
    webContents: { startPainting, stopPainting, invalidate, setBackgroundThrottling }
  }
  return { win, startPainting, stopPainting, invalidate, setBackgroundThrottling }
}

describe('applyOsrPaint', () => {
  it('freezes (true→false): stopPainting + throttle on, no invalidate, state cleared', () => {
    const { win, startPainting, stopPainting, invalidate, setBackgroundThrottling } = mkPaintWin()
    const state = { painting: true }
    applyOsrPaint(win, state, false)
    expect(stopPainting).toHaveBeenCalledTimes(1)
    expect(startPainting).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    expect(state.painting).toBe(false)
    expect(setBackgroundThrottling).toHaveBeenCalledWith(true) // H7: frozen ⇒ throttle page JS
  })

  it('resumes (false→true): startPainting + invalidate + throttle off (no stale frame), state set', () => {
    const { win, startPainting, stopPainting, invalidate, setBackgroundThrottling } = mkPaintWin()
    const state = { painting: false }
    applyOsrPaint(win, state, true)
    expect(startPainting).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(stopPainting).not.toHaveBeenCalled()
    expect(state.painting).toBe(true)
    expect(setBackgroundThrottling).toHaveBeenCalledWith(false) // H7: on-screen ⇒ un-throttle
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

// Background project sessions (Phase 1): the background/foreground transition. Structural
// target like applyOsrPaint's, extended with the throttling + mute knobs the transition drives.
function mkBgWin() {
  const startPainting = vi.fn<() => void>()
  const stopPainting = vi.fn<() => void>()
  const invalidate = vi.fn<() => void>()
  const setBackgroundThrottling = vi.fn<(on: boolean) => void>()
  const setAudioMuted = vi.fn<(m: boolean) => void>()
  const win = {
    webContents: { startPainting, stopPainting, invalidate, setBackgroundThrottling, setAudioMuted }
  }
  return { win, startPainting, stopPainting, invalidate, setBackgroundThrottling, setAudioMuted }
}

describe('applyOsrBackground (background project sessions)', () => {
  it('backgrounding freezes paint, throttles page timers, and mutes', () => {
    const { win, stopPainting, setBackgroundThrottling, setAudioMuted } = mkBgWin()
    const state = { painting: true, manualMuted: false, backgrounded: false }

    expect(applyOsrBackground(win, state, true)).toBe(true)

    expect(state.backgrounded).toBe(true)
    expect(state.painting).toBe(false)
    expect(stopPainting).toHaveBeenCalledTimes(1)
    expect(setBackgroundThrottling).toHaveBeenCalledWith(true)
    expect(setAudioMuted).toHaveBeenCalledWith(true) // !painting ⇒ effective mute
  })

  it('foregrounding un-throttles but does NOT resume paint (the liveness manager owns that)', () => {
    const { win, startPainting, invalidate, setBackgroundThrottling, setAudioMuted } = mkBgWin()
    const state = { painting: false, manualMuted: false, backgrounded: true }

    expect(applyOsrBackground(win, state, false)).toBe(true)

    expect(state.backgrounded).toBe(false)
    expect(state.painting).toBe(false) // still frozen until preview:osrSetPaint(true)
    expect(startPainting).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).toHaveBeenCalledWith(false)
    expect(setAudioMuted).toHaveBeenCalledWith(true) // still !painting ⇒ stays muted for now
  })

  it("preserves the user's manual mute across a background round-trip", () => {
    const { win, setAudioMuted } = mkBgWin()
    const state = { painting: true, manualMuted: true, backgrounded: false }
    applyOsrBackground(win, state, true)
    applyOsrBackground(win, state, false)
    // manualMuted stays latched — every effective-mute application kept it true.
    expect(state.manualMuted).toBe(true)
    for (const call of setAudioMuted.mock.calls) expect(call[0]).toBe(true)
  })

  it('is idempotent — a redundant transition is a no-op', () => {
    const { win, stopPainting, setBackgroundThrottling } = mkBgWin()
    const state = { painting: false, backgrounded: true, manualMuted: false }
    expect(applyOsrBackground(win, state, true)).toBe(false)
    expect(stopPainting).not.toHaveBeenCalled()
    expect(setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('swallows webContents throws (window torn down mid-transition)', () => {
    const { win, setBackgroundThrottling, setAudioMuted } = mkBgWin()
    setBackgroundThrottling.mockImplementation(() => {
      throw new Error('destroyed')
    })
    setAudioMuted.mockImplementation(() => {
      throw new Error('destroyed')
    })
    const state = { painting: true, manualMuted: false, backgrounded: false }
    expect(() => applyOsrBackground(win, state, true)).not.toThrow()
    expect(state.backgrounded).toBe(true)
  })
})

// Background project sessions (Phase 3): the GLOBAL_OSR_MAX victim picker. Pure — the e2e proves
// the live keep-alive path; these pin the eviction POLICY (backgrounded-only, oldest-first,
// exactly-enough, foreground never starved) without staging 8 real offscreen windows.
describe('pickOsrEvictions (GLOBAL_OSR_MAX existence budget)', () => {
  const bg = (at?: number): { backgrounded: boolean; backgroundedAt?: number } => ({
    backgrounded: true,
    backgroundedAt: at
  })
  const fg = (): { backgrounded: boolean } => ({ backgrounded: false })

  it('returns [] while the new window still fits under the budget', () => {
    expect(pickOsrEvictions([], 8)).toEqual([])
    expect(
      pickOsrEvictions(
        [
          ['a', bg(1)],
          ['b', fg()]
        ],
        8
      )
    ).toEqual([])
    // Exactly one slot free: 7 entries + the new one = 8 = max → still no eviction.
    const seven: Array<[string, { backgrounded: boolean; backgroundedAt?: number }]> = Array.from(
      { length: 7 },
      (_, i) => [`b${i}`, bg(i)]
    )
    expect(pickOsrEvictions(seven, 8)).toEqual([])
  })

  it('evicts the LONGEST-backgrounded entries first, exactly enough to fit the new window', () => {
    const entries: Array<[string, { backgrounded: boolean; backgroundedAt?: number }]> = [
      ['fresh', bg(400)],
      ['old', bg(100)],
      ['f1', fg()],
      ['mid', bg(250)],
      ['f2', fg()],
      ['f3', fg()],
      ['f4', fg()],
      ['f5', fg()]
    ]
    // size 8, max 8 → need exactly 1: the oldest backgrounded entry, nothing more.
    expect(pickOsrEvictions(entries, 8)).toEqual(['old'])
    // A tighter budget needs 3 → all three backgrounded, oldest first, still no foreground.
    expect(pickOsrEvictions(entries, 6)).toEqual(['old', 'mid', 'fresh'])
  })

  it('NEVER evicts a foreground entry, even when that leaves the budget overshot', () => {
    const entries: Array<[string, { backgrounded: boolean; backgroundedAt?: number }]> = [
      ...Array.from(
        { length: 8 },
        (_, i) => [`f${i}`, fg()] as [string, { backgrounded: boolean }]
      ),
      ['onlyBg', bg(50)]
    ]
    // size 9, max 8 → need 2, but only one candidate: evict it and deliberately overshoot.
    expect(pickOsrEvictions(entries, 8)).toEqual(['onlyBg'])
    expect(
      pickOsrEvictions(
        Array.from({ length: 9 }, (_, i) => [`f${i}`, fg()]),
        8
      )
    ).toEqual([])
  })

  it('treats a missing backgroundedAt as maximally stale (evicted first)', () => {
    const entries: Array<[string, { backgrounded: boolean; backgroundedAt?: number }]> = [
      ['stamped', bg(10)],
      ['unstamped', bg(undefined)],
      ...Array.from({ length: 6 }, (_, i) => [`f${i}`, fg()] as [string, { backgrounded: boolean }])
    ]
    expect(pickOsrEvictions(entries, 8)).toEqual(['unstamped'])
  })
})

// Background project sessions (Phase 3): the switch-back synthetic re-emit. Without it a
// remounted board whose OSR window SURVIVED the switch sits on "Connecting…" with a stale URL
// bar forever (the kept window fires no new lifecycle events). These pin the convergence
// contract: navigate always, finish-load only for a genuinely ready+non-failed page, no throw
// when the window died mid-remount — and, critically, NO reload call anywhere in the path.
describe('emitOsrRemountState (switch-back re-emit)', () => {
  function mkWc(url = 'http://localhost:5173/deep/route') {
    return {
      getURL: () => url,
      navigationHistory: { canGoBack: () => true, canGoForward: () => false }
    }
  }

  it('emits did-navigate (live URL + history) AND did-finish-load for a ready page', () => {
    const emit = vi.fn()
    emitOsrRemountState('b1', { ready: true, failed: false }, mkWc(), emit)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenNthCalledWith(1, {
      id: 'b1',
      type: 'did-navigate',
      url: 'http://localhost:5173/deep/route',
      canGoBack: true,
      canGoForward: false
    })
    expect(emit).toHaveBeenNthCalledWith(2, {
      id: 'b1',
      type: 'did-finish-load',
      url: 'http://localhost:5173/deep/route'
    })
  })

  it('emits ONLY did-navigate when the page never became ready (stay honest)', () => {
    const emit = vi.fn()
    emitOsrRemountState('b2', { ready: false, failed: false }, mkWc(), emit)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ id: 'b2', type: 'did-navigate' })
  })

  it('re-emits did-fail-load for a failed page (review fix: the kept window fires no new lifecycle, so navigate-only left the board stuck at "Connecting…")', () => {
    const emit = vi.fn()
    emitOsrRemountState('b3', { ready: true, failed: true }, mkWc(), emit)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[0][0]).toMatchObject({ id: 'b3', type: 'did-navigate' })
    expect(emit.mock.calls[1][0]).toMatchObject({
      id: 'b3',
      type: 'did-fail-load',
      url: 'http://localhost:5173/deep/route',
      errorCode: -1
    })
  })

  it('failed wins over never-ready — the board must land on load-failed, not Connecting', () => {
    const emit = vi.fn()
    emitOsrRemountState('b5', { ready: false, failed: true }, mkWc(), emit)
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit.mock.calls[1][0]).toMatchObject({ id: 'b5', type: 'did-fail-load' })
  })

  it('swallows a webContents that throws (window died mid-remount)', () => {
    const emit = vi.fn()
    const dead = {
      getURL: (): string => {
        throw new Error('destroyed')
      },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
    expect(() =>
      emitOsrRemountState('b4', { ready: true, failed: false }, dead, emit)
    ).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
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

// ── OSR disposed-frame send fix ──────────────────────────────────────────────────────────────────
// The four emit* helpers send to the module-level host `owner` from the OSR paint pump, which keeps
// firing across a dev HMR full-page reload. During that reload the host's top-level render frame is
// disposed mid-swap while the BrowserWindow + its webContents stay ALIVE (isDestroyed()===false) and
// render-process-gone never fires — so `owner.webContents.send` hits a disposed frame and Electron
// logs the uncatchable "Render frame was disposed before WebFrameMain could be accessed" spew on
// every paint. The fix = a dual destroyed-guard (covers close/crash) PLUS a navigation-driven
// readiness gate (covers the reload frame-swap the destroyed-checks can't see). These mirror the
// fake-BrowserWindow / fake-emitter doubles in index.flushRenderer.test.ts and previewShared.test.ts.

describe('canEmitToOwner (OSR disposed-frame send guard)', () => {
  const liveWin = (): BrowserWindow =>
    ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false }
    }) as unknown as BrowserWindow

  it('allows a live, ready owner', () => {
    expect(canEmitToOwner(liveWin(), true)).toBe(true)
  })

  it('denies a null owner (post-disposeAllOsr)', () => {
    expect(canEmitToOwner(null, true)).toBe(false)
  })

  it('denies a destroyed window WITHOUT touching .webContents (throwing getter)', () => {
    // Reads isDestroyed() FIRST, so a real destroyed window's throwing .webContents never escapes
    // (the BUG-001 shape from index.flushRenderer.test.ts).
    const destroyed = {
      isDestroyed: () => true,
      get webContents(): never {
        throw new Error('Object has been destroyed')
      }
    } as unknown as BrowserWindow
    expect(() => canEmitToOwner(destroyed, true)).not.toThrow()
    expect(canEmitToOwner(destroyed, true)).toBe(false)
  })

  it('denies when only the webContents is destroyed (board close / app teardown race)', () => {
    const wcGone = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true }
    } as unknown as BrowserWindow
    expect(canEmitToOwner(wcGone, true)).toBe(false)
  })

  it('🔒 denies a LIVE, NOT-ready owner — the HMR/page-reload disposed-frame swap the bare isDestroyed guard misses', () => {
    // The load-bearing case: window + webContents both report alive, but the frame is mid-swap. Only
    // the readiness gate suppresses the send here; the dual isDestroyed() guard alone would let it
    // through and reproduce the spew.
    expect(canEmitToOwner(liveWin(), false)).toBe(false)
  })
})

describe('registerOwnerLifecycle (host frame-readiness gate)', () => {
  type Listener = (...args: unknown[]) => void
  // Single-listener-per-event fake host webContents (registerOwnerLifecycle wires one per event),
  // mirroring previewShared.test.ts's fakeWc. `wc` is cast to the helper's own param type (the
  // un-exported OwnerLifecycleTarget, reached via Parameters) so the fake satisfies its overloads
  // without widening the production interface; `emit` stays separately typed for the test to fire.
  function fakeHostWc(): {
    wc: Parameters<typeof registerOwnerLifecycle>[0]
    emit: (event: string, ...args: unknown[]) => void
  } {
    const handlers = new Map<string, Listener>()
    const on = (event: string, listener: Listener): unknown => {
      handlers.set(event, listener)
      return undefined
    }
    return {
      wc: { on } as unknown as Parameters<typeof registerOwnerLifecycle>[0],
      emit: (event, ...args) => handlers.get(event)?.(...args)
    }
  }
  const noop = (): void => {}

  it('drops ready FALSE the instant a main-frame page navigation STARTS (the frame swap)', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: true }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(holder.ready).toBe(false)
  })

  it('IGNORES a same-document SPA route (hash/pushState) — leaves ready true', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: true }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(holder.ready).toBe(true)
  })

  it('IGNORES a sub-frame navigation — leaves ready true', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: true }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(holder.ready).toBe(true)
  })

  it('re-arms ready TRUE on commit (did-navigate)', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: false }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-navigate')
    expect(holder.ready).toBe(true)
  })

  it('re-arms ready TRUE on did-finish-load', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: false }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-finish-load')
    expect(holder.ready).toBe(true)
  })

  it('🔒 re-arms ready TRUE on a FAILED/aborted main-frame reload (did-fail-load) — no permanent silence', () => {
    // The regression a did-finish-load-only re-arm would cause: a reload that aborts mid-HMR (dev
    // server bounced) never fires did-finish-load, so without this the gate stays false forever and
    // EVERY open board goes permanently silent.
    const { wc, emit } = fakeHostWc()
    const holder = { ready: true }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(holder.ready).toBe(false)
    emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://localhost:5173/', true)
    expect(holder.ready).toBe(true)
  })

  it('does NOT re-arm on a SUB-frame did-fail-load (the main-frame swap is still in progress)', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: false }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-fail-load', {}, -2, 'ERR_FAILED', 'http://localhost:5173/sub', false)
    expect(holder.ready).toBe(false)
  })

  it('forces ready FALSE and nulls the owner (onGone) on a host render-process-gone crash', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: true }
    let gone = false
    registerOwnerLifecycle(wc, holder, () => {
      gone = true
    })
    emit('render-process-gone')
    expect(holder.ready).toBe(false)
    expect(gone).toBe(true)
  })

  it('models the full HMR cycle: ready → (nav-start) false → (finish-load) true', () => {
    const { wc, emit } = fakeHostWc()
    const holder = { ready: true }
    registerOwnerLifecycle(wc, holder, noop)
    emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(holder.ready).toBe(false) // sends suppressed across the disposed-frame swap
    emit('did-finish-load')
    expect(holder.ready).toBe(true) // resumed once the new frame committed
  })
})
