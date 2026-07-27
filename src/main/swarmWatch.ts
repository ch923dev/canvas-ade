/**
 * Swarm run watcher (orchestration S2) — the PROGRESS ledger to `swarmLedger`'s task ledger
 * (Magentic-One's split). One instance per app, watching every live run in the current project.
 *
 * It answers the two questions the orchestrator's own tool loop cannot, because both happen
 * BETWEEN turns — while the brain is idle and nobody is awaiting anything:
 *
 *   A · a worker died mid-task   → detect (the board left the canvas / its terminal failed),
 *                                  SALVAGE its result from the machinery that already derives one,
 *                                  mark the ledger, and narrate it in the orchestrator's one voice.
 *   B · the orchestrator dies    → `drain()` on quit: salvage every un-settled worker's current
 *                                  result, mark the run `interrupted`, and PRESERVE the worker
 *                                  boards (design D5 — closing the human's boards out from under
 *                                  them is the silent-destructive move the repo refuses elsewhere).
 *
 * plus the stall watch (design D4): a tick that folds real PTY silence into the ledger's
 * `lastActivityAt` and counts a stall EPISODE — once per episode, never once per tick.
 *
 * 🔒 Nothing here writes to a PTY, dispatches, or spends LLM budget. It records facts and narrates
 * them. Every recovery action a human might take (reassign, accept, wait) is a triage-row button
 * that still travels the gated tool path. A watcher that could re-dispatch on its own would be
 * exactly the "one approval = one action" bypass the platform refuses.
 *
 * 🔒 Salvage reads `boardResults` DIRECTLY (a sync MAIN module), not the MCP facet: the drain runs
 * inside the quit chain, where the facet may already be torn down and nothing async is safe.
 */
import { setBlockedTag, setTaskState, type SwarmLedgerStore } from './swarmLedger'
import { fmtDur, isStalled, silentMs } from './swarmLedgerProject'
import {
  MAX_LEDGER_LINE,
  SWARM_STALL_THRESHOLD_MS,
  type SwarmProvenance,
  type SwarmRunLedger,
  type SwarmTask
} from '../shared/swarmLedgerTypes'

/** How often the stall watch sweeps. Well under the 10m threshold, cheap (in-memory + one write). */
const TICK_MS = 60_000

/** Bounded per-run queue of "what happened while you were idle" lines fed to the next turn. */
const MAX_NOTICES = 20

/** The board-status slice the watcher reads (`boardRegistry.BoardStatusChange`, structurally). */
export interface SwarmWatchStatusChange {
  id: string
  status: string
}

/** The salvage read — `boardResults.readBoardResult` + `isResultSynthesized`, structurally. */
export interface SwarmSalvage {
  present?: boolean
  status?: string
  summary?: string
  refs?: string[]
  synthesized?: boolean
}

/** What the board renders for a run event the orchestrator narrates between turns. */
export interface SwarmNarration {
  /**
   * The worker this is about. The renderer resolves the TITLE (S1's `titleOf`) and prefixes both
   * strings with it — MAIN carries ids, never titles, exactly like `SwarmTriageRow`.
   */
  boardId?: string
  /** Collapsed one-line status divider, e.g. `exited`. Omitted ⇒ only the bubble is added. */
  status?: string
  /** The orchestrator bubble's sentence TAIL (rendered after the bold worker title). */
  text: string
}

export interface SwarmWatchDeps {
  store: SwarmLedgerStore
  /** `boardRegistry.subscribeBoardStatus`. Returns its unsubscribe. */
  subscribeStatus(listener: (change: SwarmWatchStatusChange) => void): () => void
  /** Sync salvage read for one board (`boardResults`). */
  readResult(boardId: string): SwarmSalvage
  /**
   * Force a synthesis attempt for one board NOW, before we read its result — `resultSynth.onSettle`,
   * which is synchronous (read the transcript facts, record a synthesized result unless the worker
   * self-reported one).
   *
   * Without this the salvage path is dead code for the exact case it exists for. A PTY exit reaches
   * `onStatus` in a few hundred ms, but synthesis is otherwise driven ONLY by the recap watcher's
   * 25s transcript debounce — so a worker that died without calling `write_result` would read as
   * "nothing to salvage" essentially every time, and permanently: once the task is `blocked` the
   * sweep never revisits it (`tick` only walks `in_progress`), so a synthesis landing 25s later is
   * never picked up. Death is itself a settle; this says so.
   */
  synthesizeNow?(boardId: string): void
  /**
   * Ms since a board last produced PTY output (`pty.getTerminalActivityStaleMs`). `undefined` for
   * a board with no live session — which is NOT silence proof, so the tick leaves it alone.
   */
  activityStaleMs?(boardId: string): number | undefined
  /** Push one narration into a run's chat spine. */
  narrate(runId: string, n: SwarmNarration): void
  /** The run's durable projection moved — re-push it to the renderer. */
  changed(runId: string): void
  now?: () => number
  tickMs?: number
  thresholdMs?: number
  /**
   * Start the sweep and return its CANCEL. A cancel closure rather than a handle: `setInterval` is
   * overloaded (Node's `Timeout` vs the DOM's `number`) and letting that handle type escape into
   * an interface makes it resolve differently per position. Tests pass a no-op and drive `tick()`.
   */
  startSweep?: (fn: () => void, ms: number) => () => void
}

