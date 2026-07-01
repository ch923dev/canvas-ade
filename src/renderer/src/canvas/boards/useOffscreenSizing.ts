import { useEffect } from 'react'
import type { RefObject } from 'react'
import type { BrowserViewport } from '../../lib/boardSchema'
import { computeOsrSize, computeFullViewOsrSize } from '../../lib/osrSizing'
import { useSettledZoomStore } from '../../store/settledZoomStore'
import { useOsrLivenessStore } from '../../store/osrLivenessStore'

/**
 * OS-3 Phase 1 (M1 sharpness + M4 reflow) — drive the offscreen preview's render size.
 *
 * Computes the offscreen render size from the board geometry, the SETTLED camera zoom, and
 * the window DPR, and pushes it to MAIN via a single `preview:osrResize`. The OSR path's
 * defining win is ZERO per-frame camera IPC (the `<canvas>` moves with the DOM), so this must
 * NOT become a pump: the size only changes on a few low-frequency events — a settled-zoom
 * change (`settledZoomStore`, published once per camera settle by `useZoomSettle`, #122), a
 * preset switch (`viewport`), a board-resize that changes the device fit, a monitor move (DPR
 * change), or a full-view enter/exit (PREV-01). MAIN no-op-guards a redundant request, so
 * re-sending on every settle is cheap. A resize that races ahead of the window's open is
 * buffered in MAIN (pendingSize).
 *
 * PREV-01: in PORTAL full view the board is portaled out of the camera-scaled canvas, so the
 * in-canvas `deviceFitScale × settledZoom` no longer describes the on-screen size — the preview
 * would render at the small in-canvas buffer and look blurry blown up. While `fullView` is set we
 * instead size the supersample from the canvas element's actual laid-out width (the full-view
 * pixel box), re-sending whenever that box changes (a ResizeObserver catches the open and any
 * window resize). On exit the effect re-runs and restores the in-canvas size.
 *
 * MAX_LIVE revive: an evicted (over-cap) board's offscreen window is DESTROYED (its frozen frame
 * stays on the <canvas>), and `useOffscreenPreview` REOPENS a fresh one when the board climbs back
 * into the cap. That reopened window is born at the OSR default (1280×800, S=1) — so without
 * re-driving the size on revive it would reflow the page at desktop width in a mobile/tablet frame
 * and lose its supersample (blurry) until the next zoom-settle. The `alive` flag (the same flag
 * `useOffscreenPreview` gates the window open/close on) is therefore a size trigger too: read it here
 * and skip while evicted, so a revive (alive false→true) re-runs this effect and re-pushes the preset
 * size. (A full-viewed board is always forced alive by the liveness manager, so full view is never
 * skipped.)
 *
 * Sibling of useOffscreenPreview / useOffscreenInput.
 */
export function useOffscreenSizing(
  boardId: string,
  w: number,
  h: number,
  viewport: BrowserViewport,
  fullView: boolean,
  canvasRef: RefObject<HTMLCanvasElement | null>
): void {
  const settledZoom = useSettledZoomStore((s) => s.zoom)
  // The MAX_LIVE existence flag (osrLiveness). Default true so a freshly-mounted board sizes
  // immediately; the manager flips it false on evict, true on revive. Mirrors useOffscreenPreview.
  const alive = useOsrLivenessStore((s) => s.alive[boardId] ?? true)
  useEffect(() => {
    if (fullView) {
      // Size S from the canvas's real on-screen box. clientWidth is the LAYOUT width — independent
      // of the open/close FLIP transform (which is a visual scale, not a layout change) — so we get
      // the settled full-view size immediately, not the mid-animation size.
      const sendFullView = (): void => {
        const el = canvasRef.current
        if (!el) return
        const dpr = window.devicePixelRatio || 1
        void window.api.resizeOsr(boardId, computeFullViewOsrSize(viewport, el.clientWidth, dpr))
      }
      sendFullView()
      let ro: ResizeObserver | undefined
      const el = canvasRef.current
      if (el && typeof ResizeObserver !== 'undefined') {
        // Fires on attach (catches a 0-width first tick), on the FLIP settling the layout box, and
        // on any window resize while in full view (the box is window-bound).
        ro = new ResizeObserver(() => sendFullView())
        ro.observe(el)
      }
      window.addEventListener('resize', sendFullView)
      return () => {
        ro?.disconnect()
        window.removeEventListener('resize', sendFullView)
      }
    }

    // In-canvas: the device-fit × settled-zoom × DPR supersample (M1) at the preset width (M4).
    // Evicted (over-cap) → no offscreen window to size; skip. Revive (alive false→true) re-runs this
    // effect (`alive` is in the deps) and re-pushes the preset size to the reopened window — else it
    // stays at the 1280×800 desktop default it was reborn with. Full view is always alive → never skipped.
    if (!alive) return
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
  }, [boardId, w, h, viewport, settledZoom, fullView, canvasRef, alive])
}
