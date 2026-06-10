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
  /** Ids of the currently selected vector elements (arrows/strokes). */
  selectedIds?: ReadonlySet<string>
  /** Live marquee box (board-local) while box-selecting; null when idle. */
  marquee?: { x: number; y: number; w: number; h: number } | null
  /** Live alignment guides (board-local) while dragging; null when idle. */
  guides?: { axis: 'x' | 'y'; at: number; from: number; to: number }[] | null
  /** Called when a committed arrow/stroke is pressed; `additive` = Shift was held. */
  onSelect?: (id: string, additive: boolean) => void
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
  selectedIds,
  marquee,
  guides,
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
          stroke={selectedIds?.has(a.id) ? 'var(--accent)' : 'var(--border-strong)'}
          strokeWidth={selectedIds?.has(a.id) ? 2.5 : 1.5}
          fill="none"
          markerEnd={selectedIds?.has(a.id) ? `url(#${markerId}-sel)` : `url(#${markerId})`}
          style={{ pointerEvents: drawing ? 'none' : 'stroke', cursor: 'grab' }}
          onPointerDown={(e) => {
            if (e.button !== 0) return // right/middle: let contextmenu handle it
            e.stopPropagation()
            onSelect?.(a.id, e.shiftKey)
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
            fill={selectedIds?.has(strokes[i].id) ? 'var(--accent)' : 'var(--text-2)'}
            style={{ pointerEvents: drawing ? 'none' : 'auto', cursor: 'grab' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return // right/middle: let contextmenu handle it
              e.stopPropagation()
              onSelect?.(strokes[i].id, e.shiftKey)
              onDragStart?.(e, strokes[i].id)
            }}
          />
        ) : null
      )}
      {draftPath && <path d={draftPath} fill="var(--text-2)" />}

      {marquee && (marquee.w > 0 || marquee.h > 0) && (
        <rect
          x={marquee.x}
          y={marquee.y}
          width={marquee.w}
          height={marquee.h}
          fill="var(--accent)"
          fillOpacity={0.08}
          stroke="var(--accent)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      )}

      {guides?.map((g) =>
        g.axis === 'x' ? (
          <line
            key={`x${g.at}`}
            x1={g.at}
            y1={g.from}
            x2={g.at}
            y2={g.to}
            stroke="var(--accent)"
            strokeWidth={1}
          />
        ) : (
          <line
            key={`y${g.at}`}
            x1={g.from}
            y1={g.at}
            x2={g.to}
            y2={g.at}
            stroke="var(--accent)"
            strokeWidth={1}
          />
        )
      )}
    </svg>
  )
}
