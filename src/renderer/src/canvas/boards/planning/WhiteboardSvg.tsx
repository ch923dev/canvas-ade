/**
 * The vector layer of the Planning whiteboard: arrows (SVG bezier + arrowhead)
 * and freehand strokes (vendored perfect-freehand → filled outline path). One
 * absolutely-positioned <svg> spanning the content well, drawing in board-local
 * coordinates (so it pans/zooms as a unit with the rest of the board content).
 *
 * Includes a live "draft" overlay so an in-progress arrow/stroke renders while
 * the pointer is still down, before it is committed to the store.
 */
import { useMemo, type ReactElement } from 'react'
import type { ArrowElement, StrokeElement } from '../../../lib/boardSchema'
import { arrowPath, strokeToPath, arrowheadMarkerId } from './svgPaths'

export interface WhiteboardSvgProps {
  boardId: string
  arrows: ArrowElement[]
  strokes: StrokeElement[]
  /** In-progress arrow while dragging the `arrow` tool (board-local). */
  draftArrow?: ArrowElement | null
  /** In-progress freehand points while dragging the `pen` tool (board-local). */
  draftStroke?: number[] | null
}

export function WhiteboardSvg({
  boardId,
  arrows,
  strokes,
  draftArrow,
  draftStroke
}: WhiteboardSvgProps): ReactElement {
  const markerId = arrowheadMarkerId(boardId)
  // Memoize the (potentially heavy) outline math for committed strokes.
  const strokePaths = useMemo(() => strokes.map((s) => strokeToPath(s.points)), [strokes])
  const draftPath = useMemo(
    () => (draftStroke && draftStroke.length >= 2 ? strokeToPath(draftStroke) : ''),
    [draftStroke]
  )

  return (
    <svg
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      <defs>
        <marker id={markerId} markerWidth={8} markerHeight={8} refX={6} refY={4} orient="auto">
          <path d="M0 0 L7 4 L0 8 z" fill="var(--border-strong)" />
        </marker>
      </defs>

      {arrows.map((a) => (
        <path
          key={a.id}
          d={arrowPath(a)}
          stroke="var(--border-strong)"
          strokeWidth={1.5}
          fill="none"
          markerEnd={`url(#${markerId})`}
        />
      ))}
      {draftArrow && (
        <path
          d={arrowPath(draftArrow)}
          stroke="var(--border-strong)"
          strokeWidth={1.5}
          fill="none"
          markerEnd={`url(#${markerId})`}
        />
      )}

      {strokePaths.map((d, i) =>
        d ? <path key={strokes[i].id} d={d} fill="var(--text-2)" /> : null
      )}
      {draftPath && <path d={draftPath} fill="var(--text-2)" />}
    </svg>
  )
}
