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
 * `primary` means MAIN + SIDEBAR (I2 dev-check amendment, 2026-11-02 — the tiling-WM "promote to
 * master" model): the named board becomes the main board and EVERY other in-scope board forms its
 * sidebar (right on a wide pane, bottom on a tall one, or the host-only `side`). Not "hero of its own
 * unit" — that left an ungrouped board alone on stage with everything else off-screen.
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
 * Spatial I3 ("tidy a group"): a `{ groupId }` scope is checked against the Named-Group mirror
 * (when the registry mirrors groups) — unknown ⇒ `invalid_input` before any confirm — and the
 * confirm NAMES the group. The renderer settles a partial scope so no board outside it moves or is
 * covered; when the arrangement had to move to open space, the ack carries `relocated: true`.
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
  /** Host-only (Jarvis `make_main_board`, the package's `arrange_main_board`): where the sidebar goes. */
  side?: unknown
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
  /** The Named-Group mirror — validates + names a `{ groupId }` scope (absent ⇒ unchecked here;
   *  the renderer still rejects an unknown group). */
  listGroups?: () => Array<{ id: string; name: string }>
}

const isDocked = (b: TidyMirrorBoard): boolean =>
  typeof b.dockedIn === 'string' && b.dockedIn.length > 0

/** Ids of every board an agent may arrange: on the canvas and not docked in a swarm. */
function arrangeableIds(boards: readonly TidyMirrorBoard[]): Set<string> {
  return new Set(boards.filter((b) => !isDocked(b)).map((b) => b.id))
}

const clip = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s)

