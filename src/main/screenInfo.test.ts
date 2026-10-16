import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'

const { getDisplayMatching } = vi.hoisted(() => ({ getDisplayMatching: vi.fn() }))
vi.mock('electron', () => ({ screen: { getDisplayMatching } }))

import { readDisplayInfo } from './screenInfo'

/** A fake BrowserWindow exposing only what readDisplayInfo reads. */
function fakeWin(opts: { destroyed?: boolean; maximized?: boolean; fullscreen?: boolean } = {}) {
  return {
    isDestroyed: () => opts.destroyed ?? false,
    getBounds: () => ({ x: 2000, y: 40, width: 1280, height: 800 }),
    isMaximized: () => opts.maximized ?? false,
    isFullScreen: () => opts.fullscreen ?? false
  } as unknown as BrowserWindow
}

beforeEach(() => {
  getDisplayMatching.mockReset()
  getDisplayMatching.mockReturnValue({
    workArea: { x: 1920, y: 0, width: 2560, height: 1400 },
    scaleFactor: 1.5
  })
})

describe('readDisplayInfo (C2 — the display holding the main window)', () => {
  it('reads the matching display work area + scale factor and the window state', () => {
    const win = fakeWin({ maximized: true })
    expect(readDisplayInfo(win)).toEqual({
      workArea: { x: 1920, y: 0, w: 2560, h: 1400 },
      scaleFactor: 1.5,
      maximized: true,
      fullscreen: false
    })
    // Matched by the window's OWN bounds (the display it sits on, not the primary display).
    expect(getDisplayMatching).toHaveBeenCalledWith({ x: 2000, y: 40, width: 1280, height: 800 })
  })

  it('reports fullscreen', () => {
    expect(readDisplayInfo(fakeWin({ fullscreen: true }))?.fullscreen).toBe(true)
  })

  it('null without a window, or with a destroyed one — never touches screen', () => {
    expect(readDisplayInfo(null)).toBeNull()
    expect(readDisplayInfo(fakeWin({ destroyed: true }))).toBeNull()
    expect(getDisplayMatching).not.toHaveBeenCalled()
  })

  it('null when Electron screen throws (e.g. read before app ready)', () => {
    getDisplayMatching.mockImplementation(() => {
      throw new Error("The 'screen' module can't be used before the app 'ready' event")
    })
    expect(readDisplayInfo(fakeWin())).toBeNull()
  })
})
