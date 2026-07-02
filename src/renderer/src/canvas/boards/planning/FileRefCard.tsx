/**
 * File-reference chip (file-tree S4) — the real, interactive render of a `fileref` Planning element
 * (S1 shipped a static placeholder; this replaces it). A chip is dropped onto a Planning board by
 * dragging a file out of the docked tree (`usePlanningFileRefIO`); it shows the extension glyph +
 * the basename (bold) + the project-relative path (muted), and:
 *
 *   - CLICK (a press that releases within CLICK_TOL with no drag) → SELECTS the chip, which reveals
 *     the resize handle. A single click no longer opens the file, so the handle stays reachable.
 *   - DOUBLE-CLICK (two such clicks within DBLCLICK_MS) → opens the file as a File board via `onOpen`
 *     (the S1 `openFileBoard` contract). Re-uses an already-open board for that path.
 *   - DRAG → moves the chip like any other whiteboard element (the well captures the pointer for
 *     the move, exactly like NoteCard/ImageCard; this card is just the drag handle in select mode).
 *   - RESIZE → a bottom-right corner handle (shown when selected + unlocked) grows/shrinks the chip
 *     box so a long name/path stops truncating. Mirrors the DiagramCard handle exactly: screen-px
 *     threshold, ONE undo step per drag (via onEditStart), board-local→screen scale captured at
 *     pointerdown so the memo'd card never subscribes to the camera.
 *
 * Click/drag/double-click are all decided on window-level pointer-ups (the well owns pointer capture
 * during a move, so the card never receives its own pointerup/click/dblclick): a pointer-up within
 * CLICK_TOL screen px is a click (select); two such clicks within DBLCLICK_MS open; a real drag moved
 * further → neither. Mirrors the 4px threshold the planning pointer layer uses elsewhere. Deletion is
 * menu/eraser only — no inline ×.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import type { FileRefElement } from '../../../lib/boardSchema'
import { fileGlyphPath } from '../../fileTreeData'
import { resizeFromDrag } from './diagramResize'
import { FILEREF_MIN } from './elements'

/** Screen-px movement under which a press counts as a click (select), not a drag (move/resize). */
const CLICK_TOL = 4
/** Max ms between two clicks to count as a double-click (open the file). */
const DBLCLICK_MS = 400

export interface FileRefCardProps {
  element: FileRefElement
  /** True when the `select` tool is active (enables drag + selection + click-to-open + resize). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card. */
  onDragStart: (e: ReactPointerEvent, id: string) => void
  /** True when this element is in the board selection set (draws the accent ring + resize handle). */
  selected?: boolean
  /** Select this element on press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
  /** Open the referenced file as a File board (a plain click — no drag, no Shift). */
  onOpen: (path: string) => void
  /** Arm one undo checkpoint at the start of a resize drag (beginChange). */
  onEditStart: () => void
  /** Tracked resize commit (sets w/h on the element). */
  onResize: (id: string, w: number, h: number) => void
}

