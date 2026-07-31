/**
 * Role packs (orchestration Phase 0) — the ONE declarative abstraction that makes "builder" and
 * "code-reviewer" two instances of a single dispatch primitive instead of two systems. A pack is
 * PURE DATA: swapping the pack swaps the worker's launch flags (model / effort / permission
 * posture, composed through the existing `agentPresets`/`composeCommand` pipeline), the role brief
 * prepended to the dispatched prompt, and the dispatch policy (write-role concurrency) — with zero
 * code fork per role. Schema follows the orchestration plan (`docs/orchestration/03-mechanism.md`
 * item 2 + `08-role-catalog.md` §3 — the three catalog deltas `writeScope` / `entryCondition` /
 * `domainHint` included; `08` wins where the two conflict).
 *
 * Phase-0 scope decisions (deliberate, documented in the PR):
 *  - App-side only. Packs never cross the MCP wire; the broker/`@expanse-ade/mcp` is untouched.
 *    `tier` is carried as data for later phases — today every Command-board worker still enrolls
 *    through the existing spawn path and the existing single human-confirm write gate.
 *  - claude is the reference worker CLI (open question Q8): `packOptionValues` targets the claude
 *    preset's option ids. Other CLIs stay reachable through the dialog's Custom escape hatch.
 *  - The role brief rides the gated REPL dispatch (prepended to the task prompt), NOT an
 *    `--append-system-prompt` launch flag — the spawn launchCommand is clamped to one 400-char
 *    line in MAIN (`mcpLifecycle.SPAWN_LAUNCH_MAX`), which a real brief would blow, and the REPL
 *    path pays the same single human confirm as every dispatch.
 *  - `isolation` was declared but NOT provisioned in Phase 0. **S3 provisions it**: a pack that
 *    declares `isolation: 'worktree'` now gets a real git worktree on its own branch before its
 *    board spawns (`src/main/swarmWorktree.ts`), so the write-concurrency ceiling rose from 1 to
 *    {@link WRITE_ROLE_CONCURRENCY_CAP} — but only for writers that ACTUALLY hold one; see
 *    {@link writeRoleConcurrencyCap}.
 */

/** Semantic model tier (cheap reader / mid builder / expensive judge) + optional explicit pin. */
export interface RolePackModel {
  tier: 'cheap' | 'mid' | 'expensive'
  /** Explicit model override — wins over the tier alias when set (e.g. a dated model id). */
  pin?: string
  /** Reasoning effort, emitted as the claude `--effort` flag when set. */
  effort?: 'low' | 'medium' | 'high'
}

/** When is this role's unit of work "done and good"? (Recorded as data; enforced in later phases.) */
export interface RolePackAcceptance {
  /** Must the worker self-report via `write_result` (vs. output-silence settle being enough)? */
  requiresWriteResult: boolean
  /** Accept only these self-reported statuses ("failed"/"blocked" = incomplete). */
  statusMustBe?: 'done'[]
  /** Host-runnable predicates for later phases, e.g. "git_diff:nonempty". */
  checks?: string[]
}

/**
 * One declarative role. Everything a role IS lives here — the dispatch path reads packs and never
 * branches on a role id. `reportSchema` is the JSON-schema shape the role's `write_result` payload
 * should satisfy (data now; host-side validation is a later-phase item).
 */
export interface RolePack {
  id: string
  name: string
  /** Broker capability envelope (worker < connected < lead). Data-only in Phase 0 (no wire change). */
  tier: 'lead' | 'connected' | 'worker'
  /** CLI permission posture; 'plan' = read-only. Composed into the launch command. */
  permissionMode: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions'
  model: RolePackModel
  /** Declared isolation need. NOT provisioned in Phase 0 (worktrees are Phase 3) — see write cap. */
  isolation: 'none' | 'worktree'
  /** Dispatch-confirm posture. 'session-consented' is legal for READ-ONLY roles only (Q4). */
  confirmPolicy: 'per-write' | 'batch' | 'session-consented'
  /** The role brief prepended to every dispatched task prompt (the worker's standing orders). */
  systemPrompt: string
  reportSchema: Record<string, unknown>
  acceptance: RolePackAcceptance
  /** Path/branch-scoped write predicate (catalog delta 1). Advisory data in Phase 0. */
  writeScope?: string
  /** Advisory routing hint — when this role should be dispatched (catalog delta 2). */
  entryCondition?: string
  /** Free-text domain flavor absorbing the persona zoo without new packs (catalog delta 3). */
  domainHint?: string
}

