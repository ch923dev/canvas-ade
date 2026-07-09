/**
 * Desktop-notifications wiring (the electron-touching half of the feature). Kept OUT of
 * agentLifecycle.ts so that module stays a pure fs + logic unit (its test imports it in a plain
 * node env where a runtime `electron` import would throw), and to keep index.ts under the
 * max-lines ratchet — the recapHealth.ts precedent.
 *
 * On each NEW agent-lifecycle line (done / needs-input / error), pass it through the single {@link
 * gateNotification} decision (master + per-event setting → onlyWhenUnfocused → the board's
 * `monitorActivity`), then raise a native OS notification (unless the OS layer is suppressed while
 * focused) and push an in-app toast + on-canvas attention mark to the renderer. The OS
 * notification's click focuses the window and pans to the board (notify:focusBoard).
 */
import { app, ipcMain, Notification, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import {
  createLifecycleNotifier,
  lifecycleBody,
  lifecycleTitle,
  type LifecycleEvent
} from './agentLifecycle'
import {
  gateNotification,
  readNotificationsConfig,
  registerNotificationsHandlers,
  type NotificationsConfig
} from './notificationsConfig'
import { setPtyLifecycleEmitter } from './pty'
import { listBoardMirror } from './boardRegistry'

/** The board facts the gate + copy need — projected from the MAIN board mirror by id. */
export interface LifecycleBoard {
  title?: string
  agentKind?: string
  monitorActivity?: boolean
}

export interface LifecycleNotificationsDeps {
  /** Absolute path to the app-owned session-map JSONL (the recap hook appends to it). */
  mapPath: string
  getWin: () => BrowserWindow | null
  /** Read the CURRENT notification prefs at fire time (fresh on every event — never cached). */
  getConfig: () => NotificationsConfig
  /** Look up a board's title/agentKind/monitorActivity by id (from the MAIN mirror); may be absent. */
  getBoard: (boardId: string) => LifecycleBoard | undefined
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

/** The injected dependencies of the ONE delivery function ({@link createLifecycleDeliver}). */
export interface LifecycleDeliverDeps {
  getWin: () => BrowserWindow | null
  /** Read the CURRENT notification prefs at fire time. */
  getConfig: () => NotificationsConfig
  /** Look up a board's title/agentKind/monitorActivity by id; may be absent. */
  getBoard: (boardId: string) => LifecycleBoard | undefined
  /** Raise the OS-notification layer. Default is a real Electron Notification; the e2e seam passes a
   *  recording spy so a headless run asserts the OS decision WITHOUT a real Notification. */
  raise: (opts: { title: string; body: string; onClick: () => void }) => void
  /** Test seam: override the window-focused read (default reads the real `win.isFocused()`), so the
   *  `onlyWhenUnfocused` branch is drivable deterministically (real OS focus is flaky under xvfb). */
  isWindowFocused?: (win: BrowserWindow) => boolean
}

/**
 * Build the ONE delivery function (SPEC Phase 2/3): gate a normalized lifecycle signal, then raise
 * the OS layer (unless suppressed while focused) and push the in-app toast + on-canvas attention to
 * the renderer over `notify:lifecycle`. Extracted as a factory so BOTH the production wiring and the
 * e2e seam drive the SAME gate + IPC push — the e2e never re-implements delivery; it only injects
 * test deps (config / board facts / focus + an OS-notify spy).
 */
export function createLifecycleDeliver(
  deps: LifecycleDeliverDeps
): (sig: DeliverableSignal) => void {
  return ({ boardId, event, cwd }: DeliverableSignal): void => {
    // Gate first: board opt-out → master → per-event → onlyWhenUnfocused (the ONE decision point).
    const board = deps.getBoard(boardId)
    const focusWin = deps.getWin()
    const windowFocused =
      !!focusWin &&
      !focusWin.isDestroyed() &&
      (deps.isWindowFocused ? deps.isWindowFocused(focusWin) : focusWin.isFocused())
    const decision = gateNotification({
      event,
      config: deps.getConfig(),
      windowFocused,
      // Absent monitorActivity ⇒ monitored (opt-out, not opt-in); only an explicit `false` silences.
      monitored: board?.monitorActivity !== false
    })
    if (!decision.deliver) return

    // OS layer — suppressed only when `onlyWhenUnfocused` is on and the window is focused.
    if (decision.os) {
      const where = cwd ? basename(cwd) : ''
      deps.raise({
        title: lifecycleTitle(event, board?.agentKind),
        body: lifecycleBody(board?.title, where),
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
    }

    // In-app toast + on-canvas attention — always fire when the event passes the gate (even when the
    // OS layer is suppressed while focused: on-canvas is what disambiguates WHICH board). Guarded
    // window deref: this can fire from a debounced fs.watch timer (Claude path) or the idle-scan
    // interval (PTY path), so the window can be destroyed by then (mirror recap:learned, BUG-001).
    const win = deps.getWin()
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send('notify:lifecycle', { boardId, event })
  }
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
  const deliver = createLifecycleDeliver({
    getWin: deps.getWin,
    getConfig: deps.getConfig,
    getBoard: deps.getBoard,
    raise: deps.notify ?? defaultOsNotify
  })
  const dispose = createLifecycleNotifier({ mapPath: deps.mapPath, onEvent: deliver })
  app.once('before-quit', dispose)
  return { dispose, deliver }
}

/**
 * One-call wiring for the whole desktop-notifications delivery layer, so index.ts (already at its
 * max-lines ratchet) adds a single statement rather than the IPC + config-read + board-projection +
 * pty-emitter plumbing (the recapHealth.ts extraction precedent). Self-imports the app-singleton
 * dependencies (`ipcMain`, the `listBoardMirror` snapshot); the caller passes only the values it
 * owns — the window getter, the session-map path, and the REAL userData dir (never a project
 * folder). Registers the `notifications:*` IPC, starts the Claude-path watcher wired to the gate,
 * routes the generic-PTY path into the SAME `deliver`, and self-disposes on before-quit.
 */
export function wireLifecycleNotifications(
  getWin: () => BrowserWindow | null,
  mapPath: string,
  userDataDir: string
): LifecycleNotificationsHandle {
  registerNotificationsHandlers(ipcMain, getWin, userDataDir)
  const handle = registerLifecycleNotifications({
    mapPath,
    getWin,
    // Fresh read per event (settings change rarely; events are infrequent — no cache to invalidate).
    getConfig: () => readNotificationsConfig(userDataDir),
    // Project the board mirror by id for the gate (monitorActivity) + copy (title / agentKind).
    getBoard: (id) => listBoardMirror().find((b) => b.id === id)
  })
  setPtyLifecycleEmitter(handle.deliver)
  return handle
}
