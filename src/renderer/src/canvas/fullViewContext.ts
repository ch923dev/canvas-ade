/** The full-view modal's portal host element (null when no modal is open). The
 *  matching BoardNode portals its live subtree into this element so the board is
 *  relocated, not re-mounted (PTY / xterm / native view survive). */
import { createContext } from 'react'

export const FullViewContext = createContext<HTMLElement | null>(null)

/**
 * Ambient "this board is in the full-view modal" flag, provided by BoardNode around
 * each board's subtree. The per-type boards (TerminalBoard / BrowserBoard /
 * PlanningBoard) render their own `BoardFrame` and don't all forward a `fullView`
 * prop, so the title-bar exit affordance (restore glyph + "Exit full view (Esc)")
 * is driven through this context instead of threading a prop through every board.
 * The explicit `fullView` prop, when set, still wins (override). Default `false`.
 */
export const BoardFullViewContext = createContext(false)
