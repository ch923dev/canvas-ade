/**
 * Swarm orchestrator tools (orchestration S1) — the Stage-1 app-resident brain's hands. The
 * jarvisTools discipline applies verbatim: tool args are MODEL output and therefore untrusted
 * (type-checked + length-capped here); every mutating call pays a human gate (spawn gets the
 * same pre-confirm Jarvis added — spawn_board is cap-checked but un-gated for MCP agents;
 * dispatch confirms INSIDE the orchestrator gate it routes through); reads are auto-allowed.
 *
 * The tool surface is the EXISTING gated dispatch rails, nothing new on the wire:
 *   - list_workers (read)   → describeApp reduced to id/type/title/status
 *   - draw_plan (gated)     → visualizePlan (checklist) — the run's plan strip source
 *   - spawn_worker (gated)  → spawnBoard(terminal) with a role-pack-composed claude launch
 *   - dispatch_task (gated) → packDispatchPrompt(role brief + FOUR-FIELD spec) → dispatchPrompt
 *   - await_worker (read)   → awaitSettled → {status, summary, provenance}
 *
 * WORKTREE ISOLATION (S3): a role pack declaring `isolation: 'worktree'` gets a real git worktree
 * on its own branch allocated BEFORE its board spawns, and that path becomes the board's cwd.
 * Allocation failure REFUSES the spawn — it never falls back to the shared project tree, because
 * `safeCwd` would silently redirect a missing dir to `$HOME` (A6-3) and a writer in a tree it
 * does not own is not degraded, it is incorrect.
 *
 * WRITE SERIALIZATION (07 §4.3): the executor admits `writeRoleConcurrencyCap()` un-settled
 * write-role dispatches per run — 2 when every in-flight writer holds its own worktree, still 1
 * the moment one does not. Refusals are returned to the model as tool errors naming WHICH case
 * fired, so the disclosure rule can be honored in chat (no silent caps, 06 §2). Pause: while the
 * run is paused every mutating tool refuses.
 */
import type { AppModel } from './appModel'
import {
  MODEL_TIER_CLAUDE_ALIAS,
  ROLE_PACKS,
  isWriteRolePack,
  packDispatchPrompt,
  rolePackById,
  singleLinePrompt,
  writeRoleConcurrencyCap,
  type RolePack
} from '../shared/rolePacks'
import type { ConfirmChoices, ConfirmWorkerConfig } from './mcpConfirm'
import type { JarvisToolDef } from './jarvisTools'
import { sanitizeDispatchText } from './dispatchSanitize'
import { describeEnvScrub, type SwarmEnvPolicySeam } from './spawnEnvPolicy'
import type { SwarmConsentSeam } from './sessionConsent'
import type { SwarmTaskSpec } from '../shared/swarmLedgerTypes'
import { MAX_DISPATCH_BATCH } from './mcpDispatchBatch'

/**
 * S2: a ledger write must never break the run it is recording. Every hook call is wrapped so a
 * disk error / permission failure degrades that run to ephemeral-only instead of failing the
 * dispatch the human already approved.
 */
async function record(fn: (() => Promise<void>) | undefined): Promise<void> {
  if (!fn) return
  try {
    await fn()
  } catch (err) {
    console.warn('[swarmLedger] record failed (non-fatal — run continues ephemerally)', err)
  }
}

const MAX_NAME = 80
const MAX_FIELD = 4000
const MAX_ITEMS = 30

/** S3 — the ledger fields for a worker's tree, or nothing at all when it has none. */
function worktreeOf(
  ctx: SwarmRunCtx,
  workerId: string
): { worktree: string; branch: string } | Record<string, never> {
  const wt = ctx.workerWorktrees.get(workerId)
  return wt ? { worktree: wt.worktree, branch: wt.branch } : {}
}

/**
 * S3 — the first write worker in `ids` that holds NO worktree of its own, or `null` when every
 * one of them is isolated. That worker shares the project working tree with every other writer,
 * which is what drops the concurrency ceiling back to the pre-S3 value of 1 — and its id is what
 * the refusal string names, so the human learns WHICH worker cost them the parallelism.
 */
function unisolatedWriter(ctx: SwarmRunCtx, ids: string[]): string | null {
  for (const id of ids) {
    if (!ctx.workerWorktrees.has(id)) return id
  }
  return null
}

/** Model output → a 1-based plan-strip position, or undefined. Bounded to the plan's own cap. */
const planItemOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, MAX_ITEMS) : undefined

