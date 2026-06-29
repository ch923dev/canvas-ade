/**
 * Board Inspector — P0 SHELL (the floating right-edge, selection-retargeted options island).
 *
 * The redesign home for the per-board header long-tail (see docs/research/mocks/board-inspector-mock).
 * A single screen-space panel, rendered as app chrome OUTSIDE the React Flow transform, so it stays
 * crisp + clickable at any zoom and at the LOD threshold where on-board chrome is sub-pixel.
 *
 * The shell owns the chrome + identity (TypeGlyph / type tag / title / Jump / Duplicate, all store-
 * driven) and exposes a CONTENT SLOT (`inspectorSlotStore`); the single eligible board portals its
 * OWN per-type inspector (`TerminalInspector`, …) into that slot — so per-type controls reuse the
 * board's exact handlers with zero duplication (P0.5). A board type with no inspector yet (browser,
 * planning, …) simply leaves the slot empty until its phase lands.
 *
 * It is a right-edge mirror of `SidePanel.tsx`: same auto-hide reveal machine (proximity zone with
 * entrance/exit hysteresis, registered ONCE with closure-locals so a deps-driven re-register can't
 * drop the window listener mid-dispatch), the same `pointer-events:none` wrapper so the hidden panel
 * passes canvas clicks straight through, and the same focus-within pin.
 *
 * Reveal model (P0): the panel only has CONTENT for a single selected board at a usable zoom
 * (`inspectorEligible`); it then reveals on right-edge PROXIMITY or focus-within (`inspectorRevealed`)
 * — never purely on selection, so synthetic e2e interactions (which click coordinates, they don't
 * sweep to the screen edge) never raise it over a board. A slim 14px edge handle advertises it
 * whenever a single board is selected. Selection-auto-show / a keyboard toggle are a later tuning pass.
 *
 * It reads `canvasStore` PURELY and only ever invokes existing store actions (jump = the one-shot
 * `pendingFocusId` intent a Canvas effect consumes; `duplicateBoard`) — it never writes selection,
 * never touches React Flow internals, and never reparents board content.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import type { BoardType } from '../lib/boardSchema'
import { useCanvasStore } from '../store/canvasStore'
import { inspectorEligible, inspectorRevealed } from './boardInspectorReveal'
import { useInspectorSlotStore } from './inspector/inspectorSlotStore'
import { TypeGlyph } from './TypeGlyph'

/** Revealed-panel width (px) — mirrors SidePanel. */
const PANEL_W = 240
/** Hidden → reveal when the cursor is within this many px of the RIGHT edge. */
const REVEAL_EDGE = 36
/** While open, stay open until the cursor passes this far from the right edge. */
const KEEP_OPEN = PANEL_W + 48
/** Entrance delay — a cursor slung along the right edge shouldn't flash the panel. */
const REVEAL_DELAY_MS = 100
/** Grace after the cursor exits before the panel hides. */
const HIDE_DELAY_MS = 1200

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
  const [inZone, setInZone] = useState(false)
  const [focused, setFocused] = useState(false)

  const eligible = inspectorEligible(board ? 1 : 0, zoom)
  const revealed = inspectorRevealed(eligible, inZone, focused)

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

  // Right-edge proximity machine — the SidePanel reveal machine mirrored to the right edge. All
  // mutable state lives in closure locals and the listeners are registered ONCE (mid-dispatch-safe);
  // only the committed `inZone` crosses into React.
  useEffect(() => {
    if (!hasProject) return
    let zone: 'out' | 'pending' | 'in' = 'out'
    let enterTimer: number | null = null
    let hideTimer: number | null = null
    let last = { x: NaN }

    // Band measured from the RIGHT edge; widens once open so moving ONTO the panel keeps it revealed.
    const inBand = (x: number): boolean =>
      x >= window.innerWidth - (zone === 'in' ? KEEP_OPEN : REVEAL_EDGE)
    const cancelEnter = (): void => {
      if (enterTimer !== null) {
        window.clearTimeout(enterTimer)
        enterTimer = null
      }
    }
    const cancelHide = (): void => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
    }
    const goOutside = (): void => {
      if (zone === 'pending') {
        cancelEnter()
        zone = 'out'
      } else if (zone === 'in' && hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null
          zone = 'out'
          setInZone(false)
        }, HIDE_DELAY_MS)
      }
    }
    const onMove = (e: PointerEvent): void => {
      last = { x: e.clientX }
      if (inBand(e.clientX)) {
        cancelHide()
        if (zone === 'out') {
          zone = 'pending'
          enterTimer = window.setTimeout(() => {
            enterTimer = null
            if (inBand(last.x)) {
              zone = 'in'
              setInZone(true)
            } else {
              zone = 'out'
            }
          }, REVEAL_DELAY_MS)
        }
      } else {
        goOutside()
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseleave', goOutside)
    window.addEventListener('blur', goOutside)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', goOutside)
      window.removeEventListener('blur', goOutside)
      cancelEnter()
      cancelHide()
    }
  }, [hasProject])

  if (!hasProject) return null

  return (
    // pointer-events:none on the wrapper so the canvas beneath the (hidden) panel stays clickable;
    // the revealed panel opts back in via CSS. Focus events pass through pointer-events, so the
    // focus-within pin works from the wrapper.
    <div
      className="ca-inspector-wrap"
      style={{ width: PANEL_W }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <div
        className="ca-inspector-handle"
        data-revealed={revealed}
        data-active={!!board}
        aria-hidden="true"
      />
      <aside
        className="ca-inspector"
        data-revealed={revealed}
        // `inert` (React 19) pulls the hidden panel out of the tab order AND the a11y tree while it
        // is not revealed — without it, Tab reaches the invisible Jump/Duplicate buttons, and the
        // focus-pin (onFocus → revealed) would then pop the panel open from a stray tab stop. It
        // stays mounted (not conditionally rendered) so the 0.14s hide transition can still play.
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
              <div className="ca-inspector-title">{board.title}</div>
            </div>

            {/* Per-type content slot — the selected board portals its own <XInspector> in here. */}
            <div className="ca-inspector-body" ref={setSlotRef} />

            <div className="ca-inspector-foot">
              <button
                className="ca-inspector-act"
                data-test="inspector-duplicate"
                onClick={() => useCanvasStore.getState().duplicateBoard(board.id)}
              >
                Duplicate
              </button>
            </div>
          </>
        )}
      </aside>
    </div>
  )
}
