/**
 * App chrome (DESIGN.md §8) — floating islands over the canvas, never full-width:
 * top-left project switcher, top-right camera cluster, bottom-center board dock.
 * All sit on `--surface-raised` with the popover shadow. Camera controls drive
 * React Flow via `useReactFlow`; the dock adds store boards centered in view.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import { useReactFlow, useStore } from '@xyflow/react'
import { useCanvasStore, type RecentProject } from '../store/canvasStore'
import { usePreviewStore } from '../store/previewStore'
import { disposeLiveResources } from '../store/disposeLiveResources'
import type { BoardType } from '../lib/boardSchema'
import { LAYOUT_PRESETS, type LayoutPreset } from '../lib/layoutPresets'
import { FIT_FRAME, OVERVIEW_FRAME, RESET_FRAME } from '../lib/canvasView'
import { cameraAnim } from '../lib/motion'
import { Icon, type IconName } from './Icon'
import { TypeGlyph } from './TypeGlyph'

export interface AppChromeProps {
  /** Add a board of `type` centered in the current view (shared with EmptyState). */
  onAdd: (type: BoardType) => void
  /** Apply a layout preset, then fit — the camera-cluster Tidy picker (Smart / tiling
   *  templates) and the `t` key (Smart). */
  onTidy: (preset: LayoutPreset) => void
}

export function AppChrome({ onAdd, onTidy }: AppChromeProps): ReactElement {
  return (
    <>
      <ProjectSwitcher />
      <CameraCluster onTidy={onTidy} />
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
function CameraCluster({ onTidy }: { onTidy: (preset: LayoutPreset) => void }): ReactElement {
  const rf = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  return (
    <div style={styles.tr}>
      <div style={styles.pill}>
        <ToolBtn name="fit" title="Zoom to fit (1)" onClick={() => void rf.fitView(cameraAnim(FIT_FRAME))} />
        <span style={styles.divider} />
        <ToolBtn name="minus" title="Zoom out" onClick={() => void rf.zoomOut(cameraAnim({}))} />
        <button style={styles.pct} title="Reset zoom (0)" onClick={() => void rf.fitView(cameraAnim(RESET_FRAME))}>
          {Math.round(zoom * 100)}%
        </button>
        <ToolBtn name="plus" title="Zoom in" onClick={() => void rf.zoomIn(cameraAnim({}))} />
        <span style={styles.divider} />
        <ToolBtn name="overview" title="Overview" onClick={() => void rf.fitView(cameraAnim(OVERVIEW_FRAME))} />
        {/* Auto-tidy: a FancyZones-style picker of layout presets (Smart link-aware + tiling
            templates) that arranges the boards then fits. Keyboard `t` = Smart. See
            Canvas.tidyAndFit. */}
        <TidyMenu onTidy={onTidy} />
      </div>
    </div>
  )
}

// A single preset thumbnail — draws the preset's fractional `zones` as mini rounded rects,
// so the picker reads like a FancyZones template grid. Zones go accent on hover (CSS).
function PresetThumb({ preset }: { preset: LayoutPreset }): ReactElement {
  return (
    <div
      style={{
        position: 'relative',
        width: 66,
        height: 42,
        borderRadius: 5,
        background: 'var(--inset)',
        border: '1px solid var(--border-subtle)',
        overflow: 'hidden'
      }}
    >
      {preset.zones.map((z, i) => (
        <div
          key={i}
          className="ca-zone"
          style={{
            position: 'absolute',
            left: `${z.x * 100}%`,
            top: `${z.y * 100}%`,
            width: `${z.w * 100}%`,
            height: `${z.h * 100}%`,
            borderRadius: 2,
            background: 'var(--text-3)',
            transition: 'background .1s'
          }}
        />
      ))}
    </div>
  )
}

// The Tidy preset PICKER (FancyZones-style). Mirrors the board ⋯ menu plumbing: portaled to
// <body>, signals the preview layer to detach live native views while open (a WebContentsView
// paints above all HTML, so it would otherwise cover this popover — ADR 0002), clamps into the
// viewport, closes on outside pointerdown / Escape. Each thumbnail applies its preset.
// KNOWN (matches the board ⋯ menu, BoardFrame.tsx): setMenuOpen runs in an effect + the detach
// IPC is async, so a live Browser view overlapping this popover can occlude it for a few frames
// before detaching. Accepted limitation of the menu-detach pattern; a fix would need sync IPC
// across BrowserPreviewLayer too. The camera cluster is top-right, where live views rarely sit.
function TidyMenu({ onTidy }: { onTidy: (preset: LayoutPreset) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  // Detach live previews while the picker is open (un-occlude it), like the board menu.
  useEffect(() => {
    setMenuOpen(open)
    if (open) return () => setMenuOpen(false)
  }, [open, setMenuOpen])

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Right-align the picker under the trigger, clamped into the viewport.
  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current?.getBoundingClientRect()
    const m = menuRef.current?.getBoundingClientRect()
    if (!t || !m) return
    const PAD = 8
    const left = Math.max(PAD, Math.min(t.right - m.width, window.innerWidth - m.width - PAD))
    setPos({ top: t.bottom + 6, left })
  }, [open])

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ToolBtn name="grid" title="Tidy layout (T)" active={open} onClick={() => setOpen((v) => !v)} />
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ ...styles.tidyPop, top: pos.top, left: pos.left }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div style={styles.tidyHead}>Tidy layout</div>
            <div style={styles.tidyGrid}>
              {LAYOUT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="ca-tidy-preset"
                  role="menuitem"
                  title={p.hint}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setOpen(false)
                    onTidy(p)
                  }}
                >
                  <PresetThumb preset={p} />
                  <span style={styles.tidyLabel}>{p.label}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

// ── Bottom-center: board dock ─────────────────────────────────────────────────
function Dock({ onAdd }: { onAdd: (type: BoardType) => void }): ReactElement {
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
  },
  tidyPop: {
    position: 'fixed',
    zIndex: 250, // above the fullview-scrim (200), matching .board-menu
    background: 'var(--surface-overlay)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--r-ctl)',
    boxShadow: 'var(--shadow-pop)',
    padding: 8,
    width: 248
  },
  tidyHead: {
    fontSize: 11,
    color: 'var(--text-3)',
    fontWeight: 600,
    letterSpacing: '0.02em',
    padding: '0 2px 6px'
  },
  tidyGrid: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  tidyLabel: { fontSize: 10.5, lineHeight: '12px', textAlign: 'center' }
}
