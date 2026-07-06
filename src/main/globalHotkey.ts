/**
 * Global project-switch hotkey (the "background service" half of the feature). MAIN owns the
 * OS-wide `globalShortcut` registration so the chord fires even when Expanse is unfocused or
 * minimized. On fire, MAIN foregrounds the window and forwards the cycle DIRECTION to the
 * renderer (1 = next / -1 = prev); the renderer owns the ordered recents ring + the
 * `performProjectSwitch` pipeline (single source of switch logic — see store/projectSwitch.ts).
 *
 * Registration can FAIL when another app/the OS already owns the accelerator (`register` returns
 * false, or throws on an unparseable string): both are collected and returned so the caller can
 * surface a warning rather than silently no-op (the silent-failure class this repo guards).
 */
import { type BrowserWindow, type IpcMain, globalShortcut } from 'electron'
import { readHotkeyConfig, type HotkeyConfig } from './hotkeyConfig'
import { registerHotkeyHandlers } from './hotkeyIpc'

/** MAIN→renderer channel carrying the cycle direction (1 next / -1 prev). */
export const PROJECT_CYCLE_CHANNEL = 'project:cycleHotkey'

export interface GlobalHotkeyDeps {
  getWin(): BrowserWindow | null
  /** Load the persisted accelerator config (re-read on every apply so a rebind takes effect). */
  loadConfig(): HotkeyConfig
}

export interface GlobalHotkeyController {
  /**
   * (Re)register from the current config. Idempotent — unbinds the previous set first. Returns
   * the accelerators that FAILED to bind (already claimed / invalid) so the caller can warn.
   */
  apply(): { failed: string[] }
  /** Unbind everything this controller registered (app teardown / disable). */
  dispose(): void
}

export function createGlobalHotkey(deps: GlobalHotkeyDeps): GlobalHotkeyController {
  let registered: string[] = []

  const foregroundAndCycle = (dir: 1 | -1): void => {
    const win = deps.getWin()
    if (!win || win.isDestroyed()) return
    // Pull Expanse forward from an unfocused/minimized state before the switch, so the user
    // sees the project they're cycling to (the whole point of a GLOBAL hotkey).
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    const wc = win.webContents
    if (!wc.isDestroyed()) wc.send(PROJECT_CYCLE_CHANNEL, dir)
  }

  const unbind = (): void => {
    for (const accel of registered) {
      try {
        globalShortcut.unregister(accel)
      } catch {
        /* best-effort — a torn-down accelerator is already gone */
      }
    }
    registered = []
  }

  return {
    apply() {
      unbind()
      const cfg = deps.loadConfig()
      const failed: string[] = []
      if (!cfg.enabled) return { failed }
      const bind = (accel: string, dir: 1 | -1): void => {
        if (!accel) return
        let ok = false
        try {
          ok = globalShortcut.register(accel, () => foregroundAndCycle(dir))
        } catch {
          ok = false // an unparseable accelerator string throws rather than returning false
        }
        if (ok) registered.push(accel)
        else failed.push(accel)
      }
      bind(cfg.next, 1)
      // Only bind prev if it differs — the same string can't hold two handlers, and a
      // duplicate would otherwise report as a spurious failure.
      if (cfg.prev !== cfg.next) bind(cfg.prev, -1)
      return { failed }
    },
    dispose() {
      unbind()
      globalShortcut.unregisterAll() // belt-and-suspenders on app teardown
    }
  }
}

/**
 * One-call wiring for MAIN: build the controller, do the initial registration (pushing any bind
 * failures to the renderer), and register the Settings get/set IPC (re-registering on every save).
 * Returns the controller so the caller can `dispose()` it on shutdown. Keeps index.ts under the
 * max-lines ratchet — the whole hotkey concern lives here.
 */
export function wireGlobalHotkey(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string
): GlobalHotkeyController {
  const controller = createGlobalHotkey({ getWin, loadConfig: () => readHotkeyConfig(userDataDir) })
  const applyHotkeys = (): { failed: string[] } => {
    const result = controller.apply()
    if (result.failed.length > 0) {
      const wc = getWin()?.webContents
      if (wc && !wc.isDestroyed()) wc.send('hotkey:registerFailed', result.failed)
    }
    return result
  }
  applyHotkeys()
  registerHotkeyHandlers(ipc, getWin, { userDataDir, reapply: applyHotkeys })
  return controller
}
