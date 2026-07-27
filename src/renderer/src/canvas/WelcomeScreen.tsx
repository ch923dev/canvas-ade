/**
 * Welcome / project-picker screen — shown when no project is open (status welcome|error).
 * Create a project (pick a folder + name = folder basename), open an existing folder, or
 * pick from the recent list. On success the store flips to `open` and the canvas mounts.
 */
import { useEffect, useState } from 'react'
import { useCanvasStore, type RecentProject } from '../store/canvasStore'
import { openProject } from '../store/openProject'

export default function WelcomeScreen(): React.ReactElement {
  const error = useCanvasStore((s) => s.project.error)
  // D0-7: this screen also renders MID-SWITCH (status 'loading' unmounts Canvas), where
  // its own `busy` flag can't see the in-flight pipeline — read the status so a project
  // switch shows a loading line instead of a fully interactive picker flash.
  const status = useCanvasStore((s) => s.project.status)
  const [recents, setRecents] = useState<RecentProject[]>([])
  // BUG-008: busy guard — blocks concurrent openDir/onCreate calls while a project IPC is
  // in-flight. Without this, a double-click or two rapid distinct clicks fire two concurrent
  // `project:open` calls; both call applyOpenResult and the last to resolve overwrites state.
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.project.recents().then(setRecents)
  }, [])

  const openDir = async (dir: string): Promise<void> => {
    // BUG-008: return early if an IPC call is already in-flight on THIS mount. This is the
    // BUTTON-disabling half only; the cross-surface race (BUG-009) is the shared lock's job, and
    // `openProject` takes it — a switch started from the ProjectSwitcher mounts this screen fresh
    // (busy=false), so the per-mount flag alone can never see it.
    if (busy) return
    setBusy(true)
    try {
      await openProject(() => window.api.project.open(dir))
    } finally {
      setBusy(false)
    }
  }

  const onOpen = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (dir) await openDir(dir)
  }

  const onCreate = async (): Promise<void> => {
    // BUG-008: return early if an IPC call is already in-flight.
    if (busy) return
    const dir = await window.api.dialog.openFolder()
    if (!dir) return
    setBusy(true)
    const name =
      dir
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() || dir
    try {
      // BUG-009: the lock is taken inside `openProject`, i.e. AFTER the modal folder dialog above —
      // a cancelled dialog returns before we ever get here, so it can never strand the lock.
      await openProject(() => window.api.project.create(dir, name, {}), 'failed to create project')
    } finally {
      setBusy(false)
    }
  }

  // Remove one entry / clear the whole recents list. LIST-ONLY (the project folder on
  // disk is never touched); main returns the fresh list, so re-render from the reply.
  // A rejected IPC keeps the current list (visible-but-removable beats a vanished list)
  // and must not surface as an unhandled rejection from an event handler.
  const onRemoveRecent = async (path: string): Promise<void> => {
    try {
      setRecents(await window.api.project.removeRecent(path))
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[WelcomeScreen] removeRecent failed; keeping the current list', err)
    }
  }

  const onClearRecents = async (): Promise<void> => {
    try {
      setRecents(await window.api.project.clearRecents())
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[WelcomeScreen] clearRecents failed; keeping the current list', err)
    }
  }

  // D0-7: any in-flight load — this screen's own IPC (busy) or a switch pipeline that
  // unmounted Canvas (status 'loading') — disables the picker and says so.
  const loading = busy || status === 'loading'
  return (
    <div className="welcome">
      <h1>Canvas ADE</h1>
      {error && <p className="welcome-error">Could not open project: {error}</p>}
      {loading && (
        <p className="welcome-loading" role="status">
          Loading project…
        </p>
      )}
      <div className="welcome-actions">
        {/* BUG-008: disable all action buttons while a project IPC is in-flight */}
        <button onClick={onCreate} disabled={loading}>
          Create project…
        </button>
        <button onClick={onOpen} disabled={loading}>
          Open folder…
        </button>
      </div>
      {recents.length > 0 && (
        <div className="welcome-recents-wrap">
          <div className="welcome-recents-head">
            <span className="welcome-recents-label">Recent</span>
            <button className="welcome-clear-recents" onClick={onClearRecents} disabled={loading}>
              Clear all
            </button>
          </div>
          <ul className="welcome-recents">
            {recents.map((r) => (
              <li key={r.path}>
                <button
                  className="recent-open"
                  onClick={() => openDir(r.path)}
                  title={r.path}
                  disabled={loading}
                >
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-path">{r.path}</span>
                </button>
                <button
                  className="recent-remove"
                  onClick={() => onRemoveRecent(r.path)}
                  disabled={loading}
                  title="Remove from list"
                  aria-label={`Remove ${r.name} from recent projects`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
