/**
 * Shared spec-node INTERIOR (diagram Phase 4 extraction) — the token-styled node body used by BOTH
 * the static `DiagramSpecView` (absolutely-positioned divs) and the Phase-4 focus-mode `DiagramEditor`
 * (React Flow custom node). Extracting it keeps the two renderers byte-identical (risk R7 — two-engine
 * drift). The node CHROME (bg/border/clip) lives in `specTheme.specNodeChrome`, this file is the JSX.
 *
 * Security contract (REVIEW §1.6): every spec string lands as a React TEXT NODE — no innerHTML.
 */
import type { ReactElement } from 'react'
import type { SpecNode } from '../../../lib/diagramSpec'
import { SPEC_KIND_PATHS, type SpecSilhouette, type SpecStatusStyle } from './specTheme'

/** Node interior (kind mark + label + status glyph + detail) — shared by live nodes, exit ghosts,
 *  and the editor's React Flow node. */
export function SpecNodeBody({
  node,
  sil,
  status
}: {
  node: SpecNode
  sil: SpecSilhouette
  status: SpecStatusStyle
}): ReactElement {
  const paths = SPEC_KIND_PATHS[node.kind ?? 'step']
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
          {node.label}
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
      {node.detail && (
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
          {node.detail}
        </div>
      )}
    </>
  )
}
