/**
 * Spatial awareness C1/C2 — the {@link DisplayInfo} MAIN adds to `canvas://layout`'s `screen`: the
 * work area + scale factor of the display that holds the main window (`screen.getDisplayMatching`),
 * and whether the window is maximized / fullscreen. Computed LAZILY at read time from the live
 * window — no IPC, nothing cached, nothing persisted (session state). The renderer never sends it.
 *
 * Null-safe: no window, a destroyed window, or an Electron `screen` failure all read as `null` (the
 * digest then reports the view without a display) — a read-only enrichment must never fail the read.
 */
import { screen, type BrowserWindow } from 'electron'
import type { DisplayInfo } from '../shared/spatialTypes'

export function readDisplayInfo(win: BrowserWindow | null): DisplayInfo | null {
  if (!win || win.isDestroyed()) return null
  try {
    const { workArea, scaleFactor } = screen.getDisplayMatching(win.getBounds())
    return {
      workArea: { x: workArea.x, y: workArea.y, w: workArea.width, h: workArea.height },
      scaleFactor,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen()
    }
  } catch {
    return null
  }
}
