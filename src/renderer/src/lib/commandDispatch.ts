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

/** A dispatched task's engineered shape: a short intent NAME for the zone + the agent INSTRUCTION. */
export interface EngineeredDispatch {
  /** Short, Title-Case intent label — the spawned group/zone name (e.g. "Project Analysis"). */
  title: string
  /** The clear, self-contained instruction handed to the worker agent. */
  prompt: string
}

/**
 * System prompt that turns the Command board into the orchestrator's PROMPT ENGINEER. From a terse
 * task it returns BOTH a short intent label (the zone name — a raw verbose task is a poor group name)
 * AND a clear, self-contained instruction for the worker agent. Sent to the in-app LLM
 * (`window.api.llm.summarize`); the instruction is shown in the confirm modal for review. The
 * `TITLE:` line is a forgiving, parseable contract (see `parseEngineeredDispatch`).
 */
export const DISPATCH_ENGINEER_SYSTEM =
  'You are an orchestrator prompt engineer for an autonomous coding agent (Claude Code) working in ' +
  "the user's project repository. From the user's short task, output EXACTLY:\n" +
  'TITLE: <a 2-4 word Title Case label naming the task\'s intent, e.g. "Project Analysis", "Auth ' +
  'Flow", "Bug Triage">\n' +
  'then a blank line, then a SINGLE clear, self-contained instruction the agent can act on directly ' +
  '(state the goal, implied steps, and what "done" looks like; assume it can read/run/edit files). ' +
  'Output only that — no preamble, no surrounding quotes, no markdown headings, no commentary.'

/**
 * Collapse the engineered prompt to a SINGLE line for the gated REPL write (C2f). The prompt is
 * delivered into the agent's input box (the gated `dispatchPrompt` PTY write) — NOT a shell command —
 * so it is NEVER shell-parsed: no shell quoting/escaping is applied (that was both unsafe — `$`/
 * backtick command-substitution — and pointless for REPL text). We only collapse whitespace because
 * the shared write gate rejects an embedded CR/LF (one approval = one line); a paragraph prompt
 * becomes one line the agent reads as a single message.
 */
export function singleLinePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim()
}

/** A short, non-LLM fallback zone name from the raw task (first ~5 words, clamped). */
export function fallbackTitle(task: string): string {
  const words = task.trim().replace(/\s+/g, ' ').split(' ').slice(0, 5).join(' ')
  if (!words) return 'Task'
  return words.length > 40 ? words.slice(0, 40).trim() + '…' : words
}

/**
 * Parse the LLM reply into `{title, prompt}`. Forgiving: a leading `TITLE: <label>` line becomes the
 * zone name and the remainder the instruction; a reply with no TITLE line is treated as the whole
 * instruction (title falls back to the task); an empty/failed reply falls back entirely to the raw
 * task. Pure — the single source of the title/prompt extraction.
 */
export function parseEngineeredDispatch(
  result: { ok: boolean; text?: string } | null | undefined,
  rawTask: string
): EngineeredDispatch {
  const text =
    result && result.ok === true && typeof result.text === 'string' ? result.text.trim() : ''
  if (!text) return { title: fallbackTitle(rawTask), prompt: rawTask }
  const lines = text.split('\n')
  const m = lines[0].trim().match(/^TITLE:\s*(.+)$/i)
  if (!m) return { title: fallbackTitle(rawTask), prompt: text }
  const title =
    m[1]
      .trim()
      .replace(/^["']|["']$/g, '')
      .slice(0, 48) || fallbackTitle(rawTask)
  const prompt = lines.slice(1).join('\n').trim() || rawTask
  return { title, prompt }
}

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

/**
 * The oldest queued task that is READY to spawn — queued, no group yet, AND configured (a
 * `launchCommand` was committed via the config dialog, C2d). Un-configured queued tasks (still in /
 * cancelled out of the config dialog) are skipped until the user dispatches them.
 */
export function nextQueuedTask(tasks: ReadonlyArray<CommandTask>): CommandTask | undefined {
  return tasks.find((t) => t.status === 'queued' && !t.group && typeof t.launchCommand === 'string')
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
