/**
 * Data-Flow board — the GRAPH tab, rendered through the SHARED spec renderer (diagram Phase 5,
 * Card 1). Replaces the retired bespoke `GraphCanvas`/`graphLayout` pair: the derived DfGraph maps
 * through `dfGraphToSpec` (render-time only — never persisted) into `DiagramSpecView`, laid out by
 * the same ELK engine as Planning diagram cards. Scroll UX is preserved: the stage is sized to the
 * layout's natural extent (fit scale 1) inside the board's scrolling `.df-body`.
 *
 * The renderer is pointer-inert (the DiagramCard discipline); this wrapper owns the focus click via
 * `specHitTest` at zoom 1 / pan 0 — the only transform to invert is the canvas camera's screen
 * scale — and translates hit slugs back to Df node ids through the adapter's `fromSlug` map.
 */
import { useMemo, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react'
import type { DfGraph, GraphDiff } from '../../../lib/dataFlowGraph'
import { dfGraphToSpec } from '../../../lib/dfSpecAdapter'
import { DiagramSpecView, specHitTest, useSpecLayout } from '@expanse-ade/diagram'
import { useDiagramMotionStore } from '../../../store/diagramMotionStore'
import { useReducedMotion } from '../planning/useReducedMotion'

const NO_PAN = { x: 0, y: 0 }

export function DataFlowSpecView({
  graph,
  diff,
  focusId,
  onFocus,
  onClearFocus
}: {
  graph: DfGraph
  /** Regenerate diff — added/changed bake into node statuses (active ● / warn !). */
  diff: GraphDiff
  /** Focused Df node id (the board's focus-subgraph state); neighbours stay lit, the rest dim. */
  focusId: string | undefined
  onFocus: (id: string) => void
  /** Empty-canvas / group click → full surface (the DiagramCard M3 clear contract). */
  onClearFocus: () => void
}): ReactElement {
  const { spec, toSlug, fromSlug } = useMemo(() => dfGraphToSpec(graph, diff), [graph, diff])
  const { layout, error } = useSpecLayout(spec)
  const reducedMotion = useReducedMotion()
  const motionSetting = useDiagramMotionStore((s) => s.setting)
  const motion = !reducedMotion && motionSetting !== 'off'

  const focusSlug = focusId !== undefined ? (toSlug.get(focusId) ?? null) : null

  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (!layout) return
    // Invert only the canvas camera's screen scale — the stage renders the layout at fit 1 (its
    // natural extent), so stage-local px ARE layout px (the hitTestViewport recipe, minus pan/zoom).
    const host = e.currentTarget
    const rect = host.getBoundingClientRect()
    const screenScale = host.offsetWidth > 0 ? rect.width / host.offsetWidth : 1
    const point = {
      x: (e.clientX - rect.left) / screenScale,
      y: (e.clientY - rect.top) / screenScale
    }
    const hit = specHitTest(point, { w: layout.width, h: layout.height }, NO_PAN, 1, layout)
    if (hit?.kind === 'node') {
      const dfId = fromSlug.get(hit.id)
      if (dfId !== undefined) onFocus(dfId)
      return
    }
    onClearFocus() // empty canvas (or a group body) → full surface
  }

  if (error) {
    return (
      <div className="df-empty">
        <div className="df-empty-h">Graph layout failed</div>
        <div className="df-empty-d">{error}</div>
      </div>
    )
  }

  return (
    <div
      className="df-specstage"
      style={layout ? { width: layout.width, height: layout.height } : undefined}
      onClick={onClick}
      role="presentation"
    >
      <DiagramSpecView
        spec={spec}
        w={layout?.width ?? 0}
        h={layout?.height ?? 0}
        motion={motion}
        layout={layout}
        error={null}
        focusId={focusSlug}
      />
    </div>
  )
}
