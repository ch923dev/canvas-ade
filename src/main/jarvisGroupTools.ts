/**
 * Spatial-awareness I1 — Jarvis's Named-Group tools: `list_groups` (READ tier, auto-allow) and
 * `group_boards` / `edit_groups` (GATED tier). Split out of jarvisTools.ts (one file = one purpose,
 * and the tidy lane edits that file) and wired into its catalog + executor.
 *
 * Both writes route IN-PROCESS through the orchestrator's `groupBoards` / `editGroups`
 * (mcpGroups.ts) — the SAME methods the `group_boards` / `edit_groups` MCP tools reach — so the
 * D2 contract is paid identically: every row validated against the live mirror, ONE
 * BatchConfirmModal (DESIGN W1) the human approves per row, a TOCTOU re-check, ONE `applyGroups`
 * command, ONE undo step, an audit row per row. There is NO Jarvis-side pre-confirm: the
 * orchestrator gate IS the confirm, and asking twice would teach the human to click through.
 * The modal renders in the centre (its per-row checkboxes don't fit the panel act card); a
 * cancelled turn settles it all-denied through the tool-call ALS (requestConfirmBatch, P1-A).
 *
 * 🔒 Same injection posture as jarvisTools.ts: every arg is model output, so it is type-checked and
 * capped here, board and group references resolve against the LIVE model (ambiguity asks, never
 * guesses), and the orchestrator re-validates + sanitizes every row before the human sees it.
 */
import type { AppModel } from './appModel'
import type { JarvisToolDef, JarvisToolOutcome } from './jarvisTools'
import {
  MAX_GROUP_BATCH,
  MAX_GROUP_MEMBERS,
  type ContextsDigest,
  type GroupRowResult
} from './mcpGroups'
import { sanitizeGroupName } from '../shared/groupName'
import type { GroupEditOp } from '../shared/mcpTypes'

/** The orchestrator slice these tools drive (part of `JarvisCanvasFacet`). */
export interface JarvisGroupFacet {
  describeApp(): Promise<AppModel>
  describeContexts(): Promise<ContextsDigest>
  groupBoards(input: {
    groups: Array<{ name: string; boardIds: string[] }>
  }): Promise<GroupRowResult[]>
  editGroups(input: { ops: GroupEditOp[] }): Promise<GroupRowResult[]>
}

export interface JarvisGroupDeps {
  facet: JarvisGroupFacet
  /** jarvisTools' `resolveBoardRef`, injected so this module never value-imports its host. */
  resolveBoard: (model: AppModel, ref: string) => { id: string; title: string }
}

/** Arg caps — defensive; the orchestrator sanitizes + clamps names to `GROUP_NAME_MAX` itself. */
const MAX_ARG = 200

const BOARDS_ARG =
  'Board references: [id] prefixes from the Workspace list (8+ chars), full board ids, or exact board titles.'
const GROUP_ARG = 'A group reference: its [id] prefix from list_groups, or its exact name.'

export function buildJarvisGroupToolDefs(): JarvisToolDef[] {
  const boards = {
    type: 'array',
    items: { type: 'string' },
    maxItems: MAX_GROUP_MEMBERS,
    description: BOARDS_ARG
  }
  return [
    {
      name: 'list_groups',
      description:
        "Read the Named Groups (id, name, member boards) and the app's SUGGESTED groupings: clusters of related boards derived from preview wiring, orchestration cables, a shared port, data flow, a shared working directory, or similar titles, each with a name and a confidence. Read this before group_boards / edit_groups. Runs without confirmation.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'group_boards',
      description: `Create Named Groups: a named outline around a set of boards. Pass EVERY group the user asked for in ONE call (at most ${MAX_GROUP_BATCH}). The user approves them per group in one confirmation, and one undo removes them all. A board may be in more than one group. Requires user confirmation.`,
      input_schema: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            maxItems: MAX_GROUP_BATCH,
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, boards },
              required: ['name', 'boards'],
              additionalProperties: false
            }
          }
        },
        required: ['groups'],
        additionalProperties: false
      }
    },
    {
      name: 'edit_groups',
      description: `Change existing Named Groups: rename, add boards, remove boards, or ungroup (removes the outline only; the boards stay put). Pass EVERY change in ONE call (at most ${MAX_GROUP_BATCH}, applied in order). The user approves them per change in one confirmation, and one undo reverts them all. Requires user confirmation.`,
      input_schema: {
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            maxItems: MAX_GROUP_BATCH,
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: ['rename', 'add', 'remove', 'ungroup'] },
                group: { type: 'string', description: GROUP_ARG },
                name: { type: 'string', description: 'rename only: the new name.' },
                boards: { ...boards, description: `add / remove only. ${BOARDS_ARG}` }
              },
              required: ['op', 'group'],
              additionalProperties: false
            }
          }
        },
        required: ['ops'],
        additionalProperties: false
      }
    }
  ]
}

