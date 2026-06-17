import type { BoardResult } from '@expanse-ade/mcp'

/**
 * MAIN-owned, in-memory store of each board's STRUCTURED last result (T1.5) — a
 * verdict + summary + references, NOT raw logs (raw scrollback lives in the PTY ring,
 * `ptyOutput.ts`). Runtime-only (not persisted to canvas.json): a result describes a
 * just-finished task, not durable project state.
 *
 * v1 has no writer, so every board reads the empty shell `{ present: false }`. This is
 * the seam M4's `write_result` tool will call via `recordBoardResult`; the MCP
 * `canvas://board/{id}/result` resource reads it via `readBoardResult`.
 */
const results = new Map<string, BoardResult>()

/**
 * PR-4: the subset of {@link results} whose entry was SYNTHESIZED from the board's recap
 * transcript (the local "for claude, derive a result from the transcript" fallback in
 * `boardResultSynth.ts`) rather than written by the worker itself via `write_result`. The
 * synthesizer consults this so it only ever overwrites its OWN prior synthesis — an explicit
 * worker self-report (recorded WITHOUT `{ synthesized: true }`) owns the id and is never
 * clobbered by a later derived snapshot. Kept in lock-step with `results` by every writer +
 * the prune/reset paths below.
 */
const synthesized = new Set<string>()

/** Read a board's last recorded result, or the empty shell if none. Read-only. */
export function readBoardResult(id: string): BoardResult {
  return results.get(id) ?? { present: false }
}

/** PR-4: true when this board's current result was synthesized (not a worker self-report). */
export function isResultSynthesized(id: string): boolean {
  return synthesized.has(id)
}

/**
 * Record a board's last result (M4 `write_result` entry point; e2e drives it too).
 * PR-4: `opts.synthesized` tags a result derived from the recap transcript; a record WITHOUT
 * it (the explicit `write_result` path, line `recordResult` delegate in index.ts) clears the
 * tag, so an explicit self-report takes ownership of the id and the synthesizer won't overwrite it.
 */
export function recordBoardResult(
  id: string,
  result: BoardResult,
  opts?: { synthesized?: boolean }
): void {
  results.set(id, result)
  if (opts?.synthesized) synthesized.add(id)
  else synthesized.delete(id)
}

/**
 * BUG-035: prune the results Map to the given live board ids.
 * Called on every project open/save/switch (same lifecycle paths that drive
 * memoryEngine.reset() and recapWatcher.retain()) so stale results from deleted
 * boards and cross-project id collisions cannot be served as current data.
 * Pass an empty Set on project switch to clear all results.
 */
export function pruneBoardResults(liveBoardIds: Set<string>): void {
  for (const id of results.keys()) {
    if (!liveBoardIds.has(id)) results.delete(id)
  }
  // PR-4: keep the synthesized-id set in lock-step so a deleted/cross-project board cannot leave
  // a stale "this was synthesized" mark that would let a future result be silently overwritten.
  for (const id of synthesized) {
    if (!liveBoardIds.has(id)) synthesized.delete(id)
  }
}

/** Test-only: clear the store between cases. */
export function __resetBoardResults(): void {
  results.clear()
  synthesized.clear()
}
