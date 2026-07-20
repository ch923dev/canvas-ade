/**
 * Static DiagramSpec renderer (Phase 1, render-only) — the `engine:'expanse'` view inside
 * DiagramCard: an SVG facing-edge layer under absolutely-positioned token-styled divs (the
 * DataFlowGraphView pattern), laid out by ELK off-thread and fit-scaled into the card box.
 *
 * Security contract (REVIEW §1.6): every spec string lands as a React TEXT NODE — no innerHTML,
 * no markup interpolation anywhere. Interaction contract: the whole view is `pointer-events: none`
 * (exactly like the mermaid `<img>`), so card-level select/drag/resize/zoom behave identically
 * across engines and no focusable element enters the planning well (the #363 keystroke class).
 *
 * Phase boundaries: `animated` edges render as a STATIC accent dash (the march + entrance motion
 * is Phase 2); `collapsed` groups and per-node `icon`/`href` are persisted but not yet rendered
 * (Phase 2/4 surfaces).
 */
import { type CSSProperties, type ReactElement } from 'react'
import type { DiagramSpec } from '../../../lib/diagramSpec'
import { specEdgeLabelPoint, specEdgePath } from './specLayout'
import { SPEC_KIND_PATHS, specEdgeStyle, specKindSilhouette, specStatusStyle } from './specTheme'
import { useSpecLayout } from './useSpecLayout'

/** Decision silhouette: clipped corners (the approved mock's calm octagon). */
const DECISION_CLIP =
  'polygon(9px 0, calc(100% - 9px) 0, 100% 9px, 100% calc(100% - 9px), ' +
  'calc(100% - 9px) 100%, 9px 100%, 0 calc(100% - 9px), 0 9px)'

export function DiagramSpecView({
  spec,
  w,
  h
}: {
  spec: DiagramSpec
  /** Available card box (board-local px; header already subtracted by the caller). */
  w: number
  h: number
}): ReactElement {
  const { layout, error } = useSpecLayout(spec)

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
      className="pl-specview"
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
        style={{
          position: 'relative',
          width: layout.width,
          height: layout.height,
          flex: 'none',
          transform: `scale(${scale})`,
          transformOrigin: 'center center'
        }}
      >
        {layout.groups.map((g) => {
          const label = spec.groups?.find((s) => s.id === g.id)?.label ?? ''
          return (
            <div
              key={`g-${g.id}`}
              className="pl-spec-group"
              style={{
                position: 'absolute',
                left: g.x,
                top: g.y,
                width: g.w,
                height: g.h,
                border: '1px dashed var(--border-strong)',
                borderRadius: 'var(--r-board)',
                background: 'rgba(255,255,255,0.015)'
              }}
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
                  color: 'var(--text-3)'
                }}
              >
                {label}
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
          {spec.edges.map((e) => {
            const a = layout.byId.get(e.from)
            const b = layout.byId.get(e.to)
            if (!a || !b) return null
            const style = specEdgeStyle(e)
            const mid = specEdgeLabelPoint(a, b, spec.direction)
            return (
              <g key={e.id} className="pl-spec-edge">
                <path
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

        {spec.nodes.map((n) => {
          const box = layout.byId.get(n.id)
          if (!box) return null
          const status = specStatusStyle(n.status)
          const sil = specKindSilhouette(n.kind)
          const paths = SPEC_KIND_PATHS[n.kind ?? 'step']
          const nodeStyle: CSSProperties = {
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
            nodeStyle.clipPath = DECISION_CLIP
            nodeStyle.borderRadius = 0
          }
          return (
            <div key={n.id} className={`pl-spec-node pl-spec-${sil}`} style={nodeStyle}>
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
