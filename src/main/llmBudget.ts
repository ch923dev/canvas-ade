/**
 * T-B3: per-day CALL-budget store for the LLM brain. Counts summarize calls against a
 * configurable per-calendar-day cap and persists the running count to
 * userData/llm-budget.json (atomic write — same userData discipline as llmConfig/llmKeyStore;
 * NEVER a project folder / .canvas/ / canvas.json). Electron-free: the clock is injected so
 * the day boundary is deterministic in tests. The engine (runSummarize) reserves one call via
 * tryConsume(cap) BEFORE the single outbound fetch; a false result becomes a typed
 * {ok:false,reason:'budget-exceeded'} and the app falls back to Tier-1. Token-dimension caps
 * are intentionally deferred (a call cap is deterministic + always available; token usage
 * would need per-provider response plumbing).
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import writeFileAtomic from 'write-file-atomic'

/** Default per-day call cap — cheap/fast summaries are short + frequent; 200/day is generous. */
export const DEFAULT_MAX_CALLS_PER_DAY = 200

/**
 * Upper bound for a persisted `calls` value when no configured cap is known (BUG-004 / BUG-038).
 * Used as the rejection threshold in read() when the actual cap is unavailable. The read-time
 * check is deliberately conservative: 10× the default (2000) guards against obvious corruption.
 * tryConsume() computes its own bound from the live cap so configured caps above 2000 work.
 */
const MAX_PERSISTED_CALLS_DEFAULT = DEFAULT_MAX_CALLS_PER_DAY * 10

/** Injected clock so the day boundary is deterministic in tests. */
export type Clock = () => Date

export interface BudgetState {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  /** Calls consumed during `day`. */
  calls: number
}

export interface BudgetStore {
  /**
   * Reserve one call against `cap` for today, resetting on a new day. Returns true (and
   * persists the increment) when allowed; false (writing nothing) when the cap is reached.
   */
  tryConsume(cap: number): boolean
  /** Today's usage (read-only; reflects a day reset without persisting). */
  peek(): BudgetState
}

function fileFor(userDataDir: string): string {
  return join(userDataDir, 'llm-budget.json')
}

/** Local YYYY-MM-DD for a Date (no UTC shift — the cap is a local-day cap). */
export function dayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Read the persisted budget state. Accepts calls up to `maxCap` (the live configured cap) so
 * caps above MAX_PERSISTED_CALLS_DEFAULT are not spuriously rejected as corrupt. When no live
 * cap is known (read-time callers like current()) the conservative default ceiling is used.
 * BUG-038: without the cap parameter, a persisted count of 2001 for a configured cap of 5000
 * was rejected as corrupt and reset to 0, creating a 0->2001->0 counter cycle.
 */
function read(userDataDir: string, maxCap?: number): BudgetState | null {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return null
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Partial<BudgetState>
    // BUG-004 (data-integrity): the on-disk `calls` is user-writable (local userData path) and
    // must be a finite, non-negative INTEGER within a sane bound. A bare `>= 0` check admits
    // floats (cap-boundary drift), Infinity (note: JSON.parse('{"calls":1e309}') === Infinity →
    // wedges the budget at cap all day), and MAX_SAFE_INTEGER (overflow DoS — every call blocked
    // until midnight). Anything outside the bound falls through to the warn + reset-to-0 path.
    // BUG-038: the upper bound is max(configured cap, default ceiling) so a legitimate count for
    // a high cap (e.g. 5000) is not rejected as corrupt. MAX_SAFE_INTEGER is still excluded.
    const ceiling = Math.max(maxCap ?? 0, MAX_PERSISTED_CALLS_DEFAULT)
    if (
      typeof p.day === 'string' &&
      typeof p.calls === 'number' &&
      Number.isInteger(p.calls) &&
      p.calls >= 0 &&
      p.calls <= ceiling
    ) {
      return { day: p.day, calls: p.calls }
    }
    // Malformed shape → today's count resets to 0. Trace it so an unexpected budget reset
    // (e.g. a OneDrive/network-share write conflict truncating the file) isn't invisible (M2).
    // BUG-038: only log this warning for genuinely malformed data, not for a valid count that
    // merely exceeds the old hard-coded 2000 ceiling.
    console.warn('[llmBudget] budget file has an invalid shape — resetting day count')
    return null
  } catch {
    console.warn('[llmBudget] budget file unreadable/corrupt — resetting day count')
    return null
  }
}

function write(userDataDir: string, state: BudgetState): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileAtomic.sync(fileFor(userDataDir), JSON.stringify(state, null, 2), 'utf8')
}

export function createBudgetStore(userDataDir: string, clock: Clock): BudgetStore {
  // BUG-038: track the largest cap seen by tryConsume so peek() can use the same ceiling and
  // avoids falsely rejecting a legitimate high count (e.g. 2001 for cap=5000) as corrupt.
  let knownCap: number | undefined

  /** Today's state, resetting a stale (prior-day) or missing/corrupt counter to zero. */
  function current(maxCap?: number): BudgetState {
    const today = dayKey(clock())
    // BUG-038: pass the live cap so read() does not reject a legitimate high count as corrupt.
    const stored = read(userDataDir, maxCap)
    if (!stored || stored.day !== today) return { day: today, calls: 0 }
    return stored
  }
  return {
    peek: () => current(knownCap),
    tryConsume(cap) {
      // Read->check->write is fully SYNCHRONOUS (no await): single-threaded Node cannot
      // interleave two tryConsume calls, so the summaryLoop and the llm:summarize IPC path --
      // which each hold their own store over this same file -- can never double-spend a slot.
      // Cross-process double-spend is precluded by Electron's single-instance lock.
      // BUG-038: pass cap to current() so a persisted count within [MAX_PERSISTED_CALLS_DEFAULT+1,
      // cap] is accepted rather than treated as corrupt and reset to 0.
      if (knownCap === undefined || cap > knownCap) knownCap = cap
      const state = current(knownCap)
      if (state.calls >= cap) return false
      write(userDataDir, { day: state.day, calls: state.calls + 1 })
      return true
    }
  }
}
