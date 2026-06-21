import { useEffect } from 'react'
import { useOsrNetworkStore } from '../../../store/osrNetworkStore'

/**
 * Subscribe a board's MAIN Network capture (`preview:osrNet`) into the `osrNetworkStore` — but ONLY
 * while the inspector panel is open. Subscribe replays the current ring buffer once, then streams
 * coalesced deltas; closing the panel unsubscribes → zero further IPC (the no-IPC-when-closed
 * invariant). On board unmount the board's state is dropped (FIND-011: wire cleanup from the start).
 */
export function useOsrNetwork(boardId: string): void {
  const open = useOsrNetworkStore((s) => s.byBoard[boardId]?.open ?? false)

  useEffect(() => {
    if (!open) return
    const off = window.api.onPreviewOsrNet(boardId, (m) =>
      useOsrNetworkStore.getState().apply(boardId, m)
    )
    void window.api.subscribeOsrNet(boardId)
    return () => {
      off()
      void window.api.unsubscribeOsrNet(boardId)
    }
  }, [boardId, open])

  // FIND-011: a board's ephemeral net state must die with the board, not leak across remounts.
  useEffect(() => () => useOsrNetworkStore.getState().clearBoard(boardId), [boardId])
}
