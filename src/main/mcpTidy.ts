import type { McpCommand, McpCommandAck } from './mcpCommand'
import { McpToolError } from './mcpToolError'
import {
  parseTidyArgs,
  sanitizeTidyAck,
  tidyResizes,
  type TidyAckFacts,
  type TidyArgs
} from '../shared/tidyContract'

/**
 * 🔒 P2 canvas-tidy method — the orchestrator's `tidyCanvas` loopback, factored OUT of
 * `mcpOrchestrator.ts` (which sits at the max-lines cap) and spread into its return object, the
 * extract-on-touch pattern `createBoardCardsMethod` (P3b) / `createVisualizeMethod` (P5a) use.
 *
 * Spatial I2 (SPEC C5 / C7): forwards the whole 0.27 wire — `mode` (fit / roles / smart / by-type /
 * grid / tile), `template`, `scope`, `overflow`, `fit`, `primary`, `resize` — as ONE `tidyBoards`
 * command to the renderer applier, which runs the matching engine (`fitLayout` / `roleLayout` / the
 * tile presets / the legacy packers) as ONE host undo step and acks `{ moved, fitZoom, readable,
 * pages?, units? }`. MAIN re-sanitizes that ack before the agent sees it.
 *
 * D8 (a): an OMITTED `mode` is an implicit `roles` — MAIN sends `mode:'roles', implicit:true`, so a
 * unit of plain shells keeps its sizes; an explicit `mode:'roles'` never falls back. The package
 * must not default `mode` (it does not), or MAIN could not tell the two apart.
 *
 * 🔒 D1 gate: the package registers `tidy_canvas` for the LEAD and CONNECTED tiers too, and binds the
 * caller's token-derived `sourceBoardId` on those calls. `sourceBoardId` present ⇒ ONE approve/deny
 * human confirm BEFORE anything moves; declined ⇒ a `declined` tool error and nothing changes.
 * Absent ⇒ the orchestrator tier (and the Jarvis facet), un-gated as before. Presence is
 * `!== undefined`, so an empty / malformed id still gates (fail closed). Every input is validated
 * BEFORE the confirm (`parseTidyArgs` + live-id checks), so the human is never asked to approve a
 * call that cannot run.
 *
 * Pure host module (no electron value import) — unit-tested through the orchestrator harness.
 */

/** The host's `tidyCanvas` input — the package's `TidyCanvasInput`, typed loosely (`unknown`)
 *  because a raw caller can reach this method too; `parseTidyArgs` checks every field. */
export interface TidyCanvasHostInput {
  mode?: unknown
  template?: unknown
  scope?: unknown
  overflow?: unknown
  fit?: unknown
  primary?: unknown
  resize?: unknown
  /** 🔒 A lead / connected caller's token-derived board id (set by the package tool, never client input). */
  sourceBoardId?: string
}

/** What `tidy_canvas` returns to the agent (C6): the moved count + the sanitized result facts. */
export type TidyCanvasResult = TidyAckFacts

/** The mirror fields the tidy method reads (`registry.listBoards()` satisfies it structurally). */
export interface TidyMirrorBoard {
  id: string
  type: string
  title: string
  /** Set ⇒ a worker docked inside a swarm board — not canvas geometry, never arranged. */
  dockedIn?: string
}

/** The command channel + the D1 confirm seams the tidy method needs. */
export interface TidyMethodDeps {
  sendCommand: (cmd: McpCommand) => Promise<McpCommandAck>
  /** MAIN-owned, fail-closed human confirm (the same modal every gated write uses). */
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
  /** The live renderer mirror — names the requesting board and validates ids before the confirm. */
  listBoards: () => TidyMirrorBoard[]
}

const isDocked = (b: TidyMirrorBoard): boolean =>
  typeof b.dockedIn === 'string' && b.dockedIn.length > 0

/** Ids of every board an agent may arrange: on the canvas and not docked in a swarm. */
function arrangeableIds(boards: readonly TidyMirrorBoard[]): Set<string> {
  return new Set(boards.filter((b) => !isDocked(b)).map((b) => b.id))
}

const clip = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s)

/** The confirm's "how" phrase (W5) — names the mode in user terms, never an id. */
function howPhrase(args: TidyArgs): string {
  switch (args.mode) {
    case 'roles':
      return args.implicit ? 'by role (the default tidy)' : 'by role'
    case 'fit':
      return 'to fit your screen (groups kept together)'
    case 'tile':
      return `into the "${args.template}" tile layout`
    default:
      return `with the ${args.mode} packer`
  }
}