/**
 * Concurrent write-posture workers, each in ITS OWN git worktree — the disclosed parallel-writer
 * ceiling from `07-swarm-board.md` §4.3 ("≤2 concurrent write-role workers; readers effectively
 * unbounded", Cursor's shipped rule). Disjoint trees make the writes correct by construction; what
 * survives is the INTEGRATION collision, which S3 detects (`swarmOverlap.ts`) and sequences for a
 * human rather than merging.
 */
export const WRITE_ROLE_CONCURRENCY_CAP = 2

/**
 * The ceiling when even ONE in-flight writer has no worktree of its own — it shares the project
 * working tree with every other writer, which is the pre-S3 situation exactly, so the pre-S3 cap
 * applies. An un-isolated write role stays LEGAL (cwd is advisory, and forbidding it is an open
 * question `03-mechanism.md` item 6 leaves open); it just cannot run in parallel with anything.
 */
export const WRITE_ROLE_CONCURRENCY_CAP_SHARED = 1

/**
 * The cap that applies right now. A FUNCTION, not a constant, because raising the number without
 * checking what actually provisioned would ship a cap whose disclosure string is a lie — the exact
 * failure the S3 kickoff calls out ("a cap raised without the strings updated is worse than no
 * change"). Both refusal strings in `swarmTools.ts` name whichever case fired.
 *
 * @param allIsolated every in-flight (and about-to-be-dispatched) write worker holds a worktree.
 */
export function writeRoleConcurrencyCap(allIsolated: boolean): number {
  return allIsolated ? WRITE_ROLE_CONCURRENCY_CAP : WRITE_ROLE_CONCURRENCY_CAP_SHARED
}

/** Claude `--model` alias per semantic tier (cheap reader / mid builder / expensive judge). */
export const MODEL_TIER_CLAUDE_ALIAS: Record<RolePackModel['tier'], string> = {
  cheap: 'haiku',
  mid: 'sonnet',
  expensive: 'opus'
}

/** A pack whose permission posture can write. Read posture is exactly 'plan'. */
export function isWriteRolePack(pack: Pick<RolePack, 'permissionMode'>): boolean {
  return pack.permissionMode !== 'plan'
}

/**
 * Does an ACTUAL committed launch command still prove the read-only posture a read pack declared?
 * The composed command stays user-editable after a pack pre-fills it (the pack is the DEFAULT, not
 * a lock), so the write-role gate and the dialog's write warning must key off the command a worker
 * will really launch with, not the pack's static declaration (PR #381 review). Read-only evidence =
 * the LAST `--permission-mode` value is `plan` (the CLI honours the last flag) AND no
 * `--dangerously-skip-permissions`. Anything else — flag removed, mode changed, bypass toggled,
 * a different CLI hand-typed — fails CLOSED to write posture: over-gating only serializes a
 * dispatch; under-gating lets two writers share one working tree.
 */
export function launchLooksReadOnly(launchCommand: string | undefined): boolean {
  if (typeof launchCommand !== 'string') return false
  if (/--dangerously-skip-permissions\b/.test(launchCommand)) return false
  const modes = [...launchCommand.matchAll(/--permission-mode[= ]+(\w+)/g)]
  return modes.length > 0 && modes[modes.length - 1][1] === 'plan'
}

/**
 * The catalog: builder + code-reviewer (the two proof instances from `03` item 2), explorer
 * (proves the cheap-read axis), researcher (external-source investigation — the catalog hole the
 * 2026-07-31 prompt-overhaul report's incident 1 exposed), and planner (its artifact is
 * planning-board elements), per the `08` §4 rollout. The packs differ ONLY in data — same spawn
 * path, same dispatch path, same report path. That is the proof that role is a parameter, not a
 * fork. Brief template: docs/research/2026-07-31-swarm-prompt-overhaul.md §3.1.
 */
