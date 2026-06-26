// src/main/terminalIpc.ts
/**
 * Frame-guarded terminal IPC (Phase 5). S1: `terminal:saveOutput` — the renderer hands over
 * the already-serialized buffer text + a suggested filename; MAIN drives the native save
 * dialog (the renderer can never pick a path silently) and writes the user-chosen file
 * atomically. Mirrors the whiteboard `export:save` model (projectIpc.ts).
 *
 * No PTY involvement: this is read-only w.r.t. the shell, so the "terminal input is
 * trusted-user-only" / "browser content never reaches the PTY" invariants are untouched.
 * Every handler rejects foreign senders via the single trust-boundary guard, matching
 * pty/clipboard/project.
 */
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import { isForeignSender } from './ipcGuard'

export interface TerminalSaveArgs {
  text: string
  suggestedName: string
}
export type TerminalSaveResult =
  | { ok: true; path: string }
  | { ok: false; canceled?: boolean; error?: string }

export function registerTerminalHandlers(ipc: IpcMain, getWin: () => BrowserWindow | null): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipc.handle(
    'terminal:saveOutput',
    async (e, args: TerminalSaveArgs): Promise<TerminalSaveResult> => {
      if (guard(e)) return { ok: false, error: 'forbidden' }
      const win = getWin()
      // Sanitize the renderer-supplied name to a bare filename (defense-in-depth — the
      // dialog already prevents a silent path pick), then ensure a .txt extension.
      const raw = (args?.suggestedName || 'terminal-output').replace(/[^\w.-]+/g, '_')
      const safeName = /\.txt$/i.test(raw) ? raw : `${raw}.txt`
      const opts = {
        title: 'Save terminal output',
        defaultPath: safeName,
        filters: [
          { name: 'Text', extensions: ['txt'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        await writeFileAtomic(res.filePath, typeof args?.text === 'string' ? args.text : '')
        return { ok: true, path: res.filePath }
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message ?? err) }
      }
    }
  )
}
