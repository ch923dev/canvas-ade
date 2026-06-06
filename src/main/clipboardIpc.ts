// src/main/clipboardIpc.ts
/**
 * Frame-guarded clipboard + terminal-image-staging IPC. The renderer is sandboxed, so
 * all native clipboard reads/writes and temp-file writes happen here behind
 * isForeignSender (the single trust-boundary guard). Deps are injected so the handlers
 * are unit-testable without mocking Electron.
 */
import { clipboard, type IpcMain, type BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { stageClipboardImage, cleanupStaged } from './terminalImageStaging'
import { getCurrentDir } from './projectStore'

export interface ClipboardDeps {
  writeText(text: string): void
  readText(): string
  /** The clipboard image as PNG bytes, or null when the clipboard holds no image. */
  readImagePng(): Buffer | null
  /** The current project dir, or null when no project is open. */
  currentDir(): string | null
  stage(projectDir: string, boardId: string, png: Buffer): string
}

function realDeps(): ClipboardDeps {
  return {
    writeText: (t) => clipboard.writeText(t),
    readText: () => clipboard.readText(),
    readImagePng: () => {
      const img = clipboard.readImage()
      return img.isEmpty() ? null : img.toPNG()
    },
    currentDir: () => getCurrentDir(),
    stage: (dir, id, png) => stageClipboardImage(dir, id, png)
  }
}

export function registerClipboardHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ClipboardDeps = realDeps()
): void {
  ipc.handle('clipboard:writeText', (e, text: string) => {
    if (isForeignSender(e, getWin)) return false
    deps.writeText(typeof text === 'string' ? text : '')
    return true
  })

  ipc.handle('clipboard:readText', (e) => {
    if (isForeignSender(e, getWin)) return ''
    return deps.readText()
  })

  ipc.handle('terminal:stageClipboardImage', (e, boardId: string) => {
    if (isForeignSender(e, getWin)) return null
    const dir = deps.currentDir()
    if (!dir) return null
    const png = deps.readImagePng()
    if (!png) return null
    try {
      return deps.stage(dir, String(boardId), png)
    } catch {
      // Filesystem error (ENOSPC disk full, EPERM antivirus lock, read-only path, …).
      // Return null so the renderer falls through to the text-paste branch rather than
      // receiving a rejected ipcRenderer.invoke promise that void-discards silently.
      return null
    }
  })

  ipc.handle('terminal:cleanupStagedImages', (e, boardId: string) => {
    if (isForeignSender(e, getWin)) return false
    const dir = deps.currentDir()
    if (dir) cleanupStaged(dir, String(boardId))
    return true
  })
}
