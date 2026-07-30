/**
 * Docked-terminals — a draggable region divider (eyeball feedback 2026-07-31: every dock
 * region resizes — chat spine · worker rail · triage strip; the viewport takes the rest).
 * Pointer-captured drag: `onStart` lets the host snapshot the region's current px, `onLive`
 * streams the cumulative SCREEN-px delta (the host divides by the camera zoom — board-local
 * px ≠ screen px under zoom), `onEnd` commits ONE tracked updateBoard step. `nodrag nopan`
 * so React Flow never reads the drag as a node move / canvas pan.
 */
import {
  useCallback,
  useRef,
  type CSSProperties,
  type ReactElement,
  type PointerEvent
} from 'react'

export function DockDivider({
  axis,
  onStart,
  onLive,
  onEnd,
  testId,
  style
}: {
  /** 'x' = vertical divider (drag left-right), 'y' = horizontal (drag up-down). */
  axis: 'x' | 'y'
  onStart: () => void
  /** Cumulative screen-px delta since onStart (host converts to board-local px). */
  onLive: (delta: number) => void
  onEnd: () => void
  testId: string
  /** Grid placement from the host (the .sw-body grid slots the dividers between regions). */
  style?: CSSProperties
}): ReactElement {
  const originRef = useRef(0)
  const draggingRef = useRef(false)
  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      e.currentTarget.setPointerCapture(e.pointerId)
      originRef.current = axis === 'x' ? e.clientX : e.clientY
      draggingRef.current = true
      onStart()
    },
    [axis, onStart]
  )
  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      if (!draggingRef.current) return
      onLive((axis === 'x' ? e.clientX : e.clientY) - originRef.current)
    },
    [axis, onLive]
  )
  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLDivElement>): void => {
      if (!draggingRef.current) return
      draggingRef.current = false
      e.currentTarget.releasePointerCapture(e.pointerId)
      onEnd()
    },
    [onEnd]
  )
  return (
    <div
      className={`sw-divider ${axis} nodrag nopan`}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      data-test={testId}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    />
  )
}