/** The canvas facet the swarm executor drives — RunningMcp is a structural superset. */
export interface SwarmCanvasFacet {
  describeApp(): Promise<AppModel>
  spawnBoard(input: {
    type: string
    prompt?: string
    cwd?: string
    title?: string
    /** v20: the human-committed OpenRouter routing intent (validated again in mcpLifecycle). */
    openRouter?: { enabled: boolean; model?: string }
    /** Docked-terminals: the hosting swarm board id (re-validated against the live mirror in
     *  mcpLifecycle; a dangling/non-swarm host degrades to an ordinary canvas spawn). */
    dockedIn?: string
  }): Promise<{ id: string }>
  dispatchPrompt(boardId: string, text: string): Promise<{ delivery: 'ready' | 'unconfirmed' }>
  awaitSettled(boardId: string): Promise<{
    present?: boolean
    status?: string
    summary?: string
    refs?: string[]
    synthesized?: boolean
  }>
  visualizePlan(spec: {
    items: Array<{ title: string; status?: string; note?: string }>
    suggested?: 'kanban' | 'grid' | 'checklist' | 'columns'
    title?: string
  }): Promise<{ id: string; queuedFor?: string }>
  /**
   * S2: read a Planning board's elements + their REAL ids (the `canvas://board/{id}/planning`
   * projection). The ledger syncs its `planItems` through this so a task can be joined to the
   * checklist item it fulfils — MAIN never mints plan-item ids, the renderer does.
   */
  boardPlanning(boardId: string): Promise<{
    elements: Array<{
      id: string
      kind: string
      title?: string
      items?: Array<{ id: string; label: string; done: boolean }>
    }>
  }>
  /**
   * S2: tick / relabel ONE plan-strip item, through the SHARED human-confirmed planning-edit gate
   * (design D6 — the human's own strip edits are direct; an agent-proposed one is confirmed and
   * MAIN re-validates it). Passive content: no PTY, no nonce, nothing executes.
   */
  updatePlanningElement(
    boardId: string,
    elementId: string,
    patch: { setItems?: Array<{ id: string; done?: boolean; label?: string }> }
  ): Promise<void>
  /**
   * S2 (design D7): dispatch a ROUND of tasks behind ONE per-row confirm modal. Each row still
   * travels the shared write gate independently (own nonce · TOCTOU re-check · audit) — the batch
   * spares the human N sequential modals, it never widens one approval into N writes.
   */
  dispatchPrompts(items: Array<{ boardId: string; text: string }>): Promise<
    Array<{
      boardId: string
      status: 'dispatched' | 'denied' | 'rejected'
      delivery?: 'ready' | 'unconfirmed'
      detail?: string
    }>
  >
}

// The run-event vocabulary lives in swarmRunEvent.ts (max-lines ratchet extraction);
// re-exported so every existing `from './swarmTools'` import keeps working.
import type { SwarmRunEvent } from './swarmRunEvent'
export type { SwarmRunEvent } from './swarmRunEvent'

/**
 * S2: the DURABLE side-effects of a tool call. Supplied by the swarm session when a project (and
 * therefore a ledger) exists; **optional throughout** — with no project, an unwritable
 * `.canvas/memory/`, or a ledger written by a newer app version, every hook is simply absent and
 * the run behaves exactly like S1 (ephemeral-only). A ledger failure must never fail a dispatch.
 */
export interface SwarmLedgerHooks {
  /** The run drew (or redrew) its plan — record the board and re-sync the plan items from it. */
  planDrawn(planBoardId: string): Promise<void>
  /** A task was dispatched into a worker. `planItem` is the 1-based plan-strip position, if given. */
  dispatched(input: {
    workerId: string
    role: string
    spec: SwarmTaskSpec
    activity?: string
    planItem?: number
    /** S3: the worker's own worktree + branch, allocated at spawn. Absent ⇒ read-only role. */
    worktree?: string | null
    branch?: string | null
  }): Promise<void>
  /** A worker settled — attach its result with the provenance it actually carries. */
  settled(input: {
    workerId: string
    status: string
    summary: string
    refs: string[]
    provenance: 'claimed' | 'synthesized'
  }): Promise<void>
}

