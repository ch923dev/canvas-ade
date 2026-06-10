/**
 * Checklist element (DESIGN.md §7.3) — a `--surface-raised` card with a title +
 * `done/total` mono count, a 3px `--accent` progress bar, and rows of togglable
 * items. Per the design: checkbox = 16px `--r-ctl`; checked = filled `--accent` +
 * `--void` check glyph; the item label goes `--text-3` + strikethrough when
 * done (D0-2: was `--text-faint`, below AA — faint is disabled-only now).
 * Toggling is LIVE (writes straight back through `onToggle` to the store).
 *
 * Lives entirely inside the Planning board's content well in board-local
 * coordinates; stops pointer propagation so toggling/editing never starts a node
 * drag or clears the canvas selection.
 */
import { useEffect, useRef, type ReactElement } from 'react'
import type { ChecklistElement } from '../../../lib/boardSchema'
import { Icon } from '../../Icon'

export interface ChecklistCardProps {
  element: ChecklistElement
  /** True when the whiteboard `select` tool is active (enables drag + edit). */
  interactive: boolean
  /** Begin a board-local drag from a screen pointer-down on the card header. */
  onDragStart: (e: React.PointerEvent, id: string) => void
  onToggle: (elementId: string, itemId: string) => void
  onChangeTitle: (elementId: string, title: string) => void
  onChangeItem: (elementId: string, itemId: string, label: string) => void
  /** Enter pressed on an item → append a fresh empty item. */
  onAddItem: (elementId: string) => void
  onRemoveItem: (elementId: string, itemId: string) => void
  /** Called when any input gains focus — used to checkpoint undo. */
  onEditStart?: () => void
  /**
   * Report the card's measured bottom edge in board-local px (element.y +
   * rendered height) whenever it changes, so the board can grow to avoid clipping
   * a tall checklist + its "Add item" button under overflow:hidden (#12).
   */
  onMeasureBottom?: (id: string, bottom: number) => void
  /** True when this element is in the board selection set (draws the accent ring). */
  selected?: boolean
  /** Select this element on grip press; `additive` = Shift held. */
  onSelect?: (id: string, additive: boolean) => void
  /** Report the rendered board-local size for selection/snap bbox (W2). */
  onMeasure?: (id: string, w: number, h: number) => void
}

