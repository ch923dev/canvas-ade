/**
 * Global project-switch hotkey config, stored in the app's userData dir (NEVER a project
 * folder — a global hotkey is a machine/app preference, not per-canvas). Pure file I/O keyed
 * by an explicit userDataDir so it is testable without Electron's `app`. Mirrors llmConfig.ts /
 * recentProjects.ts (atomic write, defaults-on-parse-fail).
 *
 * The values are Electron Accelerator strings (globalShortcut.register). Defaults use the
 * `]`/`[` bracket keys under CommandOrControl+Alt — valid accelerators unlikely to collide with
 * a common OS chord; any collision is surfaced (register returns false) and the user rebinds.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

export interface HotkeyConfig {
  /** Master switch for the global project-switch hotkeys. */
  enabled: boolean
  /** Accelerator that switches to the NEXT project in the recents ring. */
  next: string
  /** Accelerator that switches to the PREVIOUS project in the recents ring. */
  prev: string
}

export const DEFAULT_HOTKEYS: HotkeyConfig = {
  enabled: true,
  next: 'CommandOrControl+Alt+]',
  prev: 'CommandOrControl+Alt+['
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'hotkey-config.json')
}

/** Read the persisted config, repairing a blank/invalid field back to its default. */
export function readHotkeyConfig(userDataDir: string): HotkeyConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return { ...DEFAULT_HOTKEYS }
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<HotkeyConfig>
    return {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : DEFAULT_HOTKEYS.enabled,
      next: typeof p.next === 'string' && p.next.length > 0 ? p.next : DEFAULT_HOTKEYS.next,
      prev: typeof p.prev === 'string' && p.prev.length > 0 ? p.prev : DEFAULT_HOTKEYS.prev
    }
  } catch {
    return { ...DEFAULT_HOTKEYS }
  }
}

/** Persist the config. Atomic write, like recentProjects/llmConfig. */
export function writeHotkeyConfig(userDataDir: string, cfg: HotkeyConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(cfg, null, 2), 'utf8')
}
