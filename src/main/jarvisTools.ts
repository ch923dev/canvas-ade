/**
 * Jarvis J4 — the curated tool surface (PLAN §3.6, KICKOFF-JARVIS-J4 §Scope). A hand-picked
 * subset of the canvas orchestrator, exposed to the brain as Claude tool definitions and
 * executed IN-PROCESS through the same host methods the MCP tools route to — so every
 * existing trust boundary (sanitizeLaunch, sanitizeBoardTitle, the kanban/dispatch/visualize
 * confirm gates, the audit trail) is paid identically. Nothing destructive is here: no
 * close_board, no remove_card, no planning-element removal (v1 fence).
 *
 * Risk tiers (the J4 gating contract):
 *   - READ tier (auto-allow): list_boards · board_cards · focus_viewport · tidy_canvas —
 *     state reads and reversible viewport/arrangement moves; no confirm.
 *   - GATED tier: spawn_board · relay_prompt · add_card · update_card · move_card ·
 *     visualize_plan — every one pauses on a human confirm before anything changes.
 *     relay/cards/visualize confirm INSIDE the orchestrator gates they route through;
 *     spawn_board (cap-checked but un-gated for MCP agents) gets a Jarvis-side pre-confirm
 *     so the tier holds uniformly. jarvisIpc wraps execution in `runAsJarvisToolCall`, so
 *     all of these render as the panel's turn-act card instead of the center modal
 *     (visualize_plan keeps the modal — its layout chooser needs the tiles; user-decided
 *     2026-07-16).
 *
 * 🔒 Injection audit (BRAIN-5 companion): tool args are MODEL output — downstream of
 * board titles and anything else in the prompt — so this module treats them as untrusted:
 * every arg is type-checked and length-capped here, board/column/card references resolve
 * against the LIVE model (unique-prefix or exact-title only), and every mutating call still
 * pays its human gate, where the human sees the exact resolved action. Browser-board page
 * content has no path into the prompt (AppModel carries id/type/title/status/geometry only)
 * and therefore none into tool args except through a board TITLE — which the manifest
 * neutralizes and the confirm gate exposes verbatim to the human.
 */
import type { AppModel } from './appModel'
import type { FocusOutcome } from './mcpFocus'

/** A Claude Messages-API tool definition (name + JSON-Schema input). */
export interface JarvisToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Arg caps — defensive; the orchestrator gates re-validate their own. */
const MAX_TITLE = 200
const MAX_TEXT = 4000
const MAX_DESC = 4000
const MAX_TAG = 40
const MAX_ITEMS = 50

/** The canvas facet the executor drives — the widened in-process RunningMcp slice. */
export interface JarvisCanvasFacet {
  describeApp(): Promise<AppModel>
  spawnBoard(input: {
    type: string
    prompt?: string
    cwd?: string
    title?: string
    url?: string
  }): Promise<{ id: string }>
  dispatchPrompt(boardId: string, text: string): Promise<{ delivery: 'ready' | 'unconfirmed' }>
  addCard(
    boardId: string,
    spec: { columnId: string; title: string; tag?: string; description?: string }
  ): Promise<{ id: string }>
  updateCard(
    boardId: string,
    cardId: string,
    patch: { title?: string; tag?: string; description?: string }
  ): Promise<void>
  moveCard(boardId: string, cardId: string, toColumnId: string): Promise<void>
  visualizePlan(spec: {
    items: Array<{ title: string; status?: string; note?: string }>
    suggested?: 'kanban' | 'grid' | 'checklist' | 'columns'
    title?: string
  }): Promise<{ id: string; queuedFor?: string }>
  focusViewport(input: { boardId?: string; groupId?: string }): Promise<FocusOutcome>
  tidyCanvas(input: { mode?: string }): Promise<{ moved: number }>
  boardCards(boardId: string): Promise<unknown>
}

/** Names that run WITHOUT a confirm (reads + reversible viewport/arrangement moves). */
export const JARVIS_AUTO_ALLOW = new Set([
  'list_boards',
  'board_cards',
  'focus_viewport',
  'tidy_canvas'
])

export function isJarvisToolGated(name: string): boolean {
  return !JARVIS_AUTO_ALLOW.has(name)
}

const BOARD_ARG =
  'A board reference: the [id] prefix shown in the Workspace list (8+ chars), a full board id, or an exact board title.'

