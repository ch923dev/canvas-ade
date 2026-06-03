/**
 * Sticky-note element (DESIGN.md §7.3). A low-chroma tinted card with a slight
 * rotation + soft shadow, holding editable body text. Positioned absolutely in
 * board-local coordinates by the parent whiteboard. Editing is inline via a
 * transparent <textarea>; a drag handle (the whole card, in select mode) moves it.
 *
 * The card stops pointer propagation so interacting with it never starts a React
 * Flow node-drag or clears the canvas selection mid-edit.
 */
import { useEffect, useRef, type ReactElement } from 'react'
import type { NoteElement } from '../../../lib/boardSchema'
import { NOTE_TINTS } from './tints'

export interface NoteCardProps {
  note: NoteElement
  /** True when the whiteboard `select` tool is active (enables drag + edit). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card body. */
  onDragStart: (e: React.PointerEvent, id: string) => void
  onChangeText: (id: string, text: string) => void
  onDelete: (id: string) => void
  /** Called when the textarea gains focus — used to checkpoint undo. */
  onEditStart?: () => void
  /** True when this element is in the board selection set (draws the accent ring). */
  selected?: boolean
  /** Select this element on grip press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
}

export function NoteCard({
  note,
  interactive,
  onDragStart,
  onChangeText,
  onDelete,
  onEditStart,
  selected,
  onSelect
}: NoteCardProps): ReactElement {
  const tint = NOTE_TINTS[note.tint]
  const ref = useRef<HTMLTextAreaElement>(null)
  // Set while a grip-drag is initiating so the textarea's blur (focus leaves when
  // the grip is pressed) does NOT prune an empty note mid-drag (#29 guard).
  const dragging = useRef(false)

  // Auto-size the textarea to its content so the note grows with the text.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [note.text, note.w])

  // Focus a freshly-dropped empty note so the user can type immediately, AND so
  // leaving it untouched blurs → prunes it instead of leaving an orphan (#29).
  // Runs once on mount; existing (loaded) notes have content so won't grab focus.
  useEffect(() => {
    if (interactive && note.text === '') ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="pl-note"
      style={{
        position: 'absolute',
        left: note.x,
        top: note.y,
        width: note.w,
        transform: `rotate(${note.rotation ?? 0}deg)`,
        background: tint.fill,
        border: `1px solid ${tint.edge}`,
        borderRadius: 'var(--r-inner)',
        boxShadow: 'var(--shadow-pop)',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        cursor: interactive ? 'grab' : 'default'
      }}
      onPointerDown={(e) => {
        // Only swallow the press in select mode (interactive editing/drag). In a
        // draw mode (pen/arrow/place) let it fall through to the well so a stroke
        // can START on top of the card (#6).
        if (!interactive) return
        e.stopPropagation()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        ref.current?.focus()
      }}
    >
      {/* Deletion is intentionally NOT an inline button — elements are removed only via
          the right-click menu (Delete) or the eraser tool (W3 decision). `onDelete` is
          still wired for the empty-note auto-prune below, not a user delete affordance. */}
      {/* The padding ring is the drag handle: pressing anywhere on the grip (but
          not in the textarea, which stops propagation) starts the move (#13). */}
      <div
        className="pl-note-grip"
        onPointerDown={(e) => {
          // In a draw mode let the press fall through to the well (#6); in select
          // mode this band is the drag handle (the textarea owns its own press).
          if (!interactive) return
          e.stopPropagation()
          onSelect?.(note.id, e.shiftKey)
          // Suppress the empty-note blur-prune this gesture is about to trigger.
          dragging.current = true
          onDragStart(e, note.id)
          // The well captures the pointer, so the grip never sees move/up. Track the
          // gesture on the document to tell a real drag from a zero-movement press:
          // on a press with NO movement the empty-note blur-prune was skipped (the
          // `dragging` guard) AND the note never re-focuses, so it would orphan
          // permanently — re-check and prune it on pointer-up (#BUG-029/BUG-026).
          const startX = e.clientX
          const startY = e.clientY
          let moved = false
          const onMove = (ev: PointerEvent): void => {
            if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true
          }
          const onUp = (): void => {
            document.removeEventListener('pointermove', onMove)
            document.removeEventListener('pointerup', onUp)
            document.removeEventListener('pointercancel', onUp)
            dragging.current = false
            // Read the live DOM value (controlled → current store text) so a note
            // that gained content during the gesture is never pruned.
            const text = ref.current?.value ?? note.text
            if (!moved && text.trim() === '' && document.activeElement !== ref.current) {
              onDelete(note.id)
            }
          }
          document.addEventListener('pointermove', onMove)
          document.addEventListener('pointerup', onUp)
          document.addEventListener('pointercancel', onUp)
        }}
        style={{ position: 'relative', padding: '9px 11px' }}
      >
        <textarea
          ref={ref}
          value={note.text}
          readOnly={!interactive}
          placeholder="Note…"
          spellCheck={false}
          onChange={(e) => onChangeText(note.id, e.target.value)}
          onFocus={() => onEditStart?.()}
          // Prune an empty / whitespace-only note on blur so a note that was
          // focused but never given content doesn't linger as an orphan (#29).
          // Skip while a drag is starting (grip press blurs the textarea).
          onBlur={() => {
            if (!dragging.current && note.text.trim() === '') onDelete(note.id)
          }}
          // Let a draw gesture begin over the note body (#6); only block in select.
          onPointerDown={(e) => {
            if (interactive) e.stopPropagation()
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            // NOTE-1: readOnly blocks typing but not keyDown, so guard delete on the
            // `select` tool only — a Backspace while a draw tool is active (textarea
            // still focused) must not silently prune the note.
            if (!interactive) return
            if (e.key === 'Backspace' && note.text.length === 0) onDelete(note.id)
          }}
          style={{
            width: '100%',
            resize: 'none',
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontFamily: 'var(--ui)',
            fontSize: 12,
            lineHeight: '16px',
            padding: 0,
            overflow: 'hidden',
            cursor: interactive ? 'text' : 'default'
          }}
        />
      </div>
    </div>
  )
}