// ── arg validation (model output = untrusted input). Thrown errors become the tool_result via
// executeJarvisTool's catch — keep "denied" out of their text, that word means the human said no.
function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

function obj(v: unknown, at: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${at} must be an object`)
  }
  return v as Record<string, unknown>
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new Error(`"${key}" (string) is required`)
  }
  if (v.length > MAX_ARG) throw new Error(`"${key}" exceeds ${MAX_ARG} chars`)
  return v.trim()
}

function list(o: Record<string, unknown>, key: string, max: number): unknown[] {
  const v = o[key]
  if (!Array.isArray(v) || v.length === 0) throw new Error(`"${key}" (non-empty array) is required`)
  if (v.length > max) throw new Error(`"${key}" takes at most ${max} entries`)
  return v
}

/**
 * Resolve `boards` to unique board ids. `members` (remove only) lets a member that has since left
 * the canvas still be removed by its id or [id] prefix.
 */
function boardIds(
  o: Record<string, unknown>,
  model: AppModel,
  deps: JarvisGroupDeps,
  members?: string[]
): string[] {
  const ids = list(o, 'boards', MAX_GROUP_MEMBERS).map((ref, i) => {
    if (typeof ref !== 'string' || ref.trim().length === 0 || ref.length > MAX_ARG) {
      throw new Error(`boards[${i}] must be a board reference`)
    }
    const r = ref.trim()
    const member = members?.filter((id) => id === r || (r.length >= 6 && id.startsWith(r)))
    return member?.length === 1 ? member[0] : deps.resolveBoard(model, r).id
  })
  return [...new Set(ids)]
}

/** Resolve a group (id, [id] prefix ≥6, or exact name, case-insensitive); ambiguity asks. */
function resolveGroup(model: AppModel, ref: string): AppModel['canvas']['groups'][number] {
  const groups = model.canvas.groups
  const byId = groups.filter((g) => g.id === ref || (ref.length >= 6 && g.id.startsWith(ref)))
  const lower = ref.toLowerCase()
  const hits = byId.length > 0 ? byId : groups.filter((g) => g.name.trim().toLowerCase() === lower)
  if (hits.length === 0) throw new Error(`no group matches "${clip(ref, 40)}"`)
  if (hits.length > 1) {
    const names = hits
      .slice(0, 4)
      .map((g, i) => `${i + 1}. [${g.id.slice(0, 8)}] "${clip(g.name, 30)}"`)
      .join('  ')
    throw new Error(
      `"${clip(ref, 40)}" is ambiguous — candidates: ${names}. Read the numbered list to the ` +
        `user, ask which NUMBER, then retry with that group's [id] prefix.`
    )
  }
  return hits[0]
}

/** A group name as the human will see it in the confirm (the orchestrator applies the same). */
function shown(name: string): string {
  return sanitizeGroupName(name) || '(no usable name)'
}

const id8 = (id: string): string => id.slice(0, 8)

/** Fold the per-row results into ONE outcome; every row's status goes back to the model. */
function rowsOutcome(
  tool: string,
  labels: string[],
  results: GroupRowResult[],
  extra: (k: number) => Record<string, unknown>
): JarvisToolOutcome {
  const rows = results.map((r, k) => ({
    ...extra(k),
    status: r.status,
    ...(r.groupId ? { groupId: id8(r.groupId) } : {}),
    ...(r.detail ? { detail: clip(r.detail, 200) } : {})
  }))
  const count = (...s: string[]): number => results.filter((r) => s.includes(r.status)).length
  const landed = count('created', 'applied')
  const declined = count('denied')
  const rejected = count('rejected')
  const tally = [
    landed > 0 ? `${landed} done` : '',
    declined > 0 ? `${declined} declined` : '',
    rejected > 0 ? `${rejected} rejected` : ''
  ]
    .filter(Boolean)
    .join(', ')
  const summary = clip(`${tool} · ${labels.join(', ')} · ${tally}`, 140)
  if (landed === 0 && rejected === 0) {
    return { content: 'the user declined — nothing changed', isError: true, denied: true, summary }
  }
  return {
    content: clip(JSON.stringify({ rows }), 4000),
    isError: landed === 0,
    denied: false,
    summary
  }
}

