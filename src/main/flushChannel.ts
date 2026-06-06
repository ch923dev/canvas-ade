/**
 * BUG-038: flushRenderer channel-name + sender-frame helpers (extracted for testability).
 *
 * DO NOT import index.ts in tests — it boots the full Electron app. These pure helpers
 * encode only the two defects the fix addresses:
 *
 *   1. Channel-name entropy: was `Date.now():Math.random()` (predictable, ~48-bit
 *      non-CSPRNG); fixed to `randomUUID()` matching the BUG-022 fix in mcpConfirm.ts.
 *
 *   2. Sender-frame guard: the old `finish = (): void => { ... }` dropped the IpcMainEvent
 *      argument silently, making any sender-frame check impossible. Fixed: the IPC-facing
 *      `finish` accepts the event and calls `isForeignSender` before resolving.
 *
 * `index.ts` calls `makeFlushChannel()` and `makeFlushFinish()` instead of inlining the
 * logic so both behaviours are independently unit-testable.
 */
import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Returns a cryptographically-strong, unguessable one-shot IPC reply channel name for
 * the renderer-flush handshake (BUG-038). Uses `randomUUID()` (CSPRNG, 122 bits) rather
 * than `Date.now()/Math.random()` (~48 bits, predictable), consistent with BUG-022's fix
 * in `mcpConfirm.ts`.
 */
export function makeFlushChannel(): string {
  return `project:flush:done:${randomUUID()}`
}

export interface FlushFinishHandlers {
  /** Called exactly once when the flush is resolved (from the IPC reply or forced). */
  onResolve: () => void
  /** Called when the finish path fires (remove the IPC listener, clear the timer). */
  onCleanup: () => void
  /** Returns the current main window for isForeignSender frame-checks. */
  getWin: () => BrowserWindow | null
}

export interface FlushFinish {
  /**
   * The IPC-event-facing finish handler. Accepts the `IpcMainEvent` so it can guard
   * against foreign-frame senders (BUG-038). A foreign frame is silently ignored; the
   * done guard prevents double-resolution.
   */
  finish: (e: IpcMainEvent) => void
  /**
   * The unconditional finish path used by the timeout fallback and the send-failure
   * catch block, where no IpcMainEvent is available. Resolves without a frame check.
   */
  forceFinish: () => void
}

/**
 * Returns the two finish variants used by `flushRenderer` (BUG-038).
 *
 * Split into `finish` (IPC-event path, frame-guarded) and `forceFinish` (timeout/send-
 * failure path, no event) so the caller can register them on the correct paths without
 * awkward optional-argument overloads.
 */
export function makeFlushFinish(handlers: FlushFinishHandlers): FlushFinish {
  let done = false

  const resolve = (): void => {
    if (done) return
    done = true
    handlers.onCleanup()
    handlers.onResolve()
  }

  const finish = (e: IpcMainEvent): void => {
    // 🔒 BUG-038: guard against a foreign frame (e.g. a sandboxed WebContentsView
    // preview-board) sending the reply before the legitimate autosave flush completes.
    if (isForeignSender(e, handlers.getWin)) return
    resolve()
  }

  const forceFinish = (): void => {
    // Timeout fallback or send-failure catch — no IpcMainEvent, no frame check needed;
    // the timeout path is a server-side timer, not renderer input.
    resolve()
  }

  return { finish, forceFinish }
}
