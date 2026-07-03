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
import { getCurrentDir } from './projectStore'
import { takeExitResidue, peekRingWritten, setFlushWatermark, type ExitResidue } from './pty'
import {
  writeTerminalSnapshot,
  writeTerminalSnapshotAsync,
  readTerminalSnapshot,
  deleteTerminalSnapshot
} from './terminalSnapshot'

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

  // ── Phase 5 · S3: persist/restore terminal scrollback across restart ──
  // The renderer serializes its live xterm buffer and hands the ANSI string over; MAIN writes it to
  // a per-board sidecar under the open project's `.canvas/terminal/`. All three resolve the dir via
  // getCurrentDir() (never a renderer-supplied path) and no-op when no project is open — the write
  // target is confined to `.canvas/` by construction, so no path escapes the sandbox. Read-only
  // w.r.t. the shell (serialize reads the renderer buffer): the PTY-write invariants are untouched.
  //
  // `sync` defaults false (async write) so a large scrollback buffer never blocks MAIN's single
  // thread during ordinary teardown (project switch, window blur). The renderer passes `sync: true`
  // only for the main-driven `project:flush` before-quit round-trip, where the process may exit right
  // after this resolves and a synchronous write is the only way to guarantee the bytes land first.
  ipc.handle(
    'terminal:writeSnapshot',
    (
      e,
      boardId: string,
      text: string,
      sync?: boolean,
      expectedDir?: string
    ): boolean | Promise<boolean> => {
      if (guard(e)) return false
      const dir = getCurrentDir()
      if (!dir) return false
      // Background sessions (R2, BUG-009-style): the renderer pins the write to the project it
      // BELIEVES it is flushing. Today the pre-switch flush is safe only by ordering accident
      // (flush runs before currentDir flips); with resident background projects, any late flush
      // landing after a switch would write board A's scrollback into project B's
      // `.canvas/terminal/` under a colliding id. Reject on mismatch; absent = legacy caller.
      if (expectedDir !== undefined && expectedDir !== dir) return false
      const safeText = typeof text === 'string' ? text : ''
      const id = String(boardId)
      // Phase 5 splice (review fix): capture the ring watermark at handler ENTRY — the closest
      // MAIN-side point to the renderer's serialize — and commit it only when the write LANDS.
      // The background park then splices the tail from here instead of from park time, so
      // output arriving between this flush and the park is replayed, not silently dropped.
      const written = peekRingWritten(id)
      const commit = (ok: boolean): boolean => {
        if (ok && written !== null) setFlushWatermark(id, written)
        return ok
      }
      return sync
        ? commit(writeTerminalSnapshot(dir, id, safeText))
        : writeTerminalSnapshotAsync(dir, id, safeText).then(commit)
    }
  )

  ipc.handle('terminal:readSnapshot', (e, boardId: string): string | null => {
    if (guard(e)) return null
    const dir = getCurrentDir()
    if (!dir) return null
    return readTerminalSnapshot(dir, String(boardId))
  })

  // Phase 5 (bg sessions R6 UX): consume-on-read exit residue — what a background-parked
  // proc said + its exit code when it died while its project was switched away. Scoped to
  // the ACTIVE project inside takeExitResidue (compound key), so a cloned project sharing
  // board UUIDs can never read another project's last words. One read = gone (the restored
  // bar shows it once; a later remount is a plain snapshot restore).
  ipc.handle('terminal:exitResidue', (e, boardId: string): ExitResidue | null => {
    if (guard(e)) return null
    return takeExitResidue(String(boardId)) ?? null
  })

  ipc.handle('terminal:deleteSnapshot', (e, boardId: string, expectedDir?: string): boolean => {
    if (guard(e)) return false
    const dir = getCurrentDir()
    if (!dir) return false
    // R2 dir-pin, mirroring writeSnapshot: a delete raced across a switch must not remove a
    // colliding board's sidecar in the newly-active project.
    if (expectedDir !== undefined && expectedDir !== dir) return false
    deleteTerminalSnapshot(dir, String(boardId))
    return true
  })
}
