/** Board-level actions, provided by Canvas and consumed by BoardNode to build
 *  per-id callbacks for the shared BoardFrame menu / maximize button. */
import { createContext } from 'react'
import type { ResolvedPushTarget } from '../lib/previewTarget'

export interface BoardActions {
  requestFullView: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
  /** Push `url` to a chosen target — an existing Browser board (refresh / connect /
   *  re-target) or a fresh spawn ("New browser"). The renderer (TerminalBoard) decides
   *  the target by gesture: a tap refreshes the linked browser(s); a long-press opens a
   *  multi-select picker. Setting an existing browser re-points its `previewSourceId`,
   *  severing any prior terminal link. */
  pushPreviewTo: (fromBoardId: string, url: string, target: ResolvedPushTarget) => void
  /**
   * Begin a connector drag from `fromBoardId` (M2). The board's title-bar connector
   * handle calls this on pointer-down; Canvas then tracks the pointer (rubber-band
   * overlay) and on release resolves the drop target from store geometry
   * (`resolveConnectTarget`) → `addConnector(from, target, 'orchestration')`. The
   * in-flight "connecting" state is EPHEMERAL (never persisted — scene/session split).
   */
  startConnect: (fromBoardId: string) => void
  /**
   * Add a board to a group (GROUP-05): a plain membership add that does NOT re-pack the
   * cluster, so a manually-arranged layout survives. (The animated absorb re-pack stays on
   * the drag-onto-box gesture only — Canvas.onNodeDragStop → reflowAddToGroup.)
   */
  addToGroup: (boardId: string, groupId: string) => void
  /** GROUP-06: remove a board from ONE named group (per-membership menu row). */
  removeFromGroup: (boardId: string, groupId: string) => void
  /** GROUP-06: remove a board from every group it belongs to, in one undo step. */
  removeFromAllGroups: (boardId: string) => void
  /**
   * Camera-fit + dim focus on a board (the canonical `focusBoardById` path — the SAME one
   * Enter / double-click / minimap use). Used by the cross-board transfer toast's "Focus"
   * action to jump to the destination board. No auto-pan elsewhere.
   */
  focusBoard: (id: string) => void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)
