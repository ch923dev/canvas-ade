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
import type { BrowserWindow, IpcMain, IpcMainEvent } from 'electron'
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

/**
 * Ask the renderer to flush its debounced autosave before a hard exit (BUG-M2).
 * The quit path calls `app.exit(0)`, which never fires the renderer `beforeunload`,
 * so the autosave flush handler (useAutosave) would be skipped and the last ~1s of
 * edits lost. Posts `project:flush` with a unique reply channel; the renderer runs
 * its flush (awaiting `project:save`) and replies. Resolves on the reply OR a short
 * timeout fallback so a wedged/closed renderer can never hang the quit.
 *
 * Lived inline in index.ts as `flushRenderer` until the max-lines ratchet moved it
 * here beside its channel/finish primitives (the natural home — one flush module).
 */
export function flushRendererAutosave(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  timeoutMs = 1500
): Promise<void> {
  const win = getWin()
  // BUG-001: accessing .webContents on a destroyed BrowserWindow throws "Object has been
  // destroyed". Guard isDestroyed() BEFORE dereferencing .webContents so the close-then-quit
  // path (Win/Linux: window close -> window-all-closed -> before-quit -> flushRenderer) cannot
  // throw into the uncaughtException sink and short-circuit the guarded-quit chain.
  if (!win || win.isDestroyed()) return Promise.resolve()
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    // 🔒 BUG-038: use CSPRNG randomUUID() (not predictable Date.now()/Math.random).
    const replyChannel = makeFlushChannel()
    const { finish, forceFinish } = makeFlushFinish({
      getWin,
      onCleanup: () => {
        ipc.removeAllListeners(replyChannel)
        clearTimeout(timer)
      },
      onResolve: resolve
    })
    // 🔒 BUG-038: `finish` accepts IpcMainEvent and guards against foreign-frame senders.
    // BUG-019: use ipc.on (not once) so a foreign-frame message that isForeignSender
    // correctly ignores does not consume the listener before the legitimate reply arrives.
    // onCleanup calls removeAllListeners(replyChannel) when finish resolves, so cleanup
    // still happens exactly once regardless of how many messages arrive on the channel.
    const timer = setTimeout(forceFinish, timeoutMs)
    ipc.on(replyChannel, finish)
    try {
      wc.send('project:flush', replyChannel)
    } catch {
      forceFinish() // renderer gone — nothing to flush
    }
  })
}
