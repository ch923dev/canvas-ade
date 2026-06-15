/**
 * Free-text element (DESIGN.md §7.3) — plain editable text laid directly on the
 * whiteboard (no card chrome), positioned in board-local coordinates. Like the
 * note it stops pointer propagation so editing never disturbs the canvas, and the
 * `select` tool enables drag (from the gutter) + inline edit.
 */
import { memo, useEffect, useRef, type ReactElement } from 'react'
import type { TextElement } from '../../../lib/boardSchema'
import {
  FAMILY_CSS,
  SIZE_PX,
  lineHeightFor,
  COLOR_CSS,
  WEIGHT,
  TEXT_DEFAULTS,
  MIN_TEXT_WIDTH_PX
} from './textStyle'

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
  /** Select this element on grip press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
  /** Report the rendered board-local size for selection/snap bbox (W2). */
  onMeasure?: (id: string, w: number, h: number) => void
  /** Fired with (id, editing) when the textarea gains/loses focus — drives the toolbar-on-edit gate. */
  onEditingChange?: (id: string, editing: boolean) => void
}

// Memoized: stable callbacks from PlanningBoard + an element object that only changes
// for THIS text element ⇒ editing one element re-renders only its own component.
export const FreeText = memo(function FreeText({
  element,
  interactive,
  onDragStart,
  onChangeText,
  onDelete,
  onEditStart,
  selected,
  onSelect,
  onMeasure,
  onEditingChange
}: FreeTextProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Set while a grip-drag is initiating so the textarea's blur (focus leaves when
  // the grip is pressed) does NOT prune an empty text element mid-drag (#36 guard).
  const dragging = useRef(false)
  // AbortController for the in-flight document pointer listeners. Stored in a ref
  // so the useEffect cleanup can abort it (= removeEventListener all three) if the
  // component unmounts while a grip drag is in progress (BUG-037).
  const dragAbort = useRef<AbortController | null>(null)

  const wrap = element.width !== undefined

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (!wrap) {
      el.style.width = 'auto'
      el.style.width = `${Math.max(MIN_TEXT_WIDTH_PX, el.scrollWidth)}px`
    }
    if (onMeasure) {
      const host = el.parentElement // the .pl-text flex row
      if (host) onMeasure(element.id, host.offsetWidth, host.offsetHeight)
    }
    // Re-measure when a size-affecting typography token changes (not just text): a
    // toolbar fontSize/family/bold change resizes the textarea, so the selection/snap
    // bbox must be recomputed too. align/color don't affect the measured box.
  }, [
    element.text,
    element.fontSize,
    element.fontFamily,
    element.bold,
    onMeasure,
    element.id,
    element.width,
    wrap
  ])

  // Focus a freshly-dropped empty text element so the user can type immediately,
  // AND so leaving it untouched blurs → prunes it instead of leaving an orphan
  // (#36). Runs once on mount; existing (loaded) texts have content so won't grab.
  useEffect(() => {
    if (interactive && element.text === '') ref.current?.focus()
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

  const fam = element.fontFamily ?? TEXT_DEFAULTS.fontFamily
  const px = SIZE_PX[element.fontSize ?? TEXT_DEFAULTS.fontSize]
  const align = element.align ?? TEXT_DEFAULTS.align
  const colorTok = element.color ?? TEXT_DEFAULTS.color
  const weight = element.bold ? WEIGHT.bold : WEIGHT.normal

  return (
    <div
      className="pl-text"
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        display: 'flex',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2
      }}
      // Only swallow the press in select mode; let a draw gesture (pen/arrow/place)
      // fall through to the well so it can START over the text (#6).
      onPointerDown={(e) => {
        if (interactive) e.stopPropagation()
      }}
      // A dblclick on the text must not bubble to the canvas focus handler (#40).
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* No inline delete button — removal is via the right-click menu or eraser (W3).
          `onDelete` remains wired for the empty-text auto-prune (blur/Backspace) below. */}
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
            // Read the live DOM value (controlled → current store text) so a text
            // element that gained content during the gesture is never pruned.
            const text = ref.current?.value ?? element.text
            if (!moved && text.trim() === '' && document.activeElement !== ref.current) {
              onDelete(element.id)
            }
          }
          document.addEventListener('pointermove', onMove, { signal })
          document.addEventListener('pointerup', onUp, { signal })
          document.addEventListener('pointercancel', onUp, { signal })
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
        onFocus={() => {
          onEditStart?.()
          onEditingChange?.(element.id, true)
        }}
        // Prune an empty / whitespace-only text element on blur so a double-click
        // that never receives content doesn't leave an orphan (#29, #36). Skip
        // while a drag is starting (grip press blurs the textarea).
        onBlur={() => {
          onEditingChange?.(element.id, false)
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
          color: COLOR_CSS[colorTok],
          fontFamily: FAMILY_CSS[fam],
          fontSize: px,
          fontWeight: weight,
          textAlign: align,
          lineHeight: `${lineHeightFor(px)}px`,
          padding: 0,
          overflow: 'hidden',
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          width: wrap ? element.width : undefined,
          cursor: interactive ? 'text' : 'default'
        }}
      />
    </div>
  )
})
