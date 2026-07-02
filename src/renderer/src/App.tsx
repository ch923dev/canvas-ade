import { useEffect } from 'react'
import Canvas from './canvas/Canvas'
import WelcomeScreen from './canvas/WelcomeScreen'
import AuditLogViewer from './canvas/AuditLogViewer'
import ConfirmModal from './canvas/ConfirmModal'
import AskOnSwitchModal from './canvas/AskOnSwitchModal'
import ProjectDock from './canvas/ProjectDock'
import SwitchTransitionOverlay from './canvas/SwitchTransitionOverlay'
import { useSwitchTransitionStore } from './store/switchTransitionStore'
import { ToastIsland } from './canvas/Toast'
import { useUpdateToasts } from './canvas/useUpdateToasts'
import { useRendererSmoke } from './smoke/useRendererSmoke'
import { useMcpPublish } from './store/useMcpPublish'
import { useMcpCommands } from './store/useMcpCommands'
import { useCanvasStore, patchBoardMeta } from './store/canvasStore'
import { useAccountStore, useAccountSync } from './store/accountStore'
import { SignInView } from './canvas/SignInView'
import { useAutosave } from './store/useAutosave'
import { useVoiceCapture } from './voice/useVoiceCapture'
import { isE2E } from './smoke/e2eRegistry'

/**
 * App root. On boot, ask MAIN for the most-recent project (auto-reopen); fall back to
 * the welcome screen. The canvas mounts only when a project is open; autosave is armed
 * globally and self-gates on project status.
 */
function App(): React.ReactElement {
  useRendererSmoke()
  useAutosave()
  useMcpPublish()
  useMcpCommands()
  useUpdateToasts()
  // Phase 1 accounts: hydrate the account store at boot + subscribe to MAIN's auth:statusChanged.
  useAccountSync()
  // Voice V1: arm the mic-capture controller — the MessagePort MAIN transfers on
  // voice:session:start is the start signal (see useVoiceCapture).
  useVoiceCapture()

  const status = useCanvasStore((s) => s.project.status)
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
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

  useEffect(() => {
    // E2E (CANVAS_E2E) seeds boards directly and never opens a project. Flip to
    // `open` so the canvas mounts (and installs `window.__canvasE2E`); the disk path
    // (project.current) is irrelevant under the harness.
    if (isE2E()) {
      useCanvasStore.setState({ project: { dir: null, name: 'e2e', status: 'open' } })
      return
    }
    void window.api.project.current().then((r) => {
      // applyOpenResult is async (it may retry canvas.json.bak on a deep-validation
      // failure); await it INSIDE the .then so its promise (and any rejection) is owned
      // here instead of floating unhandled.
      if (r && r.ok) return applyOpenResult(r)
      // null → stay on the welcome screen (initial status is 'welcome').
      return undefined
    })
  }, [applyOpenResult])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
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
      <ConfirmModal />
      {/* Phase 4 (bg sessions): app-level like ConfirmModal — the ask-on-switch decision is
          awaited mid-switch-pipeline and must not depend on any project-scoped surface. */}
      <AskOnSwitchModal />
      {/* Phase 4c: the switch-transition overlay — z above Canvas/Welcome, below modals
          (the ask dialog settles BEFORE the overlay arms; Cancel paths never reach arm). */}
      <SwitchTransitionOverlay />
      {/* D1-A: app-level so toasts survive a project switch and show on the welcome
          screen too (a failed final flush aborts the switch — its toast must outlive
          whatever surface raised it). */}
      <ToastIsland />
      {/* Phase 1 accounts: the forced sign-in gate. `__REQUIRE_ACCOUNT__` is a build-time
          constant that DEFAULTS OFF (electron.vite.config.ts renderer define) — so this whole
          branch is dead-code-eliminated in normal builds and Phase 1 behaves exactly like today.
          It shows only on a CONFIRMED 'signed-out' (never the brief boot 'checking'), as a locked
          overlay (Esc/scrim disabled, no Cancel) over the app. */}
      {__REQUIRE_ACCOUNT__ && accountStatus === 'signed-out' && (
        <SignInView forced onClose={() => {}} />
      )}
    </div>
  )
}

export default App
