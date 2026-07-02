/**
 * Worker-pool capability discovery for the Command board (Phase A).
 *
 * The orchestrator's face shows what it COULD dispatch to before any task is submitted — a
 * read-only count of the eligible worker boards on the canvas. Pure derivation over the live
 * `canvasStore.boards` + the terminal runtime store (no MCP round-trip): this is the renderer-side
 * mirror of what the orchestrator already sees via `describeApp().canvas` (PR-3) / `listBoards`.
 *
 * Eligibility honors the schema-v10 swarm opt-out: a terminal with `monitorActivity:false` is a
 * plain shell the orchestrator was told to ignore, so it is NOT counted as an available worker
 * (mirrors the agent-facing attention queue's filter). `agentKind` is carried as metadata only.
 */
import type { Board } from '../lib/boardSchema'

/**
 * DEFAULT display cap for concurrently-spawned worker boards, used until a configured value is
 * hydrated. Mirrors `MCP_SPAWN_CAP` / `DEFAULT_SPAWN_CAP` in MAIN — duplicated here because the
 * renderer can't import MAIN. The cap is now USER-CONFIGURABLE (Settings → Agent orchestration):
 * the live value is hydrated from `window.api.orchestration.getSpawnCap()` into
 * `orchestrationConfigStore` and passed into {@link deriveWorkerPool}. Display + pump pre-check only;
 * the authoritative cap-check lives in the orchestrator's `spawnGroup`/`spawnBoard` (MAIN).
 */
export const WORKER_SPAWN_CAP = 4
/** Min/max the user may configure the spawn cap to. MIRRORS MIN_SPAWN_CAP/MAX_SPAWN_CAP in MAIN. */
export const WORKER_SPAWN_CAP_MIN = 1
export const WORKER_SPAWN_CAP_MAX = 16

/**
 * Clamp a user-entered cap to a valid integer in [MIN, MAX]; a non-finite/non-number value falls
 * back to the default (mirrors MAIN's `clampSpawnCap` so the Settings field and the store agree with
 * what MAIN will accept). The MAIN IPC re-validates regardless — this keeps the UI honest.
 */
export function clampWorkerSpawnCap(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WORKER_SPAWN_CAP
  const n = Math.floor(raw)
  if (n < WORKER_SPAWN_CAP_MIN) return WORKER_SPAWN_CAP_MIN
  if (n > WORKER_SPAWN_CAP_MAX) return WORKER_SPAWN_CAP_MAX
  return n
}

export interface WorkerPool {
  /** Idle terminals available to receive a dispatch. */
  terminalsIdle: number
  /** Terminals with a live PTY (busy = "in use"). */
  terminalsRunning: number
  /** Browser preview boards. */
  browsers: number
  /** Planning boards (seedable with a subtask checklist in Phase C/PR-6). */
  planning: number
  /** The effective spawn cap (configured value, or WORKER_SPAWN_CAP default). */
  cap: number
}

/**
 * Derive the worker-pool readout from the board list + the terminal running map
 * (`terminalRuntimeStore.running`). Pure + unit-testable. A `command` board is the orchestrator
 * itself, never a worker, so it is excluded; a `monitorActivity:false` terminal is excluded too.
 *
 * `cap` is the effective spawn cap (the configured value from `orchestrationConfigStore`, or the
 * default when a caller/test omits it) — surfaced on the pool readout so the PoolStrip display +
 * the dispatch pump's pre-check both reflect the user's setting.
 */
export function deriveWorkerPool(
  boards: ReadonlyArray<Board>,
  running: Record<string, boolean>,
  cap: number = WORKER_SPAWN_CAP
): WorkerPool {
  let terminalsIdle = 0
  let terminalsRunning = 0
  let browsers = 0
  let planning = 0
  for (const b of boards) {
    switch (b.type) {
      case 'terminal':
        // Swarm opt-out (schema v10): a plain shell the orchestrator was told to ignore is not a
        // dispatchable worker. Absent ⇒ monitored (opt-out, not opt-in).
        if (b.monitorActivity === false) break
        if (running[b.id]) terminalsRunning++
        else terminalsIdle++
        break
      case 'browser':
        browsers++
        break
      case 'planning':
        planning++
        break
      // 'command' is the orchestrator face, not a worker — excluded.
    }
  }
  return { terminalsIdle, terminalsRunning, browsers, planning, cap }
}
