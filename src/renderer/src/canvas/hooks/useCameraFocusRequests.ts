import { useEffect } from 'react'
import { getViewportForBounds, type ReactFlowInstance } from '@xyflow/react'
import { useCameraRequestStore, type CameraFocusTarget } from '../../store/cameraRequestStore'
import { useCanvasViewStore } from '../../store/canvasViewStore'
import { cameraAnim } from '../../lib/motion'
import { FIT_FRAME, Z_MAX, Z_MIN } from '../../lib/canvasView'

/**
 * Consume MCP camera-focus requests (H1 / Lane H) inside the ReactFlow provider. The applier
 * validated the target against the live store and parked it on `cameraRequestStore`; this hook
 * executes it with the SAME camera verbs the keyboard/palette paths use — `focusBoardById`
 * (Enter/double-click focus semantics: select + dim + raster-capped fit) and `fitGroup` (member
 * fit, exits dim-focus) — so an agent-driven focus is pixel-identical to a user-driven one and
 * the two can't drift. Fit-all mirrors the palette's `fitAll` (FIT_FRAME + §9 tween).
 *
 * Spatial I2 adds the tidy framings: `rect` (FIT_FRAME over the arranged bbox — the same math as
 * `useTidyTile.fitToBoards`), `viewport` (the camera `roleLayout` solved) and `groupPicker` (the
 * F-key group switcher, for the W3 toast).
 *
 * Deps are injected from Canvas.tsx (where the verb hooks already live) — this hook adds no new
 * camera logic, only the bus consumption. Each request executes ONCE (`consume` clears it), so a
 * provider re-mount can't replay a stale fit.
 */
export function useCameraFocusRequests(deps: {
  rf: ReactFlowInstance
  focusBoardById: (id: string) => void
  fitGroup: (groupId: string) => void
  focusGroup: () => void
}): void {
  const { rf, focusBoardById, fitGroup, focusGroup } = deps
  useEffect(() => {
    const run = (target: CameraFocusTarget): void => {
      switch (target.kind) {
        case 'board':
          return focusBoardById(target.id)
        case 'group':
          return fitGroup(target.id)
        case 'groupPicker':
          return focusGroup()
        case 'viewport':
          void rf.setViewport(target.viewport, cameraAnim({}))
          return
        case 'rect': {
          const pane = useCanvasViewStore.getState().pane
          if (!pane || pane.w <= 0 || pane.h <= 0) {
            void rf.fitView(cameraAnim(FIT_FRAME))
            return
          }
          const { x, y, w, h } = target.rect
          const vp = getViewportForBounds(
            { x, y, width: w, height: h },
            pane.w,
            pane.h,
            FIT_FRAME.minZoom ?? Z_MIN,
            FIT_FRAME.maxZoom ?? Z_MAX,
            FIT_FRAME.padding ?? 0.1
          )
          void rf.setViewport(vp, cameraAnim({}))
          return
        }
        default:
          void rf.fitView(cameraAnim(FIT_FRAME))
      }
    }
    return useCameraRequestStore.subscribe((state, prev) => {
      if (state.seq === prev.seq || state.target === null) return
      const target = state.target
      state.consume()
      run(target)
    })
  }, [rf, focusBoardById, fitGroup, focusGroup])
}
