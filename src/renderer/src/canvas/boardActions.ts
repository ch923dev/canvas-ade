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
  /** Add a board to a group, animating the cluster re-pack (S6). */
  addToGroup: (boardId: string, groupId: string) => void
  /** Remove a board from every group it belongs to (S6). */
  removeFromGroup: (boardId: string) => void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)
