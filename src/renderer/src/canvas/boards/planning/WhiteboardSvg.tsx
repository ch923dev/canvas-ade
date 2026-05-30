/**
 * The vector layer of the Planning whiteboard: arrows (SVG bezier + arrowhead)
 * and freehand strokes (vendored perfect-freehand → filled outline path). One
 * absolutely-positioned <svg> spanning the content well, drawing in board-local
 * coordinates (so it pans/zooms as a unit with the rest of the board content).
 *
 * Includes a live "draft" overlay so an in-progress arrow/stroke renders while
 * the pointer is still down, before it is committed to the store.
 */
import { useMemo, type PointerEvent, type ReactElement } from 'react'
import type { ArrowElement, StrokeElement } from '../../../lib/boardSchema'
import { arrowPath, strokeToPath, arrowheadMarkerId } from './svgPaths'

/**
 * Per-stroke outline cache keyed on the `points` array identity (#BUG-028). A
 * module-level WeakMap (NOT a React ref, so it is read/written outside the hook graph
 * and never during render) — unmoved strokes keep their `points` reference and hit the
 * cache, while a moved stroke's fresh array misses and recomputes; the stale array
 * GC's out of the map on its own (no manual pruning needed).
 */
const strokeOutlineCache = new WeakMap<number[], string>()
function strokeOutline(points: number[]): string {
  let path = strokeOutlineCache.get(points)
  if (path === undefined) {
    path = strokeToPath(points)
    strokeOutlineCache.set(points, path)
  }
  return path
}

export interface WhiteboardSvgProps {
  boardId: string
  arrows: ArrowElement[]
  strokes: StrokeElement[]
  /** In-progress arrow while dragging the `arrow` tool (board-local). */
  draftArrow?: ArrowElement | null
  /** In-progress freehand points while dragging the `pen` tool (board-local). */
  draftStroke?: number[] | null
  /** Id of the currently selected vector element (arrow or stroke). */
  selectedId?: string | null
  /** Called when a committed arrow or stroke is clicked. */
  onSelect?: (id: string) => void
  /**
   * Begin a board-local drag of a committed vector (arrow/stroke) — wired to the
   * same `startElementDrag` the cards use so vectors are repositionable, not just
   * select+delete (#28, #37).
   */
  onDragStart?: (e: PointerEvent, id: string) => void
  /**
   * True while ANY non-select tool (pen/arrow/note/check) is active. Disables
   * hit-testing on the committed vectors so a new stroke/arrow can START — or a
   * note/checklist can be PLACED — on top of existing ink (the press falls through
   * to the well's onWellPointerDown — #4/BUG-022), mirroring the card fall-through
   * guards. Selection/drag of vectors stays available in select mode.
   */
  drawing?: boolean
}

export function WhiteboardSvg({
  boardId,
  arrows,
  strokes,
  draftArrow,
  draftStroke,
  selectedId,
  onSelect,
  onDragStart,
  drawing = false
}: WhiteboardSvgProps): ReactElement {
  const markerId = arrowheadMarkerId(boardId)
  // Memoize the (potentially heavy) outline math PER STROKE via the module-level
  // points-keyed cache. The parent derives `strokes` via .filter() (new array every
  // render) and translateElement returns the SAME element object (same `points` ref)
  // for unmoved strokes — only the dragged one gets a fresh ref — so unchanged strokes
  // reuse their path across every drag/zoom frame instead of recomputing getStroke for
  // all of them (#BUG-028).
  const strokePaths = useMemo(() => strokes.map((s) => strokeOutline(s.points)), [strokes])
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
        <marker
          id={`${markerId}-sel`}
          markerWidth={8}
          markerHeight={8}
          refX={6}
          refY={4}
          orient="auto"
        >
          <path d="M0 0 L7 4 L0 8 z" fill="var(--accent)" />
        </marker>
      </defs>

      {arrows.map((a) => (
        <path
          key={a.id}
          d={arrowPath(a)}
          stroke={a.id === selectedId ? 'var(--accent)' : 'var(--border-strong)'}
          strokeWidth={a.id === selectedId ? 2.5 : 1.5}
          fill="none"
          markerEnd={a.id === selectedId ? `url(#${markerId}-sel)` : `url(#${markerId})`}
          style={{ pointerEvents: drawing ? 'none' : 'stroke', cursor: 'grab' }}
          onPointerDown={(e) => {
            e.stopPropagation()
            onSelect?.(a.id)
            onDragStart?.(e, a.id)
          }}
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
        d ? (
          <path
            key={strokes[i].id}
            d={d}
            fill={strokes[i].id === selectedId ? 'var(--accent)' : 'var(--text-2)'}
            style={{ pointerEvents: drawing ? 'none' : 'auto', cursor: 'grab' }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onSelect?.(strokes[i].id)
              onDragStart?.(e, strokes[i].id)
            }}
          />
        ) : null
      )}
      {draftPath && <path d={draftPath} fill="var(--text-2)" />}
    </svg>
  )
}
