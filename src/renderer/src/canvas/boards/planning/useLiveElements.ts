import { useCallback } from 'react'
import type { PlanningElement } from '../../../lib/boardSchema'
import { useCanvasStore } from '../../../store/canvasStore'

/**
 * Live-read the CURRENT elements array for a planning board straight from the store —
 * NOT a render-time `elements` prop/closure snapshot. Several call sites (context-menu
 * actions, text-patch/tint/delete handlers) must write back onto whatever is live at the
 * moment they fire, not a stale snapshot captured earlier (a snapshot write-back silently
 * clobbers any edit that landed in between — BUG-008/BUG-023 class). Mirrors `commit`'s
 * own live-read discipline in PlanningBoard.tsx.
 */
export function useLiveElements(boardId: string): () => PlanningElement[] {
  return useCallback(() => {
    const live = useCanvasStore.getState().boards.find((b) => b.id === boardId)
    return live?.type === 'planning' ? live.elements : []
  }, [boardId])
}
