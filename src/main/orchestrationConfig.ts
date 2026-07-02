/**
 * Orchestration tuning config — currently just the MCP spawn concurrency cap (the runaway-swarm
 * guard: how many worker boards the orchestrator may have live at once). Stored in the app's
 * userData dir (NEVER a project folder), because the MCP server is a process singleton — the cap is
 * app-wide, not per-canvas. Pure file I/O keyed by an explicit userDataDir so the read/write/clamp
 * core is testable without Electron's `app`. Mirrors llmConfig.ts / recentProjects.ts.
 *
 * The IPC handlers (`orchestration:getSpawnCap` / `orchestration:setSpawnCap`) live here too — they
 * are trivial and pull in nothing heavy (only the electron-free `isForeignSender` guard), so unlike
 * the llmConfig/llmIpc split this file stays unit-testable: a test that imports only the I/O
 * functions never loads Electron (the electron imports below are all `import type`, erased at build).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'

/**
 * Default spawn cap when nothing is configured. MIRRORS `MCP_SPAWN_CAP` (mcpRegistry.ts, the MAIN
 * enforcement default) and `WORKER_SPAWN_CAP` (the renderer display mirror). Declared locally rather
 * than imported so this config module stays dependency-light; `orchestrationConfig.test.ts` asserts
 * it equals `MCP_SPAWN_CAP` so the three can't drift.
 */
export const DEFAULT_SPAWN_CAP = 4
/** Minimum configurable cap — at least one worker, else the orchestrator can never spawn. */
export const MIN_SPAWN_CAP = 1
/**
 * Maximum configurable cap — the guard's own ceiling. Each worker is a real terminal + agent
 * process (node-pty + an offscreen-preview-class footprint), so an unbounded cap would defeat the
 * runaway-swarm guard it configures. 16 is already generous for a single desktop.
 */
export const MAX_SPAWN_CAP = 16

export interface OrchestrationConfig {
  /** Hard cap on live MCP-spawned worker boards. Always a valid integer in [MIN, MAX] once read. */
  spawnCap: number
}

/** Result of the write-only setSpawnCap IPC call. */
export type SpawnCapWriteResult = { ok: boolean; reason?: string }

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'orchestration-config.json')
}

/**
 * Coerce any value to a valid spawn cap: a finite integer clamped into [MIN, MAX]. A non-number /
 * non-finite / non-integer value (or a value out of range) is repaired rather than thrown, so a
 * config poisoned or hand-edited on disk can never feed a bogus cap into the orchestrator's
 * `tracked.size >= cap` check (a NaN cap would let every spawn through; a 0 cap would wedge it).
 */
export function clampSpawnCap(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SPAWN_CAP
  const n = Math.floor(raw)
  if (n < MIN_SPAWN_CAP) return MIN_SPAWN_CAP
  if (n > MAX_SPAWN_CAP) return MAX_SPAWN_CAP
  return n
}

/** Read the persisted cap, defaulting + clamping a missing/blank/invalid value to a usable cap. */
export function readOrchestrationConfig(userDataDir: string): OrchestrationConfig {
  const file = fileFor(userDataDir)
  if (!existsSync(file)) return { spawnCap: DEFAULT_SPAWN_CAP }
  try {
    const p = JSON.parse(readFileSync(file, 'utf8')) as Partial<OrchestrationConfig>
    return { spawnCap: clampSpawnCap(p.spawnCap) }
  } catch {
    return { spawnCap: DEFAULT_SPAWN_CAP }
  }
}

/** Persist the cap (clamped before write so disk never holds an out-of-range value). Atomic. */
export function writeOrchestrationConfig(userDataDir: string, cfg: OrchestrationConfig): void {
  mkdirSync(userDataDir, { recursive: true })
  const safe: OrchestrationConfig = { spawnCap: clampSpawnCap(cfg.spawnCap) }
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(safe, null, 2), 'utf8')
}

/**
 * Register the frame-guarded spawn-cap IPC (mirrors registerLlmHandlers' guard discipline). Read is
 * a plain number; write validates the arg is an in-range integer BEFORE persisting (the renderer
 * already clamps the field — this is the defense-in-depth boundary check) and returns a typed result.
 */
export function registerSpawnCapHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  userDataDir: string
): void {
  const guard = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('orchestration:getSpawnCap', (e): number => {
    // A foreign sender gets the default rather than the configured value (no information leak, and
    // a safe number for any caller). The real cap is enforced MAIN-side regardless.
    if (guard(e)) return DEFAULT_SPAWN_CAP
    return readOrchestrationConfig(userDataDir).spawnCap
  })

  ipcMain.handle('orchestration:setSpawnCap', (e, raw: unknown): SpawnCapWriteResult => {
    if (guard(e)) return { ok: false, reason: 'forbidden' }
    // Reject a clearly-bad arg (non-integer / out of range) instead of silently clamping, so a UI
    // bug surfaces; a valid in-range integer is the only thing the field ever sends.
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < MIN_SPAWN_CAP ||
      raw > MAX_SPAWN_CAP
    ) {
      return { ok: false, reason: 'invalid' }
    }
    writeOrchestrationConfig(userDataDir, { spawnCap: raw })
    return { ok: true }
  })
}
