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
import type { NoteElement, NoteTint } from '../../../lib/boardSchema'
import { NOTE_TINTS, TINT_CYCLE } from './tints'

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
  /**
   * Report the rendered board-local size so erase/marquee/snap use the actual
   * auto-sized dimensions instead of the stale schema h:96 (BUG-050).
   */
  onMeasure?: (id: string, w: number, h: number) => void
  /** Set this note's tint from the hover swatch pill (D3-A); one undo step upstream. */
  onSetTint?: (id: string, tint: NoteTint) => void
}

export function NoteCard({
  note,
  interactive,
  onDragStart,
  onChangeText,
  onDelete,
  onEditStart,
  selected,
  onSelect,
  onMeasure,
  onSetTint
}: NoteCardProps): ReactElement {
  const tint = NOTE_TINTS[note.tint]
  const ref = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // Set while a grip-drag is initiating so the textarea's blur (focus leaves when
  // the grip is pressed) does NOT prune an empty note mid-drag (#29 guard).
  const dragging = useRef(false)
  // AbortController for the in-flight document pointer listeners. Stored in a ref
  // so the useEffect cleanup can abort it (= removeEventListener all three) if the
  // component unmounts while a grip drag is in progress (BUG-037).
  const dragAbort = useRef<AbortController | null>(null)

  // Auto-size the textarea to its content so the note grows with the text.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [note.text, note.w])

  // Report the card's rendered board-local size so erase/marquee/snap use the
  // actual auto-sized height instead of the stale schema h:96 (BUG-050). A
  // ResizeObserver mirrors the checklist pattern so content-driven size changes
  // (text edits, font-size changes) are always reflected.
  useEffect(() => {
    const card = cardRef.current
    if (!card || !onMeasure) return
    const report = (): void => {
      onMeasure(note.id, card.offsetWidth, card.offsetHeight)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(card)
    return () => ro.disconnect()
  }, [note.id, onMeasure])

  // Focus a freshly-dropped empty note so the user can type immediately, AND so
  // leaving it untouched blurs → prunes it instead of leaving an orphan (#29).
  // Runs once on mount; existing (loaded) notes have content so won't grab focus.
  useEffect(() => {
    if (interactive && note.text === '') ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cleanup: if the component unmounts while a grip drag is in flight (e.g. the
  // element was deleted via keyboard while the pointer was held), abort the
  // AbortController which removes the three document pointer listeners (BUG-037).
  useEffect(() => {
    return () => {
      dragAbort.current?.abort()
      dragAbort.current = null
    }
  }, [])

  return (
    <div
      ref={cardRef}
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
      {/* Hover tint swatches (D3-A): a small overlay pill in the top-right corner,
          select tool + unlocked note only. Revealed on card hover by index.css
          (.pl-tint-pill — 120ms fade, reduced-motion gated). Pointer presses stop
          here so picking a tint never starts a grip drag or clears the selection. */}
      {interactive && note.locked !== true && onSetTint && (
        <div
          className="pl-tint-pill"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {TINT_CYCLE.map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`pl-tint-${t}`}
              data-current={note.tint === t ? '' : undefined}
              className="pl-tint-dot"
              title={`${t[0].toUpperCase()}${t.slice(1)} tint`}
              aria-label={`${t[0].toUpperCase()}${t.slice(1)} tint`}
              style={{ background: NOTE_TINTS[t].fill, border: `1px solid ${NOTE_TINTS[t].edge}` }}
              onClick={(e) => {
                e.stopPropagation()
                onSetTint(note.id, t)
              }}
            />
          ))}
        </div>
      )}
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
          // Only the primary button initiates a drag; right/middle buttons fall
          // through to the browser context-menu / OS default (primary-button guard).
          if (e.button !== 0) return
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
          // AbortController ties all three doc listeners to a single abort signal so
          // they are cleaned up atomically — either via onUp (normal end) or via the
          // useEffect cleanup (unmount-during-drag, BUG-037).
          const ac = new AbortController()
          dragAbort.current = ac
          const { signal } = ac
          const onMove = (ev: PointerEvent): void => {
            if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true
          }
          const onUp = (): void => {
            ac.abort()
            dragAbort.current = null
            dragging.current = false
            // Read the live DOM value (controlled → current store text) so a note
            // that gained content during the gesture is never pruned.
            const text = ref.current?.value ?? note.text
            if (!moved && text.trim() === '' && document.activeElement !== ref.current) {
              onDelete(note.id)
            }
          }
          document.addEventListener('pointermove', onMove, { signal })
          document.addEventListener('pointerup', onUp, { signal })
          document.addEventListener('pointercancel', onUp, { signal })
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
