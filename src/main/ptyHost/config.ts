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

export interface PtyHostConfig {
  /** Terminal sessions survive app restart (daemon-owned PTYs). */
  surviveRestart: boolean
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'ptyhost-config.json')
}

export function repairPtyHostConfig(p: unknown): PtyHostConfig {
  if (typeof p === 'object' && p !== null) {
    const o = p as { surviveRestart?: unknown }
    if (typeof o.surviveRestart === 'boolean') return { surviveRestart: o.surviveRestart }
  }
  return { surviveRestart: true }
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
