import { memo, useEffect } from 'react'
import CanvasImpl from './canvas/Canvas'
import WelcomeScreenImpl from './canvas/WelcomeScreen'
import AuditLogViewerImpl from './canvas/AuditLogViewer'
import ConfirmModalImpl from './canvas/ConfirmModal'
import BatchConfirmModalImpl from './canvas/BatchConfirmModal'
import AskOnSwitchModalImpl from './canvas/AskOnSwitchModal'
import CloseSessionsModalImpl from './canvas/CloseSessionsModal'
import ProjectDockImpl from './canvas/ProjectDock'
import SwitchTransitionOverlayImpl from './canvas/SwitchTransitionOverlay'
import { RunningProjectSwitcher as RunningProjectSwitcherImpl } from './canvas/RunningProjectSwitcher'
import { useSwitchTransitionStore } from './store/switchTransitionStore'
import { ToastIsland as ToastIslandImpl } from './canvas/Toast'
import { UpdateSurfaces as UpdateSurfacesImpl } from './canvas/UpdateSurfaces'
import { useRendererSmoke } from './smoke/useRendererSmoke'
import { McpPublisher } from './store/McpPublisher'
import { useMcpCommands } from './store/useMcpCommands'
import { useCanvasStore, patchBoardMeta } from './store/canvasStore'
import { useProjectBoot } from './store/useProjectBoot'
import { useAccountStore, useAccountSync } from './store/accountStore'
import { useUpdateStatusSync } from './store/useUpdateStatusSync'
import { SignInView as SignInViewImpl } from './canvas/SignInView'
import { useAutosave } from './store/useAutosave'
import { useProjectSwitchHotkey } from './store/useProjectSwitchHotkey'
import { useNotifications } from './store/useNotifications'
import { useSwarmEvents } from './store/useSwarmEvents'
import { useVoiceCapture } from './voice/useVoiceCapture'
import { useTtsPlayback } from './voice/useTtsPlayback'
import { VoicePill as VoicePillImpl } from './voice/VoicePill'
import { JarvisPanel as JarvisPanelImpl } from './jarvis/JarvisPanel'

/**
 * R5 (audit P-1) — THE MEMO BOUNDARY AT THE ROOT.
 *
 * Every root child is zero-prop and self-subscribing, so `memo` here means "a re-render of `App`
 * alone can never propagate into 14 subtrees". Wrapping at the use site rather than in each
 * component's own file keeps the boundary readable as ONE thing (and leaves each component's public
 * export shape untouched); shadowing the imported `…Impl` name keeps the JSX below unchanged. Same
 * shape as the existing `memo(AppChromeImpl)` one level down.
 *
 * This is defence in depth, not the fix: the 60 Hz driver was `useMcpPublish` sitting at this level,
 * and it now lives in the `McpPublisher` leaf. What `memo` buys is that the NEXT coarse store
 * subscription someone adds to `App` cannot silently re-create P-1 — `App`'s remaining picks
 * (`status`, `accountStatus`, `switchPhase`) are all low-frequency strings.
 */
const Canvas = memo(CanvasImpl)
const WelcomeScreen = memo(WelcomeScreenImpl)
const AuditLogViewer = memo(AuditLogViewerImpl)
const ConfirmModal = memo(ConfirmModalImpl)
const BatchConfirmModal = memo(BatchConfirmModalImpl)
const AskOnSwitchModal = memo(AskOnSwitchModalImpl)
const CloseSessionsModal = memo(CloseSessionsModalImpl)
const ProjectDock = memo(ProjectDockImpl)
const SwitchTransitionOverlay = memo(SwitchTransitionOverlayImpl)
const RunningProjectSwitcher = memo(RunningProjectSwitcherImpl)
const ToastIsland = memo(ToastIslandImpl)
const UpdateSurfaces = memo(UpdateSurfacesImpl)
const VoicePill = memo(VoicePillImpl)
const JarvisPanel = memo(JarvisPanelImpl)
const SignInView = memo(SignInViewImpl)

/** Stable identity for the forced sign-in gate's no-op close — an inline arrow would hand
 *  `SignInView` a fresh prop every render and defeat its memo boundary. */
