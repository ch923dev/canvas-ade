/**
 * App chrome (DESIGN.md §8) — floating islands over the canvas, never full-width:
 * top-left project switcher, top-right camera cluster, bottom-center board dock.
 * All sit on `--surface-raised` with the popover shadow. Camera controls drive
 * React Flow via `useReactFlow`; the dock adds store boards centered in view.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import type { BoardType } from '../lib/boardSchema'
import { LAYOUT_PRESETS, type LayoutPreset } from '../lib/layoutPresets'
import { FIT_FRAME, RESET_FRAME } from '../lib/canvasView'
import { cameraAnim } from '../lib/motion'
import { Icon, type IconName } from './Icon'
import { Menu } from './Menu'
import { TypeGlyph } from './TypeGlyph'
import { SettingsModal } from './SettingsModal'
import { BackdropPicker } from './BackdropPicker'
import { ProjectSwitcher } from './ProjectSwitcher'
import { RecapConsentModal } from './RecapConsentModal'
import { SidePanel } from './SidePanel'
import { BoardInspector } from './BoardInspector'
import { OrchestrationModals } from './OrchestrationModals'
import { SignInView } from './SignInView'
import { AccountPill } from './AccountPill'

// The switcher moved to its own file under the max-lines ratchet (Phase 4's live rows tipped
// this one over 700). Re-exported so existing import sites (integration tests) keep working.
export { ProjectSwitcher } from './ProjectSwitcher'

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
  const [showSignIn, setShowSignIn] = useState(false)
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
        onSignIn={() => setShowSignIn(true)}
        onAccount={() => setShowSettings(true)}
      />
      <SidePanel />
      <BoardInspector />
      <Dock />
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          // Account section's "Sign in" CTA: close Settings first, then open SignInView — stacking
          // two shared Modals would duel their focus traps + Esc handling (the orchestration-modal
          // pattern). The pill's own signed-out click opens SignInView directly.
          onSignIn={() => {
            setShowSettings(false)
            setShowSignIn(true)
          }}
        />
      )}
      {showSignIn && <SignInView onClose={() => setShowSignIn(false)} />}
      {/* Guard: MAIN/renderer dir desync can leave askRecap=true with no project open. */}
      {askRecap && projectDir !== null && <RecapConsentModal onClose={() => setAskRecap(false)} />}
      {/* Agent Orchestration Onboarding (P2): the Enable/Sync host owns its own first-init
          trigger + per-project hydration (self-guarded against firing with no project open). */}
      <OrchestrationModals />
    </>
  )
}

// ── Top-right: camera cluster ───────────────────────────────────────────────
function CameraCluster({
  onTidy,
  onSettings,
  onFocusGroup,
  onSignIn,
  onAccount
}: {
  onTidy: (preset: LayoutPreset) => void
  onSettings: () => void
  onFocusGroup: () => void
  /** Account pill, signed-out → open SignInView. */
  onSignIn: () => void
  /** Account pill, signed-in → open Settings at the Account section (top of the modal). */
  onAccount: () => void
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
          // A11Y-01: class so the shared focus-ring cluster gives it the accent ring.
          className="ca-zoom-pct"
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
        {/* Phase 1 accounts: the account pill sits immediately before the Settings gear
            (DESIGN.md › Surface 1). Signed-out → SignInView; signed-in → Settings/Account. */}
        <AccountPill onSignIn={onSignIn} onAccount={onAccount} />
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
        expanded={open}
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

    // CHROME-01: the dock is anchored top-center (left:50% + translateX(-50%)), so its
    // zone center-x and top only shift on viewport resize — never per pointermove. Cache
    // the geometry and re-measure on resize instead of calling getBoundingClientRect on
    // every global move (it ran on the passive window pointermove, i.e. constantly).
    let geom: { cx: number; top: number } | null = null
    const measure = (): void => {
      const el = wrapRef.current
      if (!el) {
        geom = null
        return
      }
      const r = el.getBoundingClientRect()
      geom = { cx: r.left + r.width / 2, top: r.top - 14 } // wrapper sits 14px below pane top
    }
    measure()
    const inRect = (x: number, y: number): boolean => {
      if (!geom) measure() // lazy re-measure if the wrapper wasn't laid out at mount
      if (!geom) return false
      return (
        Math.abs(x - geom.cx) <= DOCK_ZONE_W / 2 && y >= geom.top && y <= geom.top + DOCK_ZONE_H
      )
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
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', goOutside)
      window.removeEventListener('blur', goOutside)
      window.removeEventListener('resize', measure)
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
          pressed={tool === 'select'}
          onClick={() => setTool('select')}
        />
        <span style={styles.divider} />
        {(['terminal', 'browser', 'planning', 'command', 'file'] as const).map((type) => (
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
  pressed,
  expanded,
  onClick
}: {
  name: IconName
  title: string
  active?: boolean
  big?: boolean
  /** CHROME-02: toggle buttons (dock arming) pass their on/off state → aria-pressed.
   *  Omitted for plain action buttons (zoom/fit/settings) so they stay un-toggled to AT. */
  pressed?: boolean
  /** CHROME-02: popup triggers (Tidy) pass their open state → aria-haspopup + aria-expanded. */
  expanded?: boolean
  onClick: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  return (
    <button
      // ca-t-ctl (A12): hover transition via class so reduced-motion can suppress it.
      className="ca-t-ctl"
      title={title}
      // CHROME-02: undefined ⇒ React omits the attr (correct for plain action buttons).
      aria-pressed={pressed}
      aria-haspopup={expanded === undefined ? undefined : 'menu'}
      aria-expanded={expanded}
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
      // CHROME-02: a dock button arms a tool (a toggle) — announce its armed state.
      aria-pressed={active}
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
