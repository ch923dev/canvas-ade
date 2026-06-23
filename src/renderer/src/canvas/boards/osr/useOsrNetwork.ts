import { useEffect } from 'react'
import { useOsrNetworkStore } from '../../../store/osrNetworkStore'
import { useSharedOsrNet } from './useSharedOsrNet'

/**
 * Subscribe a board's MAIN Network capture (`preview:osrNet`) into the `osrNetworkStore` — but ONLY
 * while the inspector panel is open. Subscribe replays the current ring buffer once, then streams
 * coalesced deltas; closing the panel unsubscribes → zero further IPC (the no-IPC-when-closed
 * invariant). On board unmount the board's state is dropped (FIND-011: wire cleanup from the start).
 *
 * JD-4: the subscription is now refcounted (`useSharedOsrNet`) so a Data-Flow board can watch the same
 * source board's capture concurrently — the MAIN stream survives until the LAST watcher leaves.
 */
export function useOsrNetwork(boardId: string): void {
  const open = useOsrNetworkStore((s) => s.byBoard[boardId]?.open ?? false)
  useSharedOsrNet(boardId, open)

  // FIND-011: a board's ephemeral net state must die with the board, not leak across remounts.
  useEffect(() => () => useOsrNetworkStore.getState().clearBoard(boardId), [boardId])
}
