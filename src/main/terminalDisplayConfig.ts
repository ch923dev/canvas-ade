/**
 * Terminal display preferences (T1d — "Flicker-free terminals"), stored in the app's userData dir
 * (NEVER a project folder — an alt-screen display preference is a machine/app setting, not
 * per-canvas). Mirrors notificationsConfig.ts / hotkeyConfig.ts: atomic write, defaults-on-parse-fail,
 * frame-guarded get/set IPC, and all Electron imports are `import type` (erased at build) so the I/O
 * core stays unit-testable without loading Electron.
 *
 * The single knob is `flickerFree`. It decides ONE thing in buildSpawnEnv (ptySpawnEnv.ts): whether
 * to force `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` on a Claude Code spawn.
 *   - ON (default) → leave the CLI's default alt-screen ON → zero resize-scrollback litter
 *     (anthropics/claude-code#51828). Copy is NOT lost: Shift+drag / Option+drag still selects in
 *     alt-screen (the repo enables `macOptionClickForcesSelection`, useTerminalSpawn.ts) — only
 *     modifier-less drag-select is unavailable (the tmux/vim/iTerm convention).
 *   - OFF → force alt-screen off → modifier-less drag-select + xterm's own scrollback history are
 *     back (#332), at the cost of the resize litter above.
 * Default flipped ON 2026-07-23: since Shift+drag already copies, alt-screen no longer re-breaks the
 * #332 copy fix, so litter-free is the better out-of-the-box default. Applies to new/restarted terms.
 *
 * `isFlickerFree()` is read FRESH at each spawn (bindTerminalDisplayConfig at boot supplies the dir),
 * so flipping the Settings toggle takes effect on the next spawn without an app restart — no cache.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

export interface TerminalDisplayConfig {
  /** Let Claude Code keep its default alt-screen TUI (zero resize litter) instead of forcing it off.
   *  Default true: Shift+drag still copies, so litter-free is the better default (see header). */
  flickerFree: boolean
}

export const DEFAULT_TERMINAL_DISPLAY: TerminalDisplayConfig = {
  flickerFree: true
}

/** Result of the write-only set IPC call. */
export type TerminalDisplayWriteResult = { ok: boolean }

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'terminal-display-config.json')
}

/** Coerce any wire/disk payload into a valid config — each field repaired to its default. */
export function sanitizeTerminalDisplayConfig(raw: unknown): TerminalDisplayConfig {
  const p = (raw ?? {}) as Partial<TerminalDisplayConfig>
  return {
    flickerFree:
      typeof p.flickerFree === 'boolean' ? p.flickerFree : DEFAULT_TERMINAL_DISPLAY.flickerFree
  }
}

/** Read the persisted config, repairing a blank/invalid field back to its default. */
export function readTerminalDisplayConfig(userDataDir: string): TerminalDisplayConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return { ...DEFAULT_TERMINAL_DISPLAY }
  try {
    return sanitizeTerminalDisplayConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULT_TERMINAL_DISPLAY }
  }
}

/** Persist the config (sanitized before write so disk never holds a bogus shape). Atomic. */
export function writeTerminalDisplayConfig(userDataDir: string, cfg: TerminalDisplayConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  const safe = sanitizeTerminalDisplayConfig(cfg)
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(safe, null, 2), 'utf8')
}

// ── Spawn-time getter (bound at boot; read fresh per spawn — no cache) ──────────────────────────
let boundUserData: string | null = null

/** Bind the userData dir so the spawn path (pty.ts) can read the preference with no argument.
 *  Called once at boot by registerTerminalDisplayHandlers. Unbound ⇒ default (false). */
export function bindTerminalDisplayConfig(userDataDir: string): void {
  boundUserData = userDataDir
}

/** Is flicker-free (alt-screen) mode on? Read fresh from disk so a Settings toggle applies to the
 *  next spawn without an app restart. Unbound (pre-boot / bind never ran) ⇒ the default, since with
 *  no dir there's no persisted override to read. */
export function isFlickerFree(): boolean {
  if (!boundUserData) return DEFAULT_TERMINAL_DISPLAY.flickerFree
  return readTerminalDisplayConfig(boundUserData).flickerFree
}

/**
 * Register the frame-guarded terminal-display-config IPC (mirrors registerNotificationsHandlers'
 * guard discipline). A foreign sender gets `null` / `{ ok: false }` — no config leak, no write. Also
 * binds the userData dir for the spawn-time getter. The write path sanitizes before persisting.
 */
export function registerTerminalDisplayHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string
): void {
  bindTerminalDisplayConfig(userDataDir)
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('terminalDisplay:get', (e): TerminalDisplayConfig | null => {
    if (guard(e)) return null
    return readTerminalDisplayConfig(userDataDir)
  })

  ipcMain.handle('terminalDisplay:set', (e, raw: unknown): TerminalDisplayWriteResult => {
    if (guard(e)) return { ok: false }
    writeTerminalDisplayConfig(userDataDir, sanitizeTerminalDisplayConfig(raw))
    return { ok: true }
  })
}
