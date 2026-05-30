/** Board-level actions, provided by Canvas and consumed by BoardNode to build
 *  per-id callbacks for the shared BoardFrame menu / maximize button. */
import { createContext } from 'react'

export interface BoardActions {
  requestFullView: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)
