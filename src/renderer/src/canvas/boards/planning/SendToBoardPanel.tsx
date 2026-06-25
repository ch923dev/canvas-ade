/**
 * "Send to board…" picker (cross-board element transfer, Phase 2 — spec §3.A). A small
 * popover, modeled on BrowserPickPanel + the `.ca-port-picker` family: a Copy / Move toggle
 * (default Move, per the approved mock) over the list of OTHER planning boards plus a
 * "+ New planning board" sentinel row. Picking a destination calls `onPick({ target, mode })`
 * — the host (PlanningBoard / useSendToBoard) routes the transfer through `transferElements`
 * and closes. PURELY the chooser: it owns only the transient Copy/Move state (resets by
 * unmounting) + its own portal/clamp/dismiss; it never touches the store.
 *
 * Self-contained popover (unlike BrowserPickPanel, which its terminal host positions inline):
 * the panel is anchored at the right-click point in SCREEN space, so it portals to <body>,
 * measure-then-clamps into the viewport (the <Menu> shell's discipline), and dismisses on
 * Esc / outside-pointerdown via usePickerDismiss — stopping its OWN pointer/mouse-down so an
 * inside click never reaches the dismiss listener (the picker `nodrag` contract).
 */
import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePickerDismiss } from '../terminal/usePickerDismiss'
import { clampMenuToViewport, type MenuPlacement } from '../../menuPlacement'
import type { TransferMode } from './elements'

/** Sentinel `target` → spawn a fresh planning board and transfer into it (spec §10 Q2). */
export const NEW_PLANNING_BOARD = ' new'

export interface SendTarget {
  id: string
  title: string
}

interface Props {
  /** Screen anchor (the right-click / menu position) the panel opens at. */
  anchor: { x: number; y: number }
  /** Group-expanded selection count for the title (spec §3.A). */
  count: number
  /** The OTHER planning boards (selectOtherPlanningBoards) — the destination list. */
  targets: SendTarget[]
  /** Pick a destination → the host routes the transfer + closes. */
  onPick: (choice: { target: string; mode: TransferMode }) => void
  /** Esc / outside-pointerdown dismissal. */
  onClose: () => void
}

/** List-board glyph (verbatim from the approved mock — a rounded card with three rows). */
function BoardIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1.5" y="1.5" width="11" height="11" rx="2" stroke="currentColor" />
      <path d="M4 5h6M4 7.5h6M4 10h3.5" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/** Plus glyph for the "+ New planning board" create row (verbatim from the mock). */
function PlusIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

const MODES: TransferMode[] = ['copy', 'move']

export function SendToBoardPanel({ anchor, count, targets, onPick, onClose }: Props): ReactElement {
  // Default Move (the mock's checked radio); transient — resets by unmounting.
  const [mode, setMode] = useState<TransferMode>('move')
  const ref = useRef<HTMLDivElement>(null)
  // Start off-screen; the layout effect measures the real panel and clamps it into the
  // viewport before paint (no flash at a stale corner — the <Menu> shell's discipline).
  const [pos, setPos] = useState<MenuPlacement>({ top: -9999, left: -9999, maxHeight: 0 })

  usePickerDismiss(true, onClose)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.maxHeight = ''
    const m = el.getBoundingClientRect()
    const next = clampMenuToViewport(
      { point: anchor, align: 'left', gap: 0 },
      { width: m.width, height: m.height },
      window.innerWidth,
      window.innerHeight
    )
    // Anchor literals are fresh each render — bail on no-ops so the effect can depend on
    // them without a setState→render loop (mirrors <Menu>).
    setPos((p) =>
      p.top === next.top && p.left === next.left && p.maxHeight === next.maxHeight ? p : next
    )
  }, [anchor, targets.length])

  return createPortal(
    <div
      ref={ref}
      className="pl-sendto nodrag"
      role="dialog"
      aria-label="Send to board"
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        maxHeight: pos.maxHeight || undefined,
        overflowY: 'auto',
        zIndex: 9999
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pl-sendto-title">
        Send {count} item{count === 1 ? '' : 's'} to…
      </div>

      <div className="pl-sendto-mode" role="radiogroup" aria-label="Transfer mode">
        {MODES.map((m) => (
          <label key={m} className={`pl-sendto-radio${mode === m ? ' pl-sendto-radio-on' : ''}`}>
            <input
              type="radio"
              name="pl-sendto-mode"
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            <span>{m === 'copy' ? 'Copy' : 'Move'}</span>
          </label>
        ))}
      </div>

      <div className="pl-sendto-divider" />

      {targets.map((t) => (
        <button
          key={t.id}
          type="button"
          className="pl-sendto-board"
          title={t.title}
          onClick={() => onPick({ target: t.id, mode })}
        >
          <span className="pl-sendto-ico" aria-hidden="true">
            <BoardIcon />
          </span>
          <span className="pl-sendto-label">{t.title}</span>
        </button>
      ))}

      <button
        type="button"
        className="pl-sendto-board pl-sendto-new"
        onClick={() => onPick({ target: NEW_PLANNING_BOARD, mode })}
      >
        <span className="pl-sendto-ico" aria-hidden="true">
          <PlusIcon />
        </span>
        <span className="pl-sendto-label">New planning board</span>
      </button>
    </div>,
    document.body
  )
}