/** Per-run mutable state the executor threads (owned by the swarm session in swarmChatIpc). */
export interface SwarmRunCtx {
  paused: () => boolean
  /** S2: durable recording. Absent ⇒ the run is ephemeral-only (S1 behaviour), never an error. */
  ledger?: SwarmLedgerHooks
  /** Worker board ids dispatched with a WRITE-role and not yet settled (the serialization cap). */
  writeInFlight: Set<string>
  /** Worker board id → its dispatched role id (await_worker reads it for provenance labels). */
  workerRoles: Map<string, string>
  /**
   * S3: worker board id → the git worktree allocated for it at spawn. A write worker MISSING from
   * this map has no tree of its own and therefore shares the project working tree, which is what
   * drops the concurrency ceiling back to 1 (see {@link writeRoleConcurrencyCap}). Rebuilt from
   * the ledger on restore, so a reloaded run still knows which of its workers are isolated.
   */
  workerWorktrees: Map<string, { worktree: string; branch: string }>
  /**
   * S3: allocate a worktree for a worker BEFORE its board spawns. Absent ⇒ no allocator wired
   * (no project / test harness), and a pack that declares `isolation: 'worktree'` is refused
   * rather than silently spawned into the shared tree.
   */
  allocateWorktree?: (
    workerName: string
  ) => Promise<{ ok: true; worktree: string; branch: string } | { ok: false; reason: string }>
  /** S3: undo an allocation the human then denied — `git worktree remove`, clean only. */
  releaseWorktree?: (worktree: string) => Promise<void>
  /**
   * P5 secrets hygiene (A8-F3): `preview` = the credential var names the policy would withhold
   * from this pack's worker NOW (the spawn confirm's disclosure — an untold scrub is a scrub
   * the human did not agree to); `register` records the policy against the minted board id for
   * `buildSpawnEnv`. Absent ⇒ no scrub, no disclosure (today's full-inherit behaviour).
   */
  envPolicy?: SwarmEnvPolicySeam
  /**
   * P5 session consent: register a spawned worker (board id → run + role + the COMMITTED
   * launch's read-only evidence). The registry owns eligibility and re-derives the Q4 chain
   * per act. Absent ⇒ no worker is ever consent-eligible — per-write forever, fail-closed.
   */
  consent?: SwarmConsentSeam
  /**
   * S2: the run's Planning board, written by `draw_plan` and read by `tick_plan_item`. A mutable
   * holder rather than a ledger read, so the plan strip still works for a run with NO ledger
   * (no project) — exactly the S1 degradation everything else in S2 keeps.
   */
  planBoard: { current: string | null }
  /**
   * Docked-terminals: the SWARM board hosting this run — spawn_worker passes it as the new
   * worker's `dockedIn` (dock-by-default). Absent ⇒ canvas spawn. Placement only — every
   * gate (spawn/dispatch confirm, consent, env policy) is unchanged by where it renders.
   */
  dockHostId?: string
  emit: (ev: SwarmRunEvent) => void
  /** The shared fail-closed confirm; `workerConfig` routes to the full worker-config dialog
   *  (the swarm spawn gate), `choices` to the P5 chooser. */
  confirm: (req: {
    title: string
    body: string
    /** S3: the destructive-disposition second confirm reads as Discard / Keep it, not Approve. */
    confirmLabel?: string
    denyLabel?: string
    choices?: ConfirmChoices
    workerConfig?: ConfirmWorkerConfig
  }) => Promise<{
    approved: boolean
    choice?: string
    launchCommand?: string
    rolePackId?: string
    openRouter?: { enabled: boolean; model?: string }
  }>
}

/** Names that run WITHOUT a confirm (pure reads; await_worker only observes settle). */
export const SWARM_AUTO_ALLOW = new Set(['list_workers', 'await_worker'])

export function buildSwarmToolDefs(): JarvisToolDef[] {
  const roleIds = ROLE_PACKS.map((p) => p.id)
  return [
    {
      name: 'list_workers',
      description:
        'List the boards on the canvas (id, type, title, status). Terminal boards you spawned are your workers.',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'draw_plan',
      description:
        "Draw (or redraw) the run's plan as a checklist the human sees on the board's plan strip. Call at run start, before dispatching.",
      input_schema: {
        type: 'object',
        required: ['title', 'items'],
        properties: {
          title: { type: 'string', description: 'Short run title' },
          items: {
            type: 'array',
            maxItems: MAX_ITEMS,
            items: {
              type: 'object',
              required: ['title'],
              properties: {
                title: { type: 'string' },
                status: { enum: ['todo', 'doing', 'done'] }
              }
            }
          }
        }
      }
    },
    {
      name: 'spawn_worker',
      description:
        'Spawn one worker terminal running a claude agent shaped by a role pack. Returns the worker board id. The human confirms first.',
      input_schema: {
        type: 'object',
        required: ['name', 'role'],
        properties: {
          name: { type: 'string', description: 'Short worker name shown on its board' },
          role: { enum: roleIds, description: 'Role pack shaping flags + standing orders' },
          model: {
            enum: [...SWARM_MODEL_OVERRIDES],
            description:
              "Optional model override for this worker (e.g. the human asked for opus); omit to use the role's default tier"
          },
          cwd: { type: 'string', description: 'Working directory (defaults to the project)' }
        }
      }
    },
    {
      name: 'dispatch_task',
      description:
        "Dispatch a FOUR-FIELD task into a spawned worker's agent. All four fields are required — vague dispatches produce duplication and gaps. The human confirms first.",
      input_schema: {
        type: 'object',
        required: ['workerId', 'objective', 'context', 'boundaries', 'outputFormat'],
        properties: {
          workerId: { type: 'string' },
          objective: { type: 'string', description: 'What done looks like' },
          context: { type: 'string', description: 'What the worker must know' },
          boundaries: { type: 'string', description: 'What it must NOT touch' },
          outputFormat: { type: 'string', description: 'How to report back (write_result)' },
          activity: {
            type: 'string',
            description: 'Present-continuous card line, e.g. "Migrating settings schema…"'
          },
          planItem: {
            type: 'integer',
            minimum: 1,
            description:
              'The 1-based plan-strip position this task fulfils (as drawn by draw_plan). Links the task to its plan item so the strip shows who owns it.'
          }
        }
      }
    },
    {
      name: 'dispatch_tasks',
      description:
        'Dispatch a ROUND of tasks at once — the human reviews every row in ONE confirm and approves them individually. Prefer this over repeated dispatch_task when you are handing out several tasks together.',
      input_schema: {
        type: 'object',
        required: ['tasks'],
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_DISPATCH_BATCH,
            items: {
              type: 'object',
              required: ['workerId', 'objective', 'context', 'boundaries', 'outputFormat'],
              properties: {
                workerId: { type: 'string' },
                objective: { type: 'string' },
                context: { type: 'string' },
                boundaries: { type: 'string' },
                outputFormat: { type: 'string' },
                activity: { type: 'string' },
                planItem: { type: 'integer', minimum: 1 }
              }
            }
          }
        }
      }
    },
    {
      name: 'tick_plan_item',
      description:
        "Tick (or untick) ONE item on the run's plan strip — call it as work actually lands, so the plan the human sees stays true. The human confirms first.",
      input_schema: {
        type: 'object',
        required: ['planItem'],
        properties: {
          planItem: {
            type: 'integer',
            minimum: 1,
            description: 'The 1-based plan-strip position, as drawn by draw_plan'
          },
          done: { type: 'boolean', description: 'Defaults to true' }
        }
      }
    },
    {
      name: 'await_worker',
      description:
        "Wait for a worker to settle and return its structured result (status · summary · provenance). Use after dispatching; don't busy-poll.",
      input_schema: {
        type: 'object',
        required: ['workerId'],
        properties: { workerId: { type: 'string' } }
      }
    }
  ]
}

