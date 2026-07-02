/**
 * Board Inspector — SHELL (the compact, selection-retargeted options popover).
 *
 * The redesign home for the per-board header long-tail (see
 * docs/research/mocks/board-inspector-popover-mock). A single screen-space panel rendered as app
 * chrome OUTSIDE the React Flow transform, so it stays crisp + clickable at any zoom and at the LOD
 * threshold where on-board chrome is sub-pixel.
 *
 * v2 layout (signed off 2026-06-29): a COMPACT POPOVER — docked LEFT (just inside the file-tree
 * SidePanel lane so the two coexist side-by-side, never overlap), vertically CENTRED, sized to its
 * content (caps at viewport height + scrolls the body). Not the former full-height right rail.
 *
 * v2 reveal model: REVEAL-ON-SELECT. The popover is shown whenever there is a single eligible
 * selection (`inspectorEligible` → `inspectorRevealed`) — clicking a board IS the trigger, like a
 * properties panel. There is no proximity zone / focus pin / edge handle anymore. Dismissal is
 * deselection, which the canvas already does (pane click clears selection; selecting another board
 * retargets). The wrapper keeps `pointer-events:none` so the hidden popover passes clicks through.
 *
 * The shell owns the chrome + identity (TypeGlyph / type tag / title / Jump / Duplicate, all store-
 * driven) and exposes a CONTENT SLOT (`inspectorSlotStore`); the single eligible board portals its
 * OWN per-type inspector (`TerminalInspector`, …) into that slot — so per-type controls reuse the
 * board's exact handlers with zero duplication (P0.5). A board type with no inspector yet (browser,
 * planning, …) simply leaves the slot empty until its phase lands.
 *
 * It reads `canvasStore` PURELY and only ever invokes existing store actions (jump = the one-shot
 * `pendingFocusId` intent a Canvas effect consumes; `duplicateBoard`) — it never writes selection,
 * never touches React Flow internals, and never reparents board content.
 */
import { useCallback, useEffect, type ReactElement } from 'react'
import type { BoardType } from '../lib/boardSchema'
import { useCanvasStore } from '../store/canvasStore'
import { inspectorEligible, inspectorRevealed } from './boardInspectorReveal'
import { useInspectorSlotStore } from './inspector/inspectorSlotStore'
import { InspectorAction } from './inspector/primitives'
import { TypeGlyph } from './TypeGlyph'

const TYPE_TAG: Record<BoardType, string> = {
  terminal: 'TERMINAL',
  browser: 'BROWSER',
  planning: 'PLANNING',
  command: 'COMMAND',
  file: 'FILE',
  dataflow: 'DATA FLOW'
}

export function BoardInspector(): ReactElement | null {
  const hasProject = useCanvasStore((s) => s.project.dir !== null)
  // The single selected board, or null for 0 / 2+ selection. Stable object identity → the panel
  // re-renders only when THIS board (title/type) changes, not on every unrelated board update.
  const board = useCanvasStore((s) => {
    const id = s.selectedIds.length === 1 ? s.selectedIds[0] : null
    return id ? (s.boards.find((b) => b.id === id) ?? null) : null
  })
  const zoom = useCanvasStore((s) => s.viewport?.zoom ?? 1)

  const eligible = inspectorEligible(board ? 1 : 0, zoom)
  const revealed = inspectorRevealed(eligible)

  // Publish which board owns the content slot (the single eligible one) so that board can portal
  // its per-type inspector in. Tracks eligibility, NOT reveal — the content stays mounted while
  // hidden (behind `inert`/opacity) so it is ready the instant the panel reveals.
  const activeBoardId = eligible && board ? board.id : null
  useEffect(() => {
    useInspectorSlotStore.getState().setActiveBoardId(activeBoardId)
  }, [activeBoardId])
  // Stable callback ref (recreating it each render would detach/reattach the slot every render and
  // thrash every board's portal). Publishes the slot DOM node on mount / null on unmount.
  const setSlotRef = useCallback((el: HTMLDivElement | null) => {
    useInspectorSlotStore.getState().setSlotEl(el)
  }, [])

  if (!hasProject) return null

  return (
    // pointer-events:none on the wrapper so the canvas beneath the (hidden) popover stays clickable;
    // the revealed popover opts back in via CSS.
    <div className="ca-inspector-wrap">
      <aside
        className="ca-inspector"
        data-revealed={revealed}
        // `inert` (React 19) pulls the hidden popover out of the tab order AND the a11y tree while it
        // is not revealed — without it, Tab reaches the invisible Jump/Duplicate buttons. It stays
        // mounted (not conditionally rendered) so the hide transition can still play.
        inert={!revealed}
        aria-hidden={!revealed}
        aria-label="Board inspector"
        data-test="board-inspector"
      >
        {board && (
          <>
            <div className="ca-inspector-head">
              <div className="ca-inspector-id">
                <span className="ca-inspector-glyph">
                  <TypeGlyph type={board.type} />
                </span>
                <span className="ca-inspector-type">{TYPE_TAG[board.type]}</span>
                <button
                  type="button"
                  className="ca-inspector-jump"
                  title="Jump to board"
                  aria-label="Jump to board"
                  data-test="inspector-jump"
                  onClick={() => useCanvasStore.setState({ pendingFocusId: board.id })}
                >
                  <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden>
                    <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.2" />
                    <path
                      d="M7 1.5v2M7 10.5v2M1.5 7h2M10.5 7h2"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              {/* P5 sweep (a11y): the popover landmark gets a heading — the selected board's
                  title. role/aria-level (not <h2>) so the CSS class keeps full styling control. */}
              <div className="ca-inspector-title" role="heading" aria-level={2}>
                {board.title}
              </div>
            </div>

            {/* Per-type content slot — the selected board portals its own <XInspector> in here. */}
            <div className="ca-inspector-body" ref={setSlotRef} />

            <div className="ca-inspector-foot">
              {/* P5 sweep: through the shared primitive (type="button" + the act markup) instead
                  of re-rolling its class by hand. */}
              <InspectorAction
                dataTest="inspector-duplicate"
                onClick={() => useCanvasStore.getState().duplicateBoard(board.id)}
              >
                Duplicate
              </InspectorAction>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
