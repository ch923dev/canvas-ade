/**
 * Pending-notification queue for the dead-window case (audit P1-1 / P2-3). `deliver`'s renderer
 * push and the OS-click focus intent both used to hit `if (!win || win.isDestroyed()) return` —
 * every lifecycle event fired while tray-resident (or between window close and reopen) was lost
 * with no record. Now the dead-window branches ENQUEUE here, and the renderer DRAINS on mount.
 *
 * Pull, not push, deliberately: a MAIN-side `did-finish-load` push races the renderer, whose
 * `notify:lifecycle` listener installs only after React mounts — a push at load time is silently
 * dropped again, the identical bug one layer up. The renderer asking (`notify:drain`) in the SAME
 * effect that installs the listener is race-free by construction.
 *
 * Module-singleton state, same class as the board mirror: one queue per MAIN process, bounded
 * ring (drop-oldest — the freshest events are the ones worth replaying).
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/** Mirrors the renderer-bound `notify:lifecycle` payload (lifecycleNotifications.DeliverableSignal
 *  minus `cwd`, which only feeds the OS body). */
export interface PendingLifecycle {
  t: 'lifecycle'
  at: number
  payload: {
    boardId: string
    event: 'done' | 'needs-input' | 'error'
    attention?: 'done' | 'needs-input' | 'blocked' | 'error'
    detail?: string
  }
}

/** A focus intent from an OS-notification click that landed while the window was gone. */
export interface PendingFocus {
  t: 'focus'
  at: number
  boardId: string
}

export type PendingNotify = PendingLifecycle | PendingFocus

/** Bounded backlog: enough for a long tray residency's tail without unbounded growth. */
export const MAX_PENDING = 100

let queue: PendingNotify[] = []

export function enqueuePendingNotify(item: PendingNotify): void {
  queue.push(item)
  if (queue.length > MAX_PENDING) queue = queue.slice(queue.length - MAX_PENDING)
}

/** Return the backlog AND clear it — idempotent under a double call (StrictMode double-effect on
 *  the renderer side gets `[]` the second time, so nothing replays twice). */
export function drainPendingNotify(): PendingNotify[] {
  const out = queue
  queue = []
  return out
}

/** Test seam. */
export function resetPendingNotify(): void {
  queue = []
}

/**
 * Frame-guarded `notify:drain` (mirrors registerNotificationsHandlers' guard discipline) — a
 * foreign sender gets `[]`, never the backlog (board ids + reasons are a small information leak).
 */
export function registerNotifyDrainIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  ipcMain.handle('notify:drain', (e: IpcMainInvokeEvent): PendingNotify[] => {
    if (isForeignSender(e, getWin)) return []
    return drainPendingNotify()
  })
}
