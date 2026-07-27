/**
 * Swarm overlap detection + merge sequencing (orchestration S3) — PURE functions, no I/O, no
 * clock, no git. Worktree isolation makes parallel writes correct by construction; what it cannot
 * remove is the collision at **integration**, and this module is how that collision is found.
 *
 * The design (`03-mechanism.md` item 6): intersect the `refs[]` touched-file sets across workers
 * *after* they finish but *before* anything merges — "overlapping file sets are sequenced (merge
 * one, rebase the next, re-run its checks) rather than merged blind". Mechanical by construction,
 * so it is unit-tested directly rather than inferred from a rendered row.
 *
 * 🔒 The whole difficulty is NORMALISATION, and it is the one place a wrong answer is silently
 * wrong: two builders describe the same file from inside two different worktrees, so a naive
 * string compare finds nothing and the human merges blind. See {@link normalizeRef}.
 *
 * 🔒 This module never merges, rebases, or orders anything it cannot justify from the ledger. The
 * sequence is a recommendation the human executes; auto-merge is deferred (`04` Phase 3).
 */
import type { SwarmMergeStep } from '../shared/swarmLedgerTypes'

/** Cap on files named inside one overlap row — the rest collapse to `+N more`. */
export const MAX_OVERLAP_FILES_SHOWN = 3

/** One finished worker's contribution to the intersection. */
export interface OverlapInput {
  taskId: string
  boardId: string
  /** The worker's own worktree root, when it had one. Used to relativise absolute refs. */
  worktree: string | null
  /** The worker's self-reported touched files (`write_result` refs), verbatim and untrusted. */
  refs: string[]
}

/** Two workers wrote the same file(s). `a` finished/ordered before `b`. */
export interface OverlapPair {
  a: string
  b: string
  /** Display form (the FIRST spelling seen wins), sorted, unbounded — callers cap for display. */
  files: string[]
}

/**
 * Normalise one `refs[]` entry to a comparable project-relative path.
 *
 * Steps, in order, and why each exists (worked example in `s3-design-artifact.html` §8):
 *   1. strip a trailing `:line` (and `:line:col`) — `refs` may be `path` or `path:42`, and the
 *      same file touched at two different lines is still the same file.
 *   2. **make relative to the worker's own worktree** — the load-bearing step. builder-2 reports
 *      `…/.canvas/worktrees/builder-2/src/x.ts` and builder-4 reports `./src/x.ts`; without this
 *      they never compare equal and the overlap is invisible.
 *   3. normalise `\` → `/` — Windows agents emit backslashes, the same agent's next line may not.
 *   4. drop a leading `./`.
 *
 * Returns `null` for anything that normalises to nothing (an empty or whitespace-only ref), which
 * callers drop rather than counting as a match on "".
 */
export function normalizeRef(ref: string, worktree: string | null): string | null {
  if (typeof ref !== 'string') return null
  // 1. a trailing `:12` or `:12:5` is a location, not part of the path. A Windows drive letter
  //    (`C:\…`) is deliberately untouched — the anchor requires digits to the END of the string.
  let out = ref.trim().replace(/:\d+(?::\d+)?$/, '')
  if (!out) return null
  // 3 (early, so the prefix compare below is separator-agnostic in both operands).
  out = out.replace(/\\/g, '/')
  // 2. relativise against the worker's own worktree root.
  if (worktree) {
    const root = worktree.replace(/\\/g, '/').replace(/\/+$/, '')
    if (root && out.toLowerCase().startsWith(root.toLowerCase() + '/')) {
      out = out.slice(root.length + 1)
    }
  }
  // 4.
  out = out.replace(/^\.\//, '').replace(/^\/+/, '')
  return out.length > 0 ? out : null
}

/**
 * The comparison key. Case-folded — DELIBERATELY over-detecting.
 *
 * Case-folding finds a false overlap between `Foo.ts` and `foo.ts` on a case-sensitive filesystem
 * where they are genuinely two files. Branching on `process.platform` instead would make this
 * function platform-dependent and therefore untestable as a pure function. The asymmetry decides
 * it: **an over-warning costs a human one glance; an under-warning silently reverts somebody's
 * work.** Display always keeps the original spelling (see {@link detectOverlaps}).
 */
export function overlapKey(normalized: string): string {
  return normalized.toLowerCase()
}

/** Normalised, de-duplicated file set for one worker: comparison key → first spelling seen. */
function fileSetOf(input: OverlapInput): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of Array.isArray(input.refs) ? input.refs : []) {
    const norm = normalizeRef(raw, input.worktree)
    if (norm === null) continue
    const key = overlapKey(norm)
    if (!out.has(key)) out.set(key, norm)
  }
  return out
}

