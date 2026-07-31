/**
 * Global hotkey settings plane — the renderer-facing control for the project-switch accelerators
 * (Settings › Shortcuts). `hotkey:get` reads the persisted config; `hotkey:set` validates + writes
 * it, then re-applies the window-scoped `before-input-event` binding (PR #342 — NOT
 * `globalShortcut`; a window binding cannot fail to register, so there is no failure list to
 * report). Both handlers are `isForeignSender` frame-guarded, like every other IPC surface in MAIN.
 */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import {
  DEFAULT_HOTKEYS,
  readHotkeyConfig,
  writeHotkeyConfig,
  type HotkeyConfig
} from './hotkeyConfig'

export interface HotkeyIpcDeps {
  userDataDir: string
  /** Re-apply the window binding from the freshly written config. */
  reapply(): void
}

/** Coerce a renderer-supplied payload into a valid config (never trust the wire shape). */
function sanitize(raw: unknown): HotkeyConfig {
  const p = (raw ?? {}) as Partial<HotkeyConfig>
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_HOTKEYS.enabled,
    next: str(p.next, DEFAULT_HOTKEYS.next),
    prev: str(p.prev, DEFAULT_HOTKEYS.prev)
  }
}

export function registerHotkeyHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: HotkeyIpcDeps
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipc.handle('hotkey:get', (e): HotkeyConfig | null => {
    if (guard(e)) return null
    return readHotkeyConfig(deps.userDataDir)
  })

  ipc.handle('hotkey:set', (e, raw: unknown): { ok: boolean } => {
    if (guard(e)) return { ok: false }
    const cfg = sanitize(raw)
    writeHotkeyConfig(deps.userDataDir, cfg)
    deps.reapply()
    return { ok: true }
  })
}