/**
 * The ONLY model values a spawn_worker `model` override may take. The value is spliced into the
 * worker's launch command, so it must stay a CLOSED vocabulary — free text here would be command
 * injection into the PTY launch line (the ctxFromAuth closed-vocabulary lesson).
 */
export const SWARM_MODEL_OVERRIDES = ['haiku', 'sonnet', 'opus'] as const
export type SwarmModelOverride = (typeof SWARM_MODEL_OVERRIDES)[number]

/** Compose the role-shaped claude launch line (MAIN-side; the 400-char spawn clamp re-checks). */
export function composeRoleLaunch(pack: RolePack, modelOverride?: SwarmModelOverride): string {
  const model = modelOverride ?? pack.model.pin ?? MODEL_TIER_CLAUDE_ALIAS[pack.model.tier]
  const parts = ['claude', '--model', model]
  if (pack.model.effort) parts.push('--effort', pack.model.effort)
  if (pack.permissionMode === 'bypassPermissions') parts.push('--dangerously-skip-permissions')
  else if (pack.permissionMode !== 'default') parts.push('--permission-mode', pack.permissionMode)
  return parts.join(' ')
}

const str = (v: unknown, cap: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, cap) : undefined

export interface SwarmToolOutcome {
  content: string
  isError?: boolean
  denied?: boolean
  summary: string
}

