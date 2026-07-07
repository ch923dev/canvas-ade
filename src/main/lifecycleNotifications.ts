/**
 * Desktop-notifications wiring (the electron-touching half of the feature). Kept OUT of
 * agentLifecycle.ts so that module stays a pure fs + logic unit (its test imports it in a plain
 * node env where a runtime `electron` import would throw), and to keep index.ts under the
 * max-lines ratchet — the recapHealth.ts precedent.
 *
 * On each NEW agent-lifecycle line (done / needs-input / error), raise a native OS notification
 * (fires regardless of window focus; per-event + monitorActivity gating land in a later phase) and
 * push an in-app toast to the renderer. The OS notification's click focuses the window and pans to
 * the board (notify:focusBoard).
 */
import { app, Notification, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { createLifecycleNotifier, type LifecycleEvent } from './agentLifecycle'

const NOTIFY_TITLE: Record<LifecycleEvent, string> = {
  done: 'Task done',
  'needs-input': 'Needs your input',
  error: 'Agent error'
}

export interface LifecycleNotificationsDeps {
  /** Absolute path to the app-owned session-map JSONL (the recap hook appends to it). */
  mapPath: string
  getWin: () => BrowserWindow | null
  /** Test seam: default raises a real Electron Notification. */
  notify?: (opts: { title: string; body: string; onClick: () => void }) => void
}

function defaultOsNotify(opts: { title: string; body: string; onClick: () => void }): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title: opts.title, body: opts.body })
  n.on('click', opts.onClick)
  n.show()
}

/**
 * A normalized lifecycle signal at the delivery boundary. `cwd` is OPTIONAL here (unlike the
 * Claude-path {@link LifecycleSignal}, which always carries one): the generic-PTY path may have no
 * resolved cwd for a board, and `deliver` already renders an empty locator in that case. A
 * cwd-carrying `LifecycleSignal` is assignable to this.
 */
export type DeliverableSignal = { boardId: string; event: LifecycleEvent; cwd?: string }

export interface LifecycleNotificationsHandle {
  /** Stop the Claude-path file watcher (also auto-runs on `before-quit`). */
  dispose: () => void
  /**
   * The ONE delivery site: raise an OS notification + push the in-app toast + attention mark for a
   * normalized lifecycle signal. The Claude file watcher routes here, and the generic-PTY path
   * (pty.ts, wired via `setPtyLifecycleEmitter`) routes here too — so gating + copy + the OS/toast
   * split live in exactly one place, never duplicated per detection path.
   */
  deliver: (sig: DeliverableSignal) => void
}

/**
 * Wire the lifecycle watcher to OS notifications + in-app toasts. Returns a {@link
 * LifecycleNotificationsHandle} (disposer + the shared `deliver`) AND self-disposes on
 * `before-quit` — index.ts centralizes most teardown, but this app-lifetime watcher is `persistent:
 * false` (never keeps the process alive) and self-manages so index.ts stays under its max-lines
 * ratchet (no module-scope disposer var needed there).
 */
export function registerLifecycleNotifications(
  deps: LifecycleNotificationsDeps
): LifecycleNotificationsHandle {
  const raise = deps.notify ?? defaultOsNotify
  const deliver = ({ boardId, event, cwd }: DeliverableSignal): void => {
    const where = cwd ? basename(cwd) : ''
    raise({
      title: NOTIFY_TITLE[event],
      body: where ? `${where} — click to open the board` : 'Click to open the board',
      onClick: () => {
        const win = deps.getWin()
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        const wc = win.webContents
        if (!wc.isDestroyed()) wc.send('notify:focusBoard', { boardId })
      }
    })
    // In-app toast + attention — guarded window deref: this can fire from a debounced fs.watch
    // timer (Claude path) or the idle-scan interval (PTY path), so the window can be destroyed by
    // then (mirror the recap:learned isDestroyed() discipline, BUG-001).
    const win = deps.getWin()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send('notify:lifecycle', { boardId, event })
  }
  const dispose = createLifecycleNotifier({ mapPath: deps.mapPath, onEvent: deliver })
  app.once('before-quit', dispose)
  return { dispose, deliver }
}