const noop = (): void => {}

/**
 * App root. On boot, ask MAIN for the most-recent project (auto-reopen); fall back to
 * the welcome screen. The canvas mounts only when a project is open; autosave is armed
 * globally and self-gates on project status.
 */
function App(): React.ReactElement {
  useRendererSmoke()
  // R4: boot auto-reopen — the same lock-guarded open primitive the WelcomeScreen doors use.
  useProjectBoot()
  useAutosave()
  // Project-switch hotkey (renderer half): MAIN's window-scoped chord forwards a direction; this
  // raises the running-projects switcher overlay. Mounted here so it survives a switch (the
  // ProjectSwitcher pill unmounts mid-'loading').
  useProjectSwitchHotkey()
  // R5: useMcpPublish is NOT called here — it subscribes `boards`, so a drag would re-render this
  // whole root ~60×/s. It lives in the render-nothing <McpPublisher /> leaf mounted below.
  useMcpCommands()
  // Phase 5 auto-update: pipe MAIN's update status into the store that feeds the persistent
  // Settings badge (gear / About tile / account pill) + the tier surfaces.
  useUpdateStatusSync()
  // Phase 1 accounts: hydrate the account store at boot + subscribe to MAIN's auth:statusChanged.
  useAccountSync()
  // Voice V1: arm the mic-capture controller — the MessagePort MAIN transfers on
  // voice:session:start is the start signal (see useVoiceCapture).
  useVoiceCapture()
  // Jarvis J2: TTS playback queue + barge-in — adopts the voice:tts:port chunk stream.
  useTtsPlayback()
  // Desktop notifications: MAIN pushes agent-lifecycle events (done / needs-input / error) → an
  // in-app toast + focus-on-click. The native OS notification is raised in MAIN.
  useNotifications()
  // Orchestration S1: mirror MAIN's per-board swarm orchestrator sessions into swarmStore
  // (turn stream + run events) — one global subscription, keyed by swarm board id.
  useSwarmEvents()

  const status = useCanvasStore((s) => s.project.status)
  const accountStatus = useAccountStore((s) => s.status)
  // Phase 4c: while the switch-transition overlay is armed, the welcome picker must never
  // paint (killing the mid-switch flash is the point of the HOLD phase); during IN the
  // wrapper below carries the rise animation over the freshly mounted canvas.
  const switchPhase = useSwitchTransitionStore((s) => s.phase)

  // Belt-and-suspenders against drop-to-navigate (audit `packaged-fileurl-nav-allowed`):
  // a file or URL dropped anywhere on the window default-navigates the whole frame to
  // it (replacing the React app + every live PTY/preview). Cancel the DEFAULT on the
  // window-level dragover/drop so a stray drop can never start a navigation. We only
  // preventDefault (NOT stopPropagation), so component-level drop handlers — the
  // Planning board's image-drop well — still receive the event and run normally.
  useEffect(() => {
    const cancel = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', cancel)
    window.addEventListener('drop', cancel)
    return () => {
      window.removeEventListener('dragover', cancel)
      window.removeEventListener('drop', cancel)
    }
  }, [])

  // Terminal-recap T15: MAIN learns a board's Claude session id + transcript path (by
  // matching PTY cwd/launch to the freshest transcript) and pushes them here so the recap
  // survives reload. Patch only boards that still exist. #BUG-064: this arrives from MAIN
  // at an arbitrary moment (not a user gesture), so it goes through patchBoardMeta — a
  // history-invisible setter that neither wipes an armed redo branch (updateBoard clears
  // `future` on any diff) nor gets reverted by a later undo (it rewrites the rails too).
  // Guarded for non-electron test runtimes; the effect returns onLearned's disposer.
  useEffect(() => {
    const onLearned = window.api?.recap?.onLearned
    if (!onLearned) return
    return onLearned((patches) => {
      const s = useCanvasStore.getState()
      for (const p of patches) {
        if (s.boards.some((b) => b.id === p.boardId)) {
          patchBoardMeta(p.boardId, {
            agentSessionId: p.sessionId,
            agentTranscriptPath: p.transcriptPath
          })
        }
      }
    })
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {/* R5: the MCP board-snapshot publisher, as a render-nothing leaf. Its six-slice
          subscription re-renders at drag frequency — confining that to a null-returning
          leaf is what stops it re-rendering every sibling below (audit P-1). */}
      <McpPublisher />
      {/* Phase 4c: a permanent viewport-sized wrapper so Canvas keeps its tree position
          across the transition (adding/removing a wrapper would REMOUNT it — killing the
          PTY/preview keep-alive the epic exists for). WelcomeScreen is suppressed while
          the overlay is up (its D0-7 loading line remains the no-overlay fallback: a
          welcome-screen open never arms, and the watchdog force-clear lands back here). */}
      <div className={switchPhase === 'in' ? 'st-app-ground st-app-rise' : 'st-app-ground'}>
        {status === 'open' ? <Canvas /> : switchPhase === 'idle' ? <WelcomeScreen /> : null}
      </div>
      {status === 'open' && <AuditLogViewer />}
      {/* Phase 4b (bg sessions): the bottom-edge project dock — app-level (a sibling of
          Canvas, like AskOnSwitchModal), gated on an open project so its hot zone can't
          fire over the welcome/loading screens; a switch's 'loading' unmount auto-closes it. */}
      {status === 'open' && <ProjectDock />}
      {/* Voice V3: pill + flyout — screen-fixed overlay islands (not inside React Flow);
          dictation needs an open canvas (terminal targets), so they gate on it too. */}
      {status === 'open' && <VoicePill />}
      {/* Jarvis: the right-side panel + collapsed edge tab (surface rev, KICKOFF-PANEL).
          Conversation grounds in the open canvas (workspace manifest), so it gates on it
          too — and unmounting on project close runs the structural mic-gate teardown. */}
      {status === 'open' && <JarvisPanel />}
      <ConfirmModal />
      {/* relay_prompts: the per-row BATCH confirm gate — app-level beside ConfirmModal, its own
          FIFO queue on the mcp:confirm:batch channel. Same click-outside-inert / Esc-denies contract. */}
      <BatchConfirmModal />
      {/* Phase 4 (bg sessions): app-level like ConfirmModal — the ask-on-switch decision is
          awaited mid-switch-pipeline and must not depend on any project-scoped surface. */}
      <AskOnSwitchModal />
      {/* PR-2 background sessions: the close-with-running-sessions modal — app-level like
          ConfirmModal (MAIN's close guard must reach it whatever surface/project is open). */}
      <CloseSessionsModal />
      {/* Phase 4c: the switch-transition overlay — z above Canvas/Welcome, below modals
          (the ask dialog settles BEFORE the overlay arms; Cancel paths never reach arm). */}
      <SwitchTransitionOverlay />
      {/* Running-projects switcher (Alt-Tab-style picker). App-level + self-gating on its store's
          `open`, so the switch hotkey can raise it over any surface and it survives the switch. */}
      <RunningProjectSwitcher />
      {/* D1-A: app-level so toasts survive a project switch and show on the welcome
          screen too (a failed final flush aborts the switch — its toast must outlive
          whatever surface raised it). */}
      <ToastIsland />
      {/* Phase 5 auto-update: the tiered update surfaces (optional toast / recommended banner /
          mandatory blocking modal). App-level + self-gating on main's update status — a no-op in
          unsigned/dev builds (no updater is wired, so no status events fire). */}
      <UpdateSurfaces />
      {/* Phase 1 accounts: the forced sign-in gate. `__REQUIRE_ACCOUNT__` is a build-time
          constant that DEFAULTS OFF (electron.vite.config.ts renderer define) — so this whole
          branch is dead-code-eliminated in normal builds and Phase 1 behaves exactly like today.
          It shows only on a CONFIRMED 'signed-out' (never the brief boot 'checking'), as a locked
          overlay (Esc/scrim disabled, no Cancel) over the app. */}
      {__REQUIRE_ACCOUNT__ && accountStatus === 'signed-out' && (
        <SignInView forced onClose={noop} />
      )}
    </div>
  )
}

export default App