export interface SwarmWatch {
  /** Subscribe to board status + start the stall sweep. Idempotent. */
  start(): void
  /** Unsubscribe + stop the sweep. Idempotent. */
  stop(): void
  /** Failure case B — SYNCHRONOUS drain of every live run (safe inside the quit chain). */
  drain(): void
  /**
   * Take (and clear) the run events that happened since the last turn, as prompt lines. The brain
   * must learn a worker died from its own context, or the next turn will await a dead board.
   */
  takeNotices(runId: string): string[]
  /** Test seam — process one status change synchronously. */
  onStatus(change: SwarmWatchStatusChange): void
  /** Test seam — run one stall sweep. */
  tick(): void
}

/**
 * Board-status buckets that mean the worker is GONE, not merely quiet.
 * - `gone`   — the board left the canvas (deleted, or the project switched under it).
 * - `failed` — the terminal's own failure bucket (a process that exited non-zero).
 * `idle` is deliberately absent: an agent that finished its turn goes idle, and `awaitSettled`
 * already treats output silence as a settle. Calling that death would fail every healthy task.
 */
const DEATH_STATUSES: ReadonlySet<string> = new Set(['gone', 'failed'])

/** The task a worker board is CURRENTLY working (a board may hold several across a run). */
function liveTaskForBoard(l: SwarmRunLedger, boardId: string): SwarmTask | undefined {
  return l.tasks.find((t) => t.assignment?.boardId === boardId && t.state === 'in_progress')
}

/** 1-based plan position, for `task 3` in a narration. `null` when the task maps to no item. */
function planPos(l: SwarmRunLedger, task: SwarmTask): number | null {
  if (!task.planItemId) return null
  const i = l.planItems.findIndex((p) => p.id === task.planItemId)
  return i < 0 ? null : i + 1
}

/** `task 3` / the task's own imperative — whatever the human will recognise. */
function taskLabel(l: SwarmRunLedger, task: SwarmTask): string {
  const pos = planPos(l, task)
  return pos !== null ? `task ${pos}` : `"${task.content.slice(0, 60)}"`
}

/** The provenance WORD the UI uses everywhere (`discloseFor` + the triage rows agree on these). */
const provenanceWord = (p: SwarmProvenance): string => (p === 'synthesized' ? 'derived' : 'claimed')

