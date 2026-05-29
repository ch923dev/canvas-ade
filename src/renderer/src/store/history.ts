/**
 * Pure undo/redo helpers over plain arrays (no React/Zustand). The canvas store
 * holds `past: T[]`, `boards: T` (the present), `future: T[]`; these advance them.
 * Kept pure so the stack semantics are unit-tested in isolation.
 */
export const HISTORY_LIMIT = 50

/** Append `present` to `past`, keeping at most `limit` entries (oldest dropped). */
export function recordPast<T>(past: T[], present: T, limit = HISTORY_LIMIT): T[] {
  return [...past, present].slice(-limit)
}

/** Step back: pop past→present, push old present→future. null if past is empty. */
export function applyUndo<T>(
  past: T[],
  present: T,
  future: T[],
  limit = HISTORY_LIMIT
): { past: T[]; present: T; future: T[] } | null {
  if (past.length === 0) return null
  return {
    present: past[past.length - 1],
    past: past.slice(0, -1),
    future: [present, ...future].slice(0, limit)
  }
}

/** Step forward: shift future→present, push old present→past. null if future empty. */
export function applyRedo<T>(
  past: T[],
  present: T,
  future: T[],
  limit = HISTORY_LIMIT
): { past: T[]; present: T; future: T[] } | null {
  if (future.length === 0) return null
  return {
    present: future[0],
    future: future.slice(1),
    past: recordPast(past, present, limit)
  }
}
