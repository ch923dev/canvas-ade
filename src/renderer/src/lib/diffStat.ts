/**
 * Phase D — parse a raw unified `git diff` (from the frame-guarded `mcp:gitDiff` renderer IPC,
 * itself the read-only orchestrator path with the 100 KB clamp) into a compact diffstat for the
 * Command board's result zone + recap timeline. Pure + unit-testable; no React, no `window`.
 *
 * Counts added/removed CONTENT lines (a leading `+`/`-`) and changed files (one per `diff --git`
 * header). The parse is HUNK-AWARE: `---`/`+++` are file headers ONLY in the per-file header block
 * before the first `@@`; once inside a hunk every line is classified by its FIRST char alone, so a
 * real deletion whose body is `--- a rule` (rendered `----- a rule`) or an addition whose body is
 * `++ marker` (rendered `+++ marker`) is counted, not mistaken for a header. Approximate by design —
 * it mirrors what a user reads off a diff, not git's own `--numstat` (which we don't run); the goal
 * is the `+N −M` chip, not an exact ledger.
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
  // Track whether we are inside a hunk (i.e. past the first `@@` of the current file). The
  // per-file `---`/`+++` headers only appear in the header block BEFORE the first `@@`, so we
  // suppress them there and classify everything inside a hunk by its first char alone.
  let inHunk = false
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git')) {
      files++
      inHunk = false // a new file resets to header mode
    } else if (line.startsWith('@@')) {
      inHunk = true // a hunk header opens (and re-opens) hunk context
    } else if (!inHunk && (line.startsWith('+++') || line.startsWith('---'))) {
      // file-header lines (the `--- a/file` / `+++ b/file` block) — never counted as content
      continue
    } else if (inHunk && line.startsWith('+')) {
      insertions++
    } else if (inHunk && line.startsWith('-')) {
      deletions++
    }
    // Outside a hunk: anything else (index/mode/Binary/context noise) is ignored. Inside a hunk:
    // a leading space (or any other char) is context and ignored.
  }
  return { insertions, deletions, files }
}

/** True when a raw diff carries any real change (non-blank) — gates the diffstat chip + view-diff. */
export function hasDiff(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && raw.trim().length > 0
}
