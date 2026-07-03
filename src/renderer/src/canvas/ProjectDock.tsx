/**
 * Bottom project dock (Background Project Sessions, Phase 4b — the approved
 * PHASE4-UX-DESIGN §4). Windows-Task-View-like overview: parking the pointer on the
 * window's bottom edge (~2px hot zone, ~150ms intent delay — a drive-by never opens it)
 * slides up a centered panel with one card per SESSION project — the active project plus
 * every backgrounded resident (`project:listBackground`). Cold recents NEVER appear.
 *
 * Card = the §2 grammar (--ok dot · name · counts badge · hover-✕ → the SAME §3 confirm ·
 * ∞ forget badge) over a static canvas thumbnail (`project:thumbs`; dot-grid placeholder
 * when capture failed). Active card wears the accent ring + ACTIVE tag; clicking it just
 * closes the dock. Clicking a resident = `performProjectSwitch` — the exact §1 pipeline,
 * dialog/policy included (zero new switch semantics). The trailing + tile reuses the
 * switcher's Open folder… / Create project… flows (projectSessionsShared).
 *
 * Mounted app-level from App.tsx (gated on project status 'open'). Solid surfaces only.
 * Listener discipline: the hot-zone/Escape handlers are registered ONCE and read all
 * mutable state through refs (mid-dispatch-listener-removal class).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { performProjectSwitch } from '../store/projectSwitch'
import { captureProjectThumb } from '../store/projectThumbCapture'
import type { BackgroundProjectInfo } from '../../../preload'
import { Menu } from './Menu'
import { CloseBackgroundModal } from './CloseBackgroundModal'
import {
  bgBadge,
  dockCards,
  fetchLiveDecorations,
  pickCreateProject,
  pickOpenFolder,
  type ProjectDockCard
} from './projectSessionsShared'

/** Bottom-edge hot zone height (window px). ~2px per the original spec proved unreachable
 *  with a REAL mouse (manual dev check 2026-07-03): windowed, the bottom few px are the OS
 *  resize border (non-client — no pointermove reaches the page); maximized, the cursor
 *  parks on the taskbar below the window. 10px + the intent delay stays accident-safe. */
const EDGE_ZONE_PX = 10
/** Intent delay before the dock reveals — a drive-by across the edge never opens it. */
const REVEAL_DELAY_MS = 150
/** Grace after the pointer leaves the panel region before the dock hides. */
const HIDE_GRACE_MS = 300
/** Slack around the revealed panel that still counts as inside (edge→panel travel). */
const KEEP_MARGIN_X = 32
const KEEP_MARGIN_TOP = 16

