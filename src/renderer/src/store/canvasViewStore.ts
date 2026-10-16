import { useEffect, type RefObject } from 'react'
import { create } from 'zustand'

/**
 * Ephemeral live-VIEW bus (spatial awareness S0 / C1). The React-free MCP code (the tidy applier in
 * `spatialMcpApply`, the board publisher in `useMcpPublish`) needs facts about the user's view that
 * only the mounted Canvas can measure. They are parked HERE by {@link useCanvasViewTracker}, which
 * `useTidyTile` mounts inside the Canvas next to the pane ref it already owns.
 *
 * - `pane` is the clientWidth/clientHeight of the canvas PANE element (CSS px) — the exact element and
 *   metric `useTidyTile.paneSize` reads for the UI tidy, never the window — kept current by a
 *   ResizeObserver. `null` while no Canvas is mounted (welcome screen, node-env unit tests).
 *
 * SESSION STATE ONLY — never serialized, never routed into boardSchema or PATCHABLE_KEYS (the
 * scene/session split, like cameraRequestStore).
 */

export interface PaneSize {
  w: number
  h: number
}

interface CanvasViewState {
  pane: PaneSize | null
  setPane: (pane: PaneSize | null) => void
}

const samePane = (a: PaneSize | null, b: PaneSize | null): boolean =>
  a === b || (a !== null && b !== null && a.w === b.w && a.h === b.h)

export const useCanvasViewStore = create<CanvasViewState>((set) => ({
  pane: null,
  // Equal-value writes are dropped so a ResizeObserver tick that changed nothing re-renders no subscriber.
  setPane: (pane) => set((s) => (samePane(s.pane, pane) ? s : { pane }))
}))

/**
 * Feed {@link useCanvasViewStore} from the mounted Canvas. Mount exactly once, with the canvas pane
 * ref (`useTidyTile` does). The ResizeObserver re-measures on every pane resize (window resize,
 * minimize/restore, fullscreen); the unmount clears the pane so a stale size never outlives its Canvas.
 */
export function useCanvasViewTracker(paneRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = paneRef.current
    if (!el) return
    const { setPane } = useCanvasViewStore.getState()
    const measure = (): void => setPane({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      setPane(null)
    }
  }, [paneRef])
}
