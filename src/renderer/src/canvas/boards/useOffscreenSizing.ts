import { useEffect } from 'react'
import type { BrowserViewport } from '../../lib/boardSchema'
import { computeOsrSize } from '../../lib/osrSizing'
import { useSettledZoomStore } from '../../store/settledZoomStore'

/**
 * OS-3 Phase 1 (M1 sharpness + M4 reflow) — drive the offscreen preview's render size.
 *
 * Computes the offscreen render size from the board geometry, the SETTLED camera zoom, and
 * the window DPR, and pushes it to MAIN via a single `preview:osrResize`. The OSR path's
 * defining win is ZERO per-frame camera IPC (the `<canvas>` moves with the DOM), so this must
 * NOT become a pump: the size only changes on three low-frequency events — a settled-zoom
 * change (`settledZoomStore`, published once per camera settle by `useZoomSettle`, #122), a
 * preset switch (`viewport`), or a board-resize that changes the device fit — plus a monitor
 * move (DPR change). MAIN no-op-guards a redundant request, so re-sending on every settle is
 * cheap. A resize that races ahead of the window's open is buffered in MAIN (pendingSize).
 *
 * Sibling of useOffscreenPreview / useOffscreenInput.
 */
export function useOffscreenSizing(
  boardId: string,
  w: number,
  h: number,
  viewport: BrowserViewport
): void {
  const settledZoom = useSettledZoomStore((s) => s.zoom)
  useEffect(() => {
    const send = (): void => {
      const dpr = window.devicePixelRatio || 1
      void window.api.resizeOsr(boardId, computeOsrSize({ w, h, viewport }, settledZoom, dpr))
    }
    send()
    // Re-send on a DPR change (window moved to a different-density monitor) — re-check, not a
    // one-shot read (the BUG-016 dpr-reblur class). `resize` is the event that fires on a DPR
    // change; guard so a same-DPR resize doesn't spam.
    let lastDpr = window.devicePixelRatio || 1
    const onResize = (): void => {
      const dpr = window.devicePixelRatio || 1
      if (dpr === lastDpr) return
      lastDpr = dpr
      send()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [boardId, w, h, viewport, settledZoom])
}
