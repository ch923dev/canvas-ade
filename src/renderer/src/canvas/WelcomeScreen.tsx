/**
 * Welcome / project-picker screen — shown when no project is open (status welcome|error).
 * Create a project (pick a folder + name = folder basename), open an existing folder, or
 * pick from the recent list. On success the store flips to `open` and the canvas mounts.
 */
import { useEffect, useState } from 'react'
import {
  useCanvasStore,
  acquireProjectSwitchLock,
  releaseProjectSwitchLock,
  type RecentProject
} from '../store/canvasStore'

export default function WelcomeScreen(): React.ReactElement {
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
  const setProjectLoading = useCanvasStore((s) => s.setProjectLoading)
  const error = useCanvasStore((s) => s.project.error)
  const [recents, setRecents] = useState<RecentProject[]>([])
  // BUG-008: busy guard — blocks concurrent openDir/onCreate calls while a project IPC is
  // in-flight. Without this, a double-click or two rapid distinct clicks fire two concurrent
  // `project:open` calls; both call applyOpenResult and the last to resolve overwrites state.
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.project.recents().then(setRecents)
  }, [])

  const openDir = async (dir: string): Promise<void> => {
    // BUG-008: return early if an IPC call is already in-flight on THIS mount.
    // BUG-009: also take the module-level switch lock — a switch started from the
    // ProjectSwitcher (another surface) mounts this screen fresh mid-flight, so the
    // per-mount `busy` flag alone cannot see it and two open pipelines could interleave.
    if (busy || !acquireProjectSwitchLock()) return
    setBusy(true)
    setProjectLoading()
    try {
      // applyOpenResult is async (it may retry canvas.json.bak on a deep-validation failure).
      await applyOpenResult(await window.api.project.open(dir))
    } catch (err) {
      // BUG-030: if the IPC call rejects (e.g. disk-full in touchRecent / userData), settle
      // to status:'error' so the user can retry. Without this, status stays stuck at 'loading'.
      const msg = err instanceof Error ? err.message : 'failed to open project'
      await applyOpenResult({ ok: false, error: msg })
    } finally {
      setBusy(false)
      releaseProjectSwitchLock()
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
    // BUG-009: take the shared switch lock AFTER the (modal) folder dialog so a cancelled
    // dialog never strands it; bail if another surface's switch is mid-flight.
    if (!acquireProjectSwitchLock()) return
    setBusy(true)
    setProjectLoading()
    const name =
      dir
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() || dir
    try {
      await applyOpenResult(await window.api.project.create(dir, name, {}))
    } catch (err) {
      // BUG-030: if the IPC call rejects, settle to status:'error' so the user can recover.
      const msg = err instanceof Error ? err.message : 'failed to create project'
      await applyOpenResult({ ok: false, error: msg })
    } finally {
      setBusy(false)
      releaseProjectSwitchLock()
    }
  }

  return (
    <div className="welcome">
      <h1>Canvas ADE</h1>
      {error && <p className="welcome-error">Could not open project: {error}</p>}
      <div className="welcome-actions">
        {/* BUG-008: disable all action buttons while a project IPC is in-flight */}
        <button onClick={onCreate} disabled={busy}>
          Create project…
        </button>
        <button onClick={onOpen} disabled={busy}>
          Open folder…
        </button>
      </div>
      {recents.length > 0 && (
        <ul className="welcome-recents">
          {recents.map((r) => (
            <li key={r.path}>
              <button onClick={() => openDir(r.path)} title={r.path} disabled={busy}>
                <span className="recent-name">{r.name}</span>
                <span className="recent-path">{r.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
