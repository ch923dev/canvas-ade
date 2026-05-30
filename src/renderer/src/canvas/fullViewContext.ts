/** The full-view modal's portal host element (null when no modal is open). The
 *  matching BoardNode portals its live subtree into this element so the board is
 *  relocated, not re-mounted (PTY / xterm / native view survive). */
import { createContext } from 'react'

export const FullViewContext = createContext<HTMLElement | null>(null)
