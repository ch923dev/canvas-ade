import { useEffect } from 'react'
import Canvas from './canvas/Canvas'
import WelcomeScreen from './canvas/WelcomeScreen'
import AuditLogViewer from './canvas/AuditLogViewer'
import ConfirmModal from './canvas/ConfirmModal'
import { useRendererSmoke } from './smoke/useRendererSmoke'
import { useMcpPublish } from './store/useMcpPublish'
import { useMcpCommands } from './store/useMcpCommands'
import { useCanvasStore } from './store/canvasStore'
import { useAutosave } from './store/useAutosave'
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

  const status = useCanvasStore((s) => s.project.status)
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)

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
  // survives reload. Patch only boards that still exist (the store's `boards` is an array;
  // updateBoard filters to PATCHABLE_KEYS, which now allows these two terminal-only fields).
  // Guarded for non-electron test runtimes; the effect returns onLearned's disposer.
  useEffect(() => {
    const onLearned = window.api?.recap?.onLearned
    if (!onLearned) return
    return onLearned((patches) => {
      const s = useCanvasStore.getState()
      for (const p of patches) {
        if (s.boards.some((b) => b.id === p.boardId)) {
          s.updateBoard(p.boardId, {
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
      {status === 'open' ? <Canvas /> : <WelcomeScreen />}
      {status === 'open' && <AuditLogViewer />}
      <ConfirmModal />
    </div>
  )
}

export default App
