/**
 * The vector layer of the Planning whiteboard: arrows (SVG bezier + arrowhead)
 * and freehand strokes (vendored perfect-freehand → filled outline path). One
 * absolutely-positioned <svg> spanning the content well, drawing in board-local
 * coordinates (so it pans/zooms as a unit with the rest of the board content).
 *
 * Includes a live "draft" overlay so an in-progress arrow/stroke renders while
 * the pointer is still down, before it is committed to the store.
 */
import { memo, useMemo, type PointerEvent, type ReactElement } from 'react'
import type { ArrowElement, StrokeElement } from '../../../lib/boardSchema'
import { arrowPath, strokeToPath, arrowheadMarkerId, STROKE_OPTIONS } from './svgPaths'
import { strokeColorCss, arrowWidthPx, penWidthPx } from './strokeStyle'
import { draftPolyline } from '../../../lib/pen'
import { isLocked, setArrowEndpoint, type ArrowEnd } from './elements'

/** Legacy per-kind ink (pre-P4b) — the fallback an absent/`default` `strokeColor` resolves to. */
const ARROW_DEFAULT_STROKE = 'var(--border-strong)'
const PEN_DEFAULT_FILL = 'var(--text-2)'

/**
 * Per-stroke outline cache keyed on the `points` array identity (#BUG-028), then on the pen `size`
 * (P4b `strokeWidth` — a stroke's width can change without its points moving). A module-level WeakMap
 * (NOT a React ref, so it is read/written outside the hook graph and never during render) — unmoved
 * strokes keep their `points` reference and hit the cache, while a moved stroke's fresh array misses
 * and recomputes; the stale array GC's out of the map on its own (no manual pruning needed). The
 * inner size→path Map keeps the (rare) multi-width variants of the same points distinct.
 */