// Memoized: a moved/edited chip yields a new element object; everything else keeps its ref, so
// unrelated edits in the well don't re-render this card (matches NoteCard/ImageCard).
export const FileRefCard = memo(function FileRefCard({
  element,
  interactive,
  onDragStart,
  selected,
  onSelect,
  onOpen,
  onEditStart,
  onResize
}: FileRefCardProps): ReactElement {
  const { id, path, label, w, h } = element
  const locked = element.locked ?? false
  // Timestamp of the last qualifying single click — a second one within DBLCLICK_MS opens the file.
  const lastClickRef = useRef(0)
  // AbortController for the in-flight window pointerup/pointercancel listeners. Stored in a ref so
  // the unmount-cleanup useEffect below can abort it if the element is deleted (keyboard, eraser,
  // undo, concurrent mutation) while the pointer is still down (BUG-031, mirrors NoteCard/FreeText's
  // BUG-037 fix).
  const clickAbort = useRef<AbortController | null>(null)

  const onPointerDown = useCallback(
    (e: ReactPointerEvent): void => {
      // Draw modes fall through to the well (a stroke can start over the chip); select mode treats
      // the body as the drag handle. Only the primary button initiates a drag / select / open.
      if (!interactive || e.button !== 0) return
      e.stopPropagation()
      onSelect?.(id, e.shiftKey)
      // Arm the click resolver BEFORE the move-drag setup: the well captures the pointer for the
      // move, so this card never gets its own pointerup/dblclick — we decide on a window pointer-up
      // instead. A pointer-up ≤ CLICK_TOL travel is a click (selects, above); TWO such clicks within
      // DBLCLICK_MS open the file. A real drag moved further ⇒ neither. Arming first keeps the intent
      // independent of the drag setup succeeding. Shift-press is additive-select only — never opens.
      if (!e.shiftKey) {
        const sx = e.clientX
        const sy = e.clientY
        const ac = new AbortController()
        clickAbort.current = ac
        const { signal } = ac
        const onEnd = (ev: PointerEvent): void => {
          ac.abort()
          clickAbort.current = null
          if (ev.type !== 'pointerup' || Math.hypot(ev.clientX - sx, ev.clientY - sy) > CLICK_TOL) {
            return // a drag (move) or cancel — neither a click nor part of a double-click
          }
          if (ev.timeStamp - lastClickRef.current <= DBLCLICK_MS) {
            lastClickRef.current = 0
            onOpen(path)
          } else {
            lastClickRef.current = ev.timeStamp
          }
        }
        window.addEventListener('pointerup', onEnd, { signal })
        window.addEventListener('pointercancel', onEnd, { signal })
      }
      onDragStart(e, id)
    },
    [interactive, onSelect, onDragStart, onOpen, id, path]
  )

  // Cleanup: if the component unmounts while the click/dblclick resolver is armed (e.g. the element
  // was deleted via keyboard/eraser/undo while the pointer was still held), abort the
  // AbortController so the stale window pointerup/pointercancel listeners don't survive to fire on a
  // later, unrelated pointer release (BUG-031).
  useEffect(() => {
    return () => {
      clickAbort.current?.abort()
      clickAbort.current = null
    }
  }, [])

  // Live corner-resize gesture: start pointer (screen px) + start size + the board-local→screen
  // scale captured at pointerdown. `moved` arms the undo checkpoint lazily so a no-move tap on the
  // handle never pushes a phantom step (the planning lazy-checkpoint discipline). Mirrors DiagramCard.
  const resizeRef = useRef<{
    startX: number
    startY: number
    startW: number
    startH: number
    scale: number
    moved: boolean
  } | null>(null)

  const onResizeDown = useCallback(
    (e: ReactPointerEvent): void => {
      if (e.button !== 0) return
      e.stopPropagation() // never start a board drag / select / open from the handle
      const handle = e.currentTarget as HTMLElement
      // boardScale = the well's on-screen width ÷ its layout width — folds camera zoom + any board
      // render scale into one ratio. DOM-only, so the memo'd card never subscribes to the camera.
      const well = handle.closest('.pl-well') as HTMLElement | null
      const rect = well?.getBoundingClientRect()
      const scale = well && rect && well.offsetWidth > 0 ? rect.width / well.offsetWidth : 1
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startW: w,
        startH: h,
        scale,
        moved: false
      }
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic event in tests */
      }
    },
    [w, h]
  )

  const onResizeMove = useCallback(
    (e: ReactPointerEvent): void => {
      const r = resizeRef.current
      if (!r) return
      const dx = e.clientX - r.startX
      const dy = e.clientY - r.startY
      // Arm ONE checkpoint on the first real move (> CLICK_TOL SCREEN px — zoom-independent); a
      // sub-threshold jiggle commits nothing.
      if (!r.moved) {
        if (Math.hypot(dx, dy) <= CLICK_TOL) return
        onEditStart()
        r.moved = true
      }
      const size = resizeFromDrag({ w: r.startW, h: r.startH }, { dx, dy }, r.scale, FILEREF_MIN)
      onResize(id, size.w, size.h)
    },
    [id, onResize, onEditStart]
  )

  const onResizeUp = useCallback((e: ReactPointerEvent): void => {
    if (!resizeRef.current) return
    resizeRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* capture already released / synthetic */
    }
  }, [])

  return (
    <div
      className="pl-fileref"
      data-test="fileref-chip"
      title={path}
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: w,
        height: h,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 10px',
        borderRadius: 'var(--r-inner)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        // v17 (P4b) element opacity — absent ⇒ opaque, byte-identical to pre-P4b.
        opacity: element.opacity,
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

      {/* Bottom-right corner resize handle (select mode, selected + unlocked). Same discipline as
          the DiagramCard handle: screen-px threshold, ONE undo step per drag, accent corner mark. */}
      {selected && interactive && !locked && (
        <div
          className="pl-fileref-resize"
          data-test="fileref-resize"
          title="Resize"
          onPointerDown={onResizeDown}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: 16,
            height: 16,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'flex-end',
            cursor: 'nwse-resize',
            zIndex: 2
          }}
        >
          <div
            style={{
              width: 9,
              height: 9,
              margin: 2,
              borderRight: '2px solid var(--accent)',
              borderBottom: '2px solid var(--accent)',
              borderBottomRightRadius: 2,
              pointerEvents: 'none'
            }}
          />
        </div>
      )}
    </div>
  )
})
