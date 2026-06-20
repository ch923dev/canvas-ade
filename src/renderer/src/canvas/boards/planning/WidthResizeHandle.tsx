/**
 * Right-edge width-resize handle for the auto-height Planning cards (notes + checklists —
 * PLAN-05). A slim vertical `--accent` pill straddling the card's right edge; the caller gates
 * rendering on select + interactive + unlocked, mirroring DiagramCard's resize handle.
 *
 * Reuses DiagramCard's gesture discipline: the board-local→screen scale is captured at
 * pointerdown from the `.pl-well` (so the memo'd card never subscribes to the camera), a
 * 4-SCREEN-px threshold gates the FIRST commit (a no-move tap pushes no phantom undo step), and
 * exactly ONE undo checkpoint is armed per drag. Constrained to the X axis (`ew-resize`) because
 * these cards size their height from content — only width is user-sizable.
 */
import {
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactElement
} from 'react'
import { widthFromDrag } from './widthResize'

export interface WidthResizeHandleProps {
  /** Current board-local width (px) — the resize start size. */
  width: number
  /** Minimum board-local width (px). */
  min: number
  /** Arm one undo checkpoint on the first real move (beginChange). */
  onEditStart: () => void
  /** Tracked width commit (board-local px). */
  onResize: (w: number) => void
}

export function WidthResizeHandle({
  width,
  min,
  onEditStart,
  onResize
}: WidthResizeHandleProps): ReactElement {
  const gesture = useRef<{ startX: number; startW: number; scale: number; moved: boolean } | null>(
    null
  )

  const onDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation() // never start a card drag / toggle the selection from the handle
      const handle = e.currentTarget as HTMLElement
      // boardScale = the well's on-screen width ÷ its layout width — captures camera zoom AND any
      // board-node render scale in one ratio (== screenScale). Frozen for the gesture (the pointer
      // is captured, so the camera can't move mid-drag). DOM-only → no camera subscription.
      const well = handle.closest('.pl-well') as HTMLElement | null
      const rect = well?.getBoundingClientRect()
      const scale = well && rect && well.offsetWidth > 0 ? rect.width / well.offsetWidth : 1
      gesture.current = { startX: e.clientX, startW: width, scale, moved: false }
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic event in tests */
      }
    },
    [width]
  )

  const onMove = useCallback(
    (e: ReactPointerEvent) => {
      const g = gesture.current
      if (!g) return
      const dx = e.clientX - g.startX
      // Arm ONE checkpoint on the first real move (>4 SCREEN px — zoom-independent, like the
      // diagram + arrow-endpoint gestures); a sub-threshold jiggle commits nothing.
      if (!g.moved) {
        if (Math.abs(dx) <= 4) return
        onEditStart()
        g.moved = true
      }
      onResize(widthFromDrag(g.startW, dx, g.scale, min))
    },
    [onResize, onEditStart, min]
  )

  const onUp = useCallback((e: ReactPointerEvent) => {
    if (!gesture.current) return
    gesture.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* capture already released / synthetic */
    }
  }, [])

  return (
    <div
      className="pl-width-resize"
      title="Resize width"
      data-testid="pl-width-resize"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  )
}
