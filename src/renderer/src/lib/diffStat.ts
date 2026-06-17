/**
 * Phase D — parse a raw unified `git diff` (from the frame-guarded `mcp:gitDiff` renderer IPC,
 * itself the read-only orchestrator path with the 100 KB clamp) into a compact diffstat for the
 * Command board's result zone + recap timeline. Pure + unit-testable; no React, no `window`.
 *
 * Counts added/removed CONTENT lines (a leading `+`/`-`, excluding the `+++`/`---` file headers)
 * and changed files (one per `diff --git` header). Approximate by design — it mirrors what a user
 * reads off a diff, not git's own `--numstat` (which we don't run); the goal is the `+N −M` chip,
 * not an exact ledger.
 */
export interface DiffStat {
  insertions: number
  deletions: number
  files: number
}

export const EMPTY_DIFFSTAT: DiffStat = { insertions: 0, deletions: 0, files: 0 }

export function parseDiffStat(raw: string | undefined | null): DiffStat {
  if (!raw) return EMPTY_DIFFSTAT
  let insertions = 0
  let deletions = 0
  let files = 0
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      files++
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      // file-header lines — never counted as content changes
      continue
    } else if (line.startsWith('+')) {
      insertions++
    } else if (line.startsWith('-')) {
      deletions++
    }
  }
  return { insertions, deletions, files }
}

/** True when a raw diff carries any real change (non-blank) — gates the diffstat chip + view-diff. */
export function hasDiff(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && raw.trim().length > 0
}
