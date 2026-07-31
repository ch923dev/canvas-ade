/**
 * Swarm orchestrator system prompt (orchestration S1; overhauled per the 2026-07-31 agentic-
 * prompting report, docs/research/2026-07-31-swarm-prompt-overhaul.md) — the Stage-1 app-resident
 * brain's standing orders, encoding 07-swarm-board.md §4's dissemination mechanics:
 *
 *   1. FOUR-FIELD TASK SPEC — every dispatched task carries objective / context / boundaries /
 *      outputFormat (Anthropic's verified finding: omitting these produces duplication, gaps,
 *      and failure). The dispatch_task tool takes them as separate required args.
 *   2. EFFORT LADDER — 1 worker for lookups · 2-4 for comparisons · 3-5 per iteration typical ·
 *      10+ only for genuinely broad work (their system once spawned 50 subagents for a trivial
 *      query before these rules).
 *   3. WORKER LIFECYCLE — workers are standing capacity: reuse an idle role-match before any
 *      spawn, a spawn commits the next matching dispatch to THAT worker, and after any confirm
 *      gate the roster memory is stale — `list_workers` is the truth (report V2: the orphan-spawn
 *      incident class).
 *   4. WRITE SERIALIZATION, DISCLOSED — write-posture workers are capped (1 shared tree / 2 with
 *      worktrees); the cap is enforced by the executor and must be DISCLOSED in chat when it
 *      bites — no silent caps (06 §2).
 *   5. ONE VOICE — workers never speak to the human; narrate their events as short collapsed
 *      lines and never paste raw worker output into chat (structured reports in, transcripts
 *      one click away — the worker card holds the real terminal).
 *
 * The role CATALOG (ids + one-line purposes) is composed in from the shared role packs; the
 * full role brief is prepended by the dispatch executor (packDispatchPrompt), not carried here.
 *
 * This block is static per pause-state and rides a `cache_control` breakpoint in swarmChatIpc —
 * anything per-turn (the live worker roster) is injected into the USER turn instead
 * ({@link composeTurnRoster}), so the cache never busts on roster churn.
 */
import { ROLE_PACKS } from '../shared/rolePacks'
import type { SwarmRunLedger } from '../shared/swarmLedgerTypes'
import { TERMINAL_TASK_STATES } from './swarmLedger'

/** One line per role so the model picks by purpose, not by guessing ids. */
const roleCatalog = (): string =>
  ROLE_PACKS.map(
    (p) =>
      `- ${p.id} (${p.permissionMode === 'plan' ? 'read-only' : 'write'}): ${p.entryCondition ?? p.name}`
  ).join('\n')

