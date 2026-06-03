import type { IpcMain, BrowserWindow, IpcMainEvent } from 'electron'

/** Minimal board projection the renderer pushes to MAIN (control plane; no content). */
export interface BoardMirror {
  id: string
  type: string
  title: string
}

let mirror: BoardMirror[] = []

/** Bound the snapshot so a forged/oversized push on mcp:boards can't grow MAIN memory. */
const MAX_BOARDS = 500
const MAX_FIELD_LEN = 256

/**
 * Keep only well-formed {id,type,title} string entries; drop anything else.
 * Bounded: at most MAX_BOARDS entries, each field at most MAX_FIELD_LEN chars —
 * the renderer is trusted, but mcp:boards is an IPC channel, so a malformed/oversized
 * payload is capped rather than retained wholesale. `type` is intentionally left an
 * open string (forward board types are allowed); an unrecognized type maps to status
 * 'unknown' downstream rather than being dropped.
 */
export function sanitizeSnapshot(input: unknown): BoardMirror[] {
  if (!Array.isArray(input)) return []
  const out: BoardMirror[] = []
  for (const b of input) {
    if (out.length >= MAX_BOARDS) break
    if (
      b &&
      typeof b === 'object' &&
      typeof (b as BoardMirror).id === 'string' &&
      typeof (b as BoardMirror).type === 'string' &&
      typeof (b as BoardMirror).title === 'string'
    ) {
      const { id, type, title } = b as BoardMirror
      if (
        id.length > MAX_FIELD_LEN ||
        type.length > MAX_FIELD_LEN ||
        title.length > MAX_FIELD_LEN
      ) {
        continue
      }
      out.push({ id, type, title })
    }
  }
  return out
}

/** Last snapshot the renderer pushed (empty until the renderer mounts + publishes). */
export function listBoardMirror(): BoardMirror[] {
  return mirror
}

/** Test seam — set the mirror directly (unit tests only). */
export function __setMirrorForTest(next: BoardMirror[]): void {
  mirror = next
}

/**
 * Register the renderer→MAIN board-snapshot channel. Sender-guarded so only the
 * main window's main frame can publish (mirrors pty.ts's isForeignSender). The
 * snapshot is control-plane metadata only — never board content.
 */
export function registerBoardRegistryHandler(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void {
  ipcMain.on('mcp:boards', (e: IpcMainEvent, boards: unknown) => {
    const main = getWin()?.webContents.mainFrame
    if (main && e.senderFrame && e.senderFrame !== main) return // foreign frame
    mirror = sanitizeSnapshot(boards)
  })
}
