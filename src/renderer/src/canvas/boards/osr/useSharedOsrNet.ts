import { useEffect } from 'react'
import { useOsrNetworkStore } from '../../../store/osrNetworkStore'

/**
 * Shared, REFCOUNTED MAIN Network subscription for a board id (JD-4). The FIRST active subscriber opens
 * the MAIN stream (`subscribeOsrNet` → replay + deltas), the LAST closes it — so the Browser board's
 * Network panel AND a Data-Flow board can both watch the same source board without one's unmount
 * tearing down the other's stream. Every caller installs its own handler (preload fans to a Set) and
 * all apply into the single `osrNetworkStore`; a late subscriber reads the already-populated store
 * reactively, so no re-replay is needed past the first subscribe.
 */
const refcounts = new Map<string, number>()

export function useSharedOsrNet(boardId: string | undefined, active: boolean): void {
  useEffect(() => {
    if (!boardId || !active) return
    const off = window.api.onPreviewOsrNet(boardId, (m) =>
      useOsrNetworkStore.getState().apply(boardId, m)
    )
    const n = (refcounts.get(boardId) ?? 0) + 1
    refcounts.set(boardId, n)
    if (n === 1) void window.api.subscribeOsrNet(boardId) // 0→1: open the MAIN stream
    return () => {
      off()
      const left = (refcounts.get(boardId) ?? 1) - 1
      if (left <= 0) {
        refcounts.delete(boardId)
        void window.api.unsubscribeOsrNet(boardId) // last subscriber gone → close the MAIN stream
      } else {
        refcounts.set(boardId, left)
      }
    }
  }, [boardId, active])
}
