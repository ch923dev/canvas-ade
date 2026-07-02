/**
 * Top-left project switcher (DESIGN.md §8; split out of AppChrome.tsx under the max-lines
 * ratchet when Phase 4's live rows tipped it). Dropdown: shows the current project name; lets
 * the user open a recent project, open a folder, or create one. On switch the pipeline in
 * store/projectSwitch.ts runs (lock → keep-decision/dialog → flush-save → handover → load).
 * Phase 4 (bg sessions): recents rows carry live decorations — --ok dot + counts badge for a
 * backgrounded resident, hover-✕ (close, confirmed when running), ∞ forget badge for a
 * persisted keep policy (PHASE4-UX-DESIGN §2–3).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement
} from 'react'
import { useCanvasStore, type RecentProject } from '../store/canvasStore'
import { useSaveStatusStore } from '../store/saveStatusStore'
import { showToast, dismissToast } from '../store/toastStore'
import { performProjectSwitch } from '../store/projectSwitch'
import type { BackgroundProjectInfo } from '../../../preload'
import { Icon } from './Icon'
import { Menu } from './Menu'
import { Modal } from './Modal'

export function ProjectSwitcher(): ReactElement {
  const name = useCanvasStore((s) => s.project.name)
  const count = useCanvasStore((s) => s.boards.length)
  const toObject = useCanvasStore((s) => s.toObject)
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])
  // Phase 4 (bg sessions): live decorations for the recents rows — backgrounded residents
  // (dot + counts badge + ✕) and forever-keep dirs (the ∞ forget badge). Fetched with the
  // recents on every open (cheap registry reads) + refreshed after a ✕ / ∞ action.
  const [bgList, setBgList] = useState<BackgroundProjectInfo[]>([])
  const [foreverDirs, setForeverDirs] = useState<string[]>([])
  // The ✕ confirm target (PHASE4-UX-DESIGN §3). null = no modal.
  const [closeTarget, setCloseTarget] = useState<BackgroundProjectInfo | null>(null)
  // D0-7: a project switch in flight (flush → dispose → load). The pill dims + spins so
  // the multi-step teardown never reads as a hang; once status flips to 'loading' this
  // component unmounts and WelcomeScreen carries the loading presentation.
  const [switching, setSwitching] = useState(false)
  // D0-8→D1-A: the last failed save (set by the autosave hook's onError and the
  // flush-failure path below; cleared by the next successful save), surfaced as a
  // STICKY error toast with a Retry action — the toast bridge effect below.
  const saveFailure = useSaveStatusStore((s) => s.failure)
  const setSaveFailure = useSaveStatusStore((s) => s.setSaveFailure)
  // PERSIST-03: a successful flush/retry marks 'saved' (clearing the failure too), so the
  // ambient indicator reflects disk health rather than merely the absence of an error.
  const markSaved = useSaveStatusStore((s) => s.markSaved)
  // Anchor for the shared <Menu> shell — the pill button itself, so the dropdown hangs
  // under it (left-aligned) and re-clicking the pill toggles closed (the shell excludes
  // the anchor from outside-close; BUG-045 class).
  const triggerRef = useRef<HTMLButtonElement>(null)

  const refreshLive = useCallback(async (): Promise<void> => {
    // Promise.resolve().then wrappers: a partial window.api mock (integration tests stub only
    // what they use) must degrade to empty lists, not throw before .catch can attach.
    const [bg, forever] = await Promise.all([
      Promise.resolve()
        .then(() => window.api.project.listBackground())
        .catch(() => []),
      Promise.resolve()
        .then(() => window.api.project.keepForeverDirs())
        .catch(() => [])
    ])
    setBgList(bg)
    setForeverDirs(forever)
  }, [])

  const toggle = async (): Promise<void> => {
    if (!open) {
      setRecents(await window.api.project.recents())
      await refreshLive()
    }
    setOpen((v) => !v)
  }

  const switchTo = async (load: () => Promise<unknown>, incomingName?: string): Promise<void> => {
    setOpen(false)
    // D0-7: dim + spin the pill for the whole pipeline. The finally also covers the
    // post-unmount path (status flips to 'loading' mid-await): React 18 treats setState
    // on an unmounted component as a no-op.
    setSwitching(true)
    try {
      // The pipeline itself (lock → keep-decision/dialog → autosave cancel → pinned
      // flush-save → live-resource handover → load) lives in store/projectSwitch.ts,
      // shared with the e2e harness. Lock/flush failures surface through the save-status
      // store it writes; a dialog Cancel settles 'cancelled' (no side effects).
      await performProjectSwitch(load, incomingName ? { incomingName } : undefined)
    } finally {
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
      if (ok) markSaved()
      else setSaveFailure('Save failed again — check disk space and permissions')
    } catch (err) {
      // Fixed user-facing string (same rationale as useAutosave::onError) — raw OS
      // rejections are opaque + read aloud by the alert region; console keeps detail.
      // eslint-disable-next-line no-console
      console.error('project save retry failed', err)
      setSaveFailure('Save failed again — check disk space and permissions')
    }
  }, [toObject, markSaved, setSaveFailure])

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

  const openRecent = (r: RecentProject): Promise<void> =>
    switchTo(() => window.api.project.open(r.path), r.name)
  const openFolder = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (dir) await switchTo(() => window.api.project.open(dir), basenameOf(dir))
    else setOpen(false)
  }

  // Phase 4: ✕ on a backgrounded row. Running resources → the §3 confirm modal; an idle
  // resident (everything exited on its own) closes silently. The menu closes either way —
  // the modal (or the refreshed state on reopen) carries the continuation.
  const onCloseBackground = (bg: BackgroundProjectInfo): void => {
    setOpen(false)
    if (bg.terminalsRunning + bg.previews === 0) {
      void window.api.project.closeBackground(bg.dir).catch(() => false)
      return
    }
    setCloseTarget(bg)
  }
  const confirmCloseBackground = async (): Promise<void> => {
    const target = closeTarget
    setCloseTarget(null)
    if (target) await window.api.project.closeBackground(target.dir).catch(() => false)
  }
  // Phase 4: the ∞ forget badge — clears the keep policy (session + forever), sessions untouched.
  const onForget = (dir: string): void => {
    void window.api.project
      .forgetKeepPolicy(dir)
      .catch(() => false)
      .then(() => refreshLive())
  }
  const createNew = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (!dir) {
      setOpen(false)
      return
    }
    const pname = basenameOf(dir)
    await switchTo(() => window.api.project.create(dir, pname, {}), pname)
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
      {/* PERSIST-03: ambient save-status confirmation. The D0-8 chip is gone — save
          FAILURES still surface as the sticky Retry toast (bridge effect above); this is
          the quiet positive 'Saving…'/'Saved' signal. */}
      <SaveStatus />
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
          {recents.map((r) => {
            // Phase 4 live decorations (PHASE4-UX-DESIGN §2): dot + counts for a
            // backgrounded resident, ∞ when the keep policy is persisted, hover-✕ to close.
            const bg = bgList.find((b) => b.dir === r.path)
            const live = bg !== undefined && bg.terminalsRunning + bg.previews > 0
            const isForever = foreverDirs.includes(r.path)
            return (
              <div key={r.path} className="ps-live-row" role="none">
                <button
                  role="menuitem"
                  className="ps-row-main"
                  onClick={() => void openRecent(r)}
                  title={r.path}
                >
                  <span className={live ? 'ps-dot' : 'ps-dot-spacer'} aria-hidden />
                  <span className="ps-name">{r.name}</span>
                  {bg && <span className="ps-badge">{bgBadge(bg)}</span>}
                </button>
                {isForever && (
                  <button
                    className="ps-aux ps-inf"
                    title="Always kept in background — click to ask again"
                    aria-label={`Stop always keeping ${r.name} in the background`}
                    onClick={() => onForget(r.path)}
                  >
                    ∞
                  </button>
                )}
                {bg && (
                  <button
                    className="ps-aux ps-x"
                    title="Close background project"
                    aria-label={`Close background project ${r.name}`}
                    onClick={() => onCloseBackground(bg)}
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          })}
          <div className="project-switcher-divider" />
          <button role="menuitem" onClick={() => void openFolder()}>
            Open folder…
          </button>
          <button role="menuitem" onClick={() => void createNew()}>
            Create project…
          </button>
        </Menu>
      )}
      {/* Phase 4 (PHASE4-UX-DESIGN §3): the ✕ close confirm — plain two-button card; the
          body carries the consequence (no red-button grammar). */}
      {closeTarget && (
        <Modal
          label="Close project"
          onClose={() => setCloseTarget(null)}
          zIndex={10000}
          scrimProps={{ 'data-testid': 'close-bg-backdrop' }}
          cardProps={{ 'data-testid': 'close-bg-modal' }}
          cardStyle={{ width: 420, maxWidth: '90vw', padding: 20 }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--fs-label)',
              fontWeight: 600,
              letterSpacing: 'var(--tr-label)'
            }}
          >
            Close “{closeTarget.name}”?
          </h2>
          <p
            style={{
              margin: '10px 0 18px',
              fontSize: 'var(--fs-body)',
              lineHeight: 'var(--lh-body)',
              color: 'var(--text-2)'
            }}
          >
            This stops {closeBody(closeTarget)}. The project stays on disk and in recents.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="ca-btn-ghost"
              data-testid="close-bg-cancel"
              onClick={() => setCloseTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ca-btn-primary"
              data-testid="close-bg-confirm"
              onClick={() => void confirmCloseBackground()}
            >
              Stop &amp; close
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** Last path segment as a display name (mirrors createNew's old inline derivation). */
function basenameOf(dir: string): string {
  return (
    dir
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || dir
  )
}

/** Row badge: mono micro counts, non-zero parts only (PHASE4-UX-DESIGN §2). */
function bgBadge(bg: BackgroundProjectInfo): string {
  const parts: string[] = []
  if (bg.terminalsRunning > 0) parts.push(`${bg.terminalsRunning} term`)
  if (bg.previews > 0) parts.push(`${bg.previews} prev`)
  return parts.join(' · ')
}

/** Close-confirm body: what actually dies, singular/plural, non-zero parts only. */
function closeBody(bg: BackgroundProjectInfo): string {
  const parts: string[] = []
  if (bg.terminalsRunning > 0)
    parts.push(
      `${bg.terminalsRunning} running ${bg.terminalsRunning === 1 ? 'terminal' : 'terminals'} (their processes are killed)`
    )
  if (bg.previews > 0)
    parts.push(`closes ${bg.previews} ${bg.previews === 1 ? 'preview' : 'previews'}`)
  return parts.join(' and ')
}

// PERSIST-03: ambient save-status indicator — a quiet --text-3 confirmation next to the
// board count. 'idle' reads as "Saved" (a freshly-opened project is already on disk);
// 'saving'/'saved' give positive feedback; 'error' tints --err while the sticky Retry
// toast carries the action. role=status (polite) so AT announces the saving→saved swap.
// Own subscription so a state change re-renders only this span, not all of ProjectSwitcher.
function SaveStatus(): ReactElement {
  const state = useSaveStatusStore((s) => s.state)
  const label = state === 'saving' ? 'Saving…' : state === 'error' ? 'Save failed' : 'Saved'
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: state === 'error' ? 'var(--err)' : 'var(--text-3)'
      }}
    >
      · {label}
    </span>
  )
}

// Mirrors AppChrome's island styles for the top-left corner (the pill keeps its exact look).
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
  }
}