const strokeOutlineCache = new WeakMap<number[], Map<number, string>>()
function strokeOutline(points: number[], size: number): string {
  let bySize = strokeOutlineCache.get(points)
  if (!bySize) {
    bySize = new Map()
    strokeOutlineCache.set(points, bySize)
  }
  let path = bySize.get(size)
  if (path === undefined) {
    path = strokeToPath(points, size)
    bySize.set(size, path)
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
  /**
   * Live endpoint-drag preview (D3-B, board-local) from usePlanningPointer; the
   * dragged arrow renders with this end substituted so the bezier + arrowhead +
   * handle re-bow under the cursor. Null when idle.
   */
  endpointDrag?: { id: string; end: ArrowEnd; x: number; y: number } | null
  /** Begin dragging one endpoint of the selected arrow ('start' = tail, 'end' = head). */
  onEndpointDragStart?: (e: PointerEvent, id: string, end: ArrowEnd) => void
}

// Memoized (PLAN-07): once PLAN-01 stops the board re-rendering per camera frame, the
// remaining re-render triggers are element edits + ephemeral session state (tool, snap,
// editing/hover). PlanningBoard hands this stable callbacks + `useMemo`-stabilized
// arrow/stroke arrays (keyed on viewElements), so a re-render that doesn't touch the
// vector layer — a note keystroke, a snap toggle, an editingTextId change — skips the
// whole SVG reconcile instead of re-walking every arrow/stroke path.
export const WhiteboardSvg = memo(function WhiteboardSvg({
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
  drawing = false,
  endpointDrag,
  onEndpointDragStart
}: WhiteboardSvgProps): ReactElement {
  const markerId = arrowheadMarkerId(boardId)
  // Live endpoint substitution (D3-B): render the dragged arrow with the draft
  // endpoint — the same pure transform the pointer-up commit uses, so preview and
  // commit can never disagree. The store is written once, on pointer-up.
  const viewArrows = endpointDrag
    ? setArrowEndpoint(arrows, endpointDrag.id, endpointDrag.end, endpointDrag.x, endpointDrag.y)
    : arrows
  // Endpoint handles show for exactly ONE selected element that is an unlocked
  // arrow, in select mode only (`drawing` covers every non-select tool). Looked up
  // in the substituted/translated view so the handles track a live drag.
  const soleSelectedId = selectedIds?.size === 1 ? [...selectedIds][0] : null
  const endpointArrow =
    soleSelectedId && !drawing
      ? viewArrows.find((a) => a.id === soleSelectedId && !isLocked(a))
      : undefined
  // Per-stroke outline math is cached by the module-level points-keyed WeakMap above:
  // the parent derives `strokes` via .filter() and translateElement returns the SAME
  // element object (same `points` ref) for unmoved strokes — only the dragged one gets a
  // fresh ref — so unchanged strokes hit the cache and reuse their path every drag/zoom
  // frame (#BUG-028). No useMemo here: a [strokes]-keyed memo could never skip (the array
  // identity changes whenever the parent re-derives it), so it only added overhead — the
  // WeakMap is the real cache and the .map is a cheap per-stroke lookup.
  const strokePaths = strokes.map((s) => strokeOutline(s.points, penWidthPx(s.strokeWidth)))
  // In-progress DRAFT (SLICE-011): render a cheap O(N) centerline polyline, NOT the full
  // perfect-freehand outline. `strokeToPath`/getStroke is O(stroke length) per call, so
  // re-running it over the whole growing point list every pen-move frame is O(N^2) across
  // one stroke (~135ms cumulative for an ~800-pt scribble). `draftPolyline` touches each
  // point once, so the per-frame draft cost no longer grows with stroke length. The
  // committed stroke is still rendered via `strokeOutline`/`strokeToPath` above (the
  // store gets the raw points on pointer-up and re-runs full getStroke), so the final ink
  // is byte-identical to today's output — only the live preview is the cheap centerline.
  // Drawn as a stroked path at the pen size (`thinning: 0` => constant-width outline, so a
  // round-cap/join centerline at `STROKE_OPTIONS.size` is a faithful preview).
  const draftPath = useMemo(() => (draftStroke ? draftPolyline(draftStroke) : ''), [draftStroke])

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
        {/* One marker, `fill="context-stroke"` (Chromium/SVG2) so the arrowhead ALWAYS matches its
            arrow's stroke — the selection accent AND the P4b custom stroke colour — with no per-colour
            marker duplication. Byte-identical for the default/selected cases (stroke == old marker fill). */}
        <marker id={markerId} markerWidth={8} markerHeight={8} refX={6} refY={4} orient="auto">
          <path d="M0 0 L7 4 L0 8 z" fill="context-stroke" />
        </marker>
      </defs>

      {viewArrows.map((a) => {
        const sel = selectedIds?.has(a.id)
        // Selection recolours the arrow accent (unchanged). Otherwise the P4b strokeColor, falling
        // back to the legacy border-strong for an absent/`default` token (byte-identical). Selected
        // keeps the legacy +1px emphasis over the element's own (custom-or-default) width.
        const base = arrowWidthPx(a.strokeWidth)
        return (
          <path
            key={a.id}
            d={arrowPath(a)}
            stroke={sel ? 'var(--accent)' : strokeColorCss(a.strokeColor, ARROW_DEFAULT_STROKE)}
            strokeWidth={sel ? base + 1 : base}
            fill="none"
            opacity={a.opacity}
            markerEnd={`url(#${markerId})`}
            style={{ pointerEvents: drawing ? 'none' : 'stroke', cursor: 'grab' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return // right/middle: let contextmenu handle it
              e.stopPropagation()
              onSelect?.(a.id, e.shiftKey)
              onDragStart?.(e, a.id)
            }}
          />
        )
      })}
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
            fill={
              selectedIds?.has(strokes[i].id)
                ? 'var(--accent)'
                : strokeColorCss(strokes[i].strokeColor, PEN_DEFAULT_FILL)
            }
            opacity={strokes[i].opacity}
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
      {draftPath && (
        <path
          d={draftPath}
          fill="none"
          stroke="var(--text-2)"
          strokeWidth={STROKE_OPTIONS.size}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Endpoint handles (D3-B): hollow accent rings on the single selected arrow.
          Visible ring r=7 (signed-off artifact); a transparent r=12 circle on top is
          the hit target so the grab tolerance is ~12px board-local (scales with the
          camera like all well content). */}
      {endpointArrow &&
        (['start', 'end'] as const).map((end) => {
          const cx = end === 'start' ? endpointArrow.x : endpointArrow.x2
          const cy = end === 'start' ? endpointArrow.y : endpointArrow.y2
          return (
            <g key={end}>
              <circle
                cx={cx}
                cy={cy}
                r={7}
                fill="var(--void)"
                stroke="var(--accent)"
                strokeWidth={1.5}
                style={{ pointerEvents: 'none' }}
              />
              <circle
                data-arrow-endpoint={end}
                cx={cx}
                cy={cy}
                r={12}
                fill="transparent"
                style={{ pointerEvents: 'all', cursor: 'crosshair' }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return // right/middle: let contextmenu handle it
                  e.stopPropagation()
                  onEndpointDragStart?.(e, endpointArrow.id, end)
                }}
              />
            </g>
          )
        })}

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
})
