/**
 * Build the controlled React Flow nodes from the board store, REUSING the prior node (and
 * its `data`) object whenever a board's inputs are unchanged. The naive `boards.map(...)`
 * mints a fresh `data` object per board on every recompute, so every BoardNode gets a new
 * `data` ref and re-renders even when only ONE board moved. The per-id cache keeps stable
 * refs for untouched boards, so React Flow re-renders only the node that actually changed.
 *
 * Pure except for the caller-owned `cache` (a useRef Map): identical inputs return the
 * identical node reference, which makes this unit-testable without React.
 */
import type { Board } from '../lib/boardSchema'
import type { BoardFlowNode } from './BoardNode'

/** Selection / focus / full-view flags that drive per-node dim + full-view state. */
export interface NodeFlags {
  selectedId: string | null
  focusedId: string | null
  fullViewId: string | null
  cameraFullViewId: string | null
}

interface CacheEntry {
  node: BoardFlowNode
  board: Board
  dimmed: boolean
  fullView: boolean
  selected: boolean
}

/** Caller-owned per-id node cache (hold it in a useRef). */
export type NodeCache = Map<string, CacheEntry>

export function buildBoardNodes(
  boards: Board[],
  flags: NodeFlags,
  cache: NodeCache
): BoardFlowNode[] {
  const { selectedId, focusedId, fullViewId, cameraFullViewId } = flags
  const live = new Set<string>()
  const nodes = boards.map((b) => {
    live.add(b.id)
    const dimmed =
      (focusedId !== null && focusedId !== b.id) ||
      (cameraFullViewId !== null && cameraFullViewId !== b.id)
    const fullView = fullViewId === b.id || cameraFullViewId === b.id
    const selected = b.id === selectedId
    const prev = cache.get(b.id)
    if (
      prev &&
      prev.board === b &&
      prev.dimmed === dimmed &&
      prev.fullView === fullView &&
      prev.selected === selected
    ) {
      return prev.node
    }
    const node: BoardFlowNode = {
      id: b.id,
      type: 'board',
      position: { x: b.x, y: b.y },
      style: { width: b.w, height: b.h },
      data: { board: b, dimmed, fullView },
      selected,
      dragHandle: '.board-titlebar'
    }
    cache.set(b.id, { node, board: b, dimmed, fullView, selected })
    return node
  })
  // Prune entries for boards that are gone, so the cache can't grow unbounded across deletes.
  if (cache.size > live.size) {
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id)
  }
  return nodes
}
