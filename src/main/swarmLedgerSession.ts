/**
 * Swarm ledger session (orchestration S2) — the bridge between the tool executor's side-effects
 * and the durable `SwarmRunLedger`. One instance per RUN (= per swarm board), owned by
 * `swarmChatIpc`'s `SwarmSession`.
 *
 * Why it exists as its own module: `swarmTools.ts` should know only a tiny hook interface (so it
 * stays unit-testable with a plain stub and keeps working with NO ledger at all), and
 * `swarmChatIpc.ts` should stay wiring. The "what does a dispatch mean for the ledger" logic —
 * task identity, plan-item joins, provenance — belongs in neither, so it lives here.
 *
 * 🔒 Degradation is the design, not an afterthought. Every method resolves to a no-op when there
 * is no project, the sidecar is unwritable, or the ledger was written by a NEWER app version. A
 * run with no ledger behaves exactly like S1 (ephemeral, dies on reload) — it never errors, and it
 * never blocks a dispatch the human already approved.
 */
import {
  createSwarmLedgerStore,
  setTaskState,
  taskById,
  taskForBoard,
  type SwarmLedgerStore
} from './swarmLedger'
import {
  buildSnapshot,
  isStalled,
  liveWorktrees,
  type WorktreeStatusMap
} from './swarmLedgerProject'
import type { SwarmLedgerHooks } from './swarmTools'
import {
  MAX_LEDGER_LINE,
  SWARM_STALL_THRESHOLD_MS,
  type SwarmLedgerSnapshot,
  type SwarmPlanItem,
  type SwarmTask,
  type SwarmTaskSpec,
  type SwarmTriageAction
} from '../shared/swarmLedgerTypes'
import { singleLinePrompt } from '../shared/rolePacks'

/** One approval = one line: a reassign prompt must be a single PTY-safe line before it is used. */
const singleLine = (s: string): string => singleLinePrompt(s)

/** The planning-read slice the plan-item sync needs (structurally `RunningMcp.boardPlanning`). */
export interface PlanningReader {
  boardPlanning(boardId: string): Promise<{
    elements: Array<{
      id: string
      kind: string
      title?: string
      items?: Array<{ id: string; label: string; done: boolean }>
    }>
  }>
}

export interface SwarmLedgerSessionDeps {
  store: SwarmLedgerStore
  now?: () => number
}

export interface SwarmLedgerSession {
  /** Create-or-load this run's ledger. Safe to call repeatedly; the title only sets on create. */
  ensure(title: string): void
  /** The hooks handed to the tool executor (`SwarmRunCtx.ledger`). */
  hooks(reader: () => PlanningReader | null): SwarmLedgerHooks
  /** The renderer-facing projection, or `null` when this run has no ledger. */
  snapshot(opts?: { restored?: boolean; worktrees?: WorktreeStatusMap }): SwarmLedgerSnapshot | null
  /**
   * S3 — every distinct worktree path this run has ever allocated, so the caller (which owns the
   * I/O) knows what to `git status` before projecting. Includes trees whose task is long finished:
   * a preserved worktree stops being visible the moment we stop asking about it.
   */
  worktreePaths(): string[]
  /**
   * S3 — resolve a triage row's task id to the worktree the disposition would act on. Returns
   * `null` when the task is unknown or holds no worktree, so the dispose IPC can refuse without
   * trusting anything the renderer sent beyond the id.
   *
   * 🔒 `busy` is the destructive-path gate, re-derived here rather than inferred from the task:
   * a reused worker keeps ONE worktree across several tasks, so a row anchored on an older
   * FINISHED task can point at a tree a newer `in_progress` task is actively writing to. Callers
   * that would run `git clean -fd` must refuse on `busy`.
   */
  worktreeFor(
    taskId: string
  ): { worktree: string; branch: string; label: string; busy: boolean } | null
  /** Re-sync `planItems` from the live Planning board (labels + done + real ids). */
  syncPlan(reader: PlanningReader | null): Promise<void>
  /** Stamp "the human has seen the run up to now" — bounds the unreviewed-result rows. */
  markSeen(): void
  /**
   * Apply a triage action to one task, re-validating MAIN-side. Returns `{ok:false}` for an
   * unknown task or an inapplicable action; a `reassign` also returns the PROMPT the renderer
   * should send as the next orchestrator turn (it never dispatches by itself).
   */
  applyAction(taskId: string, action: SwarmTriageAction): { ok: boolean; prompt?: string }
  /** The swarm board was deleted — drop the durable run with it. */
  destroy(): void
}

