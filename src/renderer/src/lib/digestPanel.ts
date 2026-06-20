/**
 * Pure presentation helpers for the reopen DigestPanel (PA-10). Kept OUT of `DigestPanel.tsx` so the
 * component file only exports a component (react-refresh) and so `Canvas.tsx` can reuse the refresh
 * copy without growing (max-lines). No React / no IPC here — just data → display decisions.
 */

/** MCP-08: prose longer than this is collapsed behind a Show more / less toggle (a heuristic on
 *  char count — ~4 clamped lines — so the toggle is deterministic without measuring the DOM). */
export const PROSE_CLAMP_CHARS = 240

/**
 * MCP-04: the result of a manual ⟳ refresh, surfaced back to the panel so a refresh that produced
 * NOTHING (no provider/key, daily budget reached, no project) tells the user WHY instead of the
 * spinner silently stopping. The container owns the IPC + decides the message; the panel only shows
 * it. Absent/void return (or a plain `void`-returning handler) ⇒ no message rendered.
 */
export interface DigestRefreshResult {
  ok: boolean
  message?: string
}

/**
 * MCP-06: a board's coarse digest status → ONE of a fixed tone enum so EVERY status value gets an
 * intentional color (the audit found only `ready`/`linked` were styled; `idle`/`static`/`notes`/
 * the `n/m done` progress label all fell back to the generic gray). The dynamic planning progress
 * status ("2/5 done") is matched by SHAPE, not a literal, since its text varies.
 */
export function digestStatusTone(status: string): 'active' | 'linked' | 'progress' | 'idle' {
  if (status === 'ready') return 'active' // terminal with a launch command
  if (status === 'linked' || status === 'orchestrator') return 'linked'
  if (/^\d+\/\d+ done$/.test(status)) return 'progress' // checklist progress
  return 'idle' // idle / static / notes / unknown — a calm resting tone
}

/**
 * MCP-04: the message for a refresh that produced no summary, chosen by cause. No project open is
 * the only hard signal the renderer gets; otherwise the dominant cause is no provider/key, with the
 * daily budget as the fallback. (A budget hit is indistinguishable from "already current" without a
 * new IPC, so the copy stays soft — "may be reached".)
 */
export function digestRefreshReason(opts: { projectOpen: boolean; hasKey: boolean }): string {
  if (!opts.projectOpen) return 'Open a project to generate summaries.'
  return opts.hasKey
    ? 'No summary yet — the daily budget may be reached. Try again later.'
    : 'No AI summary — connect a provider in Settings.'
}