export const ROLE_PACKS: readonly RolePack[] = [
  {
    id: 'builder',
    name: 'Builder',
    tier: 'connected',
    permissionMode: 'bypassPermissions',
    model: { tier: 'mid' },
    isolation: 'worktree',
    confirmPolicy: 'batch',
    // Every brief follows the six-section template from the 2026-07-31 agentic-prompting report
    // (docs/research/2026-07-31-swarm-prompt-overhaul.md §3.1): identity+posture →
    // capability-scoped mission → method defaults → scope limits → report contract (mirrors
    // reportSchema) → GRADUATED escape lane ending in a routing hint the orchestrator can act on.
    // Missions are scoped by CAPABILITY (build/judge/investigate/research/decompose), never one
    // workflow's subject — subject-scoped briefs are the class that refused a valid task (V1).
    systemPrompt:
      'You are a Builder: you write code autonomously inside this assigned working tree. ' +
      'Implement exactly the assigned change and nothing more — do not refactor unrelated code, ' +
      'rename things, or widen the scope. Make the edit, then run the build and the relevant ' +
      'tests and confirm they pass; a red build or failing test is not "done". When finished, ' +
      'call the write_result tool with status "done", a one-line summary of what changed, and ' +
      'refs listing the touched files (path, plus line when a specific line matters). If you ' +
      'are blocked — missing context, an unfixable failure, or an underspecified task — call ' +
      'write_result with status "blocked" or "failed" and a summary naming exactly what you ' +
      'need — and, if the task is outside this role, the capability it actually needs — rather ' +
      'than guessing or drifting. Do not stop to ask; either finish or report.',
    reportSchema: {
      type: 'object',
      required: ['status', 'summary'],
      properties: {
        status: { enum: ['done', 'failed', 'blocked'] },
        summary: { type: 'string' },
        refs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string' }, line: { type: 'number' } }
          }
        }
      }
    },
    acceptance: {
      requiresWriteResult: true,
      statusMustBe: ['done'],
      checks: ['git_diff:nonempty']
    },
    entryCondition:
      'implement a code change — edit files, run the build and tests, in its own worktree'
  },
  {
    id: 'code-reviewer',
    name: 'Code reviewer',
    tier: 'worker',
    permissionMode: 'plan',
    model: { tier: 'expensive' },
    isolation: 'none',
    confirmPolicy: 'session-consented',
    systemPrompt:
      'You are a Code Reviewer: a read-only judge. Review only the assigned diff or branch — do ' +
      'not edit files, do not run write commands, do not wander into unrelated code. Judge ' +
      'correctness, security, and maintainability, and report each real problem; prefer no ' +
      'finding over a speculative one — an empty findings list is a valid clean result, not a ' +
      'failure. Report every real problem you find at every severity — severity labels, not ' +
      'omission, are how importance is communicated. Report via the write_result tool with ' +
      'status "done", a one-line summary, and refs where each item carries path, line, severity ' +
      '(crit|high|med|low), a note describing the issue, and a fix suggesting the change. If ' +
      'you cannot access the diff or branch under review, call write_result with status ' +
      '"failed" and a summary of what was missing — and, if the task is outside this role, the ' +
      'capability it actually needs — rather than reviewing something else.',
    reportSchema: {
      type: 'object',
      required: ['status', 'summary'],
      properties: {
        status: { enum: ['done', 'failed'] },
        summary: { type: 'string' },
        refs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'severity', 'note'],
            properties: {
              path: { type: 'string' },
              line: { type: 'number' },
              severity: { enum: ['crit', 'high', 'med', 'low'] },
              note: { type: 'string' },
              fix: { type: 'string' }
            }
          }
        }
      }
    },
    acceptance: { requiresWriteResult: true, statusMustBe: ['done'] },
    entryCondition: 'judge an assigned diff or branch — correctness, security, maintainability'
  },
  {
    id: 'explorer',
    name: 'Explorer',
    tier: 'worker',
    permissionMode: 'plan',
    model: { tier: 'cheap', effort: 'low' },
    isolation: 'none',
    confirmPolicy: 'session-consented',
    // Capability-scoped (investigate what exists HERE), with the empty-project floor: a workspace
    // that lacks what the question assumes is a valid DONE finding, not a failure — and a true
    // scope mismatch fails WITH a routing hint (web/library questions → researcher), so the
    // orchestrator can re-route instead of retrying the same role (report V1 fix).
    systemPrompt:
      'You are an Explorer: a read-only recon scout for this workspace. Answer the assigned ' +
      'where/how question by locating, reading, and summarizing what actually exists here — ' +
      'code, configs, docs; never edit, never fix what you find, and do not expand into a broad ' +
      'audit. Be terse: your answer returns into a busy orchestrator context, so give findings, ' +
      'not narrative, and cite evidence as path:line. Report via the write_result tool with ' +
      'status "done", a summary that directly answers the question, refs as path:line strings ' +
      'for the key files, open_questions for anything unresolved, and confidence of low, ' +
      'medium, or high. If the workspace does not contain what the question assumes — ' +
      'including a new or empty project — that is itself the finding: report done, say exactly ' +
      'what is and is not present, with low confidence if inference was needed. If the task ' +
      'actually requires sources outside this workspace or capabilities you do not have, call ' +
      'write_result with status "failed" and name what it needs (for web/library questions, ' +
      'that is a researcher).',
    reportSchema: {
      type: 'object',
      required: ['status', 'summary'],
      properties: {
        status: { enum: ['done', 'failed'] },
        summary: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        confidence: { enum: ['low', 'medium', 'high'] }
      }
    },
    acceptance: { requiresWriteResult: true, statusMustBe: ['done'] },
    entryCondition: 'answer a where/how question about what exists in this workspace'
  },
  {
    id: 'researcher',
    name: 'Researcher',
    tier: 'worker',
    permissionMode: 'plan',
    model: { tier: 'mid' },
    isolation: 'none',
    confirmPolicy: 'session-consented',
    // The catalog hole the 2026-07-31 report's incident 1 exposed: a web/docs question had no
    // correct routing target, so the explorer obeyed its letter and refused. Read-only posture
    // (plan) keeps session-consented legal (Q4); reportSchema is the explorer shape with
    // `sources` (URL-or-path strings) replacing `refs`.
    systemPrompt:
      'You are a Researcher: a read-only investigator. Answer the assigned question using any ' +
      'source available to you — web search, documentation, references, and files in this ' +
      'workspace — and synthesize what you find; never edit files or run write commands. ' +
      'Search broadly first, then go deep on the strongest sources; prefer primary sources, ' +
      'and note when sources disagree. Be terse: your answer returns into a busy orchestrator ' +
      'context — findings and conclusions, not a tour of your process, with each key claim ' +
      'tied to a source. Report via the write_result tool with status "done", a summary that ' +
      'directly answers the question, sources as a list of URL-or-path strings, open_questions ' +
      'for anything unresolved, and confidence of low, medium, or high. If the question is ' +
      'only partly answerable, answer that part with low confidence and say what is missing; ' +
      'if it needs capabilities you do not have (editing files, running the app), call ' +
      'write_result with status "failed" and name the capability needed.',
    reportSchema: {
      type: 'object',
      required: ['status', 'summary'],
      properties: {
        status: { enum: ['done', 'failed'] },
        summary: { type: 'string' },
        sources: { type: 'array', items: { type: 'string' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        confidence: { enum: ['low', 'medium', 'high'] }
      }
    },
    acceptance: { requiresWriteResult: true, statusMustBe: ['done'] },
    entryCondition:
      'answer a question from external sources — web, docs, references — and synthesize with citations'
  },
  {
    id: 'planner',
    name: 'Planner',
    tier: 'worker',
    permissionMode: 'plan',
    model: { tier: 'mid' },
    isolation: 'none',
    confirmPolicy: 'per-write',
    systemPrompt:
      'You are a Planner: read-only, and your output is a reusable plan other agents build ' +
      'from. Decompose only the assigned feature into a dependency-ordered task list — ' +
      'investigate the code just enough to sequence the work; make no code edits and implement ' +
      'nothing. First draw the plan on the canvas via the canvas-ade MCP (visualize_plan, or a ' +
      'planning board plus add_planning_elements — each write is human-confirmed), then call ' +
      'the write_result tool with status "done", a one-line summary, tasks where each item ' +
      'carries id, goal, deps (prerequisite task ids), and acceptance (how to tell it is done), ' +
      'plus risks as a list of strings. If the feature is too underspecified to decompose ' +
      'safely, call write_result with status "failed" naming what you need — and, if the task ' +
      'is outside this role, the capability it actually needs — rather than inventing a plan.',
    reportSchema: {
      type: 'object',
      required: ['status', 'summary'],
      properties: {
        status: { enum: ['done', 'failed'] },
        summary: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'goal'],
            properties: {
              id: { type: 'string' },
              goal: { type: 'string' },
              deps: { type: 'array', items: { type: 'string' } },
              acceptance: { type: 'string' }
            }
          }
        },
        risks: { type: 'array', items: { type: 'string' } }
      }
    },
    acceptance: { requiresWriteResult: true, statusMustBe: ['done'] },
    entryCondition: 'decompose a feature into a dependency-ordered task list, drawn on the canvas'
  }
]