/**
 * Every pair of workers whose touched-file sets intersect, in input order (so `a` is always the
 * earlier of the pair given a dependency-ordered input). A worker reporting NO usable refs
 * produces no pairs — it is "unknown", not "disjoint", and the caller still lists it in the
 * sequence rather than quietly assuming it is safe to merge in any position.
 */
export function detectOverlaps(inputs: OverlapInput[]): OverlapPair[] {
  const sets = inputs.map(fileSetOf)
  const pairs: OverlapPair[] = []
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const files: string[] = []
      // Iterate the SMALLER set; the display spelling comes from the earlier worker (`i`) when it
      // has one, so a row reads in the same spelling as the branch listed first.
      const [small, large] = sets[i].size <= sets[j].size ? [sets[i], sets[j]] : [sets[j], sets[i]]
      for (const [key, shown] of small) {
        if (large.has(key)) files.push(sets[i].get(key) ?? shown)
      }
      if (files.length > 0) {
        files.sort((x, y) => x.localeCompare(y))
        pairs.push({ a: inputs[i].taskId, b: inputs[j].taskId, files })
      }
    }
  }
  return pairs
}

/** `src/a.ts, src/b.ts (+2 more)` — the overlap row's file list, capped and honest about the cap. */
export function describeOverlapFiles(files: string[], max = MAX_OVERLAP_FILES_SHOWN): string {
  const shown = files.slice(0, max).join(', ')
  const rest = files.length - Math.min(files.length, max)
  return rest > 0 ? `${shown} (+${rest} more)` : shown
}

/** A finished, isolated task as the sequence builder needs it — already in dependency order. */
export interface MergeCandidate {
  taskId: string
  boardId: string
  branch: string
  label: string
  files: number
  dirty?: boolean
}

/**
 * Build the merge sequence: the candidates in the order given (the caller sorts by plan-item
 * position, then dispatch time — the dependency order the human authored), each annotated with
 * the 1-based positions it overlaps.
 *
 * Overlaps are recorded on the LATER step only. The instruction that falls out is the one the
 * design states: merge #1, rebase #2 onto it, re-run its checks — so the human reads the warning
 * on the branch that has to move, not on the one that is already correct.
 */
export function buildMergeSequence(
  candidates: MergeCandidate[],
  overlaps: OverlapPair[]
): SwarmMergeStep[] {
  const posOf = new Map(candidates.map((c, i) => [c.taskId, i + 1]))
  const steps: SwarmMergeStep[] = candidates.map((c) => ({
    taskId: c.taskId,
    boardId: c.boardId,
    branch: c.branch,
    label: c.label,
    files: c.files,
    overlapsWith: [],
    ...(c.dirty ? { dirty: true as const } : {})
  }))
  for (const pair of overlaps) {
    const pa = posOf.get(pair.a)
    const pb = posOf.get(pair.b)
    // A pair naming a task that is not IN the sequence (unassigned, unfinished, un-isolated) is
    // dropped here rather than pointing at a position that does not exist.
    if (pa === undefined || pb === undefined || pa === pb) continue
    const [earlier, later] = pa < pb ? [pa, pb] : [pb, pa]
    const step = steps[later - 1]
    if (!step.overlapsWith.includes(earlier)) step.overlapsWith.push(earlier)
  }
  for (const step of steps) step.overlapsWith.sort((a, b) => a - b)
  return steps
}
