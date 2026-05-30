/** Board-level actions, provided by Canvas and consumed by BoardNode to build
 *  per-id callbacks for the shared BoardFrame menu / maximize button. */
import { createContext } from 'react'

export interface BoardActions {
  requestFullView: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
  /** Slice C′: open/point a Browser board at `url` and link it to the source board. */
  pushPreview: (fromBoardId: string, url: string) => void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)