/** The curated defs handed to the Messages API (order = the model-facing catalog). */
export function buildJarvisToolDefs(): JarvisToolDef[] {
  return [
    {
      name: 'list_boards',
      description:
        'Read the live canvas: every board (id, type, title, status, group) and the named groups. Use when the Workspace snapshot is stale (e.g. right after spawning).',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'board_cards',
      description:
        'Read one KANBAN board: its columns (with ids) and cards (with ids). Read this before update_card / move_card, and before add_card when a specific column is wanted.',
      input_schema: {
        type: 'object',
        properties: { board: { type: 'string', description: BOARD_ARG } },
        required: ['board'],
        additionalProperties: false
      }
    },
    {
      name: 'focus_viewport',
      description:
        "Fit the user's camera to one board, one named group, or (with no argument) the whole canvas. Reversible; runs without confirmation.",
      input_schema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: BOARD_ARG },
          group: { type: 'string', description: 'A group id or exact group name.' }
        },
        additionalProperties: false
      }
    },
    {
      name: 'tidy_canvas',
      description:
        'Reposition every board into a clean non-overlapping arrangement (one undoable step). Runs without confirmation.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'spawn_board',
      description:
        'Create a new board. type: terminal | browser | planning | kanban. For a terminal, launch_command (e.g. "claude") becomes its first shell line and cwd its directory; url is browser-only. Requires user confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['terminal', 'browser', 'planning', 'kanban'] },
          title: { type: 'string', maxLength: MAX_TITLE },
          launch_command: { type: 'string', maxLength: 400 },
          cwd: { type: 'string', maxLength: 400 },
          url: { type: 'string', maxLength: 2000 }
        },
        required: ['type'],
        additionalProperties: false
      }
    },
    {
      name: 'relay_prompt',
      description:
        "Send a prompt line into a terminal board's running agent. Requires user confirmation; the result reports delivery ('ready' = landed in a ready REPL).",
      input_schema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: BOARD_ARG },
          text: { type: 'string', maxLength: MAX_TEXT }
        },
        required: ['board', 'text'],
        additionalProperties: false
      }
    },
    {
      name: 'add_card',
      description:
        'Add a card to a kanban board. Omit column to use the board’s first column. Requires user confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: BOARD_ARG },
          title: { type: 'string', maxLength: MAX_TITLE },
          column: { type: 'string', description: 'Column id or exact column title.' },
          tag: { type: 'string', maxLength: MAX_TAG },
          description: { type: 'string', maxLength: MAX_DESC }
        },
        required: ['board', 'title'],
        additionalProperties: false
      }
    },
    {
      name: 'update_card',
      description:
        'Update an existing card’s title / tag / description on a kanban board. card = the card id from board_cards. Requires user confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: BOARD_ARG },
          card: { type: 'string' },
          title: { type: 'string', maxLength: MAX_TITLE },
          tag: { type: 'string', maxLength: MAX_TAG },
          description: { type: 'string', maxLength: MAX_DESC }
        },
        required: ['board', 'card'],
        additionalProperties: false
      }
    },
    {
      name: 'move_card',
      description:
        'Move a card to another column on the same kanban board. Requires user confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          board: { type: 'string', description: BOARD_ARG },
          card: { type: 'string' },
          to_column: { type: 'string', description: 'Column id or exact column title.' }
        },
        required: ['board', 'card', 'to_column'],
        additionalProperties: false
      }
    },
    {
      name: 'visualize_plan',
      description:
        'Draw a plan as a NEW board (kanban / grid / checklist / columns — the user picks the final shape in a dialog). Items are short titles with optional status/note. Requires user confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: MAX_TITLE },
          suggested: { type: 'string', enum: ['kanban', 'grid', 'checklist', 'columns'] },
          items: {
            type: 'array',
            maxItems: MAX_ITEMS,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', maxLength: MAX_TITLE },
                status: { type: 'string', maxLength: 40 },
                note: { type: 'string', maxLength: 500 }
              },
              required: ['title'],
              additionalProperties: false
            }
          }
        },
        required: ['items'],
        additionalProperties: false
      }
    }
  ]
}

/** What a finished tool call reports back — to the model (content) and the panel (summary). */
export interface JarvisToolOutcome {
  /** tool_result content (JSON or plain text; bounded). */
  content: string
  isError: boolean
  /** The human declined the gate (a subtype of isError for the model; own chip state). */
  denied: boolean
  /** One-line act-row summary, length-capped, built from VALIDATED args only. */
  summary: string
}

