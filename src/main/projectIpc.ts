/**
 * Project IPC: folder picker + canvas.json open/create/save + recent-projects.
 * MAIN owns the "current dir"; the renderer drives saves (Approach A). All handlers
 * reject foreign senders (BUG-033 defense-in-depth), matching pty/preview.
 */
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  readProject,
  writeProject,
  createProject,
  getCurrentDir,
  setCurrentDir,
  projectName,
  type ProjectResult
} from './projectStore'
import { listRecents, touchRecent, type RecentProject } from './recentProjects'

/**
 * True when an IPC sender is NOT the main window's main frame (foreign → deny).
 * BUG-M6: the old guard returned `false` (allowed) when `getWin()` was null (window
 * destroyed), letting a real-but-unresolved sender through. Now: a synthetic call
 * (no `senderFrame`) is internal → allow; a real sender against an unresolved window
 * is treated as foreign → deny; otherwise compare against the live main frame.
 *
 * Exported (with an injectable main-frame getter) so it is unit-testable.
 */
export function isForeignSender(
  e: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  getMainFrame: () => BrowserWindow['webContents']['mainFrame'] | null | undefined
): boolean {
  const main = getMainFrame()
  if (!e.senderFrame) return false // synthetic/internal call — allow
  if (!main) return true // real sender but window unresolved — treat as foreign, DENY
  return e.senderFrame !== main
}

export function registerProjectHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  now: () => number = () => Date.now()
): void {
  const guard = (e: IpcMainInvokeEvent): boolean =>
    isForeignSender(e, () => getWin()?.webContents.mainFrame)

  ipcMain.handle('dialog:openFolder', async (e): Promise<string | null> => {
    if (guard(e)) return null
    const win = getWin()
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  const remember = (r: ProjectResult): void => {
    if (r.ok) {
      setCurrentDir(r.dir)
      touchRecent(userDataDir, r.dir, r.name, now())
    }
  }

  ipcMain.handle('project:open', (e, dir: string): ProjectResult => {
    if (guard(e)) return { ok: false, error: 'forbidden' }
    const r = readProject(dir)
    remember(r)
    return r
  })

  ipcMain.handle(
    'project:create',
    (e, args: { dir: string; name: string; opts: { gitInit?: boolean } }): ProjectResult => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      const r = createProject(args.dir, args.name, args.opts ?? {})
      remember(r)
      return r
    }
  )

  ipcMain.handle('project:save', async (e, doc: unknown): Promise<boolean> => {
    if (guard(e)) return false
    const dir = getCurrentDir()
    if (!dir) return false
    await writeProject(dir, doc)
    return true
  })

  ipcMain.handle('project:recents', (e): RecentProject[] => {
    if (guard(e)) return []
    return listRecents(userDataDir)
  })

  ipcMain.handle('project:current', (e): ProjectResult | null => {
    if (guard(e)) return null
    const recents = listRecents(userDataDir)
    if (recents.length === 0) return null
    const r = readProject(recents[0].path)
    if (r.ok) {
      setCurrentDir(r.dir)
      touchRecent(userDataDir, r.dir, projectName(r.dir), now())
    }
    return r.ok ? r : null
  })
}
