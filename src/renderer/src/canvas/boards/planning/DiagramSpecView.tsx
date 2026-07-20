/**
 * Static DiagramSpec renderer — the `engine:'expanse'` view inside DiagramCard: an SVG facing-edge
 * layer under absolutely-positioned token-styled divs (the DataFlowGraphView pattern), laid out by
 * ELK off-thread and fit-scaled into the card box. Since Phase 2 the LAYOUT lives in DiagramCard
 * (useSpecLayout) and arrives as a prop, so the card can hit-test focus clicks and memo revisions;
 * this module stays presentational.
 *
 * Security contract (REVIEW §1.6): every spec string lands as a React TEXT NODE — no innerHTML,
 * no markup interpolation anywhere. Interaction contract: the whole view is `pointer-events: none`
 * (exactly like the mermaid `<img>`), so card-level select/drag/resize/zoom behave identically
 * across engines and no focusable element enters the planning well (the #363 keystroke class).
 *
 * Motion (Phase 2, per the approved phase2-design mock): entrance stagger (240ms/40ms), the
 * animated-edge dash march (0.9s, Phase-0 parity — the static `'6 5'` dash ATTRIBUTE is unchanged,
 * the march is a CSS animation on top), and a one-shot status-flip pulse (620ms). All of it is
 * gated by the composed `motion` prop (prefers-reduced-motion ∧ app setting) via the
 * `pl-motion-off` class — plus a `prefers-reduced-motion` stylesheet backstop. Keyframes live in
 * `styles/boards/planning.css` (§ DiagramSpec motion). Per-node `icon`/`href` stay unrendered
 * (Phase 4 surfaces).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { DiagramSpec, SpecNode, SpecStatus } from '../../../lib/diagramSpec'
import {
  specEdgeLabelPoint,
  specEdgePath,
  type PositionedSpecNode,
  type SpecLayoutResult
} from './specLayout'
import {
  SPEC_KIND_PATHS,
  specEdgeStyle,
  specGroupStyle,
  specKindSilhouette,
  specStatusStyle,
  type SpecSilhouette,
  type SpecStatusStyle
} from './specTheme'

/** Decision silhouette: clipped corners (the approved mock's calm octagon). */
const DECISION_CLIP =
  'polygon(9px 0, calc(100% - 9px) 0, 100% 9px, 100% calc(100% - 9px), ' +
  'calc(100% - 9px) 100%, 9px 100%, 0 calc(100% - 9px), 0 9px)'

/** Status-flip pulse duration — MUST match the pl-spec-pulse keyframe (planning.css). */
const PULSE_MS = 620

/** Exit-ghost fade duration — MUST match the pl-spec-exit keyframe (planning.css). */
const EXIT_MS = 160

/** One-shot pulse bookkeeping: node id → generation (bumps re-trigger via the React key). */
type PulseMap = ReadonlyMap<string, number>

/** A node removed by a spec edit, kept for one EXIT_MS fade at its last layout box. Rendered
 *  under `pl-spec-node-exit` — deliberately NOT `pl-spec-node`, so live-node selectors (and the
 *  e2e `.pl-spec-node` count pins) never see ghosts. */
interface GhostNode {
  key: string
  node: SpecNode
  box: PositionedSpecNode
}

/** Box + silhouette + status → the node div's inline style (shared by live nodes and ghosts). */
function specNodeStyle(
  box: PositionedSpecNode,
  sil: SpecSilhouette,
  status: SpecStatusStyle
): CSSProperties {
  const style: CSSProperties = {
    position: 'absolute',
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    boxSizing: 'border-box',
    background: sil === 'note' ? 'var(--surface)' : status.fill,
    border: `1px ${sil === 'note' ? 'dashed' : 'solid'} ${status.border}`,
    borderRadius: sil === 'actor' ? 'var(--r-pill)' : 'var(--r-inner)',
    opacity: status.opacity,
    padding: sil === 'actor' ? '7px 9px 7px 12px' : '7px 9px 7px 8px'
  }
  if (sil === 'decision') {
    style.clipPath = DECISION_CLIP
    style.borderRadius = 0
  }
  return style
}

