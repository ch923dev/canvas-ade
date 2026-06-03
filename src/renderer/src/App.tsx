import { useEffect } from 'react'
import Canvas from './canvas/Canvas'
import WelcomeScreen from './canvas/WelcomeScreen'
import AuditLogViewer from './canvas/AuditLogViewer'
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

  useEffect(() => {
    // E2E (CANVAS_SMOKE=e2e) seeds boards directly and never opens a project. Flip to
    // `open` so the canvas mounts (and installs `window.__canvasE2E`); the disk path
    // (project.current) is irrelevant under the harness.
    if (isE2E()) {
      useCanvasStore.setState({ project: { dir: null, name: 'e2e', status: 'open' } })
      return
    }
    void window.api.project.current().then((r) => {
      if (r && r.ok) applyOpenResult(r)
      // null → stay on the welcome screen (initial status is 'welcome').
    })
  }, [applyOpenResult])

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      {status === 'open' ? <Canvas /> : <WelcomeScreen />}
      {status === 'open' && <AuditLogViewer />}
    </div>
  )
}

export default App
