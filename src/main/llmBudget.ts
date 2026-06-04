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
 * Upper bound for a persisted `calls` value (BUG-004). The running count can never legitimately
 * exceed any reasonable cap, so an on-disk value beyond 10× the default is corrupt/tampered and
 * is rejected (→ reset to 0) rather than trusted — closing the overflow-DoS / cap-wedge class.
 */
const MAX_PERSISTED_CALLS = DEFAULT_MAX_CALLS_PER_DAY * 10

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

function read(userDataDir: string): BudgetState | null {
  const f = fileFor(userDataDir)
  if (!existsSync(f)) return null
  try {
    const p = JSON.parse(readFileSync(f, 'utf8')) as Partial<BudgetState>
    // BUG-004 (data-integrity): the on-disk `calls` is user-writable (local userData path) and
    // must be a finite, non-negative INTEGER within a sane bound. A bare `>= 0` check admits
    // floats (cap-boundary drift), Infinity (note: JSON.parse('{"calls":1e309}') === Infinity →
    // wedges the budget at cap all day), and MAX_SAFE_INTEGER (overflow DoS — every call blocked
    // until midnight). Anything outside the bound falls through to the warn + reset-to-0 path.
    if (
      typeof p.day === 'string' &&
      typeof p.calls === 'number' &&
      Number.isInteger(p.calls) &&
      p.calls >= 0 &&
      p.calls <= MAX_PERSISTED_CALLS
    ) {
      return { day: p.day, calls: p.calls }
    }
    // Malformed shape → today's count resets to 0. Trace it so an unexpected budget reset
    // (e.g. a OneDrive/network-share write conflict truncating the file) isn't invisible (M2).
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
  /** Today's state, resetting a stale (prior-day) or missing/corrupt counter to zero. */
  function current(): BudgetState {
    const today = dayKey(clock())
    const stored = read(userDataDir)
    if (!stored || stored.day !== today) return { day: today, calls: 0 }
    return stored
  }
  return {
    peek: current,
    tryConsume(cap) {
      // Read→check→write is fully SYNCHRONOUS (no await): single-threaded Node cannot
      // interleave two tryConsume calls, so the summaryLoop and the llm:summarize IPC path —
      // which each hold their own store over this same file — can never double-spend a slot.
      // Cross-process double-spend is precluded by Electron's single-instance lock.
      const state = current()
      if (state.calls >= cap) return false
      write(userDataDir, { day: state.day, calls: state.calls + 1 })
      return true
    }
  }
}
