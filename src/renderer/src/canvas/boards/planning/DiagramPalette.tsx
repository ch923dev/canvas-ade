/**
 * Focus-mode palette (diagram Phase 4) — the floating rail overlaying the editor pane. Offers the
 * CLOSED vocabulary only: node kind (shape), status (the one palette), and an optional host-registry
 * icon. No freeform colours/shapes (the calm contract). Clicking a kind adds a node of that kind with
 * the currently-selected status + icon; the editor places it and commits an `upsertNode` (MAIN cap
 * parity — a palette drop is the same op an agent's write takes).
 */
import { useState, type ReactElement } from 'react'
import {
  SPEC_NODE_KINDS,
  SPEC_STATUSES,
  type SpecNodeKind,
  type SpecStatus
} from '../../../lib/diagramSpec'
import { Icon, type IconName } from '../../Icon'
import { SPEC_ICON_NAMES, SPEC_KIND_PATHS, SPEC_STATUS_GLYPHS, specStatusStyle } from './specTheme'

const KIND_LABEL: Record<SpecNodeKind, string> = {
  step: 'step',
  decision: 'decision',
  data: 'data',
  service: 'service',
  artifact: 'artifact',
  actor: 'actor',
  note: 'note'
}

export interface DiagramPaletteProps {
  onAddNode: (opts: { kind: SpecNodeKind; status: SpecStatus; icon?: string }) => void
}

export function DiagramPalette({ onAddNode }: DiagramPaletteProps): ReactElement {
  const [status, setStatus] = useState<SpecStatus>('neutral')
  const [icon, setIcon] = useState<IconName | null>(null)

  return (
    <div
      className="pl-editor-palette nodrag nowheel nopan"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: 10,
        top: 10,
        zIndex: 4,
        width: 172,
        padding: 8,
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-board)',
        boxShadow: 'var(--shadow-pop)'
      }}
    >
      <div style={SECTION_LABEL}>Add node</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
        {SPEC_NODE_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            title={KIND_LABEL[k]}
            onClick={() => onAddNode({ kind: k, status, icon: icon ?? undefined })}
            style={swatchStyle(false)}
          >
            <svg
              viewBox="0 0 24 24"
              width={15}
              height={15}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              {(SPEC_KIND_PATHS[k].length ? SPEC_KIND_PATHS[k] : ['M4 5h16v14H4z']).map((d) => (
                <path key={d} d={d} strokeDasharray={k === 'note' ? '2.4 2.2' : undefined} />
              ))}
            </svg>
          </button>
        ))}
      </div>

      <div style={DIVIDER} />
      <div style={SECTION_LABEL}>Status</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
        {SPEC_STATUSES.map((s) => {
          const st = specStatusStyle(s)
          const sel = s === status
          return (
            <button
              key={s}
              type="button"
              title={s}
              onClick={() => setStatus(s)}
              style={{ ...swatchStyle(sel), color: st.glyphColor }}
            >
              {SPEC_STATUS_GLYPHS[s] || '–'}
            </button>
          )
        })}
      </div>

      <div style={DIVIDER} />
      <div style={SECTION_LABEL}>Icon</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 4 }}>
        <button
          type="button"
          title="No icon (use the kind glyph)"
          onClick={() => setIcon(null)}
          style={{ ...swatchStyle(icon === null), color: 'var(--text-3)', fontSize: 11 }}
        >
          ∅
        </button>
        {SPEC_ICON_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            title={name}
            onClick={() => setIcon((cur) => (cur === name ? null : name))}
            style={{ ...swatchStyle(icon === name), color: 'var(--text-2)' }}
          >
            <Icon name={name} size={14} />
          </button>
        ))}
      </div>
    </div>
  )
}

const SECTION_LABEL: React.CSSProperties = {
  font: '500 10px/14px var(--ui)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  margin: '2px 2px 7px'
}
const DIVIDER: React.CSSProperties = {
  height: 1,
  background: 'var(--border-subtle)',
  margin: '9px 0'
}
function swatchStyle(selected: boolean): React.CSSProperties {
  return {
    all: 'unset',
    boxSizing: 'border-box',
    aspectRatio: '1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    background: selected ? 'var(--accent-wash)' : 'var(--surface-raised)',
    border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 'var(--r-ctl)',
    color: selected ? 'var(--text)' : 'var(--text-2)'
  }
}