function scopePhrase(args: TidyArgs): string {
  const scope = args.scope
  if (scope === undefined || scope === 'all') return 'the canvas'
  if (scope === 'visible') return 'the boards on screen'
  return 'groupId' in scope ? 'one group' : `${scope.boardIds.length} board(s)`
}

/** The W5 confirm body — honest about sizes: roles / tile / shrink may resize boards. */
function confirmBody(who: string, args: TidyArgs): string {
  const sizes = !tidyResizes(args)
    ? 'Boards are repositioned only: nothing is created, resized or deleted'
    : args.mode === 'roles' && args.overflow !== 'shrink'
      ? 'Terminal-like boards may be resized to their slot and browsers scale with their device ' +
        'aspect; planning, kanban and file boards keep their size. Nothing is created or deleted'
      : 'Boards may be resized to fit; nothing is created or deleted'
  return (
    `${who} asked to rearrange ${scopePhrase(args)} ${howPhrase(args)}. ${sizes}, and one ` +
    'Ctrl+Z undoes it.'
  )
}

/** The `tidyBoards` command for validated args — only the fields that are set. */
function toCommand(args: TidyArgs): McpCommand {
  const { mode, implicit, template, scope, overflow, fit, primary, resize } = args
  return {
    type: 'tidyBoards',
    mode,
    ...(implicit ? { implicit: true } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
    ...(fit !== undefined ? { fit } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(resize !== undefined ? { resize } : {})
  }
}

/**
 * The Jarvis facet's tidy (C7 amendment, 2026-10-17): Jarvis's `tidy_canvas` has NO `mode` (so it
 * is the implicit `roles` default, D8 a) and two optional args — `primary` ("make the browser the
 * main one", S14) and `boardIds` (scope, "tidy up the terminals", S12). Unknown or docked ids are
 * DROPPED (Jarvis resolves references from speech; a stale one must not fail the whole tidy), and
 * a scope that ends up empty is a no-op: returns `null`, and the facet does not tidy at all. A
 * `primary` outside a given scope joins it — the hero must be arranged to lead. Pure.
 */
export function jarvisTidyInput(
  input: { primary?: string; boardIds?: string[] },
  boards: readonly TidyMirrorBoard[]
): TidyCanvasHostInput | null {
  const live = arrangeableIds(boards)
  const primary =
    typeof input.primary === 'string' && live.has(input.primary) ? input.primary : undefined
  if (input.boardIds === undefined) return primary !== undefined ? { primary } : {}
  const ids = [...new Set(input.boardIds.filter((id) => live.has(id)))]
  if (ids.length === 0) return null
  if (primary !== undefined && !ids.includes(primary)) ids.push(primary)
  return { ...(primary !== undefined ? { primary } : {}), scope: { boardIds: ids } }
}

export function createTidyMethod(deps: TidyMethodDeps): {
  tidyCanvas(input: TidyCanvasHostInput): Promise<TidyCanvasResult>
} {
  return {
    async tidyCanvas(input) {
      const raw = input ?? {}
      const parsed = parseTidyArgs(raw)
      if (!parsed.ok) throw new McpToolError('invalid_input', `tidy_canvas: ${parsed.error}`)
      const args = parsed.args
      const boards = deps.listBoards()
      const live = arrangeableIds(boards)
      if (args.primary !== undefined && !live.has(args.primary)) {
        throw new McpToolError(
          'invalid_input',
          `tidy_canvas: primary '${clip(args.primary)}' is not a board on the canvas (or it is docked in a swarm board)`
        )
      }
      const scope = args.scope
      if (scope !== undefined && typeof scope === 'object' && 'boardIds' in scope) {
        // Only the Jarvis facet sends an id list (the package wire cannot): unknown / docked ids
        // drop, and nothing left to arrange is a no-op — no confirm, no command.
        const ids = scope.boardIds.filter((id) => live.has(id))
        if (ids.length === 0) return { moved: 0 }
        args.scope = { boardIds: ids }
      }
      if (raw.sourceBoardId !== undefined) {
        const source = boards.find((b) => b.id === raw.sourceBoardId)
        const who = source ? `The agent in "${source.title}"` : 'A terminal agent'
        const { approved } = await deps.confirm({
          title: 'Tidy the canvas?',
          body: confirmBody(who, args)
        })
        if (!approved) {
          throw new McpToolError('declined', 'tidy_canvas: declined by the user — nothing moved')
        }
      }
      const ack = await deps.sendCommand(toCommand(args))
      if (!ack.ok) throw new Error(`tidy_canvas failed: ${ack.error}`)
      return sanitizeTidyAck(ack as unknown as Record<string, unknown>)
    }
  }
}
