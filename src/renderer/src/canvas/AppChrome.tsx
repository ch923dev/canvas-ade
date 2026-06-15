/**
 * App chrome (DESIGN.md §8) — floating islands over the canvas, never full-width:
 * top-left project switcher, top-right camera cluster, bottom-center board dock.
 * All sit on `--surface-raised` with the popover shadow. Camera controls drive
 * React Flow via `useReactFlow`; the dock adds store boards centered in view.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import {
  useCanvasStore,
  acquireProjectSwitchLock,
  releaseProjectSwitchLock,
  type RecentProject
} from '../store/canvasStore'
import { useSaveStatusStore } from '../store/saveStatusStore'
import { showToast, dismissToast } from '../store/toastStore'
import { disposeLiveResources } from '../store/disposeLiveResources'
import { cancelActiveAutosave } from '../store/useAutosave'
import type { BoardType } from '../lib/boardSchema'
import { LAYOUT_PRESETS, type LayoutPreset } from '../lib/layoutPresets'
import { FIT_FRAME, RESET_FRAME } from '../lib/canvasView'
import { cameraAnim } from '../lib/motion'
import { Icon, type IconName } from './Icon'
import { Menu } from './Menu'
import { TypeGlyph } from './TypeGlyph'
import { SettingsModal } from './SettingsModal'
import { BackdropPicker } from './BackdropPicker'
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
  // D0-8→D1-A: the last failed save (set by the autosave hook's onError and the
  // flush-failure path below; cleared by the next successful save), surfaced as a
  // STICKY error toast with a Retry action — the toast bridge effect below.
  const saveFailure = useSaveStatusStore((s) => s.failure)
  const setSaveFailure = useSaveStatusStore((s) => s.setSaveFailure)
  const clearSaveFailure = useSaveStatusStore((s) => s.clearSaveFailure)
  // Anchor for the shared <Menu> shell — the pill button itself, so the dropdown hangs
  // under it (left-aligned) and re-clicking the pill toggles closed (the shell excludes
  // the anchor from outside-close; BUG-045 class).
  const triggerRef = useRef<HTMLButtonElement>(null)

  const toggle = async (): Promise<void> => {
    if (!open) setRecents(await window.api.project.recents())
    setOpen((v) => !v)
  }

  const switchTo = async (load: () => Promise<unknown>): Promise<void> => {
    setOpen(false)
    // BUG-009: one switch pipeline at a time, ACROSS surfaces. The lock is module-level
    // (shared with WelcomeScreen's open/create) because mid-switch the status flips to
    // 'loading', which unmounts Canvas and mounts a fresh WelcomeScreen whose per-mount
    // `busy` state cannot see this in-flight switch — without the shared lock a second
    // click there (or a re-opened dropdown here) interleaves two open pipelines and the
    // renderer can settle on project B while MAIN's currentDir points at C, after which
    // autosave writes B's canvas into C's canvas.json.
    if (!acquireProjectSwitchLock()) return
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
      const saved = await window.api.project.save(
        toObject(),
        useCanvasStore.getState().project.dir ?? undefined
      )
      if (saved === false) {
        // eslint-disable-next-line no-console
        console.error('project switch: final flush failed; aborting switch to avoid data loss')
        // D0-8: the abort must be VISIBLE — raise the save-failure chip, not console-only.
        setSaveFailure('Project could not be saved — switch cancelled to avoid losing edits')
        return
      }
      // D0-8 symmetry: the flush SUCCEEDED — clear any standing failure chip now, or
      // the global store carries the old project's stale message into the new one
      // (the chip would flash on the next project until its first autosave).
      clearSaveFailure()
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
      releaseProjectSwitchLock()
      setSwitching(false)
    }
  }

  // D0-8: manual retry (the toast's Retry action). A success clears the failure (the
  // bridge effect then dismisses the toast); a `false` return (the IPC write failed
  // without throwing) refreshes the message so the click visibly registered —
  // otherwise the action looks dead; a rejection logs + refreshes likewise.
  const retrySave = useCallback(async (): Promise<void> => {
    try {
      // BUG-009 parity: pin the write to the current project dir so a racing switch
      // can't land this doc in the wrong canvas.json.
      const ok = await window.api.project.save(
        toObject(),
        useCanvasStore.getState().project.dir ?? undefined
      )
      if (ok) clearSaveFailure()
      else setSaveFailure('Save failed again — check disk space and permissions')
    } catch (err) {
      // Fixed user-facing string (same rationale as useAutosave::onError) — raw OS
      // rejections are opaque + read aloud by the alert region; console keeps detail.
      // eslint-disable-next-line no-console
      console.error('project save retry failed', err)
      setSaveFailure('Save failed again — check disk space and permissions')
    }
  }, [toObject, clearSaveFailure, setSaveFailure])

  // D1-A: bridge the save-failure state into the app toast channel (replaces the D0-8
  // chip). STICKY — a failed save is a data-loss condition the user must act on, so it
  // never auto-expires; keyed so a repeat failure replaces in place and the next
  // successful save (or a successful Retry) dismisses it by id.
  useEffect(() => {
    if (saveFailure) {
      showToast({
        id: 'save-failure',
        message: saveFailure,
        kind: 'error',
        sticky: true,
        action: { label: 'Retry', run: () => void retrySave() }
      })
    } else {
      dismissToast('save-failure')
    }
  }, [saveFailure, retrySave])

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
        ref={triggerRef}
        className="project-switcher-trigger"
        // D0-7: dim + disable the pill while a switch pipeline runs (flush → dispose → load)
        // so the multi-step teardown never reads as a hang.
        style={switching ? { ...styles.proj, opacity: 0.6, cursor: 'default' } : styles.proj}
        disabled={switching}
        onClick={() => void toggle()}
        title="Switch project"
        aria-haspopup="menu"
        aria-expanded={open}
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
      {/* D0-8 chip removed by D1-A — save failures surface as a sticky Retry toast via
          the bridge effect above. */}
      {/* Shared Menu shell (D1-C): body portal + viewport clamp (D0-4's maxHeight scroll
          cap for a long recents list), Escape/outside/resize close, menuitem roving
          tabindex + arrow keys, ADR 0002 preview-detach while open. reclampKey re-clamps
          when the async recents list lands. */}
      {open && (
        <Menu
          anchor={triggerRef}
          align="left"
          gap={6}
          label="Switch project"
          className="project-switcher-menu"
          reclampKey={recents.length}
          onClose={() => setOpen(false)}
        >
          {recents.map((r) => (
            <button
              key={r.path}
              role="menuitem"
              onClick={() => void openRecent(r.path)}
              title={r.path}
            >
              {r.name}
            </button>
          ))}
          <div className="project-switcher-divider" />
          <button role="menuitem" onClick={() => void openFolder()}>
            Open folder…
          </button>
          <button role="menuitem" onClick={() => void createNew()}>
            Create project…
          </button>
        </Menu>
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
        {/* Focus a group — present only when >=1 group exists. */}
        <FocusGroupBtn onFocusGroup={onFocusGroup} />
        {/* Auto-tidy: a FancyZones-style picker of layout presets (Smart link-aware + tiling
            templates) that arranges the boards then fits. Keyboard `t` = Smart. See
            Canvas.tidyAndFit. */}
        <TidyMenu onTidy={onTidy} />
        {/* Backdrop wallpaper picker (docs/canvas-backdrop spec §3) — Tidy's sibling. */}
        <BackdropPicker />
        <span style={styles.divider} />
        <ToolBtn name="settings" title="Settings" onClick={onSettings} />
      </div>
    </div>
  )
}