/** The confirm's "how" phrase (W5) — names the mode in user terms, never an id. */
function howPhrase(args: TidyArgs, mainTitle: string | undefined): string {
  if (args.primary !== undefined) {
    const where = args.side === undefined || args.side === 'auto' ? '' : ` on the ${args.side}`
    return `with "${clip(mainTitle ?? 'that board')}" as the main board and every other board in a sidebar${where}`
  }
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

function scopePhrase(args: TidyArgs, groupName: string | undefined): string {
  const scope = args.scope
  if (scope === undefined || scope === 'all') return 'the canvas'
  if (scope === 'visible') return 'the boards on screen'
  if ('boardIds' in scope) return `${scope.boardIds.length} board(s)`
  return groupName !== undefined ? `the group "${clip(groupName)}"` : 'one group'
}

/** The W5 confirm body — honest about sizes: roles / tile / shrink / main may resize boards. */
function confirmBody(
  who: string,
  args: TidyArgs,
  mainTitle: string | undefined,
  groupName: string | undefined
): string {
  const sizes = !tidyResizes(args)
    ? 'Boards are repositioned only: nothing is created, resized or deleted'
    : args.primary !== undefined
      ? 'Every board in it may be resized: the main board fills the big slot and the others ' +
        'share the sidebar. Nothing is created or deleted'
      : args.mode === 'roles' && args.overflow !== 'shrink'
        ? 'Terminal-like boards may be resized to their slot and browsers scale with their device ' +
          'aspect; planning, kanban and file boards keep their size. Nothing is created or deleted'
        : 'Boards may be resized to fit; nothing is created or deleted'
  return (
    `${who} asked to rearrange ${scopePhrase(args, groupName)} ${howPhrase(args, mainTitle)}. ` +
    `${sizes}, and one Ctrl+Z undoes it.`
  )
}

/** The `tidyBoards` command for validated args — only the fields that are set. */
function toCommand(args: TidyArgs): McpCommand {
  const { mode, implicit, template, scope, overflow, fit, primary, resize, side } = args
  return {
    type: 'tidyBoards',
    mode,
    ...(implicit ? { implicit: true } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(overflow !== undefined ? { overflow } : {}),
    ...(fit !== undefined ? { fit } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(resize !== undefined ? { resize } : {}),
    ...(side !== undefined ? { side } : {})
  }
}

/**
 * The Jarvis facet's tidy (C7 amendment, 2026-10-17; split 2026-11-02): Jarvis's `tidy_canvas` has
 * NO `mode` (so it is the implicit `roles` default, D8 a) and an optional `boardIds` scope ("tidy up
 * the terminals", S12); its separate `make_main_board` tool sends `primary` (+ `side`) — main +
 * sidebar. Unknown or docked ids are DROPPED (Jarvis resolves references from speech; a stale one
 * must not fail the whole tidy), and a scope that ends up empty is a no-op: returns `null`, and the
 * facet does not tidy at all. A `primary` outside a given scope joins it — the main board must be in
 * the arrangement it leads. An unknown / docked `primary` drops `side` with it. A `groupId` (I3, a
 * group Jarvis already resolved against the live model) becomes a `{ groupId }` scope verbatim —
 * the tidy method then checks it against the group mirror. Pure.
 */
export function jarvisTidyInput(
  input: { primary?: string; boardIds?: string[]; groupId?: string; side?: string },
  boards: readonly TidyMirrorBoard[]
): TidyCanvasHostInput | null {
  const live = arrangeableIds(boards)
  const primary =
    typeof input.primary === 'string' && live.has(input.primary) ? input.primary : undefined
  const main =
    primary !== undefined
      ? { primary, ...(input.side !== undefined ? { side: input.side } : {}) }
      : {}
  if (input.groupId !== undefined) return { ...main, scope: { groupId: input.groupId } }
  if (input.boardIds === undefined) return main
  const ids = [...new Set(input.boardIds.filter((id) => live.has(id)))]
  if (ids.length === 0) return null
  if (primary !== undefined && !ids.includes(primary)) ids.push(primary)
  return { ...main, scope: { boardIds: ids } }
}

/**
 * The package's `arrange_main_board` input (0.28 — an OPTIONAL host method, so the app can ship it
 * before the pin bump): the main board + where its sidebar goes + an optional scope / camera flag.
 * Typed loosely (`unknown`): the same `parseTidyArgs` rules run on it as `primary` / `side`.
 */
export interface ArrangeMainBoardHostInput {
  boardId?: unknown
  side?: unknown
  scope?: unknown
  fit?: unknown
  /** 🔒 A lead / connected caller's token-derived board id (set by the package tool). */
  sourceBoardId?: string
}

export function createTidyMethod(deps: TidyMethodDeps): {
  tidyCanvas(input: TidyCanvasHostInput): Promise<TidyCanvasResult>
  arrangeMainBoard(input: ArrangeMainBoardHostInput): Promise<TidyCanvasResult>
} {
  /** One tidy, any entry point — `tool` names the caller's tool in every error it sees. */
  async function tidy(input: TidyCanvasHostInput, tool: string): Promise<TidyCanvasResult> {
    const raw = input ?? {}
    const parsed = parseTidyArgs(raw)
    if (!parsed.ok) throw new McpToolError('invalid_input', `${tool}: ${parsed.error}`)
    const args = parsed.args
    const boards = deps.listBoards()
    const live = arrangeableIds(boards)
    if (args.primary !== undefined && !live.has(args.primary)) {
      throw new McpToolError(
        'invalid_input',
        `${tool}: board '${clip(args.primary)}' is not a board on the canvas (or it is docked in a swarm board)`
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
    let groupName: string | undefined
    if (scope !== undefined && typeof scope === 'object' && 'groupId' in scope && deps.listGroups) {
      groupName = deps.listGroups().find((g) => g.id === scope.groupId)?.name
      if (groupName === undefined) {
        throw new McpToolError(
          'invalid_input',
          `${tool}: group '${clip(scope.groupId)}' is not a group on the canvas (read canvas://contexts)`
        )
      }
    }
    if (raw.sourceBoardId !== undefined) {
      const source = boards.find((b) => b.id === raw.sourceBoardId)
      const who = source ? `The agent in "${source.title}"` : 'A terminal agent'
      const mainTitle = boards.find((b) => b.id === args.primary)?.title
      const { approved } = await deps.confirm({
        title:
          args.primary !== undefined
            ? 'Make it the main board?'
            : groupName !== undefined
              ? 'Tidy the group?'
              : 'Tidy the canvas?',
        body: confirmBody(who, args, mainTitle, groupName)
      })
      if (!approved) {
        throw new McpToolError('declined', `${tool}: declined by the user — nothing moved`)
      }
    }
    const ack = await deps.sendCommand(toCommand(args))
    if (!ack.ok) throw new Error(`${tool} failed: ${ack.error}`)
    return sanitizeTidyAck(ack as unknown as Record<string, unknown>)
  }
  return {
    tidyCanvas: (input) => tidy(input, 'tidy_canvas'),
    // Main + sidebar as its own intent (I2 dev-check amendment): no mode ⇒ the implicit roles
    // engine with `primary` = the main board. Same validation, same D1 confirm, same one undo.
    arrangeMainBoard: async (input) => {
      const raw = input ?? {}
      if (typeof raw.boardId !== 'string' || raw.boardId.length === 0) {
        throw new McpToolError('invalid_input', 'arrange_main_board: boardId must be a board id')
      }
      return tidy(
        {
          primary: raw.boardId,
          ...(raw.side !== undefined ? { side: raw.side } : {}),
          ...(raw.scope !== undefined ? { scope: raw.scope } : {}),
          ...(raw.fit !== undefined ? { fit: raw.fit } : {}),
          ...(raw.sourceBoardId !== undefined ? { sourceBoardId: raw.sourceBoardId } : {})
        },
        'arrange_main_board'
      )
    }
  }
}
