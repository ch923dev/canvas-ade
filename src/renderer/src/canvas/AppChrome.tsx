/**
 * App chrome (DESIGN.md §8) — floating islands over the canvas, never full-width:
 * top-left project switcher, top-right camera cluster, bottom-center board dock.
 * All sit on `--surface-raised` with the popover shadow. Camera controls drive
 * React Flow via `useReactFlow`; the dock adds store boards centered in view.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import { useCanvasStore, type RecentProject } from '../store/canvasStore'
import { disposeLiveResources } from '../store/disposeLiveResources'
import type { BoardType } from '../lib/boardSchema'
import { cameraAnim } from '../lib/motion'
import { Icon, type IconName } from './Icon'
import { TypeGlyph } from './TypeGlyph'

/** Padding used by fit / overview framing (overview leaves more margin). All three
 *  are wrapped in `cameraAnim` at the callsite for the §9 200ms tween (reduced-motion safe). */
const FIT = { padding: 0.2, maxZoom: 1 } as const
/** "Reset zoom" (%): recenter on content pinned at 100% so it can't strand boards (#41). */
const RESET = { padding: 0.2, maxZoom: 1, minZoom: 1 } as const
const OVERVIEW = { padding: 0.35 } as const

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

// ── Top-left: project switcher ──────────────────────────────────────────────
// Dropdown: shows the current project name; lets the user open a recent project,
// open a folder, or create one. On switch: flush-save → mark loading (suppress
// autosave) → dispose live native views/PTYs → load the new project.
function ProjectSwitcher(): ReactElement {
  const name = useCanvasStore((s) => s.project.name)
  const count = useCanvasStore((s) => s.boards.length)
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
  const setProjectLoading = useCanvasStore((s) => s.setProjectLoading)
  const toObject = useCanvasStore((s) => s.toObject)
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])

  const toggle = async (): Promise<void> => {
    if (!open) setRecents(await window.api.project.recents())
    setOpen((v) => !v)
  }

  const switchTo = async (load: () => Promise<unknown>): Promise<void> => {
    setOpen(false)
    // 1. Flush the current project to disk before tearing it down.
    await window.api.project.save(toObject())
    // 2. Suppress autosave + dispose native views/PTYs.
    setProjectLoading()
    await disposeLiveResources()
    // 3. Load the new project.
    applyOpenResult((await load()) as Parameters<typeof applyOpenResult>[0])
  }

  const openRecent = (dir: string): Promise<void> => switchTo(() => window.api.project.open(dir))
  const openFolder = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (dir) await switchTo(() => window.api.project.open(dir))
    else setOpen(false)
  }
  const createNew = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (!dir) {
      setOpen(false)
      return
    }
    const pname =
      dir
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() || dir
    await switchTo(() => window.api.project.create(dir, pname, {}))
  }

  return (
    <div style={styles.tl} className="project-switcher">
      <button
        className="project-switcher-trigger"
        style={styles.proj}
        onClick={() => void toggle()}
        title="Switch project"
      >
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="diamond" size={15} />
        </span>
        <span className="t-label" style={{ color: 'var(--text)' }}>
          {name ?? 'canvas-ade'}
        </span>
        <span style={{ color: 'var(--text-3)', display: 'inline-flex' }}>
          <Icon name="chevron" size={13} />
        </span>
      </button>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
        · {count} {count === 1 ? 'board' : 'boards'}
      </span>
      {open && (
        <div className="project-switcher-menu" role="menu">
          {recents.map((r) => (
            <button key={r.path} onClick={() => void openRecent(r.path)} title={r.path}>
              {r.name}
            </button>
          ))}
          <div className="project-switcher-divider" />
          <button onClick={() => void openFolder()}>Open folder…</button>
          <button onClick={() => void createNew()}>Create project…</button>
        </div>
      )}
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
        <ToolBtn name="fit" title="Zoom to fit (1)" onClick={() => void rf.fitView(cameraAnim(FIT))} />
        <span style={styles.divider} />
        <ToolBtn name="minus" title="Zoom out" onClick={() => void rf.zoomOut(cameraAnim({}))} />
        <button style={styles.pct} title="Reset zoom (0)" onClick={() => void rf.fitView(cameraAnim(RESET))}>
          {Math.round(zoom * 100)}%
        </button>
        <ToolBtn name="plus" title="Zoom in" onClick={() => void rf.zoomIn(cameraAnim({}))} />
        <span style={styles.divider} />
        <ToolBtn name="overview" title="Overview" onClick={() => void rf.fitView(cameraAnim(OVERVIEW))} />
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
    padding: '0 10px',
    borderRadius: 8,
    cursor: 'pointer',
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