/** Look up a catalog pack by id. Unknown/absent id ⇒ undefined (the dialog's Custom path). */
export function rolePackById(id: string | undefined | null): RolePack | undefined {
  return id ? ROLE_PACKS.find((p) => p.id === id) : undefined
}

const TIERS: ReadonlySet<string> = new Set(['lead', 'connected', 'worker'])
const PERMISSION_MODES: ReadonlySet<string> = new Set([
  'plan',
  'default',
  'acceptEdits',
  'bypassPermissions'
])
const MODEL_TIERS: ReadonlySet<string> = new Set(['cheap', 'mid', 'expensive'])
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high'])
const ISOLATIONS: ReadonlySet<string> = new Set(['none', 'worktree'])
const CONFIRM_POLICIES: ReadonlySet<string> = new Set(['per-write', 'batch', 'session-consented'])

/**
 * Structural validation of a candidate pack — the "validated data" half of the abstraction (a
 * malformed pack is a data bug, caught in unit tests, not a runtime surprise). Returns a list of
 * violations; empty = valid. Enforces the one cross-field invariant Phase 0 owns: Q4 —
 * `session-consented` autonomy is legal for READ-ONLY roles only.
 */
export function validateRolePack(pack: unknown): string[] {
  const errors: string[] = []
  if (typeof pack !== 'object' || pack === null) return ['pack must be an object']
  const p = pack as Partial<RolePack>
  if (typeof p.id !== 'string' || !p.id.trim()) errors.push('id must be a non-empty string')
  if (typeof p.name !== 'string' || !p.name.trim()) errors.push('name must be a non-empty string')
  if (typeof p.tier !== 'string' || !TIERS.has(p.tier))
    errors.push('tier must be lead|connected|worker')
  if (typeof p.permissionMode !== 'string' || !PERMISSION_MODES.has(p.permissionMode)) {
    errors.push('permissionMode must be plan|default|acceptEdits|bypassPermissions')
  }
  const model = p.model as Partial<RolePackModel> | undefined
  if (typeof model !== 'object' || model === null) {
    errors.push('model must be an object')
  } else {
    if (typeof model.tier !== 'string' || !MODEL_TIERS.has(model.tier)) {
      errors.push('model.tier must be cheap|mid|expensive')
    }
    if (model.pin !== undefined && (typeof model.pin !== 'string' || !model.pin.trim())) {
      errors.push('model.pin must be a non-empty string when set')
    }
    if (
      model.effort !== undefined &&
      (typeof model.effort !== 'string' || !EFFORTS.has(model.effort))
    ) {
      errors.push('model.effort must be low|medium|high when set')
    }
  }
  if (typeof p.isolation !== 'string' || !ISOLATIONS.has(p.isolation)) {
    errors.push('isolation must be none|worktree')
  }
  if (typeof p.confirmPolicy !== 'string' || !CONFIRM_POLICIES.has(p.confirmPolicy)) {
    errors.push('confirmPolicy must be per-write|batch|session-consented')
  }
  if (typeof p.systemPrompt !== 'string' || !p.systemPrompt.trim()) {
    errors.push('systemPrompt must be a non-empty string')
  }
  if (typeof p.reportSchema !== 'object' || p.reportSchema === null) {
    errors.push('reportSchema must be an object')
  }
  const acc = p.acceptance as Partial<RolePackAcceptance> | undefined
  if (typeof acc !== 'object' || acc === null) {
    errors.push('acceptance must be an object')
  } else if (typeof acc.requiresWriteResult !== 'boolean') {
    errors.push('acceptance.requiresWriteResult must be a boolean')
  }
  for (const [key, v] of [
    ['writeScope', p.writeScope],
    ['entryCondition', p.entryCondition],
    ['domainHint', p.domainHint]
  ] as const) {
    if (v !== undefined && (typeof v !== 'string' || !v.trim())) {
      errors.push(`${key} must be a non-empty string when set`)
    }
  }
  // Q4 invariant: pre-consenting a session's dispatches is only safe when the role cannot write.
  if (p.confirmPolicy === 'session-consented' && p.permissionMode !== 'plan') {
    errors.push('confirmPolicy session-consented requires the read-only permissionMode plan (Q4)')
  }
  return errors
}

