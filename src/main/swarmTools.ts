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
 * WRITE SERIALIZATION (07 §4 honored at Phase-0 reality): until worktree isolation (S3), all
 * write-posture workers share one working tree, so the executor admits at most
 * WRITE_ROLE_CONCURRENCY_CAP (=1) un-settled write-role dispatches per run — refusals are
 * returned to the model as tool errors naming the cap, so the disclosure rule can be honored
 * in chat (no silent caps, 06 §2). Pause: while the run is paused every mutating tool refuses.
 */
import type { AppModel } from './appModel'
import {
  MODEL_TIER_CLAUDE_ALIAS,
  ROLE_PACKS,
  WRITE_ROLE_CONCURRENCY_CAP,
  isWriteRolePack,
  packDispatchPrompt,
  rolePackById,
  singleLinePrompt,
  type RolePack
} from '../shared/rolePacks'
import type { ConfirmChoices, ConfirmWorkerConfig } from './mcpConfirm'
import type { JarvisToolDef } from './jarvisTools'
import { sanitizeDispatchText } from './dispatchSanitize'
import type { SwarmLedgerSnapshot, SwarmTaskSpec } from '../shared/swarmLedgerTypes'

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
}

/** Run events the executor emits so the renderer's swarm board mirrors the run live. */
export type SwarmRunEvent =
  | { kind: 'workerSpawned'; workerId: string; role?: string; title: string }
  | { kind: 'planDrawn'; planBoardId: string }
  | { kind: 'activity'; workerId: string; text: string }
  | {
      kind: 'workerSettled'
      workerId: string
      provenance: 'claimed' | 'synthesized'
      status: string
    }
  /**
   * S2: the durable projection. Rides the EXISTING run-event channel rather than a second sync
   * path (the kickoff's rule), so the renderer has ONE subscription and MAIN has ONE push.
   */
  | { kind: 'ledger'; snapshot: SwarmLedgerSnapshot }
  /**
   * S2: something happened to the run BETWEEN turns (a worker died, a worker stalled) and the
   * orchestrator says so in its own voice. `text` is the sentence TAIL — the renderer prefixes the
   * worker's title, because MAIN carries board ids and never titles (the `SwarmTriageRow` rule).
   * Composed deterministically in MAIN: no LLM call, no budget spend, and it can only state facts
   * the ledger actually holds.
   */
  | { kind: 'narrate'; boardId?: string; status?: string; text: string }

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
  emit: (ev: SwarmRunEvent) => void
  /** The shared fail-closed confirm; `workerConfig` routes to the full worker-config dialog
   *  (the swarm spawn gate), `choices` to the P5 chooser. */
  confirm: (req: {
    title: string
    body: string
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
        // The Jarvis-pattern pre-gate: spawn_board is cap-checked but un-gated for MCP agents;
        // the swarm brain pays an explicit human confirm so every mutating tool is gated. The
        // request carries `workerConfig`, so the renderer shows the FULL worker-config dialog
        // (the command board's spawn surface — role row, agent presets, builder, editable
        // launch line) and the human COMMITS the worker's real config, not just approve/deny.
        const defaultLaunch = composeRoleLaunch(pack, model)
        const decision = await ctx.confirm({
          title: 'Spawn a swarm worker?',
          body: `The orchestrator wants to spawn "${workerName}" (${pack.id}, ${pack.permissionMode === 'plan' ? 'read-only' : 'write'}) running: ${defaultLaunch}`,
          workerConfig: {
            workerName,
            roleId: pack.id,
            ...(model ? { modelDefault: model } : {}),
            defaultLaunch
          }
        })
        if (!decision.approved)
          return {
            content: 'denied by the human',
            isError: true,
            denied: true,
            summary: 'spawn denied'
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
        const spawned = await facet.spawnBoard({
          type: 'terminal',
          title: workerName,
          prompt: launch,
          ...(str(args.cwd, 1024) ? { cwd: str(args.cwd, 1024) } : {}),
          ...(openRouter ? { openRouter } : {})
        })
        ctx.workerRoles.set(spawned.id, finalPack.id)
        ctx.emit({
          kind: 'workerSpawned',
          workerId: spawned.id,
          role: finalPack.id,
          title: workerName
        })
        return {
          content: JSON.stringify({ workerId: spawned.id }),
          summary: `spawned ${workerName} (${finalPack.id})`
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
        // Write serialization (Phase-0 shared working tree): cap un-settled write-role
        // dispatches; the refusal names the cap so the model can disclose it in chat.
        if (pack && isWriteRolePack(pack) && !ctx.writeInFlight.has(workerId)) {
          if (ctx.writeInFlight.size >= WRITE_ROLE_CONCURRENCY_CAP) {
            return refuse(
              `write cap: ${ctx.writeInFlight.size} write-role task already running and workers share one working tree until worktree isolation lands — await it first (disclose this to the human)`
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
                  ...(planItem !== undefined ? { planItem } : {})
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
