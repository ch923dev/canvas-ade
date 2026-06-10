/**
 * App chrome (DESIGN.md §8) — floating islands over the canvas, never full-width:
 * top-left project switcher, top-right camera cluster, bottom-center board dock.
 * All sit on `--surface-raised` with the popover shadow. Camera controls drive
 * React Flow via `useReactFlow`; the dock adds store boards centered in view.
 */
import {
  useEffect,
  useId,
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
import { useSaveStatusStore } from '../store/saveStatusStore'
import { disposeLiveResources } from '../store/disposeLiveResources'
import { cancelActiveAutosave } from '../store/useAutosave'
import type { BoardType } from '../lib/boardSchema'
import { LAYOUT_PRESETS, type LayoutPreset } from '../lib/layoutPresets'
import { FIT_FRAME, OVERVIEW_FRAME, RESET_FRAME } from '../lib/canvasView'
import { cameraAnim } from '../lib/motion'
import { Icon, type IconName } from './Icon'
import { TypeGlyph } from './TypeGlyph'
import { SettingsModal } from './SettingsModal'
import { RecapConsentModal } from './RecapConsentModal'

export interface AppChromeProps {
  /** Apply a layout preset, then fit — the camera-cluster Tidy picker (Smart / tiling
   *  templates) and the `t` key (Smart). */
  onTidy: (preset: LayoutPreset) => void
  /** Grouped focus (camera-cluster focus button + the `f` key): fit the sole group directly or
   *  open the which-group picker. The Canvas owns the picker/fit; this is just the trigger. */
  onFocusGroup: () => void
}

export function AppChrome({ onTidy, onFocusGroup }: AppChromeProps): ReactElement {
  const [showSettings, setShowSettings] = useState(false)
  const [askRecap, setAskRecap] = useState(false)
  // Re-run whenever the user switches to a different project (project.dir changes).
  // Each project persists its own consent answer; an undecided project prompts once.
  const projectDir = useCanvasStore((s) => s.project.dir)
  useEffect(() => {
    let cancelled = false
    // Optional-chain the whole surface (matches App.tsx's window.api?.recap?.… guard): the api
    // bridge can be absent in smoke/test renders, and an unguarded access would throw on mount.
    void window.api?.recap
      ?.getConsent?.()
      ?.then((s) => {
        // Drive the prompt off the NEW project's decision in BOTH directions: open it when the
        // project is undecided, and CLOSE a prompt left over from a previous project when the
        // new one is already decided (or no project is open → getConsent returns 'declined').
        // Setting only `true` here let the modal leak across a project switch — a fixed-position
        // scrim then occluded the canvas for the next project (and, in e2e, every later spec).
        if (!cancelled) setAskRecap(s === 'undecided')
      })
      ?.catch(() => {
        // IPC rejection (channel unavailable, teardown race) — silently skip the prompt.
      })
    return () => {
      cancelled = true
    }
  }, [projectDir])
  return (
    <>
      <ProjectSwitcher />
      <CameraCluster
        onTidy={onTidy}
        onSettings={() => setShowSettings(true)}
        onFocusGroup={onFocusGroup}
      />
      <Dock />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      {/* Guard: MAIN/renderer dir desync can leave askRecap=true with no project open. */}
      {askRecap && projectDir !== null && <RecapConsentModal onClose={() => setAskRecap(false)} />}
    </>
  )
}

// ── Top-left: project switcher ──────────────────────────────────────────────
// Dropdown: shows the current project name; lets the user open a recent project,
// open a folder, or create one. On switch: flush-save → mark loading (suppress
// autosave) → dispose live native views/PTYs → load the new project.
export function ProjectSwitcher(): ReactElement {
  const name = useCanvasStore((s) => s.project.name)
  const count = useCanvasStore((s) => s.boards.length)
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
  const setProjectLoading = useCanvasStore((s) => s.setProjectLoading)
  const toObject = useCanvasStore((s) => s.toObject)
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])
  // D0-7: a project switch in flight (flush → dispose → load). The pill dims + spins so
  // the multi-step teardown never reads as a hang; once status flips to 'loading' this
  // component unmounts and WelcomeScreen carries the loading presentation.
  const [switching, setSwitching] = useState(false)
  // D0-8: the last failed save, surfaced as a visible chip (set by the autosave hook's
  // onError and the flush-failure path below; cleared by the next successful save).
  const saveFailure = useSaveStatusStore((s) => s.failure)
  const setSaveFailure = useSaveStatusStore((s) => s.setSaveFailure)
  const clearSaveFailure = useSaveStatusStore((s) => s.clearSaveFailure)
  const menuRef = useRef<HTMLDivElement>(null)

  // project-switcher-no-outside-close: dismiss the dropdown on an outside pointerdown /
  // Escape / resize, matching BoardMenu and the layout-preset picker below.
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

  const toggle = async (): Promise<void> => {
    if (!open) setRecents(await window.api.project.recents())
    setOpen((v) => !v)
  }

  // D0-4: clamp the dropdown into the viewport (BoardMenu/TidyMenu parity). The menu is
  // CSS-anchored under the pill; a long recents list can run past the bottom edge (cap +
  // scroll) and a long project name past the right edge (pull left).
  useLayoutEffect(() => {
    if (!open) return
    const el = menuRef.current
    if (!el) return
    const PAD = 8
    // Reset before measuring: this effect re-runs while open (recents load), and
    // measuring with a previously-applied shift would compound the offset.
    el.style.left = ''
    el.style.maxHeight = ''
    const r = el.getBoundingClientRect()
    el.style.maxHeight = `${Math.max(80, window.innerHeight - r.top - PAD)}px`
    el.style.overflowY = 'auto'
    if (r.right > window.innerWidth - PAD) {
      el.style.left = `${window.innerWidth - PAD - r.right}px`
    }
  }, [open, recents])

  const switchTo = async (load: () => Promise<unknown>): Promise<void> => {
    setOpen(false)
    // D0-7: dim + spin the pill for the whole pipeline. The finally also covers the
    // post-unmount path (status flips to 'loading' mid-await): React 18 treats setState
    // on an unmounted component as a no-op.
    setSwitching(true)
    try {
      // PERSIST-B: kill any pending debounced autosave armed editing the outgoing project.
      // The explicit flush below is the authoritative final write; a leftover timer would
      // otherwise fire after load flips status back to 'open' (currentDir now the NEW dir)
      // and write the new project's state redundantly.
      cancelActiveAutosave()
      // 1. Flush the current project to disk before tearing it down. project:save returns
      //    false on a write failure; the debounced autosaver is gated off once we flip to
      //    'loading', so a swallowed false here loses the outgoing project's tail edits with
      //    no signal (PERSIST-A / the SAVE-1 silent-loss class). Surface it and abort the
      //    switch so the outgoing project stays open and editable for a retry.
      const saved = await window.api.project.save(toObject())
      if (saved === false) {
        // eslint-disable-next-line no-console
        console.error('project switch: final flush failed; aborting switch to avoid data loss')
        // D0-8: the abort must be VISIBLE — raise the save-failure chip, not console-only.
        setSaveFailure('Project could not be saved — switch cancelled to avoid losing edits')
        return
      }
      // 2. Suppress autosave + dispose native views/PTYs.
      setProjectLoading()
      await disposeLiveResources()
      // 3. Load the new project. applyOpenResult is async (it may retry canvas.json.bak on a
      //    deep-validation failure) — await so the switch completes (or settles error) here.
      //    BUG-006: load() can REJECT — createNew's project:create → MAIN createProject can
      //    throw on a disk error (mkdirSync / writeFileAtomic; project:open's readProject
      //    absorbs its errors, but create does not). Callers `void switchTo`, so an unhandled
      //    rejection here would leave status stuck at 'loading' with all native resources
      //    already disposed: unrecoverable. Route any throw through the existing error path so
      //    the app settles to 'error' (carrying the message) and stays recoverable.
      try {
        await applyOpenResult((await load()) as Parameters<typeof applyOpenResult>[0])
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'failed to load project'
        await applyOpenResult({ ok: false, error: msg })
      }
    } finally {
      setSwitching(false)
    }
  }

  // D0-8: manual retry from the chip. A success clears the chip; a `false` return (the
  // IPC write failed without throwing) refreshes the message so the click visibly
  // registered — otherwise the chip looks dead; a rejection surfaces the latest error.
  const retrySave = async (): Promise<void> => {
    try {
      const ok = await window.api.project.save(toObject())
      if (ok) clearSaveFailure()
      else setSaveFailure('Save failed again — check disk space and permissions')
    } catch (err) {
      setSaveFailure(err instanceof Error ? err.message : 'project save failed')
    }
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
        // D0-7: dim + disable the pill while a switch pipeline runs (flush → dispose → load)
        // so the multi-step teardown never reads as a hang.
        style={switching ? { ...styles.proj, opacity: 0.6, cursor: 'default' } : styles.proj}
        disabled={switching}
        // Stop the trigger's own pointerdown from reaching the document outside-close listener,
        // or re-clicking to close would close-then-reopen (BoardMenu parity).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => void toggle()}
        title="Switch project"
      >
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="diamond" size={15} />
        </span>
        <span className="t-label" style={{ color: 'var(--text)' }}>
          {switching ? 'Loading…' : (name ?? 'canvas-ade')}
        </span>
        <span
          className={switching ? 'ca-spin' : undefined}
          style={{ color: 'var(--text-3)', display: 'inline-flex' }}
        >
          <Icon name={switching ? 'refresh' : 'chevron'} size={13} />
        </span>
      </button>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
        · {count} {count === 1 ? 'board' : 'boards'}
      </span>
      {/* D0-8: visible save-failure chip (SAVE-1 class). A failed save is the one state
          worth announcing assertively — but `alert` is not an allowed role on an
          interactive element (SRs ignore it or double-announce), so the live region is a
          visually-hidden SIBLING and the button stays a plain button. Click = retry;
          cleared by the next successful save. Interim surface; final home = D1 toast. */}
      {saveFailure && (
        <>
          <span role="alert" className="sr-only">
            {saveFailure}
          </span>
          <button
            className="proj-save-chip"
            title={`${saveFailure} — click to retry`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void retrySave()}
          >
            ⚠ Save failed — retry
          </button>
        </>
      )}
      {open && (
        // Inside pointerdowns must not reach the document outside-close listener, so a menu-item
        // click isn't pre-empted by an unmount (BoardMenu parity).
        <div
          ref={menuRef}
          className="project-switcher-menu"
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
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
function CameraCluster({
  onTidy,
  onSettings,
  onFocusGroup
}: {
  onTidy: (preset: LayoutPreset) => void
  onSettings: () => void
  onFocusGroup: () => void
}): ReactElement {
  const rf = useReactFlow()
  const zoom = useStore((s) => s.transform[2])
  return (
    <div style={styles.tr}>
      <div style={styles.pill}>
        <ToolBtn
          name="fit"
          title="Zoom to fit (1)"
          onClick={() => void rf.fitView(cameraAnim(FIT_FRAME))}
        />
        <span style={styles.divider} />
        <ToolBtn name="minus" title="Zoom out" onClick={() => void rf.zoomOut(cameraAnim({}))} />
        <button
          style={styles.pct}
          title="Reset zoom (0)"
          onClick={() => void rf.fitView(cameraAnim(RESET_FRAME))}
        >
          {Math.round(zoom * 100)}%
        </button>
        <ToolBtn name="plus" title="Zoom in" onClick={() => void rf.zoomIn(cameraAnim({}))} />
        <span style={styles.divider} />
        <ToolBtn
          name="overview"
          title="Overview"
          onClick={() => void rf.fitView(cameraAnim(OVERVIEW_FRAME))}
        />
        {/* Focus a group — present only when >=1 group exists (its own divider disappears with it,
            so no double-gap when there are no groups). */}
        <FocusGroupBtn onFocusGroup={onFocusGroup} />
        {/* Auto-tidy: a FancyZones-style picker of layout presets (Smart link-aware + tiling
            templates) that arranges the boards then fits. Keyboard `t` = Smart. See
            Canvas.tidyAndFit. */}
        <TidyMenu onTidy={onTidy} />
        <span style={styles.divider} />
        <ToolBtn name="settings" title="Settings" onClick={onSettings} />
      </div>
    </div>
  )
}

// Focus-a-group button — rendered only when >=1 group exists. Fits the sole group directly, or
// opens the which-group picker, via the Canvas-provided handler. Reuses the `maximize` glyph
// (no dedicated focus icon; fit/overview already sit in this cluster). The leading divider is
// part of this component so it disappears together with the button (no double-gap with no group).
function FocusGroupBtn({ onFocusGroup }: { onFocusGroup: () => void }): ReactElement {
  const groupCount = useCanvasStore((s) => s.groups.length)
  if (groupCount === 0) return <></>
  return (
    <>
      <span style={styles.divider} />
      <ToolBtn name="maximize" title="Focus group (F)" onClick={onFocusGroup} />
    </>
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
  const menuToken = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  // Detach live previews while the picker is open (un-occlude it), like the board menu.
  // Token-keyed so closing this picker can't reattach views under a still-open board ⋯
  // menu, or vice versa (PREV-C).
  useEffect(() => {
    setMenuOpen(menuToken, open)
    if (open) return () => setMenuOpen(menuToken, false)
  }, [open, setMenuOpen, menuToken])

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
      <ToolBtn
        name="grid"
        title="Tidy layout (T)"
        active={open}
        onClick={() => setOpen((v) => !v)}
      />
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

// ── Top-center: board dock ────────────────────────────────────────────────────
// Clicking a board button ARMS that type (sets the store `tool`); the canvas then
// turns a click into a default-size board and a drag into a sized one
// (useBoardPlacement). Select disarms. Exported for the dock arming integration test.
export function Dock(): ReactElement {
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
          <DockBtn key={type} type={type} active={tool === type} onClick={() => setTool(type)} />
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

function DockBtn({
  type,
  active = false,
  onClick
}: {
  type: BoardType
  active?: boolean
  onClick: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  const label = type[0].toUpperCase() + type.slice(1)
  return (
    <button
      // D0-4: the dock was the only chrome cluster without tooltips — explain the
      // arm-then-place model (click arms the tool; the canvas turns a click into a
      // default-size board, a drag into a sized one).
      title={`Add ${label} board — click to place, drag to size`}
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
        background: active
          ? 'var(--accent-wash)'
          : hover
            ? 'var(--surface-overlay)'
            : 'transparent',
        color: active ? 'var(--accent)' : hover ? 'var(--text)' : 'var(--text-2)',
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: 'var(--ui)',
        transition: 'color .1s, background .1s'
      }}
    >
      <span
        style={{
          color: active || hover ? 'var(--accent)' : 'var(--text-3)',
          display: 'inline-flex'
        }}
      >
        <TypeGlyph type={type} />
      </span>
      <span
        style={{
          // D0-2: a readable affordance hint — faint is disabled-only
          color: active || hover ? 'var(--accent)' : 'var(--text-3)',
          fontFamily: 'var(--mono)'
        }}
      >
        +
      </span>
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
    top: 14,
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
