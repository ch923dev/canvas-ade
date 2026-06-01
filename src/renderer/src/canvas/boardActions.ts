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
}

export const BoardActionsContext = createContext<BoardActions | null>(null)
