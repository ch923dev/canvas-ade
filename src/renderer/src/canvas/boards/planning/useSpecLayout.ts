/**
 * Async spec→layout hook (Phase 1) — its own module (not in-file in the view: an in-file custom
 * hook flips react-hooks v6 into deep per-file analysis; lane gotcha). Feeds a DiagramSpec through
 * the pure ELK mapping + the off-thread engine and returns the positioned layout, cancelling a
 * stale run when the spec changes mid-flight (the DiagramCard render-effect discipline).
 */
import { useEffect, useState } from 'react'
import type { DiagramSpec } from '../../../lib/diagramSpec'
import { elkResultToLayout, specToElkGraph, type SpecLayoutResult } from './specLayout'
import { elkLayout } from './specElk'

export interface SpecLayoutState {
  layout: SpecLayoutResult | null
  /** Layout-engine failure (chunk fetch / ELK error) — rendered as the inline error state. */
  error: string | null
}

/**
 * Per-spec-object layout memo (B4): revision scrubbing and collapse toggles flip between STABLE
 * spec objects (revisions persist in the element; applyCollapse is the identity when nothing
 * collapses), so keying on object identity makes ‹ › scrubs and re-expands instant instead of
 * re-running ELK. WeakMap ⇒ entries die with their specs, no size management needed.
 */
const layoutCache = new WeakMap<DiagramSpec, SpecLayoutResult>()

/**
 * `spec` may be null (the mermaid engine branch — hooks must run unconditionally in DiagramCard,
 * which owns the layout since Phase 2 so the card can hit-test focus clicks and memo revisions).
 */
export function useSpecLayout(spec: DiagramSpec | null): SpecLayoutState {
  const [state, setState] = useState<SpecLayoutState>({ layout: null, error: null })
  // Cache hit resolves SYNCHRONOUSLY at render (no setState-in-effect): a scrub to an
  // already-laid-out spec paints its layout in the same frame the spec flips.
  const cached = spec ? layoutCache.get(spec) : undefined

  useEffect(() => {
    if (!spec || layoutCache.has(spec)) return // hit — served from the render-time read above
    let cancelled = false
    void (async () => {
      try {
        const root = await elkLayout(specToElkGraph(spec))
        if (cancelled) return
        const layout = elkResultToLayout(spec, root)
        layoutCache.set(spec, layout)
        setState({ layout, error: null })
      } catch (e) {
        if (cancelled) return
        setState({ layout: null, error: String((e as Error)?.message ?? e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [spec])

  return cached ? { layout: cached, error: null } : state
}