export function composeSwarmSystem(paused: boolean): string {
  return [
    'You are the ORCHESTRATOR of a swarm run on the Expanse canvas. The human talks to you and',
    'only you; you decompose their goal, dispatch tasks to worker terminal agents, watch their',
    'results, and narrate progress. You are a coordinator — you never write code or files',
    'yourself; workers do the work.',
    '',
    'RULES (all mandatory):',
    '- PLAN FIRST: at the start of a run, draw the plan with draw_plan (a short checklist of',
    '  numbered steps). Keep it honest as the run evolves: pass dispatch_task the planItem number',
    '  a task fulfils, and tick_plan_item as each step actually lands. Never tick ahead of the',
    '  work — the strip is what the human trusts to know where the run is.',
    '- EFFORT LADDER: 1 worker for a simple lookup/fix · 2-4 for comparisons/reviews · 3-5 for a',
    '  typical multi-part task · 10+ ONLY for genuinely broad, parallelizable work. Never spawn',
    '  more workers than the task needs.',
    "- WORKERS ARE REUSABLE: a spawned worker is standing capacity, not one task's wrapper.",
    '  Before ANY spawn, check the roster (the [worker roster] block in the latest turn, or',
    '  list_workers) for an idle worker whose role fits; if one exists, dispatch to it — do not',
    '  spawn a duplicate. Spawn only when no idle role-match exists or the effort ladder',
    '  genuinely calls for parallel capacity.',
    '- SPAWN COMMITS YOU TO DISPATCH: spawning creates capacity for a specific need — the next',
    '  dispatch for that need goes to THAT worker id. Never leave a spawned worker idle with no',
    '  task while spawning another; an orphaned worker is your bookkeeping error. After any',
    '  confirm gate or denial, re-check list_workers before deciding to spawn — your memory of',
    '  the roster is stale; the tool is the truth.',
    '- FOUR-FIELD TASKS: every dispatch_task carries objective (what done looks like), context',
    '  (what the worker must know: background, key questions, suggested starting points, and',
    '  what other in-flight workers own), boundaries (what it must NOT touch), and outputFormat',
    '  (how to report back). Vague dispatches produce duplication and gaps. Write each spec so',
    '  that if every worker followed its instructions exactly, the results together would answer',
    '  the whole goal.',
    '- DISTINCT TASKS: in any round, every task must be clearly separate work — no two workers',
    "  on overlapping ground. Each task's context names what the other in-flight workers own so",
    "  no one re-does or collides with a sibling's work.",
    '- WRITE SERIALIZATION: write-role workers share one working tree unless each holds its own',
    '  worktree, so write-role tasks are capped (the executor refuses more). When the cap bites,',
    '  SAY SO in your reply and either queue the write or dispatch read-only work meanwhile.',
    '  Read-only roles (reviewer/explorer/researcher/planner) may run in parallel freely.',
    '- ONE VOICE: never paste raw worker output into chat. Summarize results in one or two lines;',
    '  the human can open any worker card for the real terminal.',
    '- HUMAN GATE: every spawn and every dispatch pays a human confirmation before it lands. If a',
    '  confirm is denied, accept it — do not retry the same action.',
    '- BATCH A ROUND: when you are handing out several tasks together, use dispatch_tasks (plural)',
    '  rather than repeated dispatch_task. The human reviews every row in ONE confirm and approves',
    '  them individually; some rows may come back denied, and you must say which and carry on.',
    "- NO ROLE FITS: if a task matches no role's purpose, say so and ask the human — do not force",
    '  it onto the nearest role. A worker\'s "failed — needs X" report is routing information:',
    '  re-dispatch to the right role or surface the gap; do not re-try the same role.',
    '- KNOW WHEN TO STOP: when the remaining plan items are done or further dispatches have',
    '  diminishing returns, stop dispatching, synthesize what landed, and report. Do not spawn or',
    '  dispatch to "make sure".',
    paused
      ? '- THE RUN IS PAUSED: dispatch/spawn tools will refuse. Answer questions, refine the plan,'
      : '- PAUSE: if the human pauses the run, dispatch/spawn tools refuse until resumed.',
    paused ? '  and wait for the human to resume.' : '',
    '',
    'WORKER ROLES (pick by purpose; the role brief is attached to your dispatch automatically):',
    roleCatalog(),
    "Each role has a default model tier; pass spawn_worker's optional model (haiku|sonnet|opus)",
    'only when the human asks for a specific model or the task clearly warrants a stronger one.',
    '',
    'Reply style: terse and factual, like a good engineering lead. Present tense for in-flight',
    'work ("dispatching builder-1"), past for landed facts.'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

// ── Per-turn roster injection (report §3.3 item 2 — the load-bearing orphan-spawn fix) ──

/** One roster row, already joined across the session's role map, live boards, and the ledger. */
export interface TurnRosterWorker {
  id: string
  role: string
  /** The worker board's live title (the name the human sees); falls back to the id. */
  title?: string
  /** The active task's present-continuous line — present ⇒ busy, absent ⇒ idle. */
  activity?: string
  /** 1-based plan-strip position of the active task, when it maps to one. */
  planItem?: number
  /** The watcher's verdict on a busy worker (stalled ⇒ silent too long; ledger state). */
  stalled?: boolean
}

/**
 * Join the session's spawned-worker map, the live board list, and the run ledger into roster
 * rows. Pure — swarmChatIpc feeds it and prepends {@link composeTurnRoster}'s block to the user
 * turn. Sources, in order of authority:
 *  - `roles` (session `workerRoles`): every worker spawned THIS session, including one spawned
 *    and never dispatched — exactly the orphan the roster exists to surface.
 *  - `ledger.tasks`: busy/idle + activity + plan item (an in-flight assignment ⇒ busy). Also
 *    re-seeds workers from assignments after a restart, when the session map is empty.
 *  - `boards` (live canvas): titles, and existence — a worker whose board is gone is dropped
 *    (it is not dispatchable; the watcher's notices already told the brain it died). A null
 *    `boards` (no facet) keeps every known worker rather than guessing.
 */
export function turnRosterWorkers(
  roles: ReadonlyMap<string, string>,
  boards: ReadonlyArray<{ id: string; title?: string; status?: string }> | null,
  ledger: Pick<SwarmRunLedger, 'tasks' | 'planItems'> | null
): TurnRosterWorker[] {
  const known = new Map<string, TurnRosterWorker>()
  for (const [id, role] of roles) known.set(id, { id, role })
  // Ledger pass: the NEWEST task entry per board is the worker's current one, and it reads busy
  // only while that entry is non-terminal — a board whose latest task finished is idle. A raw
  // fold over all history would let an old, never-revisited `blocked` entry's activity/stalled
  // shadow a later finish, showing a fully idle worker as stuck forever — so the orchestrator
  // spawns a duplicate instead of reusing it, the exact incident class this roster exists to
  // prevent (PR #417 review). Deliberately NOT taskForBoard's prefer-open resolution: that
  // preference exists to route a worker's re-settle onto its open row, and here it would keep
  // the same stale blocked entry current past a newer finished task.
  const current = new Map<string, SwarmRunLedger['tasks'][number]>()
  for (const task of ledger?.tasks ?? []) {
    const a = task.assignment
    if (!a) continue
    if (!known.has(a.boardId)) known.set(a.boardId, { id: a.boardId, role: a.role })
    current.set(a.boardId, task)
  }
  for (const [boardId, task] of current) {
    if (TERMINAL_TASK_STATES.has(task.state)) continue
    const row = known.get(boardId)!
    row.activity = task.activeForm
    if (task.state === 'blocked') row.stalled = true
    if (task.planItemId && ledger) {
      const idx = ledger.planItems.findIndex((p) => p.id === task.planItemId)
      if (idx >= 0) row.planItem = idx + 1
    }
  }
  if (boards === null) return [...known.values()]
  const live = new Map(boards.map((b) => [b.id, b]))
  const rows: TurnRosterWorker[] = []
  for (const row of known.values()) {
    const board = live.get(row.id)
    if (!board) continue
    const title = typeof board.title === 'string' ? board.title.trim() : ''
    rows.push(title ? { ...row, title } : row)
  }
  return rows
}

/**
 * The `[worker roster]` block prepended to each orchestrator USER turn — ambient, authoritative
 * roster state so "spawn vs. reuse" is decided against the live truth, not a tool result several
 * turns back behind a confirm gate (context rot — the orphan-spawn condition). Injected into the
 * user turn, NEVER the system block: `composeSwarmSystem` rides a `cache_control` breakpoint and
 * per-turn text there would bust the cache every turn. Request-only (not stored in history), so
 * stale rosters never accumulate in the transcript. Empty string when there is nothing to say
 * (no workers and no plan) — turn one stays clean.
 */
export function composeTurnRoster(
  workers: ReadonlyArray<TurnRosterWorker>,
  plan?: { done: number; total: number } | null
): string {
  const planLine = plan && plan.total > 0 ? `plan: ${plan.done}/${plan.total} done` : ''
  if (workers.length === 0 && !planLine) return ''
  const lines = workers.map((w) => {
    const name =
      w.title && w.title !== w.id ? `${w.title} (${w.id}, ${w.role})` : `${w.id} (${w.role})`
    if (!w.activity) return `- ${name}: idle — reuse before spawning another ${w.role}`
    const plan = w.planItem !== undefined ? `, plan item ${w.planItem}` : ''
    const stall = w.stalled ? ' [stalled/blocked]' : ''
    return `- ${name}: busy — "${w.activity}"${plan}${stall}`
  })
  return [
    '[worker roster — live state this turn; dispatch to an idle role-match before spawning]',
    ...(workers.length === 0 ? ['- no workers spawned yet'] : lines),
    ...(planLine ? [planLine] : [])
  ].join('\n')
}
