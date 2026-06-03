/**
 * Project IPC: folder picker + canvas.json open/create/save + recent-projects.
 * MAIN owns the "current dir"; the renderer drives saves (Approach A). All handlers
 * reject foreign senders (BUG-033 defense-in-depth), matching pty/preview.
 */
import path from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import {
  readProject,
  writeProject,
  createProject,
  getCurrentDir,
  setCurrentDir,
  projectName,
  writeAsset,
  readAsset,
  collectAssetIds,
  gcAssets,
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

/**
 * True when a renderer-supplied project dir must be REJECTED before any fs touch
 * (M-6): a non-empty absolute path with no `..` traversal segment is required.
 * Real OS-dialog results are already absolute + normalized, so legit flows pass.
 * Pure + exported for unit tests.
 */
export function isUnsafeProjectDir(dir: string): boolean {
  if (typeof dir !== 'string' || dir.length === 0) return true
  // Accept an absolute path in EITHER flavor: `path.isAbsolute` is host-specific
  // (POSIX rejects `C:\...`, Win32 accepts `/...`), so the bare check made the M-6
  // unit test pass on Windows but fail on the Linux CI runner. The `..`-traversal
  // guard below is separator-agnostic, so honoring both forms loses no safety.
  if (!path.win32.isAbsolute(dir) && !path.posix.isAbsolute(dir)) return true
  // `path.normalize` collapses `..`, so a traversal that fully resolves
  // (e.g. `C:\Users\x\..\..\evil` → `C:\evil`) would slip past a check on the
  // normalized form. Reject any `..` segment in the ORIGINAL input instead —
  // legit OS-dialog paths never contain one.
  return path.normalize(dir).split(/[/\\]/).includes('..') || dir.split(/[/\\]/).includes('..')
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
    if (isUnsafeProjectDir(dir)) return { ok: false, error: 'invalid path' }
    const r = readProject(dir)
    remember(r)
    if (r.ok) gcAssets(r.dir, collectAssetIds(r.doc))
    return r
  })

  ipcMain.handle(
    'project:create',
    async (
      e,
      args: {
        dir: string
        name: string
        opts: { gitInit?: boolean }
      }
    ): Promise<ProjectResult> => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      if (isUnsafeProjectDir(args.dir)) return { ok: false, error: 'invalid path' }
      const r = await createProject(args.dir, args.name, args.opts ?? {})
      remember(r)
      return r
    }
  )

  ipcMain.handle('project:save', async (e, doc: unknown): Promise<boolean> => {
    if (guard(e)) return false
    const dir = getCurrentDir()
    if (!dir) return false
    // SAVE-1: a write failure (disk full, permission denied, envelope-invalid doc)
    // must report failure to the renderer, not reject opaquely. The renderer's
    // autosaver surfaces a `false`/rejection via its onError hook so a failing disk
    // is visible instead of silently swallowed.
    try {
      await writeProject(dir, doc)
      return true
    } catch (err) {
      console.error('project:save failed', err)
      return false
    }
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
      gcAssets(r.dir, collectAssetIds(r.doc))
    }
    return r.ok ? r : null
  })

  ipcMain.handle(
    'asset:write',
    async (
      e,
      args: { bytes: Uint8Array; ext: string }
    ): Promise<{ assetId: string } | { error: string }> => {
      if (guard(e)) return { error: 'forbidden' }
      const dir = getCurrentDir()
      if (!dir) return { error: 'no project open' }
      try {
        return await writeAsset(dir, args.bytes, args.ext)
      } catch (err) {
        return { error: String((err as Error)?.message ?? err) }
      }
    }
  )

  ipcMain.handle('asset:read', (e, assetId: string): Uint8Array | null => {
    if (guard(e)) return null
    const dir = getCurrentDir()
    if (!dir) return null
    return readAsset(dir, assetId)
  })

  ipcMain.handle(
    'export:save',
    async (
      e,
      args: { bytes: Uint8Array; ext: 'png' | 'svg'; defaultName: string }
    ): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }> => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      const win = getWin()
      const ext = args.ext === 'png' ? 'png' : 'svg'
      const safeName = (args.defaultName || 'whiteboard').replace(/[^\w.-]+/g, '_')
      const opts = {
        defaultPath: `${safeName}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
      }
      const res = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        await writeFileAtomic(res.filePath, Buffer.from(args.bytes))
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) }
      }
    }
  )
}
