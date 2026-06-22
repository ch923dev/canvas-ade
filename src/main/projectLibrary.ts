import { app, shell } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { isForeignSender } from './ipcGuard'
import { assetsDirOf, downloadsDirOf, getCurrentDir } from './projectStore'

/**
 * Project Library — a project-level browser for files saved INTO the project under `<project>/.canvas/`
 * (ADR 0009): the OSR Browser boards' downloads (`.canvas/downloads/`) and the canvas asset store
 * (`.canvas/assets/`). Distinct from the per-board DevTools Assets/Downloads tabs, which inspect the
 * CURRENT page's network resources — this lists durable files on disk.
 *
 * Security: every path this module resolves is confined to `<project>/.canvas/{downloads,assets}` and
 * re-validated with `resolve()` + prefix check, so a compromised renderer can neither enumerate nor
 * reveal/open anything outside the project's `.canvas/` tree. All IPC is `isForeignSender` frame-guarded.
 */

export type LibraryKind = 'download' | 'asset'

export interface LibraryItem {
  /** Display name (basename). Downloads keep their saved filename; assets are `<sha1>.<ext>`. */
  name: string
  /** Path relative to `.canvas/` (e.g. `downloads/report.pdf`, `assets/<sha1>.png`) — the reveal/open key. */
  relPath: string
  /** Bytes on disk. */
  size: number
  /** Last-modified epoch ms (the list is sorted newest-first). */
  mtime: number
  kind: LibraryKind
}

export interface LibraryListing {
  /** Absolute `.canvas/downloads` dir for the panel footer (always shown, even when empty). */
  downloadsDir: string
  downloads: LibraryItem[]
  assets: LibraryItem[]
}

/**
 * The OSR download save dir: the open project's `.canvas/downloads/` (ADR 0009), or the OS Downloads
 * folder when no project is open. The dir is NOT created here — `registerOsrDownloads` ensures it
 * (mkdir -p) at save time so an unopened project never spuriously scaffolds a stray folder.
 */
export function getDownloadsDir(): string {
  const dir = getCurrentDir()
  return dir ? downloadsDirOf(dir) : app.getPath('downloads')
}

/** List the regular files directly inside `dir` as LibraryItems (skips subdirs like `.trash`). */
function listDir(dir: string, kind: LibraryKind, relBase: string): LibraryItem[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const items: LibraryItem[] = []
  for (const name of names) {
    try {
      const st = statSync(resolve(dir, name))
      if (!st.isFile()) continue // skip `.trash/` and any nested dir
      items.push({ name, relPath: `${relBase}/${name}`, size: st.size, mtime: st.mtimeMs, kind })
    } catch {
      /* a vanished/locked entry must not abort the listing */
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime)
}

/** Enumerate a project's `.canvas/downloads/` + `.canvas/assets/` (newest-first per tab). */
export function listLibrary(projectDir: string): LibraryListing {
  return {
    downloadsDir: downloadsDirOf(projectDir),
    downloads: listDir(downloadsDirOf(projectDir), 'download', 'downloads'),
    assets: listDir(assetsDirOf(projectDir), 'asset', 'assets')
  }
}

/**
 * Resolve a renderer-supplied `relPath` to an absolute path ONLY if it lands directly inside
 * `<project>/.canvas/downloads` or `.../assets` (no traversal, no nested dirs). Returns null otherwise
 * — the containment guard for reveal/open. A single path segment is required (basename === relPath tail).
 */
export function resolveLibraryItem(projectDir: string, relPath: string): string | null {
  if (typeof relPath !== 'string' || !relPath) return null
  const full = resolve(projectDir, '.canvas', relPath)
  for (const base of [downloadsDirOf(projectDir), assetsDirOf(projectDir)]) {
    const baseR = resolve(base)
    // Must sit DIRECTLY inside the base dir: prefixed by `<base>/` and a single remaining segment.
    if (full.startsWith(baseR + sep) && basename(full) === full.slice(baseR.length + 1)) {
      return full
    }
  }
  return null
}

/** Register the Project Library IPC (list · reveal · open). Frame-guarded; confined to `.canvas/`. */
export function registerProjectLibraryIpc(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.handle('project:listLibrary', (ev): LibraryListing | null => {
    if (isForeignSender(ev, getWin)) return null
    const dir = getCurrentDir()
    return dir ? listLibrary(dir) : null
  })
  ipcMain.handle('project:revealLibraryItem', (ev, relPath: string): boolean => {
    if (isForeignSender(ev, getWin)) return false
    const dir = getCurrentDir()
    if (!dir) return false
    const full = resolveLibraryItem(dir, relPath)
    if (!full || !existsSync(full)) return false
    shell.showItemInFolder(full)
    return true
  })
  ipcMain.handle('project:openLibraryItem', async (ev, relPath: string): Promise<boolean> => {
    if (isForeignSender(ev, getWin)) return false
    const dir = getCurrentDir()
    if (!dir) return false
    const full = resolveLibraryItem(dir, relPath)
    if (!full || !existsSync(full)) return false
    const err = await shell.openPath(full) // '' on success; a message string on failure
    return err === ''
  })
}
