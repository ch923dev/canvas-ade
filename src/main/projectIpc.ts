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

function isForeignSender(e: IpcMainInvokeEvent, getWin: () => BrowserWindow | null): boolean {
  const main = getWin()?.webContents.mainFrame
  return !!main && !!e.senderFrame && e.senderFrame !== main
}

export function registerProjectHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string,
  now: () => number = () => Date.now()
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

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
