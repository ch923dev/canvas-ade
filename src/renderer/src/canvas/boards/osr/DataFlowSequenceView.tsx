/**
 * Data-Flow board — the SEQUENCE tab renderer (JD-4). Split out of the retired
 * `DataFlowGraphView.tsx` in diagram Phase 5 (the graph tab now renders through the shared spec
 * renderer; time-ordered lanes are not a node/edge graph, so this view stays bespoke). Pure view;
 * all page-controlled strings are React-escaped text (no innerHTML / dangerouslySetInnerHTML).
 */
import { type ReactElement } from 'react'
import type { TemplateGroup } from '../../../lib/routeTemplate'
import type { LineageEdge } from '../../../lib/lineage'

/** The sequence layout — endpoints as time-ordered lanes (by first-call `startTs`), with a time axis
 *  and dashed id-lineage hops crossing the lanes where a value flows forward. */
export function SequenceView({
  groups,
  lineage
}: {
  groups: TemplateGroup[]
  lineage: LineageEdge[]
}): ReactElement {
  // lanes ordered by the earliest call in each template (the flow's time order)
  const firstTs = (g: TemplateGroup): number =>
    g.records.reduce((m, r) => Math.min(m, r.startTs), Number.POSITIVE_INFINITY)
  const lanes = [...groups].sort((a, b) => firstTs(a) - firstTs(b))
  const times = lanes.map(firstTs).filter((t) => Number.isFinite(t))
  const lo = times.length ? Math.min(...times) : 0
  const hi = times.length ? Math.max(...times) : 1
  const span = Math.max(1, hi - lo)
  const xOf = (g: TemplateGroup): number => {
    const t = firstTs(g)
    return Number.isFinite(t) ? 14 + ((t - lo) / span) * 64 : 14 // % within the track
  }
  const laneIdx = new Map(lanes.map((g, i) => [g.key, i]))

  return (
    <div className="df-seq">
      {lanes.map((g) => (
        <div className="df-lane" key={g.key}>
          <div className="df-ln">
            <span className="df-gm">{g.tpl.method}</span>
            <span className="df-lep">{g.tpl.template}</span>
          </div>
          <div className="df-track">
            <div className="df-call" style={{ left: `${xOf(g)}%` }}>
              <span className="df-st" />
              {g.calls} call{g.calls === 1 ? '' : 's'}
              {g.p50Ms !== undefined && <span className="df-dur"> · {g.p50Ms}ms</span>}
            </div>
          </div>
        </div>
      ))}
      {lineage.length > 0 && (
        <div className="df-seq-hops">
          {lineage.map((l) => {
            const fi = laneIdx.get(l.fromKey)
            const ti = laneIdx.get(l.toKey)
            if (fi === undefined || ti === undefined) return null
            return (
              <div className="df-hop" key={`${l.fromKey}-${l.toKey}-${l.idName}`}>
                <span className="df-hop-lbl">{l.idName} ⊳</span> lane {fi + 1} → {ti + 1}
              </div>
            )
          })}
        </div>
      )}
      <div className="df-taxis">
        <span>0 ms</span>
        <span>{Math.round(span)} ms →</span>
      </div>
    </div>
  )
}