export function createSwarmWatch(deps: SwarmWatchDeps): SwarmWatch {
  const now = deps.now ?? Date.now
  const thresholdMs = deps.thresholdMs ?? SWARM_STALL_THRESHOLD_MS
  const tickMs = deps.tickMs ?? TICK_MS
  const startSweep =
    deps.startSweep ??
    ((fn: () => void, ms: number): (() => void) => {
      const h = setInterval(fn, ms)
      return () => clearInterval(h)
    })

  let unsubscribe: (() => void) | null = null
  let stopSweep: (() => void) | null = null
  const notices = new Map<string, string[]>()

  const note = (runId: string, line: string): void => {
    const list = notices.get(runId) ?? []
    list.push(line.slice(0, MAX_LEDGER_LINE))
    notices.set(runId, list.slice(-MAX_NOTICES))
  }

  /** Every run this project can still act on. A `done`/`interrupted` run is history, not a watch. */
  const liveRuns = (): SwarmRunLedger[] => deps.store.listRuns().filter((l) => l.state === 'live')

  /**
   * 🔒 Failure case A. Re-checked INSIDE `store.update` (the BUG-021 TOCTOU discipline): between
   * the status change and the write, the orchestrator's own `await_worker` may have settled this
   * task legitimately — and a settled task must never be rewritten as lost.
   */
  const recordDeath = (ledger: SwarmRunLedger, task: SwarmTask, boardId: string): void => {
    const salvage = safeRead(boardId)
    let narrated: SwarmNarration | null = null
    deps.store.update(ledger.runId, (l) => {
      const t = l.tasks.find((x) => x.taskId === task.taskId)
      if (!t || t.state !== 'in_progress') return
      const at = now()
      let provenance: SwarmProvenance | null = null
      if (salvage.present === true) {
        provenance = salvage.synthesized === true ? 'synthesized' : 'claimed'
        t.result = {
          status: (salvage.status ?? 'unknown').slice(0, MAX_LEDGER_LINE),
          summary: salvage.summary ?? '',
          refs: Array.isArray(salvage.refs) ? salvage.refs : [],
          provenance,
          at
        }
        l.eventSeq += 1
        l.events.push({
          seq: l.eventSeq,
          at,
          kind: 'salvaged',
          taskId: t.taskId,
          boardId,
          provenance
        })
      }
      // `blocked` + the `lost` TAG, not the `failed` terminal state the design table sketched:
      // `setTaskState` clears `blockedTag` on any terminal state, and `lost` is the very tag the
      // triage row and the card key off. A dead worker's task is not finished — it needs a human.
      setTaskState(l, t.taskId, 'blocked', at)
      setBlockedTag(l, t.taskId, 'lost', at)
      // The stall clock restarts: a lost task must not ALSO start emitting stall rows.
      if (t.assignment) t.assignment.lastActivityAt = at
      const label = taskLabel(l, t)
      const files = t.result ? t.result.refs.length : 0
      narrated = {
        boardId,
        status: 'exited',
        text: provenance
          ? `died on ${label} — I salvaged a result from its transcript (${provenanceWord(provenance)}${files > 0 ? `, ${files} file${files === 1 ? '' : 's'}` : ''}), so treat it as unverified. The task is back on the triage queue.`
          : `died on ${label} with nothing to salvage. The task is back on the triage queue.`
      }
    })
    if (!narrated) return
    const n: SwarmNarration = narrated
    deps.narrate(ledger.runId, n)
    note(ledger.runId, `worker ${boardId} ${n.text}`)
    deps.changed(ledger.runId)
  }

  /**
   * A salvage read must never throw into the quit chain or a status listener. NORMALIZED inside
   * the guard, not merely returned: the caller reads these fields later (inside a ledger write),
   * where a throwing accessor would escape the try entirely.
   */
  const safeRead = (boardId: string): SwarmSalvage => {
    try {
      // Settle FIRST, then read: a worker that died mid-task has a transcript on disk and no
      // `write_result`, and nothing else will convert that into a result before the sweep stops
      // caring. Best-effort and inside the same guard — a synthesizer that throws must not take
      // the salvage (or the quit chain) down with it.
      try {
        deps.synthesizeNow?.(boardId)
      } catch {
        /* synthesis is opportunistic — fall through to whatever is already recorded */
      }
      const r = deps.readResult(boardId)
      if (!r || r.present !== true) return { present: false }
      return {
        present: true,
        status: typeof r.status === 'string' ? r.status : undefined,
        summary: typeof r.summary === 'string' ? r.summary : undefined,
        refs: Array.isArray(r.refs) ? r.refs.filter((x) => typeof x === 'string') : [],
        synthesized: r.synthesized === true
      }
    } catch {
      return { present: false }
    }
  }

  const onStatus = (change: SwarmWatchStatusChange): void => {
    if (!change?.id) return
    const dead = DEATH_STATUSES.has(change.status)
    for (const ledger of liveRuns()) {
      const task = liveTaskForBoard(ledger, change.id)
      if (!task) continue
      if (dead) {
        recordDeath(ledger, task, change.id)
      } else if (change.status === 'running') {
        // A status flip to running IS ledger-observable activity — the worker is doing something.
        deps.store.update(ledger.runId, (l) => {
          const a = l.tasks.find((t) => t.taskId === task.taskId)?.assignment
          if (a) a.lastActivityAt = now()
        })
      }
    }
  }

  /**
   * The stall sweep (design D4). Two jobs, in order:
   *   1. fold REAL PTY silence into `lastActivityAt` — the ledger only sees dispatches and
   *      settles, so without this a worker that has been printing for nine minutes still looks
   *      silent. `lastActivityAt` only ever moves FORWARD (a stale reading can't rewind it).
   *   2. count a stall EPISODE and narrate it — once. The episode guard lives in the ledger
   *      itself (a `stall` event newer than `lastActivityAt`), so it survives a restart and
   *      needs no in-memory bookkeeping that a reload would lose.
   */
  const tick = (): void => {
    const at = now()
    for (const ledger of liveRuns()) {
      const narrations: SwarmNarration[] = []
      let anyStalled = false
      deps.store.update(ledger.runId, (l) => {
        for (const task of l.tasks) {
          const a = task.assignment
          if (!a || task.state !== 'in_progress') continue
          const stale = deps.activityStaleMs?.(a.boardId)
          if (typeof stale === 'number' && Number.isFinite(stale)) {
            a.lastActivityAt = Math.max(a.lastActivityAt, at - Math.max(0, stale))
          }
          if (!isStalled(task, at, thresholdMs)) continue
          anyStalled = true
          // One narration per stall EPISODE: any activity moves `lastActivityAt` past the last
          // stall event, which opens the next episode. Wait (snooze) does the same.
          const counted = l.events.some(
            (e) => e.kind === 'stall' && e.taskId === task.taskId && e.at >= a.lastActivityAt
          )
          if (counted) continue
          a.stallCount += 1
          const silent = silentMs(task, at) ?? 0
          l.eventSeq += 1
          l.events.push({
            seq: l.eventSeq,
            at,
            kind: 'stall',
            taskId: task.taskId,
            count: a.stallCount,
            silentMs: silent
          })
          narrations.push({
            boardId: a.boardId,
            text: `has been silent ${fmtDur(silent)} on ${taskLabel(l, task)} — past the ${fmtDur(thresholdMs)} stall threshold. It is still running, so I have not touched it. Reassign the task, or give it longer.`
          })
        }
      })
      for (const n of narrations) {
        deps.narrate(ledger.runId, n)
        note(ledger.runId, `worker ${n.boardId} ${n.text}`)
      }
      // Re-push while a stall PERSISTS, not only when it starts: the card's disclosure carries the
      // elapsed silence ("stalled 18m"), and a frozen number is a disclosure that quietly lies.
      if (narrations.length > 0 || anyStalled) deps.changed(ledger.runId)
    }
  }

  /**
   * 🔒 Failure case B — SYNCHRONOUS by construction. It runs inside the quit chain, where an
   * awaited promise is a race against `app.exit`: `readResult` is a sync map read and the ledger
   * write is `writeFileAtomic.sync`, so the whole drain completes before the next statement.
   *
   * What it does NOT do (design D5): kill, close, or interrupt a worker board. The run is marked
   * `interrupted` and every un-settled worker's current result is preserved; the boards are the
   * human's, and re-attach is Phase 5.
   */
  const drain = (): void => {
    for (const ledger of liveRuns()) {
      const live = ledger.tasks.filter((t) => t.state === 'in_progress' && t.assignment)
      const salvaged = new Map<string, SwarmSalvage>()
      for (const t of live) salvaged.set(t.taskId, safeRead(t.assignment!.boardId))
      deps.store.update(ledger.runId, (l) => {
        const at = now()
        let liveTasks = 0
        for (const t of l.tasks) {
          const a = t.assignment
          if (!a || t.state !== 'in_progress') continue
          liveTasks += 1
          const s = salvaged.get(t.taskId)
          // Only ATTACH — never settle. The task really was still running; whether that work is
          // usable is a judgement the human makes next session, from the triage queue.
          if (s?.present !== true || t.result) continue
          const provenance: SwarmProvenance = s.synthesized === true ? 'synthesized' : 'claimed'
          t.result = {
            status: (s.status ?? 'unknown').slice(0, MAX_LEDGER_LINE),
            summary: s.summary ?? '',
            refs: Array.isArray(s.refs) ? s.refs : [],
            provenance,
            at
          }
          l.eventSeq += 1
          l.events.push({
            seq: l.eventSeq,
            at,
            kind: 'salvaged',
            taskId: t.taskId,
            boardId: a.boardId,
            provenance
          })
        }
        l.state = 'interrupted'
        l.eventSeq += 1
        l.events.push({ seq: l.eventSeq, at, kind: 'interrupted', liveTasks })
      })
    }
  }

  return {
    start() {
      if (unsubscribe === null) unsubscribe = deps.subscribeStatus(onStatus)
      if (stopSweep === null) stopSweep = startSweep(tick, tickMs)
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
      stopSweep?.()
      stopSweep = null
    },
    drain,
    takeNotices(runId) {
      const list = notices.get(runId) ?? []
      notices.delete(runId)
      return list
    },
    onStatus,
    tick
  }
}

/**
 * Compose the run notices into the prefix that rides the NEXT turn's user message. Returns the
 * text unchanged when nothing happened — the common case must add no tokens.
 *
 * Why a prefix on the user turn rather than an injected assistant turn: the provider requires
 * strict user/assistant alternation, and two assistant turns in a row (the narration, then the
 * reply) is a malformed request. This keeps the transcript legal AND stops the brain from
 * awaiting a worker it has already been told is dead.
 */
export function withRunNotices(text: string, notices: string[]): string {
  if (notices.length === 0) return text
  return `[run events since your last turn]\n${notices.map((n) => `- ${n}`).join('\n')}\n\n${text}`
}