/**
 * The pack's launch shape as claude-preset builder values (`agentPresets` option ids →
 * `composeCommand` flags): model tier/pin → `--model`, effort → `--effort`, and the permission
 * posture — `bypassPermissions` maps to the trust-gate-clearing `--dangerously-skip-permissions`
 * toggle (today's worker default, so a builder boots straight to a ready REPL), every other mode
 * to `--permission-mode <mode>`. Pure data-in/data-out; the dialog feeds the result to the same
 * `composeCommand` every terminal already uses — no second composition path.
 */
export function packOptionValues(pack: RolePack): Record<string, string | boolean> {
  return {
    model: pack.model.pin ?? MODEL_TIER_CLAUDE_ALIAS[pack.model.tier],
    ...(pack.model.effort ? { effort: pack.model.effort } : {}),
    ...(pack.permissionMode === 'bypassPermissions'
      ? { 'skip-permissions': true }
      : { 'permission-mode': pack.permissionMode })
  }
}

/**
 * Collapse a composed dispatch prompt to a SINGLE line for the gated REPL write. The prompt is
 * delivered into the agent's input box (the gated `dispatchPrompt` PTY write) — NOT a shell
 * command — so it is never shell-parsed: no quoting/escaping, only whitespace collapse, because
 * the shared write gate REJECTS an embedded CR/LF (one approval = one line; see
 * `dispatchSanitize.ts`). Lives in shared so BOTH the renderer command dispatch and MAIN's swarm
 * tool executor use the same collapse — the S1 swarm bug was MAIN composing a multi-line spec
 * and skipping this step, so every dispatch died in the sanitizer before its confirm.
 */
export function singleLinePrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim()
}

/**
 * Prepend the role brief to the engineered task prompt for the gated REPL dispatch. The brief is
 * the dialog-committed override when one was recorded ("what the user SAW is what ships" — the
 * dialog shows the brief editable and always commits it with a pack dispatch), else the pack's
 * default; an explicitly EMPTIED override means "no brief" and is respected. No pack and no
 * override ⇒ the prompt is unchanged (the Custom path). The caller still runs `singleLinePrompt`
 * over the result (the shared write gate rejects embedded CR/LF), so brief + task collapse to
 * one line.
 */
export function packDispatchPrompt(
  pack: RolePack | undefined,
  taskPrompt: string,
  briefOverride?: string
): string {
  const brief = briefOverride !== undefined ? briefOverride.trim() : (pack?.systemPrompt ?? '')
  return brief ? `${brief}\n\n${taskPrompt}` : taskPrompt
}