// Focus-a-group button — rendered only when >=1 group exists. Fits the sole group directly, or
// opens the which-group picker, via the Canvas-provided handler. Reuses the `maximize` glyph
// (no dedicated focus icon; fit/tidy already sit in this cluster). The cluster's leading divider
// is always present (rendered before this button), so this renders just the button — no double-gap.
function FocusGroupBtn({ onFocusGroup }: { onFocusGroup: () => void }): ReactElement {
  const groupCount = useCanvasStore((s) => s.groups.length)
  if (groupCount === 0) return <></>
  return <ToolBtn name="maximize" title="Focus group (F)" onClick={onFocusGroup} />
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
            borderRadius: 2
            // rest background + hover transition live on .ca-zone in index.css — an
            // inline background would out-specify the .ca-tidy-preset:hover accent rule
            // (it was dead until moved); transition class-level for A12 gating.
          }}
        />
      ))}
    </div>
  )
}

// The Tidy preset PICKER (FancyZones-style). Rendered through the shared <Menu> shell
// (D1-C): body portal, right-aligned under the trigger + unified viewport clamp, outside
// pointerdown / Escape / resize close, menuitem roving tabindex + arrow keys. Each
// thumbnail applies its preset. (Browser previews render into a clipping DOM <canvas>
// since OS-3, so this popover z-orders over them — no detach-while-open dance needed.)
function TidyMenu({ onTidy }: { onTidy: (preset: LayoutPreset) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <ToolBtn
        name="grid"
        title="Tidy layout (T)"
        active={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <Menu
          anchor={triggerRef}
          align="right"
          gap={6}
          label="Tidy layout"
          style={styles.tidyPop}
          onClose={() => setOpen(false)}
        >
          <div style={styles.tidyHead}>Tidy layout</div>
          <div style={styles.tidyGrid}>
            {LAYOUT_PRESETS.map((p) => (
              <button
                key={p.id}
                className="ca-tidy-preset"
                role="menuitem"
                title={p.hint}
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
        </Menu>
      )}
    </div>
  )
}

// ── Top-center: board dock ────────────────────────────────────────────────────
// Clicking a board button ARMS that type (sets the store `tool`); the canvas then
// turns a click into a default-size board and a drag into a sized one
// (useBoardPlacement). Select disarms. Exported for the dock arming integration test.
//
// Auto-hide (2026-06-13, v2 proximity): the pill hides behind a slim handle bar so
// it never sits over board content at awkward zooms; it reveals when the mouse MOVES
// within a generous top-center proximity zone (window-level pointermove — element
// hover was a flicker trap: two small elements swapping pointer-events under a
// stationary cursor). A short entrance delay keeps a fast pass-through from flashing
// it; it hides a grace period after the cursor exits the zone. Pinned open while a
// board type is armed (the pill is the only armed-mode indicator), while the canvas
// is empty (EmptyState mirrors and points at it), and while keyboard focus is inside
// (a hidden-but-focusable pill would tab blind).

/** Proximity zone (screen px), centred on the dock, anchored to the pane top. */
const DOCK_ZONE_W = 600
const DOCK_ZONE_H = 120
/** Entrance delay — a cursor slung across the top shouldn't flash the dock. */
const DOCK_REVEAL_DELAY_MS = 100
/** Grace after the cursor exits the zone before the dock hides. */
const DOCK_HIDE_DELAY_MS = 1500

export function Dock(): ReactElement {
  const tool = useCanvasStore((s) => s.tool)
  const setTool = useCanvasStore((s) => s.setTool)
  const empty = useCanvasStore((s) => s.boards.length === 0)
  const [inZone, setInZone] = useState(false)
  const [focused, setFocused] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const revealed = inZone || focused || empty || tool !== 'select'

  // Zone state machine, registered ONCE with all mutable state in closure locals:
  // a deps-driven re-register can drop a window listener MID-DISPATCH and miss the
  // very event being handled (the D1 Menu/Modal Escape class — see
  // mid-dispatch-listener-removal). Only the committed `inZone` crosses into React.
  useEffect(() => {
    let zone: 'out' | 'pending' | 'in' = 'out'
    let enterTimer: number | null = null
    let hideTimer: number | null = null
    let last = { x: NaN, y: NaN }

    const inRect = (x: number, y: number): boolean => {
      const el = wrapRef.current
      if (!el) return false
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const top = r.top - 14 // the wrapper sits 14px below the pane top (styles.dock)
      return Math.abs(x - cx) <= DOCK_ZONE_W / 2 && y >= top && y <= top + DOCK_ZONE_H
    }
    const cancelEnter = (): void => {
      if (enterTimer !== null) {
        window.clearTimeout(enterTimer)
        enterTimer = null
      }
    }
    const cancelHide = (): void => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
    }
    // Out-of-zone transition — shared by far-away moves and cursor-left-the-window
    // (without the latter, exiting through the window's top edge leaves it stuck open).
    const goOutside = (): void => {
      if (zone === 'pending') {
        cancelEnter()
        zone = 'out'
      } else if (zone === 'in' && hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null
          zone = 'out'
          setInZone(false)
        }, DOCK_HIDE_DELAY_MS)
      }
    }
    const onMove = (e: PointerEvent): void => {
      last = { x: e.clientX, y: e.clientY }
      if (inRect(e.clientX, e.clientY)) {
        cancelHide()
        if (zone === 'out') {
          zone = 'pending'
          enterTimer = window.setTimeout(() => {
            enterTimer = null
            // Commit only if the cursor is STILL in the zone when the delay elapses.
            if (inRect(last.x, last.y)) {
              zone = 'in'
              setInZone(true)
            } else {
              zone = 'out'
            }
          }, DOCK_REVEAL_DELAY_MS)
        }
      } else {
        goOutside()
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseleave', goOutside)
    window.addEventListener('blur', goOutside)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', goOutside)
      window.removeEventListener('blur', goOutside)
      cancelEnter()
      cancelHide()
    }
  }, [])

  return (
    // pointerEvents:none on the wrapper: while hidden, board content under the dock's
    // footprint stays clickable — only the revealed pill opts back in via CSS (reveal
    // is the window-level zone listener above, not element hover). Focus events are
    // unaffected by pointer-events, so the focus-within pin works from the wrapper.
    <div
      ref={wrapRef}
      style={styles.dock}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <div className="ca-dock-handle" data-revealed={revealed} aria-hidden="true" />
      <div
        className="ca-dock-pill"
        data-revealed={revealed}
        style={{ ...styles.pill, padding: 4, gap: 3 }}
      >
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
      // ca-t-ctl (A12): hover transition via class so reduced-motion can suppress it.
      className="ca-t-ctl"
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
        color: active ? 'var(--accent)' : hover ? 'var(--text)' : 'var(--text-3)'
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
      // ca-t-ctl (A12): hover transition via class so reduced-motion can suppress it.
      className="ca-t-ctl"
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
        fontFamily: 'var(--ui)'
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
    zIndex: 50,
    // Auto-hide: the wrapper must never hit-test — children opt back in (CSS).
    pointerEvents: 'none'
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
    // Positioning + zIndex come from the <Menu> shell (fixed, clamped, 250).
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
