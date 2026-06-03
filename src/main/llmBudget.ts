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
    if (typeof p.day === 'string' && typeof p.calls === 'number' && p.calls >= 0) {
      return { day: p.day, calls: p.calls }
    }
    return null
  } catch {
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
      const state = current()
      if (state.calls >= cap) return false
      write(userDataDir, { day: state.day, calls: state.calls + 1 })
      return true
    }
  }
}