/** Node interior (kind mark + label + glyph + detail) — shared by live nodes and exit ghosts. */
function specNodeBody(n: SpecNode, sil: SpecSilhouette, status: SpecStatusStyle): ReactElement {
  const paths = SPEC_KIND_PATHS[n.kind ?? 'step']
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 16 }}>
        {paths.length > 0 && (
          <svg
            viewBox="0 0 24 24"
            style={{
              flex: 'none',
              width: 13,
              height: 13,
              stroke: 'var(--text-3)',
              strokeWidth: 1.5,
              fill: 'none',
              strokeLinecap: 'round',
              strokeLinejoin: 'round'
            }}
            aria-hidden
          >
            {paths.map((d) => (
              <path key={d} d={d} />
            ))}
          </svg>
        )}
        <span
          style={{
            font: sil === 'note' ? '400 11px/15px var(--ui)' : '500 12px/16px var(--ui)',
            color: sil === 'note' ? 'var(--text-2)' : 'var(--text)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {n.label}
        </span>
        {status.glyph && (
          <span
            className="pl-spec-glyph"
            style={{
              flex: 'none',
              font: '600 10px/14px var(--mono)',
              width: 14,
              height: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: status.glyphColor
            }}
          >
            {status.glyph}
          </span>
        )}
      </div>
      {n.detail && (
        <div
          style={{
            font: '450 10px/14px var(--mono)',
            color: 'var(--text-3)',
            margin: '3px 0 0 19px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {n.detail}
        </div>
      )}
    </>
  )
}

/** Geometry equality between two layouts — a status-only spec edit relayouts to identical boxes,
 *  and must NOT re-fade edges or spawn ghosts (the morph is for real position changes). */
function sameGeometry(a: SpecLayoutResult, b: SpecLayoutResult): boolean {
  if (a.width !== b.width || a.height !== b.height || a.nodes.length !== b.nodes.length)
    return false
  return b.nodes.every((n) => {
    const p = a.byId.get(n.id)
    return p !== undefined && p.x === n.x && p.y === n.y && p.w === n.w && p.h === n.h
  })
}

export function DiagramSpecView({
  spec,
  w,
  h,
  motion,
  layout,
  error
}: {
  spec: DiagramSpec
  /** Available card box (board-local px; header already subtracted by the caller). */
  w: number
  h: number
  /** Composed motion gate: prefers-reduced-motion ∧ the app setting. False ⇒ fully static. */
  motion: boolean
  /** Positioned layout from the card's useSpecLayout (null while the first layout resolves). */
  layout: SpecLayoutResult | null
  error: string | null
}): ReactElement {
  // ── Status-flip pulse: diff statuses per node id across spec changes; a changed id gets a
  // generation bump (React key remount restarts the one-shot animation) and is dropped again
  // after the keyframe ends. Timers are fire-and-forget per batch (each deletes only its own
  // generation, so a rapid re-flip is never clipped by an older timer) and cleared on unmount.
  const [pulses, setPulses] = useState<PulseMap>(new Map())
  const prevStatusRef = useRef<Map<string, SpecStatus> | null>(null)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  useEffect(() => {
    const next = new Map(spec.nodes.map((n) => [n.id, n.status ?? ('neutral' as SpecStatus)]))
    const prev = prevStatusRef.current
    prevStatusRef.current = next
    if (!prev || !motion) return
    const changed = spec.nodes.filter((n) => {
      const p = prev.get(n.id)
      return p !== undefined && p !== (n.status ?? 'neutral')
    })
    if (changed.length === 0) return
    const batch: [string, number][] = []
    setPulses((m) => {
      const c = new Map(m)
      for (const n of changed) {
        const gen = (c.get(n.id) ?? 0) + 1
        c.set(n.id, gen)
        batch.push([n.id, gen])
      }
      return c
    })
    const t = setTimeout(() => {
      timersRef.current.delete(t)
      setPulses((m) => {
        const c = new Map(m)
        for (const [nid, gen] of batch) if (c.get(nid) === gen) c.delete(nid)
        return c
      })
    }, PULSE_MS + 80)
    timersRef.current.add(t)
  }, [spec, motion])
  // ── Layout morph (M2): when a spec edit moves geometry, live nodes/groups glide there via the
  // CSS left/top/width/height transitions (planning.css § DiagramSpec motion); removed nodes
  // linger one EXIT_MS fade as ghosts at their last box; edges re-fade against the new geometry
  // via a generation key (an SVG path `d` cannot transition). Status-only edits relayout to
  // identical boxes and skip all of it — sameGeometry gates the whole block.
  const [ghosts, setGhosts] = useState<GhostNode[]>([])
  const [layoutGen, setLayoutGen] = useState(0)
  const genRef = useRef(0)
  const prevLayoutRef = useRef<{ spec: DiagramSpec; layout: SpecLayoutResult } | null>(null)
  useEffect(() => {
    if (!layout) return
    const prev = prevLayoutRef.current
    if (prev?.layout === layout) return // spec flipped, new layout still resolving — hold the diff
    prevLayoutRef.current = { spec, layout }
    if (!prev || !motion || sameGeometry(prev.layout, layout)) return
    genRef.current += 1
    setLayoutGen(genRef.current)
    const gone: GhostNode[] = prev.spec.nodes.flatMap((n) => {
      if (spec.nodes.some((m) => m.id === n.id)) return []
      const box = prev.layout.byId.get(n.id)
      return box ? [{ key: `${n.id}#x${genRef.current}`, node: n, box }] : []
    })
    if (gone.length === 0) return
    setGhosts((g) => [...g, ...gone])
    const t = setTimeout(() => {
      timersRef.current.delete(t)
      setGhosts((g) => g.filter((x) => !gone.some((d) => d.key === x.key)))
    }, EXIT_MS + 40)
    timersRef.current.add(t)
  }, [layout, spec, motion])
  useEffect(
    () => () => {
      for (const t of timersRef.current) clearTimeout(t)
    },
    []
  )

  if (error || !layout) {
    return (
      <div
        className="pl-spec-state"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 12,
          boxSizing: 'border-box',
          color: error ? 'var(--text-3)' : 'var(--text-faint)',
          fontFamily: 'var(--ui)',
          fontSize: 11,
          pointerEvents: 'none'
        }}
      >
        {error ? `diagram error: ${error}` : 'laying out…'}
      </div>
    )
  }

  // Fit the content extent into the card box (contain, like the mermaid <img>'s object-fit).
  const scale = Math.min(w / layout.width, h / layout.height)
  return (
    <div
      className={`pl-specview ${motion ? 'pl-motion-on' : 'pl-motion-off'}`}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        pointerEvents: 'none'
      }}
    >
      <div
        className="pl-spec-enter"
        style={{
          position: 'relative',
          width: layout.width,
          height: layout.height,
          flex: 'none',
          transform: `scale(${scale})`,
          transformOrigin: 'center center'
        }}
      >
        {layout.groups.map((g, gi) => {
          const sg = spec.groups?.find((s) => s.id === g.id)
          const chrome = specGroupStyle(sg?.status)
          return (
            <div
              key={`g-${g.id}`}
              className="pl-spec-group"
              style={
                {
                  position: 'absolute',
                  left: g.x,
                  top: g.y,
                  width: g.w,
                  height: g.h,
                  border: `1px dashed ${chrome.border}`,
                  borderRadius: 'var(--r-board)',
                  background: chrome.background,
                  '--i': gi
                } as CSSProperties
              }
            >
              <span
                style={{
                  position: 'absolute',
                  top: -8,
                  left: 10,
                  padding: '0 6px',
                  background: 'var(--surface)',
                  font: '500 10px var(--ui)',
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: chrome.label
                }}
              >
                {sg?.label ?? ''}
              </span>
            </div>
          )
        })}

        <svg
          className="pl-spec-edges"
          width={layout.width}
          height={layout.height}
          style={{ position: 'absolute', inset: 0 }}
          aria-hidden
        >
          <defs>
            <marker
              id="pl-spec-ah"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="var(--border-strong)" />
            </marker>
            <marker
              id="pl-spec-ah-accent"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0 L8 4 L0 8 z" fill="var(--accent)" />
            </marker>
          </defs>
          {spec.edges.map((e, ei) => {
            const a = layout.byId.get(e.from)
            const b = layout.byId.get(e.to)
            if (!a || !b) return null
            const style = specEdgeStyle(e)
            const mid = specEdgeLabelPoint(a, b, spec.direction)
            return (
              <g
                key={`${e.id}#l${layoutGen}`}
                className="pl-spec-edge"
                style={{ '--i': ei } as CSSProperties}
              >
                <path
                  className={style.animated ? 'pl-spec-march' : undefined}
                  d={specEdgePath(a, b, spec.direction)}
                  fill="none"
                  stroke={style.stroke}
                  strokeWidth={1.5}
                  strokeDasharray={style.dasharray || undefined}
                  markerEnd={style.animated ? 'url(#pl-spec-ah-accent)' : 'url(#pl-spec-ah)'}
                />
                {e.label && (
                  <text
                    x={mid.x}
                    y={mid.y - 5}
                    textAnchor="middle"
                    style={{ font: '450 10px var(--mono)', fill: 'var(--text-3)' }}
                  >
                    {e.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {spec.nodes.map((n, ni) => {
          const box = layout.byId.get(n.id)
          if (!box) return null
          const status = specStatusStyle(n.status)
          const sil = specKindSilhouette(n.kind)
          const pulseGen = pulses.get(n.id)
          const nodeStyle = {
            ...specNodeStyle(box, sil, status),
            '--i': ni,
            '--pl-pulse-hue': status.glyphColor
          } as CSSProperties
          return (
            <div
              key={pulseGen ? `${n.id}#p${pulseGen}` : n.id}
              className={`pl-spec-node pl-spec-${sil}${pulseGen ? ' pl-spec-pulse' : ''}`}
              style={nodeStyle}
            >
              {specNodeBody(n, sil, status)}
            </div>
          )
        })}

        {ghosts.map((g) => {
          const status = specStatusStyle(g.node.status)
          const sil = specKindSilhouette(g.node.kind)
          return (
            <div
              key={g.key}
              className={`pl-spec-node-exit pl-spec-${sil}`}
              style={specNodeStyle(g.box, sil, status)}
            >
              {specNodeBody(g.node, sil, status)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
