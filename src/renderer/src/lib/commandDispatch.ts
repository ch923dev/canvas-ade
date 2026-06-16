/**
 * Command-board dispatch — the PURE, unit-testable core of the Phase C choreography (the
 * side-effecting half lives in `canvas/boards/command/useCommandDispatch.ts`). It owns the slot
 * accounting that serializes task spawns at the orchestrator's concurrency cap, the failed→done
 * verdict reading, and the raw-status→kanban transition. No React, no `window`, no store.
 */
import type { CommandTask, Composition, TaskGroup, TaskStatus } from '../store/commandStore'

export type { Composition, TaskGroup } from '../store/commandStore'

/** Terminal-only is the default composition (the signed-off decision); +planning/+browser opt-in. */
export const DEFAULT_COMPOSITION: Composition = { planning: false, browser: false }

/** A worker's structured result (renderer mirror of the package `BoardResult`, fields we read). */
export interface WorkerResult {
  present?: boolean
  status?: string
  summary?: string
  refs?: string[]
}

/** Slots a composition consumes against the spawn cap: terminal (always) + each opt-in member. */
export function slotsFor(c: Composition): number {
  return 1 + (c.planning ? 1 : 0) + (c.browser ? 1 : 0)
}

/** A task's composition, defaulting to terminal-only when unset (older/seam-created tasks). */
export function compositionOf(task: Pick<CommandTask, 'composition'>): Composition {
  return task.composition ?? DEFAULT_COMPOSITION
}

/** Slots held by in-flight tasks — routing + executing reserve their group's full composition. */
export function inFlightSlots(tasks: ReadonlyArray<CommandTask>): number {
  return tasks
    .filter((t) => t.status === 'routing' || t.status === 'executing')
    .reduce((n, t) => n + slotsFor(compositionOf(t)), 0)
}

/**
 * Whether a task of composition `comp` fits under `cap` given what is already in flight. The
 * renderer's estimate gates the pump; MAIN's `spawnGroup` re-check is the authoritative backstop
 * (a rejection re-queues — see `isCapError`), so a transient renderer/MAIN drift self-heals.
 */
export function canDispatch(
  tasks: ReadonlyArray<CommandTask>,
  comp: Composition,
  cap: number
): boolean {
  return inFlightSlots(tasks) + slotsFor(comp) <= cap
}

/** The oldest still-queued, not-yet-spawned task — the pump dispatches these as slots free. */
export function nextQueuedTask(tasks: ReadonlyArray<CommandTask>): CommandTask | undefined {
  return tasks.find((t) => t.status === 'queued' && !t.group)
}

/** Member tags for a task card — terminal always; planning/browser when the group spawned them. */
export function memberTags(group: TaskGroup | undefined): Array<'term' | 'plan' | 'brow'> {
  if (!group) return []
  const tags: Array<'term' | 'plan' | 'brow'> = ['term']
  if (group.planningId) tags.push('plan')
  if (group.browserId) tags.push('brow')
  return tags
}

/** A worker result carrying an explicit failure verdict (otherwise a settle is a success → done). */
export function isFailureResult(r: WorkerResult | null | undefined): boolean {
  return typeof r?.status === 'string' && /fail|error/i.test(r.status)
}

/** True when a spawn rejection was the MAIN concurrency cap (re-queue + wait, don't fail). */
export function isCapError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /cap/i.test(msg)
}

/**
 * True when a handoff failed in the PRE-gate readiness window — the just-spawned terminal hasn't
 * reached MAIN's (debounced) board mirror / spawned its PTY yet, so the terminal-check threw with no
 * side effect. SAFE to retry (no write happened). A post-confirm error (denied/write-failed) does
 * NOT match, so a retry can never re-pop the confirm.
 */
export function isWorkerNotReady(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /not found|not a terminal/i.test(msg)
}

/**
 * Pure kanban transition for a RAW board-status push. Only a terminal member going `gone` (the
 * board was closed mid-flight) changes the task here → failed; the authoritative done/failed
 * verdict comes from `handoffPrompt`'s settle, never the racy raw `idle`. Returns null = no change.
 */
export function nextStatusForBoardChange(
  current: TaskStatus,
  boardStatus: string
): TaskStatus | null {
  if (boardStatus === 'gone' && (current === 'routing' || current === 'executing')) return 'failed'
  return null
}
