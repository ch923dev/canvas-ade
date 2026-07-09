/**
 * Desktop-notification preferences, stored in the app's userData dir (NEVER a project folder — a
 * notification preference is a machine/app setting, not per-canvas). Pure file I/O keyed by an
 * explicit userDataDir so the read/write/gate core is testable without Electron's `app`. Mirrors
 * hotkeyConfig.ts / orchestrationConfig.ts (atomic write, defaults-on-parse-fail).
 *
 * The IPC handlers (`notifications:get` / `notifications:set`) live here too — they are trivial and
 * pull in nothing heavy (only the electron-free `isForeignSender` guard, and all electron imports
 * below are `import type`, erased at build), so this file stays unit-testable exactly like
 * orchestrationConfig.ts: a test that imports only the I/O + gate functions never loads Electron.
 *
 * The gate (`gateNotification`) is the SINGLE decision point every lifecycle event passes through
 * before delivery — kept here (pure, beside the config it reads) so lifecycleNotifications.ts's
 * `deliver` stays a thin electron-touching shell. See SPEC Phase 2 › Gate.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import type { LifecycleEvent } from './agentLifecycle'

export interface NotificationsConfig {
  /** Master switch. Off ⇒ no lifecycle notification of any kind fires. */
  enabled: boolean
  /** Notify when an agent finishes a task (`done`). */
  onDone: boolean
  /** Notify when an agent is waiting on the user (`needs-input`). */
  onInput: boolean
  /** Notify when an agent errors / wants focus (`error`). */
  onError: boolean
  /**
   * Suppress the OS-notification layer while the Expanse window is focused (default off — the OS
   * notification fires even when focused). The in-app toast + on-canvas board indicator still fire
   * when this suppresses the OS layer: on-canvas is exactly what disambiguates WHICH board when
   * you're already looking at the app.
   */
  onlyWhenUnfocused: boolean
}

export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  enabled: true,
  onDone: true,
  onInput: true,
  onError: true,
  onlyWhenUnfocused: false
}

/** Result of the write-only setNotifications IPC call. */
export type NotificationsWriteResult = { ok: boolean }

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'notifications-config.json')
}

/** Coerce any wire/disk payload into a valid config — each field repaired to its default. */
export function sanitizeNotificationsConfig(raw: unknown): NotificationsConfig {
  const p = (raw ?? {}) as Partial<NotificationsConfig>
  const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
  return {
    enabled: bool(p.enabled, DEFAULT_NOTIFICATIONS.enabled),
    onDone: bool(p.onDone, DEFAULT_NOTIFICATIONS.onDone),
    onInput: bool(p.onInput, DEFAULT_NOTIFICATIONS.onInput),
    onError: bool(p.onError, DEFAULT_NOTIFICATIONS.onError),
    onlyWhenUnfocused: bool(p.onlyWhenUnfocused, DEFAULT_NOTIFICATIONS.onlyWhenUnfocused)
  }
}

/** Read the persisted config, repairing a blank/invalid field back to its default. */
export function readNotificationsConfig(userDataDir: string): NotificationsConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return { ...DEFAULT_NOTIFICATIONS }
  try {
    return sanitizeNotificationsConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULT_NOTIFICATIONS }
  }
}

/** Persist the config (sanitized before write so disk never holds a bogus shape). Atomic. */
export function writeNotificationsConfig(userDataDir: string, cfg: NotificationsConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  const safe = sanitizeNotificationsConfig(cfg)
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(safe, null, 2), 'utf8')
}

/** The per-event toggle for a given lifecycle event. */
function eventEnabled(event: LifecycleEvent, cfg: NotificationsConfig): boolean {
  switch (event) {
    case 'done':
      return cfg.onDone
    case 'needs-input':
      return cfg.onInput
    case 'error':
      return cfg.onError
  }
}

export interface NotificationGateInput {
  event: LifecycleEvent
  config: NotificationsConfig
  /** Is the Expanse window focused right now? (drives `onlyWhenUnfocused`). */
  windowFocused: boolean
  /**
   * The board's `monitorActivity` opt-in resolved to a boolean — `false` ONLY when the board
   * explicitly opted out (absent-in-mirror ⇒ monitored ⇒ `true`). A board that opted out is fully
   * silent on every surface.
   */
  monitored: boolean
}

export interface NotificationGateDecision {
  /** Deliver ANY surface (toast + on-canvas attention)? `false` ⇒ fully silent. */
  deliver: boolean
  /** Also raise the native OS notification layer? Only meaningful when `deliver` is true. */
  os: boolean
}

/**
 * The one gate every lifecycle event passes before delivery (SPEC Phase 2 › Gate):
 * `board monitorActivity → master enabled → per-event → onlyWhenUnfocused`.
 *
 * - The board opt-out, the master switch, and the per-event switch each fully silence the event.
 * - `onlyWhenUnfocused` (when the window is focused) suppresses ONLY the OS layer — the in-app
 *   toast + on-canvas indicator still fire, because on-canvas is what disambiguates which board
 *   while you're already looking at the app.
 */
export function gateNotification(input: NotificationGateInput): NotificationGateDecision {
  const { event, config, windowFocused, monitored } = input
  if (!monitored || !config.enabled || !eventEnabled(event, config)) {
    return { deliver: false, os: false }
  }
  const os = !(config.onlyWhenUnfocused && windowFocused)
  return { deliver: true, os }
}

/**
 * Register the frame-guarded notifications-config IPC (mirrors registerSpawnCapHandlers' guard
 * discipline). A foreign sender gets `null` / `{ ok: false }` — no config leak, no write. The write
 * path sanitizes the payload before persisting (never trust the wire shape).
 */
export function registerNotificationsHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('notifications:get', (e): NotificationsConfig | null => {
    if (guard(e)) return null
    return readNotificationsConfig(userDataDir)
  })

  ipcMain.handle('notifications:set', (e, raw: unknown): NotificationsWriteResult => {
    if (guard(e)) return { ok: false }
    writeNotificationsConfig(userDataDir, sanitizeNotificationsConfig(raw))
    return { ok: true }
  })
}