/**
 * Task ids are per-run and derived from the ledger's own length, NOT a global counter: a restarted
 * app must keep minting ids that do not collide with the ones already on disk.
 */
function nextTaskId(existing: ReadonlyArray<{ taskId: string }>): string {
  let n = existing.length + 1
  const taken = new Set(existing.map((t) => t.taskId))
  while (taken.has(`t${n}`)) n += 1
  return `t${n}`
}

/** The plan's first checklist, projected to ledger plan items (ids are the renderer's, not ours). */
export function planItemsFrom(
  planning: {
    elements: Array<{ kind: string; items?: Array<{ id: string; label: string; done: boolean }> }>
  } | null
): SwarmPlanItem[] {
  const list = planning?.elements.find((e) => e.kind === 'checklist' && Array.isArray(e.items))
  if (!list?.items) return []
  return list.items.map((i) => ({
    id: i.id,
    label: i.label.slice(0, MAX_LEDGER_LINE),
    done: i.done === true
  }))
}

export function createSwarmLedgerSession(
  boardId: string,
  deps: SwarmLedgerSessionDeps
): SwarmLedgerSession {
  const now = deps.now ?? Date.now
  const { store } = deps

  /** Preserve each item's `ownerTaskId` across a re-sync — that join is ours, not the board's. */
  const mergeOwners = (fresh: SwarmPlanItem[], prev: SwarmPlanItem[]): SwarmPlanItem[] => {
    const owners = new Map(prev.filter((p) => p.ownerTaskId).map((p) => [p.id, p.ownerTaskId!]))
    return fresh.map((f) => {
      const owner = owners.get(f.id)
      return owner ? { ...f, ownerTaskId: owner } : f
    })
  }

  const syncPlan = async (reader: PlanningReader | null): Promise<void> => {
    const ledger = store.readRun(boardId)
    if (!ledger || !reader || !ledger.planBoardId) return
    let planning: Awaited<ReturnType<PlanningReader['boardPlanning']>> | null = null
    try {
      planning = await reader.boardPlanning(ledger.planBoardId)
    } catch {
      return // the plan board may have been deleted — leave the last known items alone
    }
    const fresh = planItemsFrom(planning)
    if (fresh.length === 0) return
    store.update(boardId, (l) => {
      l.planItems = mergeOwners(fresh, l.planItems)
    })
  }

  return {
    ensure(title) {
      store.ensureRun(boardId, title)
    },

    hooks(reader) {
      return {
        async planDrawn(planBoardId) {
          store.update(boardId, (l) => {
            l.planBoardId = planBoardId
          })
          // The checklist ids only exist once the renderer has materialised the board, so the
          // sync is a follow-up read rather than something visualizePlan could have returned.
          await syncPlan(reader())
        },

        async dispatched({ workerId, role, spec, activity, planItem, worktree, branch }) {
          // Refresh the plan first so a `planItem` position resolves against the CURRENT strip
          // (the human may have added or removed rows since the plan was drawn).
          if (planItem !== undefined) await syncPlan(reader())
          store.update(boardId, (l) => {
            const at = now()
            const planItemId = planItem !== undefined ? l.planItems[planItem - 1]?.id : undefined
            const taskId = nextTaskId(l.tasks)
            const content = spec.objective.slice(0, MAX_LEDGER_LINE)
            l.tasks.push({
              taskId,
              ...(planItemId ? { planItemId } : {}),
              content,
              // Fall back to the imperative when the orchestrator omitted an activity line —
              // a card must never render an empty verb.
              activeForm: (activity ?? content).slice(0, MAX_LEDGER_LINE),
              state: 'in_progress',
              assignment: {
                boardId: workerId,
                role,
                spec: clampSpec(spec),
                dispatchedAt: at,
                lastActivityAt: at,
                stallCount: 0,
                // 🔒 S3: the worker's own worktree, allocated BEFORE its board spawned. `null` for
                // a read-only role, which needs none. Recorded per assignment (not per worker)
                // because the assignment is the run's only durable record of who did the work —
                // so a worker's second task carries the same pair forward.
                worktree: worktree ?? null,
                branch: branch ?? null
              }
            })
            if (planItemId) {
              const item = l.planItems.find((p) => p.id === planItemId)
              if (item) item.ownerTaskId = taskId
            }
            l.eventSeq += 1
            l.events.push({
              seq: l.eventSeq,
              at,
              kind: 'assigned',
              taskId,
              boardId: workerId,
              role
            })
          })
        },

        async settled({ workerId, status, summary, refs, provenance }) {
          store.update(boardId, (l) => {
            const task = taskForBoard(l, workerId)
            if (!task) return
            const at = now()
            task.result = { status, summary, refs, provenance, at }
            if (task.assignment) task.assignment.lastActivityAt = at
            // Trust the worker's own verdict for the state; provenance records how much that
            // verdict is worth. S2 never upgrades a claim into a verification.
            const failed = /^(fail|error|blocked)/i.test(status)
            setTaskState(l, task.taskId, failed ? 'failed' : 'done', at, provenance)
            // A settled task releases its plan item's owner dot.
            const item = l.planItems.find((p) => p.ownerTaskId === task.taskId)
            if (item) delete item.ownerTaskId
          })
        }
      }
    },

    snapshot(opts) {
      const ledger = store.readRun(boardId)
      if (!ledger) return null
      return buildSnapshot(ledger, {
        now: now(),
        restored: opts?.restored === true,
        ...(opts?.worktrees ? { worktrees: opts.worktrees } : {})
      })
    },

    worktreePaths() {
      const ledger = store.readRun(boardId)
      if (!ledger) return []
      const seen = new Set<string>()
      for (const t of ledger.tasks) {
        const w = t.assignment?.worktree
        if (w) seen.add(w)
      }
      return [...seen]
    },

    worktreeFor(taskId) {
      const ledger = store.readRun(boardId)
      const task = ledger ? taskById(ledger, taskId) : undefined
      const a = task?.assignment
      if (!ledger || !task || !a?.worktree || !a.branch) return null
      const pos = ledger.planItems.findIndex((p) => p.id === task.planItemId)
      return {
        worktree: a.worktree,
        branch: a.branch,
        // The commit/stash message the modal shows and the git write uses — the branch leaf is
        // how the human identified this worker on the card.
        label: a.branch.split('/').filter(Boolean).pop() ?? (pos >= 0 ? `task ${pos + 1}` : taskId),
        // Keyed off the WORKTREE, not off `task.state`: this row may be anchored on a finished
        // task whose worker has since taken another one in the same tree.
        busy: liveWorktrees(ledger).includes(a.worktree)
      }
    },

    syncPlan,

    markSeen() {
      store.update(boardId, (l) => {
        l.lastSeenAt = now()
      })
    },

    /**
     * 🔒 Apply a triage-row action. THE REPLY PROPOSES, MAIN DISPOSES: the renderer sends a row id
     * and an action name; everything else is re-derived from the ledger here. An unknown task, or
     * an action the row was never offered, changes nothing.
     *
     * `reassign` deliberately does NOT dispatch. It un-assigns the task and hands back a prompt
     * for the ORCHESTRATOR to act on, so the re-dispatch still travels the normal gated tool path
     * and gets narrated in the chat's one voice — a button that silently wrote to a PTY would be
     * exactly the gate bypass the platform refuses.
     */
    applyAction(taskId, action) {
      const before = store.readRun(boardId)
      const task = before ? taskById(before, taskId) : undefined
      if (!before || !task) return { ok: false }
      // 🔒 The pairing is re-derived, not trusted. The renderer sends `(taskId, action)`, and until
      // this check the only validation was "the task exists" — so a stale row id (the queue moves
      // under the human) or a buggy renderer could `reassign` a perfectly healthy in-progress task,
      // wiping its live assignment and telling the orchestrator to dispatch it again. `offers()`
      // mirrors the `actions` triageRows would put on THIS task right now.
      if (!offers(task, now()).includes(action)) return { ok: false }
      const at = now()
      let prompt: string | undefined

      if (action === 'accept') {
        if (!task.result) return { ok: false } // nothing to accept
        store.update(boardId, (l) => {
          const t = taskById(l, taskId)
          if (!t?.result) return
          // Acceptance is NOT verification — provenance is untouched on purpose.
          t.result.acceptedByHuman = true
          // Accepting a DEAD worker's salvaged result is what closes that task: the work stands,
          // so the row and the card's `lost` state must go with it. Without this the tag survives
          // acceptance and the run shows a lost worker with an accepted result forever.
          if (t.blockedTag === 'lost') {
            t.state = 'done'
            delete t.blockedTag
            l.eventSeq += 1
            l.events.push({ seq: l.eventSeq, at, kind: 'status', taskId, state: 'done' })
          }
        })
      } else if (action === 'dismiss') {
        store.update(boardId, (l) => {
          const t = taskById(l, taskId)
          if (t) t.dismissed = true
        })
      } else if (action === 'wait') {
        store.update(boardId, (l) => {
          const t = taskById(l, taskId)
          if (!t) return
          // One more full threshold of patience, and the stall clock restarts so the next
          // surfacing measures silence from NOW rather than re-firing immediately.
          t.snoozedUntil = at + SWARM_STALL_THRESHOLD_MS
          if (t.assignment) t.assignment.lastActivityAt = at
        })
      } else if (action === 'reassign') {
        const pos = before.planItems.findIndex((p) => p.id === task.planItemId)
        const label =
          pos >= 0 ? `plan item ${pos + 1} ("${before.planItems[pos].label}")` : `"${task.content}"`
        const why =
          task.blockedTag === 'lost'
            ? 'its worker died mid-task'
            : task.blockedTag === 'failing_check'
              ? 'its acceptance check failed'
              : 'its worker has stalled'
        prompt = singleLine(
          `Reassign ${label} — ${why}. Spawn or pick another worker, dispatch the task again with the four-field spec, and tell me what you changed.`
        )
        store.update(boardId, (l) => {
          const t = taskById(l, taskId)
          if (!t) return
          // Back to the queue, unassigned: the old worker no longer owns this task, so it stops
          // producing stall/lost rows for work nobody is doing any more.
          t.state = 'pending'
          delete t.blockedTag
          delete t.assignment
          delete t.snoozedUntil
          l.eventSeq += 1
          l.events.push({ seq: l.eventSeq, at, kind: 'status', taskId, state: 'pending' })
          const item = l.planItems.find((p) => p.ownerTaskId === taskId)
          if (item) delete item.ownerTaskId
        })
      } else {
        return { ok: false }
      }
      return { ok: true, ...(prompt ? { prompt } : {}) }
    },

    destroy() {
      store.removeRun(boardId)
    }
  }
}

