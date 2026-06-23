/**
 * Data-Flow board — presentational graph + sequence renderers (JD-4). Pure view: given a computed
 * layout + focus/diff sets, it draws positioned nodes and an SVG edge layer (the mock-b/c look). Split
 * from `DataFlowBoard.tsx` (the file-size doctrine) so the orchestration + this rendering each stay
 * small. All page-controlled strings are React-escaped text (no innerHTML / dangerouslySetInnerHTML).
 */
import { type ReactElement } from 'react'
import type { DfEdge } from '../../../lib/dataFlowGraph'
import type { GraphDiff } from '../../../lib/dataFlowGraph'
import { edgePath, type GraphLayout, type PositionedNode } from '../../../lib/graphLayout'
import type { TemplateGroup } from '../../../lib/routeTemplate'
import type { LineageEdge } from '../../../lib/lineage'

const EDGE_CLASS: Record<DfEdge['kind'], string> = {
  call: 'df-e-call',
  returns: 'df-e-ret',
  rel: 'df-e-rel',
  lineage: 'df-e-lin'
}

/** The graph layout: an SVG edge layer under absolutely-positioned node cards (focus-dimmed + diffed). */
export function GraphCanvas({
  layout,
  edges,
  bright,
  diff,
  focusId,
  onFocus
}: {
  layout: GraphLayout
  edges: DfEdge[]
  bright: Set<string>
  diff: GraphDiff
  focusId: string | undefined
  onFocus: (id: string) => void
}): ReactElement {
  return (
    <div className="df-canvas" style={{ width: layout.width, height: layout.height }}>
      <svg className="df-edges" width={layout.width} height={layout.height} aria-hidden>
        {edges.map((e) => {
          const a = layout.byId.get(e.from)
          const b = layout.byId.get(e.to)
          if (!a || !b) return null
          const lit = bright.has(e.from) && bright.has(e.to)
          return (
            <g key={e.id} className={EDGE_CLASS[e.kind] + (lit ? '' : ' df-dim')}>
              <path d={edgePath(a, b)} fill="none" />
              {e.kind === 'lineage' && e.label && (
                <text x={(a.x + a.w + b.x) / 2} y={Math.min(a.y, b.y) + 6} className="df-elabel">
                  {e.label} ⊳
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {layout.nodes.map((n) => (
        <GraphNode
          key={n.id}
          node={n}
          dim={!bright.has(n.id)}
          focused={n.id === focusId}
          added={diff.added.has(n.id)}
          changed={diff.changed.has(n.id)}
          onClick={() => onFocus(n.id)}
        />
      ))}
    </div>
  )
}

function GraphNode({
  node,
  dim,
  focused,
  added,
  changed,
  onClick
}: {
  node: PositionedNode
  dim: boolean
  focused: boolean
  added: boolean
  changed: boolean
  onClick: () => void
}): ReactElement {
  const cls =
    `df-gn df-gn-${node.kind}` +
    (focused ? ' df-focused' : '') +
    (dim ? ' df-dim' : '') +
    (added ? ' df-added' : '') +
    (changed && !added ? ' df-changed' : '')
  return (
    <div
      className={cls}
      style={{ left: node.x, top: node.y, width: node.w }}
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      <div className="df-gh">
        {node.method && <span className="df-gm">{node.method}</span>}
        {node.kind === 'page' && <span className="df-gm">PAGE</span>}
        {node.kind === 'entity' && <span className="df-gm">ENTITY</span>}
        {node.kind === 'shape' && <span className="df-gm">SHAPE</span>}
        <span className="df-gep">{node.label}</span>
        {node.sub && <span className="df-gmeta">{node.sub}</span>}
        {added && <span className="df-chip df-chip-add">new</span>}
        {changed && !added && <span className="df-chip df-chip-chg">changed</span>}
      </div>
      {node.fields && node.fields.length > 0 && (
        <div className="df-gb">
          {node.fields.map((f) => (
            <div className="df-gf" key={f.key}>
              <span className="df-gk">{f.key}</span>
              <span className={'df-gty' + (f.idLike ? ' df-id' : '')}>{f.type}</span>
            </div>
          ))}
          {node.moreFields ? <div className="df-gmore">+{node.moreFields} more</div> : null}
        </div>
      )}
    </div>
  )
}

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
