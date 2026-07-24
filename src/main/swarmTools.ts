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
  type RolePack
} from '../shared/rolePacks'
import type { JarvisToolDef } from './jarvisTools'

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

/** Per-run mutable state the executor threads (owned by the swarm session in swarmChatIpc). */
export interface SwarmRunCtx {
  paused: () => boolean
  /** Worker board ids dispatched with a WRITE-role and not yet settled (the serialization cap). */
  writeInFlight: Set<string>
  /** Worker board id → its dispatched role id (await_worker reads it for provenance labels). */
  workerRoles: Map<string, string>
  emit: (ev: SwarmRunEvent) => void
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
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

/** Compose the role-shaped claude launch line (MAIN-side; the 400-char spawn clamp re-checks). */
export function composeRoleLaunch(pack: RolePack): string {
  const model = pack.model.pin ?? MODEL_TIER_CLAUDE_ALIAS[pack.model.tier]
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
        // The Jarvis-pattern pre-gate: spawn_board is cap-checked but un-gated for MCP agents;
        // the swarm brain pays an explicit human confirm so every mutating tool is gated.
        const { approved } = await ctx.confirm({
          title: 'Spawn a swarm worker?',
          body: `The orchestrator wants to spawn "${workerName}" (${pack.id}, ${pack.permissionMode === 'plan' ? 'read-only' : 'write'}) running: ${composeRoleLaunch(pack)}`
        })
        if (!approved)
          return {
            content: 'denied by the human',
            isError: true,
            denied: true,
            summary: 'spawn denied'
          }
        const spawned = await facet.spawnBoard({
          type: 'terminal',
          title: workerName,
          prompt: composeRoleLaunch(pack),
          ...(str(args.cwd, 1024) ? { cwd: str(args.cwd, 1024) } : {})
        })
        ctx.workerRoles.set(spawned.id, pack.id)
        ctx.emit({ kind: 'workerSpawned', workerId: spawned.id, role: pack.id, title: workerName })
        return {
          content: JSON.stringify({ workerId: spawned.id }),
          summary: `spawned ${workerName} (${pack.id})`
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
        try {
          // The orchestrator's OWN human gate lives inside dispatchPrompt — no double confirm.
          const r = await facet.dispatchPrompt(workerId, packDispatchPrompt(pack, spec, undefined))
          if (activity) ctx.emit({ kind: 'activity', workerId, text: activity })
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
            summary: 'dispatch failed'
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