export async function executeSwarmTool(
  name: string,
  input: unknown,
  facet: SwarmCanvasFacet,
  ctx: SwarmRunCtx
): Promise<SwarmToolOutcome> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  try {
    switch (name) {
      case 'list_workers': {
        const app = await facet.describeApp()
        const rows = app.canvas.boards.map((b) => ({
          id: b.id,
          type: b.type,
          title: b.title,
          status: b.status
        }))
        return { content: JSON.stringify(rows), summary: `${rows.length} boards` }
      }
      case 'draw_plan': {
        if (ctx.paused()) return refuse('run paused — the human must resume first')
        const title = str(args.title, MAX_NAME) ?? 'Run plan'
        const raw = Array.isArray(args.items) ? args.items.slice(0, MAX_ITEMS) : []
        const items = raw
          .map((it) => {
            const o = (typeof it === 'object' && it !== null ? it : {}) as Record<string, unknown>
            const t = str(o.title, MAX_NAME)
            return t
              ? {
                  title: t,
                  ...(o.status === 'done' || o.status === 'doing'
                    ? { status: o.status as string }
                    : {})
                }
              : null
          })
          .filter((x): x is { title: string; status?: string } => x !== null)
        if (items.length === 0) return refuse('draw_plan needs at least one item')
        const r = await facet.visualizePlan({ items, suggested: 'checklist', title })
        ctx.planBoard.current = r.id
        ctx.emit({ kind: 'planDrawn', planBoardId: r.id })
        await record(ctx.ledger && (() => ctx.ledger!.planDrawn(r.id)))
        return {
          content: JSON.stringify({ planBoardId: r.id }),
          summary: `plan: ${items.length} items`
        }
      }
      case 'spawn_worker': {
        if (ctx.paused()) return refuse('run paused — the human must resume first')
        const workerName = str(args.name, MAX_NAME)
        const pack = rolePackById(str(args.role, 40))
        if (!workerName) return refuse('spawn_worker needs a name')
        if (!pack)
          return refuse(`unknown role — pick one of: ${ROLE_PACKS.map((p) => p.id).join(', ')}`)
        // Closed-vocabulary model override (the value is spliced into the launch line — anything
        // outside the whitelist is refused, never passed through).
        const modelArg = str(args.model, 20)
        const model = SWARM_MODEL_OVERRIDES.find((m) => m === modelArg)
        if (modelArg && !model)
          return refuse(`unknown model — pick one of: ${SWARM_MODEL_OVERRIDES.join(', ')}`)
        // 🔒 S3 — ALLOCATE BEFORE SPAWN. `safeCwd` silently redirects a missing directory to
        // `$HOME` (A6-3), so a worktree created late (or not verified) means the builder writes
        // into the user's home folder with a green status and nothing anywhere saying so. The
        // allocator stats the directory itself; anything short of success REFUSES the spawn
        // rather than falling back to the shared project tree — that fallback is the exact bug
        // S3 exists to kill, and a write worker in a tree it does not own is not "degraded", it
        // is incorrect.
        let allocated: { worktree: string; branch: string } | undefined
        if (pack.isolation === 'worktree') {
          if (!ctx.allocateWorktree) {
            return refuse(
              `worktree isolation is unavailable in this session, and ${pack.id} writes files — without its own worktree it would share the project working tree with every other writer. Open a project backed by a git repository, or spawn a read-only role (disclose this to the human)`
            )
          }
          const alloc = await ctx.allocateWorktree(workerName)
          if (!alloc.ok) {
            return refuse(
              `could not give ${workerName} its own worktree — ${alloc.reason}. ${pack.id} writes files, so spawning it without one would share the project working tree with every other writer; refusing (disclose this to the human)`
            )
          }
          allocated = { worktree: alloc.worktree, branch: alloc.branch }
        }
        // The Jarvis-pattern pre-gate: spawn_board is cap-checked but un-gated for MCP agents;
        // the swarm brain pays an explicit human confirm so every mutating tool is gated. The
        // request carries `workerConfig`, so the renderer shows the FULL worker-config dialog
        // (the command board's spawn surface — role row, agent presets, builder, editable
        // launch line) and the human COMMITS the worker's real config, not just approve/deny.
        const defaultLaunch = composeRoleLaunch(pack, model)
        // S3 disclosure: the human approving a builder is also approving a new branch + a fresh
        // checkout on their disk, and a fresh worktree has NO node_modules (design D7 — not
        // linked in S3). A cost not named in the modal is a cost the human did not agree to.
        const isolationNote = allocated
          ? ` It will run in its own git worktree at ${allocated.worktree} on a new branch ${allocated.branch} — a fresh checkout with no node_modules, so a build or test step must install first.`
          : ''
        // P5 env-scrub disclosure: name the withheld credential vars BEFORE the human approves
        // (the gate must describe the act it gates). Composed in spawnEnvPolicy — ONE string.
        const envNote = describeEnvScrub(ctx.envPolicy?.preview(pack) ?? [])
        const decision = await ctx.confirm({
          title: 'Spawn a swarm worker?',
          body: `The orchestrator wants to spawn "${workerName}" (${pack.id}, ${pack.permissionMode === 'plan' ? 'read-only' : 'write'}) running: ${defaultLaunch}${isolationNote}${envNote}`,
          workerConfig: {
            workerName,
            roleId: pack.id,
            ...(model ? { modelDefault: model } : {}),
            defaultLaunch
          }
        })
        if (!decision.approved) {
          // Roll the allocation back: a denied spawn must not leave a branch and a checkout on
          // the human's disk for a worker that never existed. Clean-only removal, so if anything
          // already wrote in there it is kept (and surfaces as a dirty-worktree row).
          if (allocated) await ctx.releaseWorktree?.(allocated.worktree).catch(() => {})
          return {
            content: 'denied by the human',
            isError: true,
            denied: true,
            summary: 'spawn denied'
          }
        }
        // 🔒 Re-validate the dialog commit (the reply proposes, MAIN disposes): the launch line
        // must be ONE bounded non-empty line — anything else refuses (never silently "fixed"),
        // and an absent launchCommand (an approve-only surface) approves exactly defaultLaunch.
        // The role id must be registry-known; off-set falls back to the requested pack.
        let launch = defaultLaunch
        if (decision.launchCommand !== undefined) {
          const committed = decision.launchCommand.trim()
          if (!committed || /[\r\n]/.test(committed) || committed.length > 400) {
            return refuse(
              'worker config commit invalid — the launch command must be one non-empty line ≤400 chars'
            )
          }
          launch = committed
        }
        const finalPack = rolePackById(str(decision.rolePackId ?? '', 40)) ?? pack
        // 🔒 v20 OpenRouter intent from the dialog commit: only an explicit `enabled === true`
        // with a clean single-line slug rides the spawn; a malformed commit refuses (never
        // silently stripped — the launch-line discipline). mcpLifecycle re-validates again.
        let openRouter: { enabled: true; model?: string } | undefined
        if (decision.openRouter !== undefined) {
          const o = decision.openRouter
          const slug = typeof o.model === 'string' ? o.model.trim() : undefined
          if (
            o.enabled !== true ||
            (slug !== undefined &&
              (/\s/.test(slug) || slug.length > 200 || sanitizeDispatchText(slug) !== slug))
          ) {
            return refuse(
              'worker config commit invalid — the OpenRouter model must be one clean line ≤200 chars'
            )
          }
          openRouter = { enabled: true, ...(slug ? { model: slug } : {}) }
        }
        // 🔒 S3 — the isolation field gets the same "reply proposes, MAIN disposes" treatment as
        // the launch line: the dialog may COMMIT a different role than the one we allocated for.
        // Switched INTO a write role with no tree ⇒ refuse (never spawn a writer into the shared
        // tree by way of a dropdown). Switched OUT of one ⇒ release the tree we just made.
        if (finalPack.isolation === 'worktree' && !allocated) {
          return refuse(
            `worker config commit invalid — the committed role ${finalPack.id} needs its own worktree, but one was allocated for ${pack.id} instead. Re-spawn with the write role selected up front`
          )
        }
        if (finalPack.isolation !== 'worktree' && allocated) {
          await ctx.releaseWorktree?.(allocated.worktree).catch(() => {})
          allocated = undefined
        }
        // The worktree WINS over any cwd the model proposed: a pack that declares isolation is
        // isolated, and honouring a model-supplied cwd here would silently un-isolate it.
        const spawnCwd = allocated?.worktree ?? str(args.cwd, 1024)
        let spawned: { id: string }
        try {
          spawned = await facet.spawnBoard({
            type: 'terminal',
            title: workerName,
            prompt: launch,
            ...(spawnCwd ? { cwd: spawnCwd } : {}),
            ...(openRouter ? { openRouter } : {}),
            ...(ctx.dockHostId ? { dockedIn: ctx.dockHostId } : {})
          })
        } catch (err) {
          // No board exists, so nothing will ever use this tree — take it back rather than
          // leaking a checkout for a worker that failed to spawn.
          if (allocated) await ctx.releaseWorktree?.(allocated.worktree).catch(() => {})
          throw err
        }
        ctx.workerRoles.set(spawned.id, finalPack.id)
        if (allocated) ctx.workerWorktrees.set(spawned.id, allocated)
        // P5: record the COMMITTED pack's env policy + consent registration against the minted
        // board id — the renderer's pty:spawn arrives a command-ack + mount later, so both
        // registries are populated well before they are consulted.
        ctx.envPolicy?.register(spawned.id, finalPack)
        ctx.consent?.registerWorker(spawned.id, finalPack.id, launch)
        ctx.emit({
          kind: 'workerSpawned',
          workerId: spawned.id,
          role: finalPack.id,
          title: workerName
        })
        return {
          content: JSON.stringify({
            workerId: spawned.id,
            ...(allocated ? { worktree: allocated.worktree, branch: allocated.branch } : {})
          }),
          // The statusline renders `summary` only — the branch has to ride it or the human never
          // learns a branch was created on their disk from the board alone.
          summary: `spawned ${workerName} (${finalPack.id})${allocated ? ` on ${allocated.branch}` : ''}`
        }
      }
      case 'dispatch_task': {
        if (ctx.paused()) return refuse('run paused — the human must resume first')
        const workerId = str(args.workerId, 128)
        const objective = str(args.objective, MAX_FIELD)
        const context = str(args.context, MAX_FIELD)
        const boundaries = str(args.boundaries, MAX_FIELD)
        const outputFormat = str(args.outputFormat, MAX_FIELD)
        if (!workerId || !objective || !context || !boundaries || !outputFormat) {
          return refuse(
            'dispatch_task requires workerId + all four fields (objective, context, boundaries, outputFormat)'
          )
        }
        const pack = rolePackById(ctx.workerRoles.get(workerId))
        // 🔒 S3 write serialization. The ceiling is a FUNCTION of what actually provisioned: 2
        // writers when each holds its own worktree (the 07 §4.3 policy), but still 1 the moment
        // any in-flight writer shares the project tree. Both refusals name WHICH case fired —
        // raising the number without rewriting these strings would ship a cap that lies about
        // its own reason, which the kickoff calls worse than not raising it at all.
        if (pack && isWriteRolePack(pack) && !ctx.writeInFlight.has(workerId)) {
          const shared = unisolatedWriter(ctx, [...ctx.writeInFlight, workerId])
          const cap = writeRoleConcurrencyCap(shared === null)
          if (ctx.writeInFlight.size >= cap) {
            return refuse(
              shared === null
                ? `write cap: ${ctx.writeInFlight.size} write-role tasks already running, each in its own worktree — that is the parallel-writer ceiling (07 §4.3). Await one first (disclose this to the human)`
                : `write cap: ${shared} has no worktree of its own, so it shares the project working tree with the other writer — only ${cap} un-isolated write-role task may run at a time. Await it, or respawn this worker with a worktree-isolated role (disclose this to the human)`
            )
          }
          ctx.writeInFlight.add(workerId)
        }
        const spec =
          `OBJECTIVE: ${objective}\n\nCONTEXT: ${context}\n\nBOUNDARIES: ${boundaries}\n\n` +
          `OUTPUT FORMAT: ${outputFormat}`
        const activity = str(args.activity, MAX_NAME)
        // S2: the 1-based plan-strip position this task fulfils. Model output → bounded to a
        // positive integer here; the ledger maps it to the REAL checklist item id (which only the
        // renderer mints), and an out-of-range position simply leaves the task unmapped.
        const planItemRaw = args.planItem
        const planItem =
          typeof planItemRaw === 'number' && Number.isInteger(planItemRaw) && planItemRaw > 0
            ? Math.min(planItemRaw, MAX_ITEMS)
            : undefined
        try {
          // The orchestrator's OWN human gate lives inside dispatchPrompt — no double confirm.
          // singleLinePrompt is MANDATORY: the write gate REJECTS embedded CR/LF (one approval
          // = one line), and both the four-field spec and the role brief are multi-line.
          const r = await facet.dispatchPrompt(
            workerId,
            singleLinePrompt(packDispatchPrompt(pack, spec, undefined))
          )
          if (activity) ctx.emit({ kind: 'activity', workerId, text: activity })
          // Record AFTER the gate: only a dispatch the human actually approved becomes a
          // durable assignment (a denied dispatch throws above and never reaches here).
          await record(
            ctx.ledger &&
              (() =>
                ctx.ledger!.dispatched({
                  workerId,
                  role: pack?.id ?? 'worker',
                  spec: { objective, context, boundaries, outputFormat },
                  ...(activity ? { activity } : {}),
                  ...(planItem !== undefined ? { planItem } : {}),
                  // S3: the worker's tree, so the assignment records where the work went.
                  ...worktreeOf(ctx, workerId)
                }))
          )
          return {
            content: JSON.stringify({ delivery: r?.delivery ?? 'ready' }),
            summary: `dispatched → ${workerId}`
          }
        } catch (err) {
          ctx.writeInFlight.delete(workerId)
          const msg = err instanceof Error ? err.message : String(err)
          const denied = /denied/i.test(msg)
          return {
            content: `dispatch failed: ${msg}`,
            isError: true,
            denied,
            // The chat statusline renders ONLY the summary — carry the reason so a failing
            // dispatch is diagnosable from the board (the S1 eyeball found bare "dispatch
            // failed" ×6 with the real sanitizer error invisible).
            summary: `dispatch failed — ${singleLinePrompt(msg).slice(0, 120)}`
          }
        }
      }
      case 'dispatch_tasks': {
        if (ctx.paused()) return refuse('run paused — the human must resume first')
        const rows = Array.isArray(args.tasks) ? args.tasks.slice(0, MAX_DISPATCH_BATCH) : []
        if (rows.length === 0) return refuse('dispatch_tasks needs at least one task')
        const parsed: Array<{
          workerId: string
          spec: SwarmTaskSpec
          pack?: RolePack
          activity?: string
          planItem?: number
        }> = []
        for (const raw of rows) {
          const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
          const workerId = str(o.workerId, 128)
          const objective = str(o.objective, MAX_FIELD)
          const context = str(o.context, MAX_FIELD)
          const boundaries = str(o.boundaries, MAX_FIELD)
          const outputFormat = str(o.outputFormat, MAX_FIELD)
          if (!workerId || !objective || !context || !boundaries || !outputFormat) {
            // 🔒 All-or-nothing on VALIDATION: a half-valid round would put a modal in front of
            // the human that does not match what the model asked for. Fix the input and retry.
            return refuse(
              'every task in dispatch_tasks needs workerId + all four fields (objective, context, boundaries, outputFormat)'
            )
          }
          const pack = rolePackById(ctx.workerRoles.get(workerId))
          parsed.push({
            workerId,
            spec: { objective, context, boundaries, outputFormat },
            ...(pack ? { pack } : {}),
            ...(str(o.activity, MAX_NAME) ? { activity: str(o.activity, MAX_NAME) } : {}),
            ...(planItemOf(o.planItem) !== undefined ? { planItem: planItemOf(o.planItem) } : {})
          })
        }
        // 🔒 S3 write serialization, DISCLOSED: a round carrying more write-role tasks than the
        // ceiling is refused whole rather than silently trimmed — the model splits it and says
        // why in chat (no silent caps, 06 §2). The ceiling is the same function as above, so a
        // round containing one un-isolated writer collapses to 1 and the string says so.
        const newWrites = new Set(
          parsed
            .filter((p) => p.pack && isWriteRolePack(p.pack) && !ctx.writeInFlight.has(p.workerId))
            .map((p) => p.workerId)
        )
        const wanted = ctx.writeInFlight.size + newWrites.size
        const sharedWriter = unisolatedWriter(ctx, [...ctx.writeInFlight, ...newWrites])
        const batchCap = writeRoleConcurrencyCap(sharedWriter === null)
        if (wanted > batchCap) {
          return refuse(
            `write cap: this round needs ${wanted} concurrent write-role workers but only ${batchCap} may run in parallel, one per worktree${sharedWriter !== null ? ` (${sharedWriter} has no worktree of its own, which drops that ceiling to ${batchCap})` : ''} — split the round and disclose this to the human`
          )
        }
        for (const id of newWrites) ctx.writeInFlight.add(id)
        const outcomes = await facet.dispatchPrompts(
          parsed.map((p) => ({
            boardId: p.workerId,
            text: singleLinePrompt(
              packDispatchPrompt(
                p.pack,
                `OBJECTIVE: ${p.spec.objective}\n\nCONTEXT: ${p.spec.context}\n\n` +
                  `BOUNDARIES: ${p.spec.boundaries}\n\nOUTPUT FORMAT: ${p.spec.outputFormat}`,
                undefined
              )
            )
          }))
        )
        let landed = 0
        for (let i = 0; i < parsed.length; i++) {
          const p = parsed[i]
          const outcome = outcomes[i]
          if (outcome?.status !== 'dispatched') {
            // A denied/rejected row never held the tree — release its slot immediately.
            ctx.writeInFlight.delete(p.workerId)
            continue
          }
          landed += 1
          if (p.activity) ctx.emit({ kind: 'activity', workerId: p.workerId, text: p.activity })
          await record(
            ctx.ledger &&
              (() =>
                ctx.ledger!.dispatched({
                  workerId: p.workerId,
                  role: p.pack?.id ?? 'worker',
                  spec: p.spec,
                  ...(p.activity ? { activity: p.activity } : {}),
                  ...(p.planItem !== undefined ? { planItem: p.planItem } : {}),
                  ...worktreeOf(ctx, p.workerId)
                }))
          )
        }
        const declined = outcomes.filter((o) => o?.status === 'denied').length
        const failed = outcomes.filter((o) => o?.status === 'rejected')
        return {
          content: JSON.stringify(outcomes),
          // Every non-landed row is named in the summary — the statusline renders `summary` only,
          // so a reason that is not in this string is a reason the human never sees.
          summary:
            `dispatched ${landed}/${parsed.length}` +
            (declined > 0 ? ` · ${declined} declined` : '') +
            (failed.length > 0
              ? ` · ${failed.length} failed (${singleLinePrompt(failed[0].detail ?? 'unknown').slice(0, 80)})`
              : '')
        }
      }
      case 'tick_plan_item': {
        if (ctx.paused()) return refuse('run paused — the human must resume first')
        const planBoardId = ctx.planBoard.current
        if (!planBoardId) return refuse('no plan drawn yet — call draw_plan first')
        const raw = args.planItem
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
          return refuse('tick_plan_item needs a 1-based planItem position')
        }
        const done = args.done !== false
        // Resolve the position against the LIVE board, not a remembered list: the human may have
        // added, renamed or removed rows since the plan was drawn, and MAIN mints no item ids.
        const planning = await facet.boardPlanning(planBoardId)
        const list = planning.elements.find((e) => e.kind === 'checklist' && Array.isArray(e.items))
        const item = list?.items?.[Math.min(raw, MAX_ITEMS) - 1]
        if (!list || !item) return refuse(`plan item ${raw} does not exist`)
        if (item.done === done) {
          // Not an error — a no-op tick must not burn a human confirm on nothing.
          return {
            content: JSON.stringify({ changed: false }),
            summary: `item ${raw} already ${done ? 'done' : 'open'}`
          }
        }
        // The planning-edit gate raises the human confirm and re-validates the patch itself.
        await facet.updatePlanningElement(planBoardId, list.id, {
          setItems: [{ id: item.id, done }]
        })
        return {
          content: JSON.stringify({ changed: true, done }),
          summary: `${done ? 'ticked' : 'unticked'} plan item ${raw}`
        }
      }
      case 'await_worker': {
        const workerId = str(args.workerId, 128)
        if (!workerId) return refuse('await_worker needs a workerId')
        const result = await facet.awaitSettled(workerId)
        ctx.writeInFlight.delete(workerId)
        const provenance: 'claimed' | 'synthesized' = result.synthesized ? 'synthesized' : 'claimed'
        ctx.emit({ kind: 'workerSettled', workerId, provenance, status: result.status ?? 'done' })
        await record(
          ctx.ledger &&
            (() =>
              ctx.ledger!.settled({
                workerId,
                status: result.status ?? 'unknown',
                summary: result.summary ?? '',
                refs: result.refs ?? [],
                provenance
              }))
        )
        return {
          content: JSON.stringify({
            status: result.status ?? 'unknown',
            summary: result.summary ?? '',
            refs: result.refs ?? [],
            provenance
          }),
          summary: `${workerId} settled (${provenance})`
        }
      }
      default:
        return refuse(`unknown tool ${name}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `tool failed: ${msg}`, isError: true, summary: `${name} failed` }
  }
}

const refuse = (why: string): SwarmToolOutcome => ({
  content: why,
  isError: true,
  summary: why.slice(0, 60)
})
