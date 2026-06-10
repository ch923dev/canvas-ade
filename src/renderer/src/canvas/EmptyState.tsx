/**
 * Empty-canvas prompt (DESIGN.md §8) — shown when a project has no boards: app
 * mark watermark, heading, one body line, and three dashed ghost buttons mirroring
 * the dock. The dock + top chrome remain visible behind it. Pointer-through except
 * the buttons so the canvas underneath stays pannable.
 */
import type { CSSProperties, ReactElement } from 'react'
import type { BoardType } from '../lib/boardSchema'
import { Icon } from './Icon'
import { TypeGlyph } from './TypeGlyph'

export function EmptyState({ onAdd }: { onAdd: (type: BoardType) => void }): ReactElement {
  return (
    <div style={styles.wrap}>
      <div style={styles.inner}>
        <div style={styles.mark}>
          <Icon name="diamond" size={38} sw={1.2} />
        </div>
        <div className="t-h" style={{ color: 'var(--text)' }}>
          Empty canvas
        </div>
        <div style={styles.body}>
          Drop a board to start — spin up a coding agent, preview your running app, or sketch a
          plan.
        </div>
        <div style={styles.row}>
          {(['terminal', 'browser', 'planning'] as const).map((type) => (
            <button key={type} style={styles.ghost} onClick={() => onAdd(type)}>
              <span style={{ color: 'var(--text-3)', display: 'inline-flex' }}>
                <TypeGlyph type={type} />
              </span>
              {/* D0-2: a readable affordance hint — faint is disabled-only */}
              <span style={{ color: 'var(--text-3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
                +
              </span>
              {type[0].toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  wrap: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    pointerEvents: 'none',
    zIndex: 10
  },
  inner: { textAlign: 'center', pointerEvents: 'auto', marginTop: -40 },
  mark: {
    color: 'var(--text-3)', // D0-2 (A1): watermark must read — faint is disabled-only
    display: 'flex',
    justifyContent: 'center',
    marginBottom: 20,
    opacity: 0.6
  },
  body: {
    fontSize: 13,
    color: 'var(--text-3)',
    marginTop: 7,
    maxWidth: 320,
    lineHeight: 1.5,
    marginLeft: 'auto',
    marginRight: 'auto'
  },
  row: { display: 'flex', gap: 10, justifyContent: 'center', marginTop: 22 },
  ghost: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 14px',
    borderRadius: 8,
    cursor: 'pointer',
    background: 'transparent',
    border: '1px dashed var(--border)',
    color: 'var(--text-2)',
    fontSize: 13,
    fontWeight: 500,
    fontFamily: 'var(--ui)'
  }
}
