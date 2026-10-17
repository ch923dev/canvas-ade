import { useEffect, type RefObject } from 'react'
import { create } from 'zustand'
import { useCanvasStore } from './canvasStore'
import type { CanvasViewport } from '../lib/boardSchema'

/**
 * Ephemeral live-VIEW bus (spatial awareness S0 / C1). The React-free MCP code (the tidy applier in
 * `spatialMcpApply`, the board publisher in `useMcpPublish`) needs facts about the user's view that
 * only the mounted Canvas can measure. They are parked HERE by {@link useCanvasViewTracker}, which
 * `useTidyTile` mounts inside the Canvas next to the pane ref it already owns.
 *
 * - `pane` is the clientWidth/clientHeight of the canvas PANE element (CSS px) — the exact element and
 *   metric `useTidyTile.paneSize` reads for the UI tidy, never the window — kept current by a
 *   ResizeObserver. `null` while no Canvas is mounted (welcome screen, node-env unit tests).
 * - `camera` is the SETTLED React Flow transform: the live `canvasStore.viewport` mirror moves every
 *   camera frame, so it is copied here only once the camera has been still for
 *   {@link VIEW_SETTLE_MS}. That is what lets the publisher re-publish `view` on camera settle and
 *   never per frame. (The store mirror, not `onMoveEnd`: programmatic fits bypass RF's move events —
 *   the `useZoomSettle` lesson.)
 *
 * SESSION STATE ONLY — never serialized, never routed into boardSchema or PATCHABLE_KEYS (the
 * scene/session split, like cameraRequestStore).
 */

export interface PaneSize {
  w: number
  h: number
}

/** The camera must be still this long before it counts as settled (matches the publish debounce). */
export const VIEW_SETTLE_MS = 150

interface CanvasViewState {
  pane: PaneSize | null
  camera: CanvasViewport | null
  setPane: (pane: PaneSize | null) => void
  setCamera: (camera: CanvasViewport | null) => void
}

const samePane = (a: PaneSize | null, b: PaneSize | null): boolean =>
  a === b || (a !== null && b !== null && a.w === b.w && a.h === b.h)

const sameCamera = (a: CanvasViewport | null, b: CanvasViewport | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.zoom === b.zoom)

export const useCanvasViewStore = create<CanvasViewState>((set) => ({
  pane: null,
  camera: null,
  // Equal-value writes are dropped so a tick that changed nothing re-renders no subscriber.
  setPane: (pane) => set((s) => (samePane(s.pane, pane) ? s : { pane })),
  setCamera: (camera) => set((s) => (sameCamera(s.camera, camera) ? s : { camera }))
}))

/**
 * Feed {@link useCanvasViewStore} from the mounted Canvas. Mount exactly once, with the canvas pane
 * ref (`useTidyTile` does). The ResizeObserver re-measures on every pane resize (window resize,
 * minimize/restore, fullscreen); the camera is copied on settle. The unmount clears both so a stale
 * view never outlives its Canvas.
 */
export function useCanvasViewTracker(paneRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const { setPane, setCamera } = useCanvasViewStore.getState()
    const measure = (): void => setPane({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)

    // Camera settle: debounce the per-frame viewport mirror (identity compare — it is replaced per change).
    let timer: number | null = null
    let prev = useCanvasStore.getState().viewport
    setCamera(prev)
    const unsub = useCanvasStore.subscribe((s) => {
      if (s.viewport === prev) return
      prev = s.viewport
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        setCamera(useCanvasStore.getState().viewport)
      }, VIEW_SETTLE_MS)
    })
    return () => {
      ro.disconnect()
      unsub()
      if (timer !== null) window.clearTimeout(timer)
      setPane(null)
      setCamera(null)
    }
  }, [paneRef])
}
