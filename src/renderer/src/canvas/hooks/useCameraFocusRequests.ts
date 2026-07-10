import { useEffect } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCameraRequestStore } from '../../store/cameraRequestStore'
import { cameraAnim } from '../../lib/motion'
import { FIT_FRAME } from '../../lib/canvasView'

/**
 * Consume MCP camera-focus requests (H1 / Lane H) inside the ReactFlow provider. The applier
 * validated the target against the live store and parked it on `cameraRequestStore`; this hook
 * executes it with the SAME camera verbs the keyboard/palette paths use — `focusBoardById`
 * (Enter/double-click focus semantics: select + dim + raster-capped fit) and `fitGroup` (member
 * fit, exits dim-focus) — so an agent-driven focus is pixel-identical to a user-driven one and
 * the two can't drift. Fit-all mirrors the palette's `fitAll` (FIT_FRAME + §9 tween).
 *
 * Deps are injected from Canvas.tsx (where both verb hooks already live) — this hook adds no new
 * camera logic, only the bus consumption. Each request executes ONCE (`consume` clears it), so a
 * provider re-mount can't replay a stale fit.
 */
export function useCameraFocusRequests(deps: {
  rf: ReactFlowInstance
  focusBoardById: (id: string) => void
  fitGroup: (groupId: string) => void
}): void {
  const { rf, focusBoardById, fitGroup } = deps
  useEffect(() => {
    return useCameraRequestStore.subscribe((state, prev) => {
      if (state.seq === prev.seq || state.target === null) return
      const target = state.target
      state.consume()
      if (target.kind === 'board') focusBoardById(target.id)
      else if (target.kind === 'group') fitGroup(target.id)
      else void rf.fitView(cameraAnim(FIT_FRAME))
    })
  }, [rf, focusBoardById, fitGroup])
}
