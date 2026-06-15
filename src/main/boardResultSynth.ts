/**
 * boardResultSynth.ts — PR-4 (Command-board prerequisite): synthesize a board's structured
 * `BoardResult` from its recap transcript when the worker agent settles.
 *
 * The EXPLICIT result path is already wired end-to-end: a worker calls the worker-tier
 * `write_result` MCP tool → `orchestrator.writeResult` → `recordBoardResult` (and wakes any
 * parked handoff). What this file adds is the COMPLEMENTARY local fallback the design calls for —
 * "for claude, reuse the existing recap transcript watcher to synthesize a result" — so the
 * `done` state, the recap TIMELINE, and merge get a real `BoardResult` even when the agent does
 * not self-report.
 *
 * 🔒 Security: this is LOCAL-ONLY (it reads the same transcript tail the recap face already reads,
 * via `computeRecapFacts`) — no egress, no LLM, no token, and NO new write path to any PTY. It only
 * writes the MAIN-internal results store, exactly like the existing recap/summary read paths. An
 * explicit worker self-report always wins: {@link createResultSynthesizer} never overwrites a result
 * the worker recorded itself (tracked by `isResultSynthesized`).
 */
import type { BoardResultInput } from '@expanse-ade/mcp'
import type { RecapFacts } from './recapFacts'
import { IDLE_AFTER_MS } from './summaryLoop'
import { isResultSynthesized, readBoardResult, recordBoardResult } from './boardResults'

/** Cap the synthesized one-line summary (a glance anchor, not a transcript — recap's weight class). */
export const SYNTH_SUMMARY_MAX = 200

/**
 * Pure: map a board's recap facts to the `BoardResultInput` a worker would have self-reported,
 * or `null` when no verdict should be recorded yet.
 *
 * Returns `null` for the NOT-DONE states — `running`/`spawning` (transient toward idle; the
 * scheduler re-checks once they quiet) and `waiting-on-you` (blocked on the user, not a
 * completion). For a settled board it produces a `failure` verdict on a non-zero exit or a
 * spawn-failure, else `success`, plus a one-line summary and the touched-file paths as `refs`
 * (already deduped + recency-capped upstream by `computeRecapFacts`).
 */
export function synthesizeBoardResult(facts: RecapFacts): BoardResultInput | null {
  const { status } = facts
  if (status === 'running' || status === 'spawning' || status === 'waiting-on-you') return null

  const failed =
    status === 'spawn-failed' ||
    (status === 'exited' && typeof facts.exitCode === 'number' && facts.exitCode !== 0)

  const out: BoardResultInput = {
    status: failed ? 'failure' : 'success',
    summary: buildSummary(facts, failed)
  }
  const refs = facts.files.map((f) => f.path)
  if (refs.length > 0) out.refs = refs
  return out
}

/** One-line, capped summary: `[exit/spawn head] — [session title] — [N files, M commands, K turns]`. */
function buildSummary(facts: RecapFacts, failed: boolean): string {
  const head =
    facts.status === 'spawn-failed'
      ? 'spawn failed'
      : facts.status === 'exited'
        ? typeof facts.exitCode === 'number'
          ? `exited (code ${facts.exitCode})`
          : 'exited'
        : ''
  const counts: string[] = []
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (facts.files.length) counts.push(plural(facts.files.length, 'file'))
  if (facts.commands.length) counts.push(plural(facts.commands.length, 'command'))
  if (facts.turns.agent) counts.push(plural(facts.turns.agent, 'turn'))

  const segs = [head, facts.title ?? '', counts.join(', ')].filter(Boolean)
  const summary = segs.join(' — ') || (failed ? 'failed' : 'completed')
  return summary.slice(0, SYNTH_SUMMARY_MAX)
}

export interface ResultSynthDeps {
  /** Resolve a board's current recap facts (transcript tail + runtime), or null if unavailable. */
  getFacts: (boardId: string) => RecapFacts | null
  /** Clock seam (default Date.now); stamps the recorded result's `at`. */
  now?: () => number
  /** Transcript-silence threshold above which a quiet agent reads `idle` (default IDLE_AFTER_MS). */
  idleAfterMs?: number
  /** Slack added to the deferred re-check so it lands JUST past the idle threshold (default 1s). */
  recheckSlackMs?: number
  /** Timer seam (tests inject a manual scheduler). Returns a cancel fn. Default: unref'd setTimeout. */
  schedule?: (fn: () => void, ms: number) => () => void
}

export interface ResultSynthesizer {
  /**
   * A transcript settle fired for `boardId` — record a synthesized result NOW if the agent is
   * settled; if it is still transiently active (`running`/`spawning`), park ONE deferred re-check
   * just past the idle threshold to catch the quiet finish (the watcher won't re-fire without
   * another transcript write).
   */
  onSettle(boardId: string): void
  /** Drop pending re-check timers for boards no longer live (mirrors `recapWatcher.retain`). */
  retain(liveBoardIds: Set<string>): void
  /** Cancel every pending re-check timer (teardown). */
  dispose(): void
}

/**
 * Build the settle→synthesize driver. One pending re-check timer per board at most; the deferred
 * re-check is ONE-SHOT (never re-arms itself) so a perpetually-busy board can't spin a poll loop —
 * a genuinely resumed agent re-arms only via a fresh transcript settle.
 */
export function createResultSynthesizer(deps: ResultSynthDeps): ResultSynthesizer {
  const now = deps.now ?? Date.now
  const idleAfterMs = deps.idleAfterMs ?? IDLE_AFTER_MS
  const slack = deps.recheckSlackMs ?? 1000
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return () => clearTimeout(t)
    })

  const timers = new Map<string, () => void>()
  const clearTimer = (id: string): void => {
    const cancel = timers.get(id)
    if (cancel) {
      cancel()
      timers.delete(id)
    }
  }

  // Record a synthesized result for `id` UNLESS an explicit `write_result` owns it (a present
  // result not tagged synthesized = the worker self-reported → never clobber it).
  const tryRecord = (id: string, facts: RecapFacts): void => {
    const existing = readBoardResult(id)
    if (existing.present && !isResultSynthesized(id)) return
    const input = synthesizeBoardResult(facts)
    if (!input) return
    recordBoardResult(
      id,
      { present: true, at: new Date(now()).toISOString(), ...input },
      { synthesized: true }
    )
  }

  const run = (id: string, allowRecheck: boolean): void => {
    let facts: RecapFacts | null = null
    try {
      facts = deps.getFacts(id)
    } catch {
      facts = null
    }
    if (!facts) return
    tryRecord(id, facts)
    if (!allowRecheck) return
    if (facts.status === 'running' || facts.status === 'spawning') {
      const elapsed = facts.lastActivity ? Math.max(0, now() - facts.lastActivity) : 0
      const wait = Math.max(0, idleAfterMs - elapsed) + slack
      clearTimer(id)
      timers.set(
        id,
        schedule(() => {
          timers.delete(id)
          run(id, false)
        }, wait)
      )
    }
  }

  return {
    onSettle(boardId) {
      run(boardId, true)
    },
    retain(liveBoardIds) {
      for (const id of [...timers.keys()]) if (!liveBoardIds.has(id)) clearTimer(id)
    },
    dispose() {
      for (const id of [...timers.keys()]) clearTimer(id)
    }
  }
}