/**
 * Execute a group tool, or return `null` when `name` is not one (the caller falls through to its
 * own unknown-tool refusal). Throws on a bad arg; executeJarvisTool turns that into the outcome.
 */
export async function executeJarvisGroupTool(
  name: string,
  input: Record<string, unknown>,
  deps: JarvisGroupDeps
): Promise<JarvisToolOutcome | null> {
  switch (name) {
    case 'list_groups': {
      const [model, digest] = await Promise.all([
        deps.facet.describeApp(),
        deps.facet.describeContexts()
      ])
      const groups = model.canvas.groups.slice(0, 30).map((g) => ({
        id: id8(g.id),
        name: clip(g.name, 60),
        boards: g.boardIds.slice(0, 20).map(id8)
      }))
      // A context that IS an existing group (nothing to add) is not a suggestion.
      const suggested = digest.contexts
        .filter((c) => !c.existingGroupId || (c.addBoardIds?.length ?? 0) > 0)
        .slice(0, 12)
        .map((c) => ({
          name: clip(c.suggestedName, 60),
          confidence: c.confidence,
          linkedBy: c.signals,
          boards: c.boardIds.slice(0, 20).map(id8),
          ...(c.existingGroupId
            ? { extendsGroup: id8(c.existingGroupId), add: (c.addBoardIds ?? []).map(id8) }
            : {})
        }))
      return {
        content: clip(
          JSON.stringify({ groups, suggested, ungrouped: digest.ungrouped.slice(0, 40).map(id8) }),
          4000
        ),
        isError: false,
        denied: false,
        summary: clip(`list_groups · ${groups.length} group(s), ${suggested.length} suggested`, 140)
      }
    }
    case 'group_boards': {
      const rows = list(input, 'groups', MAX_GROUP_BATCH)
      const model = await deps.facet.describeApp()
      const groups = rows.map((raw, i) => {
        const o = obj(raw, `groups[${i}]`)
        return { name: str(o, 'name'), boardIds: boardIds(o, model, deps) }
      })
      const results = await deps.facet.groupBoards({ groups })
      const names = groups.map((g) => shown(g.name))
      return rowsOutcome(
        name,
        names.map((n) => `"${n}"`),
        results,
        (k) => ({ name: names[k] ?? '' })
      )
    }
    case 'edit_groups': {
      const raw = list(input, 'ops', MAX_GROUP_BATCH)
      const model = await deps.facet.describeApp()
      const labels: string[] = []
      const ops = raw.map((r, i): GroupEditOp => {
        const o = obj(r, `ops[${i}]`)
        const group = resolveGroup(model, str(o, 'group'))
        const label = `"${shown(group.name)}"`
        const groupId = group.id
        switch (o.op) {
          case 'rename': {
            const next = str(o, 'name')
            labels.push(`${label} → "${shown(next)}"`)
            return { op: 'rename', groupId, name: next }
          }
          case 'add':
            labels.push(`+${label}`)
            return { op: 'add', groupId, boardIds: boardIds(o, model, deps) }
          case 'remove':
            labels.push(`−${label}`)
            return { op: 'remove', groupId, boardIds: boardIds(o, model, deps, group.boardIds) }
          case 'ungroup':
            labels.push(`ungroup ${label}`)
            return { op: 'ungroup', groupId }
          default:
            throw new Error(`ops[${i}].op must be rename | add | remove | ungroup`)
        }
      })
      const results = await deps.facet.editGroups({ ops })
      return rowsOutcome(name, labels, results, (k) => ({
        op: ops[k]?.op ?? '',
        group: labels[k] ?? ''
      }))
    }
    default:
      return null
  }
}
