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
 * Display cap for concurrently-spawned worker boards. Mirrors `MCP_SPAWN_CAP` in MAIN
 * (`mcpLifecycle.ts`) — duplicated here because the renderer can't import MAIN. Display-only:
 * the authoritative cap-check lives in the orchestrator's `spawnGroup`/`spawnBoard` (PR-5b).
 */
export const WORKER_SPAWN_CAP = 4

export interface WorkerPool {
  /** Idle terminals available to receive a dispatch. */
  terminalsIdle: number
  /** Terminals with a live PTY (busy = "in use"). */
  terminalsRunning: number
  /** Browser preview boards. */
  browsers: number
  /** Planning boards (seedable with a subtask checklist in Phase C/PR-6). */
  planning: number
  /** Display cap (WORKER_SPAWN_CAP). */
  cap: number
}

/**
 * Derive the worker-pool readout from the board list + the terminal running map
 * (`terminalRuntimeStore.running`). Pure + unit-testable. A `command` board is the orchestrator
 * itself, never a worker, so it is excluded; a `monitorActivity:false` terminal is excluded too.
 */
export function deriveWorkerPool(
  boards: ReadonlyArray<Board>,
  running: Record<string, boolean>
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
  return { terminalsIdle, terminalsRunning, browsers, planning, cap: WORKER_SPAWN_CAP }
}
