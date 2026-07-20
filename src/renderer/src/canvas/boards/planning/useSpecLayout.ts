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

export function useSpecLayout(spec: DiagramSpec): SpecLayoutState {
  const [state, setState] = useState<SpecLayoutState>({ layout: null, error: null })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const root = await elkLayout(specToElkGraph(spec))
        if (cancelled) return
        setState({ layout: elkResultToLayout(spec, root), error: null })
      } catch (e) {
        if (cancelled) return
        setState({ layout: null, error: String((e as Error)?.message ?? e) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [spec])

  return state
}
