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
}

export function NoteCard({
  note,
  interactive,
  onDragStart,
  onChangeText,
  onDelete
}: NoteCardProps): ReactElement {
  const tint = NOTE_TINTS[note.tint]
  const ref = useRef<HTMLTextAreaElement>(null)

  // Auto-size the textarea to its content so the note grows with the text.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [note.text, note.w])

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
        boxShadow: '0 6px 18px -8px rgba(0, 0, 0, 0.6)',
        cursor: interactive ? 'grab' : 'default'
      }}
      onPointerDown={(e) => {
        e.stopPropagation()
        // Drag from the card chrome, not from inside the textarea (let it focus).
        if (interactive && e.target === e.currentTarget) onDragStart(e, note.id)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        ref.current?.focus()
      }}
    >
      <div className="pl-note-grip" style={{ position: 'relative', padding: '9px 11px' }}>
        <textarea
          ref={ref}
          value={note.text}
          readOnly={!interactive}
          placeholder="Note…"
          spellCheck={false}
          onChange={(e) => onChangeText(note.id, e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Backspace' && note.text.length === 0) onDelete(note.id)
          }}
          style={{
            width: '100%',
            resize: 'none',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontFamily: 'var(--ui)',
            fontSize: 12,
            lineHeight: '17px',
            padding: 0,
            overflow: 'hidden',
            cursor: interactive ? 'text' : 'default'
          }}
        />
      </div>
    </div>
  )
}
