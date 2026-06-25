// src/main/shellIpc.ts
/**
 * Frame-guarded "open this URL in the OS browser" IPC — a GENERAL external-open channel for app
 * surfaces that produce a clickable URL outside the Browser-preview subsystem (Phase 4 terminal
 * web-links today; any future caller). The renderer is sandboxed and never opens a URL itself; it
 * invokes this and MAIN re-validates the scheme against the ONE allowlist (previewShared ›
 * openExternalSafe / isAllowedExternal, "Bug #23": http/https/mailto only) before
 * shell.openExternal — never trust the renderer for an OS-level open. The injected `open` (default
 * openExternalSafe) keeps the handler unit-testable without Electron. Mirrors clipboardIpc.ts.
 */
import { type IpcMain, type BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { openExternalSafe } from './previewShared'

export function registerShellHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  open: (url: string) => boolean = openExternalSafe
): void {
  ipc.handle('shell:openExternal', (e, url: string) => {
    if (isForeignSender(e, getWin)) return false
    // Coerce non-strings to '' so the allowlist parse rejects them (returns false) rather than
    // throwing; the scheme is the real gate, enforced inside `open` (openExternalSafe).
    return open(typeof url === 'string' ? url : '')
  })
}