export function ProjectDock(): ReactElement {
  const activeDir = useCanvasStore((s) => s.project.dir)
  const activeName = useCanvasStore((s) => s.project.name)
  const [open, setOpen] = useState(false)
  const [bgList, setBgList] = useState<BackgroundProjectInfo[]>([])
  const [foreverDirs, setForeverDirs] = useState<string[]>([])
  const [activeCounts, setActiveCounts] = useState<{ terminals: number; previews: number } | null>(
    null
  )
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [closeTarget, setCloseTarget] = useState<BackgroundProjectInfo | null>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const plusRef = useRef<HTMLButtonElement>(null)
  // Mirrors of the ephemeral state for the once-registered window listeners below.
  const openRef = useRef(false)
  const plusOpenRef = useRef(false)
  const closeTargetRef = useRef<BackgroundProjectInfo | null>(null)

  const setPlusOpenBoth = useCallback((v: boolean): void => {
    plusOpenRef.current = v
    setPlusOpen(v)
  }, [])
  const setCloseTargetBoth = useCallback((v: BackgroundProjectInfo | null): void => {
    closeTargetRef.current = v
    setCloseTarget(v)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const [{ bg, forever }, info] = await Promise.all([
      fetchLiveDecorations(),
      // Promise.resolve().then wrapper: a partial window.api mock (integration tests stub
      // only what they use) must degrade to null, not throw before .catch attaches.
      Promise.resolve()
        .then(() => window.api.project.askOnSwitchInfo())
        .catch(() => null)
    ])
    setBgList(bg)
    setForeverDirs(forever)
    setActiveCounts(info ? { terminals: info.terminals, previews: info.previews } : null)
    // The §4 dock-open capture moment: snapshot the ACTIVE canvas, THEN pull the map so
    // the active card's thumb is fresh. Failure is normal (placeholder path).
    await captureProjectThumb()
    const t = await Promise.resolve()
      .then(() => window.api.project.thumbs())
      .catch(() => ({}) as Record<string, string>)
    setThumbs(t)
  }, [])

  const openDock = useCallback((): void => {
    openRef.current = true
    setOpen(true)
    void refresh()
  }, [refresh])
  const closeDock = useCallback((): void => {
    openRef.current = false
    setOpen(false)
    setPlusOpenBoth(false)
  }, [setPlusOpenBoth])

  // Hot-zone state machine — registered ONCE with all mutable state in refs/locals (a
  // deps-driven re-register can drop a window listener MID-DISPATCH; the AppChrome Dock
  // class). Reveal: pointer parked in the bottom EDGE_ZONE_PX for REVEAL_DELAY_MS. Hide:
  // pointer outside the panel (+ slack, down to the window bottom) for HIDE_GRACE_MS —
  // paused while a child overlay (the + menu / §3 confirm) is up, since those portal
  // outside the panel rect.
  useEffect(() => {
    let pending: number | null = null
    let hide: number | null = null
    const cancelPending = (): void => {
      if (pending !== null) {
        window.clearTimeout(pending)
        pending = null
      }
    }
    const cancelHide = (): void => {
      if (hide !== null) {
        window.clearTimeout(hide)
        hide = null
      }
    }
    const scheduleHide = (): void => {
      if (hide === null) {
        hide = window.setTimeout(() => {
          hide = null
          closeDock()
        }, HIDE_GRACE_MS)
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (!openRef.current) {
        if (e.clientY >= window.innerHeight - EDGE_ZONE_PX) {
          if (pending === null) {
            pending = window.setTimeout(() => {
              pending = null
              openDock()
            }, REVEAL_DELAY_MS)
          }
        } else {
          cancelPending()
        }
        return
      }
      if (plusOpenRef.current || closeTargetRef.current) {
        cancelHide()
        return
      }
      const el = panelRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const inside =
        e.clientX >= r.left - KEEP_MARGIN_X &&
        e.clientX <= r.right + KEEP_MARGIN_X &&
        e.clientY >= r.top - KEEP_MARGIN_TOP
      if (inside) cancelHide()
      else scheduleHide()
    }
    // Cursor left the window / focus left the app: never commit a pending reveal blind.
    const onGone = (): void => cancelPending()
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseleave', onGone)
    window.addEventListener('blur', onGone)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', onGone)
      window.removeEventListener('blur', onGone)
      cancelPending()
      cancelHide()
    }
  }, [openDock, closeDock])

  // Escape closes the dock — CAPTURE phase so we can see whether a child overlay (the +
  // menu / confirm modal) still owns this Esc before its own bubble handler closes it;
  // if one is up, that Esc is theirs and the dock stays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !openRef.current) return
      if (plusOpenRef.current || closeTargetRef.current) return
      closeDock()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeDock])

  // Card click = the exact §1 switch pipeline (dialog/policy come free). Active card just
  // closes the dock. Fire-and-forget like the switcher rows — the pipeline owns outcomes.
  const onCardClick = (card: ProjectDockCard): void => {
    closeDock()
    if (card.active) return
    void performProjectSwitch(() => window.api.project.open(card.dir), {
      incomingName: card.name
    })
  }

  // ✕ on a resident card: running → the shared §3 confirm; idle → silent close (§3 rule).
  // The dock stays open — the refreshed card set is the continuation.
  const onCloseCard = (card: ProjectDockCard): void => {
    const bg = bgList.find((b) => b.dir === card.dir)
    if (!bg) return
    if (bg.terminalsRunning + bg.previews === 0) {
      void Promise.resolve()
        .then(() => window.api.project.closeBackground(bg.dir))
        .catch(() => false)
        .then(() => refresh())
      return
    }
    setCloseTargetBoth(bg)
  }
  const confirmClose = async (): Promise<void> => {
    const target = closeTarget
    setCloseTargetBoth(null)
    if (target) {
      await Promise.resolve()
        .then(() => window.api.project.closeBackground(target.dir))
        .catch(() => false)
    }
    void refresh()
  }
  // ∞ forget — clears the keep policy (session + forever), sessions untouched.
  const onForget = (dir: string): void => {
    void Promise.resolve()
      .then(() => window.api.project.forgetKeepPolicy(dir))
      .catch(() => false)
      .then(() => refresh())
  }

  // + tile: the switcher's Open folder… / Create project… flows (shared, not duplicated).
  const onPlusPick = async (
    pick: () => Promise<{ load: () => Promise<unknown>; name: string } | null>
  ): Promise<void> => {
    setPlusOpenBoth(false)
    const picked = await pick()
    if (!picked) return
    closeDock()
    void performProjectSwitch(picked.load, { incomingName: picked.name })
  }

  const cards = dockCards({ dir: activeDir, name: activeName }, activeCounts, bgList)

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          className="pd-panel"
          role="group"
          aria-label="Project dock"
          data-testid="project-dock"
        >
          {cards.map((card) => {
            const live = card.terminalsRunning + card.previews > 0
            const badge = bgBadge(card)
            return (
              <div
                key={card.dir}
                className="pd-card"
                data-active={card.active || undefined}
                data-testid="pd-card"
              >
                <div className="pd-head">
                  <span className={live ? 'ps-dot' : 'ps-dot-spacer'} aria-hidden />
                  <span className="pd-name" title={card.dir}>
                    {card.name}
                  </span>
                  {badge && <span className="ps-badge">{badge}</span>}
                  {foreverDirs.includes(card.dir) && (
                    <button
                      className="ps-aux ps-inf"
                      title="Always kept in background — click to ask again"
                      aria-label={`Stop always keeping ${card.name} in the background`}
                      onClick={() => onForget(card.dir)}
                    >
                      ∞
                    </button>
                  )}
                  {!card.active && (
                    <button
                      className="ps-aux ps-x"
                      title="Close background project"
                      aria-label={`Close background project ${card.name}`}
                      onClick={() => onCloseCard(card)}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <button
                  className="pd-shot"
                  data-testid="pd-shot"
                  aria-label={
                    card.active ? `${card.name} — active project` : `Switch to ${card.name}`
                  }
                  onClick={() => onCardClick(card)}
                >
                  {thumbs[card.dir] ? (
                    <img className="pd-thumb" src={thumbs[card.dir]} alt="" draggable={false} />
                  ) : (
                    <span className="pd-thumb pd-thumb-empty" aria-hidden />
                  )}
                  {card.active && <span className="pd-active-tag">ACTIVE</span>}
                </button>
              </div>
            )
          })}
          <button
            ref={plusRef}
            className="pd-plus"
            data-testid="pd-plus"
            title="Open or create a project"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            onClick={() => setPlusOpenBoth(!plusOpen)}
          >
            +
          </button>
          {plusOpen && (
            <Menu
              anchor={plusRef}
              align="right"
              gap={6}
              label="Add project"
              className="project-switcher-menu"
              onClose={() => setPlusOpenBoth(false)}
            >
              <button role="menuitem" onClick={() => void onPlusPick(pickOpenFolder)}>
                Open folder…
              </button>
              <button role="menuitem" onClick={() => void onPlusPick(pickCreateProject)}>
                Create project…
              </button>
            </Menu>
          )}
        </div>
      )}
      {/* The SAME §3 close-confirm the switcher uses (CloseBackgroundModal) — rendered
          outside the panel so it survives an auto-hide race. */}
      {closeTarget && (
        <CloseBackgroundModal
          target={closeTarget}
          onCancel={() => setCloseTargetBoth(null)}
          onConfirm={() => void confirmClose()}
        />
      )}
    </>
  )
}

export default ProjectDock
