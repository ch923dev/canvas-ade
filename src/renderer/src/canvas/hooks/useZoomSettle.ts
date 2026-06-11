/**
 * Camera settle watcher (terminal raster fix — docs/research/2026-06-11-terminal-font-blur.md).
 *
 * Debounces the live viewport mirror (`canvasStore.viewport`, fed every camera frame
 * by Canvas's React Flow transform subscription) and, once the camera has been still
 * for SETTLE_MS:
 *   1. snaps a zoom inside the snap band to exactly 100% (`snapZoom`), anchored at
 *      the pane center with duration 0 — the everyday working band lands pixel-exact
 *      for raster content (the xterm WebGL canvas), and
 *   2. publishes the settled zoom to `settledZoomStore` — the terminal WebGL policy
 *      (useTerminalWebgl via useTerminalSpawn) switches renderers on settle only,
 *      never per gesture frame.
 *
 * Why the store mirror and not useOnViewportChange/onMoveEnd: programmatic camera
 * moves (rf.zoomTo / fitView with duration 0) bypass onViewportChange — only
 * d3-zoom gestures fire it (the #82 camera-sync lesson). The canvasStore mirror is
 * the one source that sees every camera change, programmatic or gestural.
 *
 * Mount exactly once, inside the ReactFlowProvider (Canvas).
 */
import { useEffect } from 'react'
import { useReactFlow, useStoreApi } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { useSettledZoomStore } from '../../store/settledZoomStore'
import { snapZoom } from '../../lib/canvasView'

/** Camera must be still this long before a settle fires. Long enough to coalesce a
 *  wheel-tick burst / the 200ms cameraAnim tween, short enough to feel immediate. */
export const SETTLE_MS = 250

export function useZoomSettle(): void {
  const rf = useReactFlow()
  const storeApi = useStoreApi()

  useEffect(() => {
    let timer: number | null = null
    let prev = useCanvasStore.getState().viewport

    const settle = (): void => {
      timer = null
      const vp = useCanvasStore.getState().viewport
      if (!vp) return // no camera frame mirrored yet (fresh project) — nothing to settle
      const { x, y, zoom } = vp
      const snapped = snapZoom(zoom)
      if (snapped !== zoom) {
        // Re-anchor so the world point at the pane center stays put across the snap
        // (a bare zoomTo would anchor at the viewport origin and visibly shift content).
        const { width, height } = storeApi.getState()
        const cx = width / 2
        const cy = height / 2
        void rf.setViewport(
          {
            x: cx - ((cx - x) * snapped) / zoom,
            y: cy - ((cy - y) * snapped) / zoom,
            zoom: snapped
          },
          { duration: 0 }
        )
        return // the snap re-fires the subscription below; the NEXT settle publishes 1
      }
      useSettledZoomStore.getState().setSettledZoom(zoom)
    }

    // Route the initial (possibly project-restored) viewport through the same path,
    // so a project saved at e.g. 0.97 snaps + publishes without needing a gesture.
    timer = window.setTimeout(settle, SETTLE_MS)
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.viewport === prev) return // identity compare — viewport is replaced per change
      prev = s.viewport
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(settle, SETTLE_MS)
    })
    return () => {
      unsub()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [rf, storeApi])
}