/**
 * The actions a triage row for THIS task would carry right now — the applicability gate behind
 * `applyAction`. Deliberately mirrors `triageRows`' own per-tag `actions` arrays (the same order,
 * the same conditions), because the contract is "an action the row was never offered changes
 * nothing": the row's vocabulary IS the authority, and a task that produces no row offers none.
 *
 * `open` is not listed anywhere here on purpose — it is a renderer-side jump, never a ledger write.
 * S3's `resolve` is absent for the same class of reason: a worktree disposition needs async git,
 * so it rides `swarm:worktreeDispose` (which re-validates the task → worktree join itself). Its
 * absence here is what makes `applyAction('resolve')` a no-op rather than a silent half-action.
 */
function offers(task: SwarmTask, now: number): SwarmTriageAction[] {
  if (task.blockedTag === 'lost') return task.result ? ['accept', 'reassign'] : ['reassign']
  if (task.blockedTag === 'failing_check') return ['dismiss', 'reassign']
  if (task.blockedTag === 'dependency') return []
  if (isStalled(task, now)) return ['wait', 'reassign']
  // A finished, unreviewed result: the queue offers Accept on it (the `unreviewed` row). The
  // `lastSeenAt`/snooze filters that decide whether it is CURRENTLY listed are deliberately not
  // repeated — they hide a row from the queue, they do not make accepting its result invalid.
  if (task.state === 'done' && task.result && !task.result.acceptedByHuman) return ['accept']
  return []
}

function clampSpec(spec: SwarmTaskSpec): SwarmTaskSpec {
  return {
    objective: spec.objective,
    context: spec.context,
    boundaries: spec.boundaries,
    outputFormat: spec.outputFormat
  }
}

/** Convenience for the boot wiring: one store per app, rebinding itself on a project switch. */
export function createSwarmLedgerStoreFor(getProjectDir: () => string | null): SwarmLedgerStore {
  return createSwarmLedgerStore({ getProjectDir })
}
