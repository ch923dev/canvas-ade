/**
 * Free-text element (DESIGN.md §7.3) — plain editable text laid directly on the
 * whiteboard (no card chrome), positioned in board-local coordinates. Like the
 * note it stops pointer propagation so editing never disturbs the canvas, and the
 * `select` tool enables drag (from the gutter) + inline edit.
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import type { TextElement } from '../../../lib/boardSchema'
import { Icon } from '../../Icon'

export interface FreeTextProps {
  element: TextElement
  interactive: boolean
  onDragStart: (e: React.PointerEvent, id: string) => void
  onChangeText: (id: string, text: string) => void
  onDelete: (id: string) => void
  /** Called when the textarea gains focus — used to checkpoint undo. */
  onEditStart?: () => void
  /** True when this element is in the board selection set (draws the accent ring). */
  selected?: boolean
  /** True when the element is locked (W3): shows a lock glyph + muted selection ring. */
  locked?: boolean
  /** Select this element on grip press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
  /** Report the rendered board-local size for selection/snap bbox (W2). */
  onMeasure?: (id: string, w: number, h: number) => void
  /** Right-click on the text → open the W3 element context menu (W3). */
  onContextMenu?: (e: React.MouseEvent) => void
}

const delBtn: CSSProperties = {
  position: 'absolute',
  top: 2,
  right: 2,
  width: 18,
  height: 18,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--border)',
  background: 'var(--surface-raised)',
  color: 'var(--text-3)',
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity .1s'
}

export function FreeText({
  element,
  interactive,
  onDragStart,
  onChangeText,
  onDelete,
  onEditStart,
  selected,
  locked,
  onSelect,
  onMeasure,
  onContextMenu
}: FreeTextProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Set while a grip-drag is initiating so the textarea's blur (focus leaves when
  // the grip is pressed) does NOT prune an empty text element mid-drag (#36 guard).
  const dragging = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    el.style.width = 'auto'
    el.style.width = `${Math.max(40, el.scrollWidth)}px`
    if (onMeasure) {
      const host = el.parentElement // the .pl-text flex row
      if (host) onMeasure(element.id, host.offsetWidth, host.offsetHeight)
    }
  }, [element.text, onMeasure, element.id])

  // Focus a freshly-dropped empty text element so the user can type immediately,
  // AND so leaving it untouched blurs → prunes it instead of leaving an orphan
  // (#36). Runs once on mount; existing (loaded) texts have content so won't grab.
  useEffect(() => {
    if (interactive && element.text === '') ref.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="pl-text"
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        display: 'flex',
        outline: selected
          ? `1.5px solid ${locked ? 'var(--border-strong)' : 'var(--accent)'}`
          : 'none',
        outlineOffset: 2
      }}
      // Only swallow the press in select mode; let a draw gesture (pen/arrow/place)
      // fall through to the well so it can START over the text (#6).
      onPointerDown={(e) => {
        if (interactive) e.stopPropagation()
      }}
      // A dblclick on the text must not bubble to the canvas focus handler (#40).
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={onContextMenu}
    >
      {interactive && !locked && (
        <button
          type="button"
          className="pl-del"
          title="Delete"
          aria-label="delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(element.id)
          }}
          style={delBtn}
        >
          <Icon name="x" size={11} />
        </button>
      )}
      {/* Slim drag gutter on the left edge so the text stays selectable. */}
      <span
        className="pl-text-grip"
        title="Drag"
        onPointerDown={(e) => {
          // In a draw mode let the press fall through to the well so a stroke/arrow
          // can START over the grip (#6); only swallow + drag in select mode.
          if (!interactive) return
          e.stopPropagation()
          onSelect?.(element.id, e.shiftKey)
          // Suppress the empty-text blur-prune this gesture is about to trigger.
          dragging.current = true
          onDragStart(e, element.id)
          // The well captures the pointer, so the grip never sees move/up. Track the
          // gesture on the document to tell a real drag from a zero-movement press:
          // on a press with NO movement the empty-text blur-prune was skipped (the
          // `dragging` guard) AND the text never re-focuses, so it would orphan
          // permanently — re-check and prune it on pointer-up (#BUG-026).
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
            // Read the live DOM value (controlled → current store text) so a text
            // element that gained content during the gesture is never pruned.
            const text = ref.current?.value ?? element.text
            if (!moved && text.trim() === '' && document.activeElement !== ref.current) {
              onDelete(element.id)
            }
          }
          document.addEventListener('pointermove', onMove)
          document.addEventListener('pointerup', onUp)
          document.addEventListener('pointercancel', onUp)
        }}
        style={{
          width: 6,
          alignSelf: 'stretch',
          cursor: interactive ? 'grab' : 'default',
          marginRight: 2,
          borderRadius: 2
        }}
      />
      <textarea
        ref={ref}
        value={element.text}
        readOnly={!interactive}
        placeholder="Text…"
        spellCheck={false}
        rows={1}
        onChange={(e) => onChangeText(element.id, e.target.value)}
        onFocus={() => onEditStart?.()}
        // Prune an empty / whitespace-only text element on blur so a double-click
        // that never receives content doesn't leave an orphan (#29, #36). Skip
        // while a drag is starting (grip press blurs the textarea).
        onBlur={() => {
          if (!dragging.current && element.text.trim() === '') onDelete(element.id)
        }}
        // Let a draw gesture begin over the text (#6); only block in select.
        onPointerDown={(e) => {
          if (interactive) e.stopPropagation()
        }}
        onKeyDown={(e) => {
          e.stopPropagation()
          // TEXT-1: readOnly blocks typing but not keyDown — guard delete on the
          // `select` tool only so a Backspace while a draw tool is active can't prune
          // the element out from under the user (mirrors NoteCard).
          if (!interactive) return
          if (e.key === 'Backspace' && element.text.length === 0) onDelete(element.id)
        }}
        style={{
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--text)',
          fontFamily: 'var(--ui)',
          fontSize: 13,
          lineHeight: '18px',
          padding: 0,
          overflow: 'hidden',
          whiteSpace: 'pre',
          cursor: interactive ? 'text' : 'default'
        }}
      />
      {locked && (
        <span
          title="Locked"
          style={{
            position: 'absolute',
            top: -4,
            right: -14,
            color: 'var(--text-3)',
            pointerEvents: 'none',
            display: 'grid',
            placeItems: 'center'
          }}
        >
          <Icon name="lock" size={11} />
        </span>
      )}
    </div>
  )
}
