/**
 * Pure summarizer for the in-process E2E smoke (`CANVAS_SMOKE=e2e`). Keeps the
 * pass/fail + exit-code decision out of the Electron orchestrator so it can be
 * unit-tested without an Electron runtime. An empty parts list is a FAILURE —
 * it means nothing actually ran (e.g. the renderer hook never appeared).
 */
export interface E2EPart {
  /** Board/area name: 'terminal' | 'browser' | 'planning'. */
  name: string
  ok: boolean
  /** Human-readable evidence (echoed into the marker line). */
  detail?: string
}

export interface E2ESummary {
  ok: boolean
  /** 0 when ok, 1 otherwise — assigned to process.exitCode by the caller. */
  exitCode: number
  /** The `E2E_DONE …` stdout marker line. */
  line: string
}

export function summarizeE2E(parts: E2EPart[]): E2ESummary {
  const ok = parts.length > 0 && parts.every((p) => p.ok)
  return { ok, exitCode: ok ? 0 : 1, line: `E2E_DONE ${JSON.stringify({ ok, parts })}` }
}