/** 16px checkbox; filled `--accent` + a `--void` check glyph when done. */
function Checkbox({ done }: { done: boolean }): ReactElement {
  return (
    <span
      // Decorative — the owning button carries role="checkbox" + aria-checked (A10).
      aria-hidden
      // ca-t-check (A12): the toggle fill/border transition lives in a class so
      // prefers-reduced-motion can suppress it (index.css media block).
      className="ca-t-check"
      style={{
        width: 16,
        height: 16,
        flex: 'none',
        borderRadius: 'var(--r-ctl)',
        display: 'grid',
        placeItems: 'center',
        border: `1.5px solid ${done ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: done ? 'var(--accent)' : 'transparent',
        color: 'var(--void)'
      }}
    >
      {done && <Icon name="check" size={11} sw={2.4} />}
    </span>
  )
}

export function ChecklistCard({
  element,
  interactive,
  onDragStart,
  onToggle,
  onChangeTitle,
  onChangeItem,
  onAddItem,
  onRemoveItem,
  onEditStart,
  onMeasureBottom,
  selected,
  onSelect,
  onMeasure
}: ChecklistCardProps): ReactElement {
  const total = element.items.length
  const done = element.items.filter((i) => i.done).length
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  const lastInputRef = useRef<HTMLInputElement>(null)
  const prevTotal = useRef(total)
  const cardRef = useRef<HTMLDivElement>(null)
  // Per-item input refs (keyed by item id) so Backspace-delete can restore focus
  // to the adjacent row after the keyed input unmounts (BUG-014).
  const itemRefs = useRef<Map<string, HTMLInputElement>>(new Map())
  // Item id to focus after a remove commits + re-renders (the adjacent row).
  const focusAfterRemove = useRef<string | null>(null)

  // After appending an item, focus the new (last) row.
  useEffect(() => {
    if (total > prevTotal.current) lastInputRef.current?.focus()
    prevTotal.current = total
  }, [total])

  // After a Backspace-remove re-renders without the deleted row, restore keyboard
  // focus to the adjacent row instead of letting it fall to document.body (BUG-014).
  useEffect(() => {
    const targetId = focusAfterRemove.current
    if (targetId === null) return
    focusAfterRemove.current = null
    itemRefs.current.get(targetId)?.focus()
  }, [total])

  // Report the card's bottom edge (board-local) on any size change so the board
  // can auto-grow rather than clip a tall checklist under overflow:hidden (#12).
  // offsetHeight is in board-local px (the card lives inside the unzoomed well).
  useEffect(() => {
    const el = cardRef.current
    if (!el || (!onMeasureBottom && !onMeasure)) return
    const report = (): void => {
      onMeasureBottom?.(element.id, element.y + el.offsetHeight)
      onMeasure?.(element.id, el.offsetWidth, el.offsetHeight)
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [element.id, element.y, onMeasureBottom, onMeasure])

  return (
    <div
      ref={cardRef}
      className="pl-check"
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: element.w,
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
        borderRadius: 'var(--r-board)',
        padding: '11px 12px 12px',
        boxShadow: 'var(--shadow-pop)',
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        cursor: interactive ? 'grab' : 'default'
      }}
      // The whole card body is the drag surface (mirrors the note's grip ring). In
      // select mode a press that isn't on an interactive control — the title/item
      // inputs, checkboxes, and buttons all stopPropagation themselves — selects this
      // element and starts the move. In a draw mode (pen/arrow/place) the press falls
      // through to the well so a stroke can START over the card (#6).
      onPointerDown={(e) => {
        if (!interactive) return
        // Only the primary button initiates a drag; right/middle buttons fall
        // through to the browser context-menu / OS default (primary-button guard).
        if (e.button !== 0) return
        e.stopPropagation()
        onSelect?.(element.id, e.shiftKey)
        onDragStart(e, element.id)
      }}
      // A dblclick on the card must not bubble to the canvas focus handler (#40).
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* No inline delete button — a checklist is removed via the right-click menu or
          the eraser tool (W3). */}
      {/* Header = title + done/total count. The drag is owned by the card body above
          (a press here on anything but the title input bubbles up to it). */}
      <div
        className="pl-check-head"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: interactive ? 'grab' : 'default'
        }}
      >
        <input
          value={element.title}
          readOnly={!interactive}
          placeholder="Checklist"
          spellCheck={false}
          onChange={(e) => onChangeTitle(element.id, e.target.value)}
          onFocus={() => onEditStart?.()}
          // Let a draw gesture begin over the title (#6); only block in select.
          onPointerDown={(e) => {
            if (interactive) e.stopPropagation()
          }}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontFamily: 'var(--ui)',
            fontSize: 12.5,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            padding: 0,
            cursor: interactive ? 'text' : 'default'
          }}
        />
        <span
          style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)', flex: 'none' }}
        >
          {done}/{total}
        </span>
      </div>

      {/* 3px progress bar — width animates with the live done ratio. */}
      <div
        style={{
          height: 3,
          borderRadius: 'var(--r-pill)',
          background: 'var(--inset)',
          overflow: 'hidden'
        }}
      >
        <div
          // ca-t-fill (A12): the progress-width animation, reduced-motion gated.
          className="ca-t-fill"
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'var(--accent)'
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 1 }}>
        {element.items.map((item, idx) => (
          <div
            key={item.id}
            style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%' }}
          >
            <button
              type="button"
              // A10: announced as a real checkbox (role + checked state); the visible
              // square below is purely decorative. Stays a <button> so Space/Enter
              // toggling and focusability come free.
              role="checkbox"
              aria-checked={item.done}
              aria-label={item.label || 'Checklist item'}
              title={item.done ? 'Mark not done' : 'Mark done'}
              // Block the press only in select mode; a draw gesture may begin over
              // the checkbox and should reach the well (#6). Toggling is a click.
              onPointerDown={(e) => {
                if (interactive) e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                onToggle(element.id, item.id)
              }}
              style={{
                border: 'none',
                background: 'none',
                padding: 0,
                cursor: 'pointer',
                display: 'flex',
                flex: 'none'
              }}
            >
              <Checkbox done={item.done} />
            </button>
            <input
              ref={(node) => {
                if (idx === element.items.length - 1)
                  (lastInputRef as React.MutableRefObject<HTMLInputElement | null>).current = node
                if (node) itemRefs.current.set(item.id, node)
                else itemRefs.current.delete(item.id)
              }}
              value={item.label}
              readOnly={!interactive}
              placeholder="Item…"
              spellCheck={false}
              onChange={(e) => onChangeItem(element.id, item.id, e.target.value)}
              onFocus={() => onEditStart?.()}
              // Let a draw gesture begin over an item row (#6); block in select.
              onPointerDown={(e) => {
                if (interactive) e.stopPropagation()
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  onAddItem(element.id)
                } else if (e.key === 'Backspace' && item.label.length === 0 && total > 1) {
                  e.preventDefault()
                  // Restore focus to the adjacent row after the keyed input unmounts:
                  // the next item, or the previous one when deleting the last (BUG-014).
                  const next = element.items[idx + 1] ?? element.items[idx - 1]
                  focusAfterRemove.current = next ? next.id : null
                  onRemoveItem(element.id, item.id)
                } else if (e.key === 'Backspace' && item.label.length === 0) {
                  // Keep the non-zero floor (never a zero-item card), but make
                  // Backspace on the sole empty row feel intentional — blur out of
                  // the dead row instead of silently swallowing the key (#35).
                  e.preventDefault()
                  e.currentTarget.blur()
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                background: 'transparent',
                fontFamily: 'var(--ui)',
                fontSize: 12,
                lineHeight: '16px',
                padding: 0,
                // D0-2 (A1): done items must stay readable — faint is disabled-only
                color: item.done ? 'var(--text-3)' : 'var(--text-2)',
                textDecoration: item.done ? 'line-through' : 'none',
                textDecorationColor: 'var(--text-3)',
                cursor: interactive ? 'text' : 'default'
              }}
            />
          </div>
        ))}
      </div>

      {interactive && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onAddItem(element.id)
          }}
          style={{
            alignSelf: 'flex-start',
            marginTop: 1,
            border: 'none',
            background: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            color: 'var(--text-3)',
            fontFamily: 'var(--ui)',
            fontSize: 11.5
          }}
        >
          <Icon name="plus" size={13} />
          Add item
        </button>
      )}
    </div>
  )
}
