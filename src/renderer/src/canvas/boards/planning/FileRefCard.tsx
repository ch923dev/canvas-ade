/**
 * File-reference chip (file-tree S4) — the real, interactive render of a `fileref` Planning element
 * (S1 shipped a static placeholder; this replaces it). A chip is dropped onto a Planning board by
 * dragging a file out of the docked tree (`usePlanningFileRefIO`); it shows the extension glyph +
 * the basename (bold) + the project-relative path (muted), and:
 *
 *   - CLICK (a press that releases within CLICK_TOL with no drag) → opens the file as a File board
 *     via `onOpen` (the S1 `openFileBoard` contract). Re-uses an already-open board for that path.
 *   - DRAG → moves the chip like any other whiteboard element (the well captures the pointer for
 *     the move, exactly like NoteCard/ImageCard; this card is just the drag handle in select mode).
 *
 * The click-vs-drag split is decided on a window-level pointer-up (the well owns pointer capture
 * during a move, so the card never receives its own pointerup): if the pointer travelled ≤ CLICK_TOL
 * screen px it was a click → open; a real drag moved further → no open. Mirrors the 4px threshold the
 * planning pointer layer uses everywhere else. Deletion is menu/eraser only — no inline ×.
 */
import { memo, useCallback, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react'
import type { FileRefElement } from '../../../lib/boardSchema'
import { fileGlyphPath } from '../../fileTreeData'

/** Screen-px movement under which a press counts as a click (open), not a drag (move). */
const CLICK_TOL = 4

export interface FileRefCardProps {
  element: FileRefElement
  /** True when the `select` tool is active (enables drag + selection + click-to-open). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card. */
  onDragStart: (e: ReactPointerEvent, id: string) => void
  /** True when this element is in the board selection set (draws the accent ring). */
  selected?: boolean
  /** Select this element on press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
  /** Open the referenced file as a File board (a plain click — no drag, no Shift). */
  onOpen: (path: string) => void
}

// Memoized: a moved/edited chip yields a new element object; everything else keeps its ref, so
// unrelated edits in the well don't re-render this card (matches NoteCard/ImageCard).
export const FileRefCard = memo(function FileRefCard({
  element,
  interactive,
  onDragStart,
  selected,
  onSelect,
  onOpen
}: FileRefCardProps): ReactElement {
  const { id, path, label } = element

  const onPointerDown = useCallback(
    (e: ReactPointerEvent): void => {
      // Draw modes fall through to the well (a stroke can start over the chip); select mode treats
      // the body as the drag handle. Only the primary button initiates a drag / open.
      if (!interactive || e.button !== 0) return
      e.stopPropagation()
      onSelect?.(id, e.shiftKey)
      // Arm the click-vs-drag resolver BEFORE the move-drag setup: the well captures the pointer for
      // the move, so this card never gets its own pointerup — we decide on a window pointer-up
      // instead. ≤ CLICK_TOL travel ⇒ a click ⇒ open; a real drag moved further ⇒ no open. Arming
      // first also keeps open-intent independent of the drag setup succeeding. Shift-press is
      // additive-select only — never opens.
      if (!e.shiftKey) {
        const sx = e.clientX
        const sy = e.clientY
        const onEnd = (ev: PointerEvent): void => {
          window.removeEventListener('pointerup', onEnd)
          window.removeEventListener('pointercancel', onEnd)
          if (
            ev.type === 'pointerup' &&
            Math.hypot(ev.clientX - sx, ev.clientY - sy) <= CLICK_TOL
          ) {
            onOpen(path)
          }
        }
        window.addEventListener('pointerup', onEnd)
        window.addEventListener('pointercancel', onEnd)
      }
      onDragStart(e, id)
    },
    [interactive, onSelect, onDragStart, onOpen, id, path]
  )

  return (
    <div
      className="pl-fileref"
      data-test="fileref-chip"
      title={path}
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: element.w,
        height: element.h,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 10px',
        borderRadius: 'var(--r-inner)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        cursor: interactive ? 'pointer' : 'default',
        overflow: 'hidden'
      }}
      onPointerDown={onPointerDown}
    >
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: '0 0 auto', color: 'var(--text-3)', pointerEvents: 'none' }}
      >
        <path d={fileGlyphPath(label)} />
      </svg>
      <span style={{ minWidth: 0, pointerEvents: 'none' }}>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--ui)',
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {label}
        </span>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--text-3)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {path}
        </span>
      </span>
    </div>
  )
})
