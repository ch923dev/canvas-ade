/**
 * Welcome / project-picker screen — shown when no project is open (status welcome|error).
 * Create a project (pick a folder + name = folder basename), open an existing folder, or
 * pick from the recent list. On success the store flips to `open` and the canvas mounts.
 */
import { useEffect, useState } from 'react'
import { useCanvasStore, type RecentProject } from '../store/canvasStore'

export default function WelcomeScreen(): React.ReactElement {
  const applyOpenResult = useCanvasStore((s) => s.applyOpenResult)
  const setProjectLoading = useCanvasStore((s) => s.setProjectLoading)
  const error = useCanvasStore((s) => s.project.error)
  const [recents, setRecents] = useState<RecentProject[]>([])

  useEffect(() => {
    void window.api.project.recents().then(setRecents)
  }, [])

  const openDir = async (dir: string): Promise<void> => {
    setProjectLoading()
    // applyOpenResult is async (it may retry canvas.json.bak on a deep-validation failure).
    await applyOpenResult(await window.api.project.open(dir))
  }

  const onOpen = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (dir) await openDir(dir)
  }

  const onCreate = async (): Promise<void> => {
    const dir = await window.api.dialog.openFolder()
    if (!dir) return
    setProjectLoading()
    const name =
      dir
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() || dir
    await applyOpenResult(await window.api.project.create(dir, name, {}))
  }

  return (
    <div className="welcome">
      <h1>Canvas ADE</h1>
      {error && <p className="welcome-error">Could not open project: {error}</p>}
      <div className="welcome-actions">
        <button onClick={onCreate}>Create project…</button>
        <button onClick={onOpen}>Open folder…</button>
      </div>
      {recents.length > 0 && (
        <ul className="welcome-recents">
          {recents.map((r) => (
            <li key={r.path}>
              <button onClick={() => openDir(r.path)} title={r.path}>
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