export interface JarvisToolExecDeps {
  facet: JarvisCanvasFacet
  /** Jarvis-side pre-confirm (spawn_board — un-gated in the orchestrator). Fail-closed. */
  confirm: (req: { title: string; body: string }) => Promise<{ approved: boolean }>
}

// ── arg validation helpers (model output = untrusted input) ──
class ToolArgError extends Error {}

function reqStr(input: Record<string, unknown>, key: string, max: number): string {
  const v = input[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new ToolArgError(`"${key}" (string) is required`)
  }
  if (v.length > max) throw new ToolArgError(`"${key}" exceeds ${max} chars`)
  return v.trim()
}

function optStr(input: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new ToolArgError(`"${key}" must be a string`)
  if (v.length > max) throw new ToolArgError(`"${key}" exceeds ${max} chars`)
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * Resolve a board reference (id, unique id prefix ≥6 chars, or exact title, case-insensitive)
 * against the live model. Ambiguity throws with the candidates — the model is prompted to
 * ask the user a one-line disambiguation question rather than guess.
 */
export function resolveBoardRef(
  model: AppModel,
  ref: string,
  wantType?: string
): { id: string; title: string; type: string } {
  const boards = model.canvas.boards
  const r = ref.trim()
  const lower = r.toLowerCase()
  const exact = boards.filter((b) => b.id === r)
  const prefix =
    exact.length === 0 && r.length >= 6 ? boards.filter((b) => b.id.startsWith(r)) : exact
  const byTitle =
    prefix.length === 0 ? boards.filter((b) => b.title.trim().toLowerCase() === lower) : prefix
  const hits = byTitle
  if (hits.length === 0) throw new ToolArgError(`no board matches "${clip(r, 40)}"`)
  if (hits.length > 1) {
    const names = hits
      .slice(0, 4)
      .map((b) => `[${b.id.slice(0, 8)}] "${clip(b.title, 30)}"`)
      .join(', ')
    throw new ToolArgError(`"${clip(r, 40)}" is ambiguous (${names}) — ask the user which one`)
  }
  const hit = hits[0]
  if (wantType && hit.type !== wantType) {
    throw new ToolArgError(`board "${clip(hit.title, 30)}" is a ${hit.type}, not a ${wantType}`)
  }
  return { id: hit.id, title: hit.title, type: hit.type }
}

/** Resolve a group reference (id or exact name, case-insensitive). */
function resolveGroupRef(model: AppModel, ref: string): { id: string; name: string } {
  const r = ref.trim()
  const lower = r.toLowerCase()
  const hits = model.canvas.groups.filter(
    (g) => g.id === r || g.name.trim().toLowerCase() === lower
  )
  if (hits.length === 0) throw new ToolArgError(`no group matches "${clip(r, 40)}"`)
  if (hits.length > 1) throw new ToolArgError(`group "${clip(r, 40)}" is ambiguous`)
  return { id: hits[0].id, name: hits[0].name }
}

/** Resolve a column reference (id or exact title) from a board_cards projection. */
function resolveColumn(cards: unknown, ref: string | undefined): { id: string; title: string } {
  const cols = (cards as { columns?: Array<{ id: string; title: string }> } | null)?.columns
  if (!Array.isArray(cols) || cols.length === 0) throw new ToolArgError('the board has no columns')
  if (ref === undefined) return { id: cols[0].id, title: cols[0].title }
  const lower = ref.trim().toLowerCase()
  const hit = cols.find((c) => c.id === ref || c.title.trim().toLowerCase() === lower)
  if (!hit) {
    const names = cols.map((c) => `"${clip(c.title, 24)}"`).join(', ')
    throw new ToolArgError(`no column matches "${clip(ref, 40)}" (have: ${names})`)
  }
  return { id: hit.id, title: hit.title }
}

const ok = (summary: string, result: unknown): JarvisToolOutcome => ({
  content: clip(JSON.stringify(result), 4000),
  isError: false,
  denied: false,
  summary: clip(summary, 140)
})

const fail = (summary: string, message: string, denied = false): JarvisToolOutcome => ({
  content: clip(message, 1000),
  isError: true,
  denied,
  summary: clip(summary, 140)
})

/** A thrown gate-deny reads as its own outcome (the chip + the spoken reply differ from error). */
function isDenyError(err: unknown): boolean {
  return err instanceof Error && /denied/i.test(err.message)
}

/** One-line act summary per tool, built from VALIDATED args (never raw model output). */
export function summarizeJarvisTool(name: string, detail: string): string {
  return clip(`${name} · ${detail}`, 140)
}

/**
 * Execute ONE tool call. Never throws: every path resolves a JarvisToolOutcome whose
 * `content` goes back to the model as the tool_result (errors carry is_error so the model
 * answers grounded in the failure instead of hallucinating success).
 */
export async function executeJarvisTool(
  name: string,
  input: Record<string, unknown>,
  deps: JarvisToolExecDeps
): Promise<JarvisToolOutcome> {
  try {
    switch (name) {
      case 'list_boards': {
        const model = await deps.facet.describeApp()
        const boards = model.canvas.boards.slice(0, 60).map((b) => ({
          id: b.id.slice(0, 8),
          type: b.type,
          title: clip(b.title, 60),
          status: b.status
        }))
        const groups = model.canvas.groups.map((g) => ({
          name: clip(g.name, 40),
          boards: g.boardIds.length
        }))
        return ok('list_boards', { count: model.canvas.boards.length, boards, groups })
      }
      case 'board_cards': {
        const model = await deps.facet.describeApp()
        const board = resolveBoardRef(model, reqStr(input, 'board', 200))
        const cards = await deps.facet.boardCards(board.id)
        return ok(summarizeJarvisTool(name, `"${board.title}"`), cards)
      }
      case 'focus_viewport': {
        const model = await deps.facet.describeApp()
        const boardRef = optStr(input, 'board', 200)
        const groupRef = optStr(input, 'group', 200)
        if (boardRef !== undefined && groupRef !== undefined) {
          return fail(name, 'pass at most one of board / group')
        }
        let arg: { boardId?: string; groupId?: string } = {}
        let detail = 'whole canvas'
        if (boardRef !== undefined) {
          const b = resolveBoardRef(model, boardRef)
          arg = { boardId: b.id }
          detail = `"${b.title}"`
        } else if (groupRef !== undefined) {
          const g = resolveGroupRef(model, groupRef)
          arg = { groupId: g.id }
          detail = `group "${g.name}"`
        }
        const outcome = await deps.facet.focusViewport(arg)
        return ok(summarizeJarvisTool(name, detail), outcome)
      }
      case 'tidy_canvas': {
        const outcome = await deps.facet.tidyCanvas({})
        return ok(summarizeJarvisTool(name, `${outcome.moved} board(s) moved`), outcome)
      }
      case 'spawn_board': {
        const type = reqStr(input, 'type', 20)
        if (!['terminal', 'browser', 'planning', 'kanban'].includes(type)) {
          return fail(name, `unsupported board type "${clip(type, 20)}"`)
        }
        const title = optStr(input, 'title', MAX_TITLE)
        const launch = optStr(input, 'launch_command', 400)
        const cwd = optStr(input, 'cwd', 400)
        const url = optStr(input, 'url', 2000)
        const detail = [
          `a ${type} board`,
          title ? `"${title}"` : null,
          launch ? `running: ${launch}` : null,
          cwd ? `in ${cwd}` : null,
          url ? `at ${url}` : null
        ]
          .filter(Boolean)
          .join(' ')
        // 🔒 The Jarvis-side gate: spawn is un-gated for MCP agents (content-less), but the
        // J4 tier says every Jarvis mutation confirms. The human sees the EXACT spawn.
        const { approved } = await deps.confirm({
          title: 'Jarvis: spawn a board',
          body: `Spawn ${detail}`
        })
        if (!approved) return fail(summarizeJarvisTool(name, detail), 'the user declined', true)
        const spawned = await deps.facet.spawnBoard({
          type,
          ...(title ? { title } : {}),
          ...(launch ? { prompt: launch } : {}),
          ...(cwd ? { cwd } : {}),
          ...(url ? { url } : {})
        })
        return ok(summarizeJarvisTool(name, detail), { id: spawned.id.slice(0, 8), type, title })
      }
      case 'relay_prompt': {
        const model = await deps.facet.describeApp()
        const board = resolveBoardRef(model, reqStr(input, 'board', 200), 'terminal')
        const text = reqStr(input, 'text', MAX_TEXT)
        // The dispatch gate does the rest: sanitize → nonce → human confirm (the panel act
        // card, via the origin marker) → readiness → write → audit.
        const { delivery } = await deps.facet.dispatchPrompt(board.id, text)
        return ok(summarizeJarvisTool(name, `→ "${board.title}"`), {
          board: board.id.slice(0, 8),
          delivery
        })
      }
      case 'add_card': {
        const model = await deps.facet.describeApp()
        const board = resolveBoardRef(model, reqStr(input, 'board', 200), 'kanban')
        const title = reqStr(input, 'title', MAX_TITLE)
        const column = resolveColumn(
          await deps.facet.boardCards(board.id),
          optStr(input, 'column', 200)
        )
        const spec = {
          columnId: column.id,
          title,
          ...(optStr(input, 'tag', MAX_TAG) ? { tag: optStr(input, 'tag', MAX_TAG) } : {}),
          ...(optStr(input, 'description', MAX_DESC)
            ? { description: optStr(input, 'description', MAX_DESC) }
            : {})
        }
        const added = await deps.facet.addCard(board.id, spec)
        return ok(
          summarizeJarvisTool(name, `"${clip(title, 40)}" → "${board.title}" · ${column.title}`),
          { cardId: added.id, board: board.id.slice(0, 8), column: column.title, title }
        )
      }
      case 'update_card': {
        const model = await deps.facet.describeApp()
        const board = resolveBoardRef(model, reqStr(input, 'board', 200), 'kanban')
        const card = reqStr(input, 'card', 200)
        const patch = {
          ...(optStr(input, 'title', MAX_TITLE)
            ? { title: optStr(input, 'title', MAX_TITLE) }
            : {}),
          ...(optStr(input, 'tag', MAX_TAG) ? { tag: optStr(input, 'tag', MAX_TAG) } : {}),
          ...(optStr(input, 'description', MAX_DESC)
            ? { description: optStr(input, 'description', MAX_DESC) }
            : {})
        }
        if (Object.keys(patch).length === 0) return fail(name, 'nothing to change — pass a field')
        await deps.facet.updateCard(board.id, card, patch)
        return ok(summarizeJarvisTool(name, `card on "${board.title}"`), {
          updated: Object.keys(patch)
        })
      }
      case 'move_card': {
        const model = await deps.facet.describeApp()
        const board = resolveBoardRef(model, reqStr(input, 'board', 200), 'kanban')
        const card = reqStr(input, 'card', 200)
        const column = resolveColumn(
          await deps.facet.boardCards(board.id),
          reqStr(input, 'to_column', 200)
        )
        await deps.facet.moveCard(board.id, card, column.id)
        return ok(summarizeJarvisTool(name, `→ ${column.title} on "${board.title}"`), {
          movedTo: column.title
        })
      }
      case 'visualize_plan': {
        const rawItems = input.items
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
          return fail(name, '"items" (non-empty array) is required')
        }
        if (rawItems.length > MAX_ITEMS) return fail(name, `at most ${MAX_ITEMS} items`)
        const items = rawItems.map((it, i) => {
          if (it === null || typeof it !== 'object') {
            throw new ToolArgError(`items[${i}] must be an object`)
          }
          const o = it as Record<string, unknown>
          return {
            title: reqStr(o, 'title', MAX_TITLE),
            ...(optStr(o, 'status', 40) ? { status: optStr(o, 'status', 40) } : {}),
            ...(optStr(o, 'note', 500) ? { note: optStr(o, 'note', 500) } : {})
          }
        })
        const suggestedRaw = optStr(input, 'suggested', 20)
        const suggested =
          suggestedRaw !== undefined &&
          ['kanban', 'grid', 'checklist', 'columns'].includes(suggestedRaw)
            ? (suggestedRaw as 'kanban' | 'grid' | 'checklist' | 'columns')
            : undefined
        const title = optStr(input, 'title', MAX_TITLE)
        const outcome = await deps.facet.visualizePlan({
          items,
          ...(suggested ? { suggested } : {}),
          ...(title ? { title } : {})
        })
        return ok(summarizeJarvisTool(name, `${items.length} item(s)`), {
          boardId: outcome.id.slice(0, 8),
          ...(outcome.queuedFor ? { queuedFor: outcome.queuedFor } : {})
        })
      }
      default:
        return fail(name, `unknown tool "${clip(name, 40)}"`)
    }
  } catch (err) {
    if (err instanceof ToolArgError) return fail(name, err.message)
    if (isDenyError(err)) return fail(name, 'the user declined', true)
    // Host errors can carry paths/titles the human already sees; still cap + pass through so
    // the model grounds its reply in the real failure (e.g. the spawn cap message).
    const msg = err instanceof Error ? err.message : String(err)
    return fail(name, msg)
  }
}
