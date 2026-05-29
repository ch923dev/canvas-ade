/**
 * App chrome (DESIGN.md §8) — floating islands over the canvas, never full-width:
 * top-left project switcher, top-right camera cluster, bottom-center board dock.
 * All sit on `--surface-raised` with the popover shadow. Camera controls drive
 * React Flow via `useReactFlow`; the dock adds store boards centered in view.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import type { BoardType } from '../lib/boardSchema'
import { Icon, type IconName } from './Icon'
import { TypeGlyph } from './TypeGlyph'

/** Padding used by fit / overview framing (overview leaves more margin). */
const FIT = { padding: 0.2, maxZoom: 1 } as const
/** "Reset zoom" (%): recenter on content pinned at 100% so it can't strand boards (#41). */
const RESET = { padding: 0.2, maxZoom: 1, minZoom: 1 } as const
const OVERVIEW = { padding: 0.35, duration: 240 } as const

export interface AppChromeProps {
  /** Add a board of `type` centered in the current view (shared with EmptyState). */
  onAdd: (type: BoardType) => void
}

export function AppChrome({ onAdd }: AppChromeProps): ReactElement {
  return (
    <>
      <ProjectSwitcher />
      <CameraCluster />
      <Dock onAdd={onAdd} />
    </>
  )
}

// ── Top-left: project switcher (placeholder until multi-project lands) ──────────
// Rendered as a non-interactive label (no onClick, no pointer/chevron affordance)
// so it doesn't present as a dead clickable control (#31). The chevron + click
// menu land with real multi-project support in Phase 3.
function ProjectSwitcher(): ReactElement {
  const count = useCanvasStore((s) => s.boards.length)
  return (
    <div style={styles.tl}>
      <div style={styles.proj}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="diamond" size={15} />
        </span>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>canvas-ade</span>
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
        · {count} {count === 1 ? 'board' : 'boards'}
      </span>
    </div>
  )
}

// ── Top-right: camera cluster ───────────────────────────────────────────────
function CameraCluster(): ReactElement {
  const rf = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  return (
    <div style={styles.tr}>
      <div style={styles.pill}>
        <ToolBtn name="fit" title="Zoom to fit (1)" onClick={() => void rf.fitView(FIT)} />
        <span style={styles.divider} />
        <ToolBtn name="minus" title="Zoom out" onClick={() => void rf.zoomOut()} />
        <button style={styles.pct} title="Reset zoom (0)" onClick={() => void rf.fitView(RESET)}>
          {Math.round(zoom * 100)}%
        </button>
        <ToolBtn name="plus" title="Zoom in" onClick={() => void rf.zoomIn()} />
        <span style={styles.divider} />
        <ToolBtn name="overview" title="Overview" onClick={() => void rf.fitView(OVERVIEW)} />
      </div>
    </div>
  )
}

// ── Bottom-center: board dock ─────────────────────────────────────────────────
function Dock({ onAdd }: AppChromeProps): ReactElement {
  const tool = useCanvasStore((s) => s.tool)
  const setTool = useCanvasStore((s) => s.setTool)
  return (
    <div style={styles.dock}>
      <div style={{ ...styles.pill, padding: 4, gap: 3 }}>
        <ToolBtn
          name="select"
          title="Select"
          big
          active={tool === 'select'}
          onClick={() => setTool('select')}
        />
        <span style={styles.divider} />
        {(['terminal', 'browser', 'planning'] as const).map((type) => (
          <DockBtn key={type} type={type} onClick={() => onAdd(type)} />
        ))}
      </div>
    </div>
  )
}

// ── Small button primitives ───────────────────────────────────────────────────
function ToolBtn({
  name,
  title,
  active = false,
  big = false,
  onClick
}: {
  name: IconName
  title: string
  active?: boolean
  big?: boolean
  onClick: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: big ? 32 : 28,
        height: 28,
        display: 'grid',
        placeItems: 'center',
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        background: active
          ? 'var(--accent-wash)'
          : hover
            ? 'var(--surface-overlay)'
            : 'transparent',
        color: active ? 'var(--accent)' : hover ? 'var(--text)' : 'var(--text-3)',
        transition: 'color .1s, background .1s'
      }}
    >
      <Icon name={name} size={16} />
    </button>
  )
}

function DockBtn({ type, onClick }: { type: BoardType; onClick: () => void }): ReactElement {
  const [hover, setHover] = useState(false)
  const label = type[0].toUpperCase() + type.slice(1)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 32,
        padding: '0 11px 0 9px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        background: hover ? 'var(--surface-overlay)' : 'transparent',
        color: hover ? 'var(--text)' : 'var(--text-2)',
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: 'var(--ui)',
        transition: 'color .1s, background .1s'
      }}
    >
      <span style={{ color: hover ? 'var(--accent)' : 'var(--text-3)', display: 'inline-flex' }}>
        <TypeGlyph type={type} />
      </span>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>+</span>
      {label}
    </button>
  )
}

const styles: Record<string, CSSProperties> = {
  tl: {
    position: 'absolute',
    top: 14,
    left: 16,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    gap: 8
  },
  tr: { position: 'absolute', top: 14, right: 16, zIndex: 50 },
  dock: {
    position: 'absolute',
    bottom: 18,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 50
  },
  proj: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    height: 34,
    padding: '0 11px 0 10px',
    borderRadius: 8,
    cursor: 'default',
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-subtle)',
    boxShadow: 'var(--shadow-pop)'
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    padding: 3,
    borderRadius: 9,
    background: 'var(--surface-raised)',
    border: '1px solid var(--border-subtle)',
    boxShadow: 'var(--shadow-pop)'
  },
  divider: { width: 1, height: 18, background: 'var(--border-subtle)', margin: '0 3px' },
  pct: {
    fontFamily: 'var(--mono)',
    fontSize: 11,
    color: 'var(--text-2)',
    width: 44,
    textAlign: 'center',
    border: 'none',
    background: 'none',
    cursor: 'pointer'
  }
}
