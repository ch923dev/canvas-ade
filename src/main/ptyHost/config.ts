/**
 * PTY-host rollout gate (DESIGN.md D2): a runtime setting, default ON, so one binary carries a
 * live escape hatch. PR 1 ships the plumbing + env override; the Settings › Terminal toggle row
 * lands with the PR-2 UX. Mirrors the voiceConfig idiom (pure file IO keyed by an explicit
 * userDataDir; read-repair on malformed values) at minimal size.
 *
 * Effective gate = platform (win32 only in PR 1 — the staged-runtime model is Windows-specific)
 * AND the env override (`CANVAS_PTYHOST=0|1`, e2e/dev forcing) AND the persisted setting.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

/** PR-2 close policy: what a user-initiated close does when live sessions exist. */
export type CloseWithSessions = 'ask' | 'keep' | 'stop'

export interface PtyHostConfig {
  /** Terminal sessions survive app restart (daemon-owned PTYs). */
  surviveRestart: boolean
  /** PR-2: close-with-running-sessions behavior — 'ask' pops the close modal (default),
   *  'keep' silently enters tray residency, 'stop' silently kills everything (today's close). */
  onCloseWithSessions: CloseWithSessions
  /** PR-2: OS notification when a background session exits while the window is closed. */
  notifyBackgroundExit: boolean
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'ptyhost-config.json')
}

const CLOSE_MODES: readonly CloseWithSessions[] = ['ask', 'keep', 'stop']

export function repairPtyHostConfig(p: unknown): PtyHostConfig {
  const o = typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {}
  return {
    surviveRestart: typeof o.surviveRestart === 'boolean' ? o.surviveRestart : true,
    onCloseWithSessions: CLOSE_MODES.includes(o.onCloseWithSessions as CloseWithSessions)
      ? (o.onCloseWithSessions as CloseWithSessions)
      : 'ask',
    notifyBackgroundExit:
      typeof o.notifyBackgroundExit === 'boolean' ? o.notifyBackgroundExit : true
  }
}

export function readPtyHostConfig(userDataDir: string): PtyHostConfig {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return repairPtyHostConfig(null)
  try {
    return repairPtyHostConfig(JSON.parse(readFileSync(f, 'utf8')))
  } catch {
    return repairPtyHostConfig(null)
  }
}

export function writePtyHostConfig(userDataDir: string, cfg: PtyHostConfig): void {
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(cfg, null, 2))
}

/** The full effective gate. `env` injected for tests. */
export function ptyHostEnabled(
  cfg: PtyHostConfig,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): boolean {
  if (platform !== 'win32') return false
  if (env.CANVAS_PTYHOST === '0') return false
  if (env.CANVAS_PTYHOST === '1') return true
  return cfg.surviveRestart
}
