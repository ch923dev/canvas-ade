/**
 * Background-session exit residue store (extracted from pty.ts, R6).
 *
 * When a BACKGROUND-parked proc exits on its own, its last words — the post-park ring tail + exit
 * code — are stashed here, keyed `(owningDir, boardId)`, so a switch-back can say "exited in
 * background (code N)" instead of showing a stale snapshot with no explanation. Consume-on-read
 * (Phase-5 UX); bounded; cleared per-project on close and wholesale on quit. Undo-parked exits keep
 * the silent-drop (a deleted board's process, not a running terminal).
 *
 * Extracted to a sibling (file-size doctrine: extract AROUND pty.ts's kill-tree / identity-cleanup
 * invariants, never through them) — this store touches none of them; it is a plain keyed map.
 */
import { getCurrentDir } from './projectStore'

export interface ExitResidue {
  output: string
  exitCode: number
  exitedAt: number
}

const exitResidue = new Map<string, ExitResidue>()
const EXIT_RESIDUE_CAP = 32

/** NUL separator for the compound residue key — bare board ids collide across cloned projects
 *  (R1); a NUL join (mirroring the summaryLoop precedent) can't appear in a path or a board id. */
const SEP = String.fromCharCode(0)

function residueKey(dir: string | null, id: string): string {
  return `${dir ?? ''}${SEP}${id}`
}

export function recordExitResidue(dir: string | null, id: string, r: ExitResidue): void {
  if (exitResidue.size >= EXIT_RESIDUE_CAP) {
    // Drop the oldest entry (Map preserves insertion order) — bounded, self-draining.
    const oldest = exitResidue.keys().next().value
    if (oldest !== undefined) exitResidue.delete(oldest)
  }
  exitResidue.set(residueKey(dir, id), r)
}

/** Consume (read + delete) the ACTIVE project's exit residue for a board, if any. */
export function takeExitResidue(id: string): ExitResidue | undefined {
  const key = residueKey(getCurrentDir(), id)
  const r = exitResidue.get(key)
  if (r) exitResidue.delete(key)
  return r
}

export function clearExitResidueForProject(dir: string | null): void {
  const prefix = `${dir ?? ''}${SEP}`
  for (const key of [...exitResidue.keys()]) {
    if (key.startsWith(prefix)) exitResidue.delete(key)
  }
}

/** Drop every project's residue (quit / e2e reset) — nothing will ever consume them. */
export function clearAllExitResidue(): void {
  exitResidue.clear()
}
