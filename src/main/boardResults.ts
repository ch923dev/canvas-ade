import type { BoardResult } from '@ch923dev/canvas-ade-mcp'

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

/** Read a board's last recorded result, or the empty shell if none. Read-only. */
export function readBoardResult(id: string): BoardResult {
  return results.get(id) ?? { present: false }
}

/** Record a board's last result (M4 `write_result` entry point; e2e drives it too). */
export function recordBoardResult(id: string, result: BoardResult): void {
  results.set(id, result)
}

/** Test-only: clear the store between cases. */
export function __resetBoardResults(): void {
  results.clear()
}
