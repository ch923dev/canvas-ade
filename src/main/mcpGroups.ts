import type { McpCommandAck } from './mcpCommand'
import type { ConfirmBatchItem } from './mcpConfirm'
import type { BoardRegistry, DispatchStatus } from './mcpRegistry'
import type { GroupEditOp } from '../shared/mcpTypes'
import {
  deriveContexts,
  GENERIC_BOARD_TITLES,
  type ContextConnectorInput,
  type ContextGroupInput,
  type ContextSignal,
  type DerivedContext
} from '../shared/deriveContexts'
import { sanitizeGroupName } from '../shared/groupName'
import { McpToolError } from './mcpToolError'

/**
 * 🔒 Spatial-awareness I1 — the agent's Named-Group surface: `canvas://contexts` (`describeContexts`),
 * `group_boards` (`groupBoards`) and `edit_groups` (`editGroups`), `@expanse-ade/mcp` ≥ 0.27.0 (SPEC
 * C5–C7). Factored OUT of `mcpOrchestrator.ts` (max-lines cap) and spread into `buildOrchestrator`,
 * the `createTidyMethod` / `createFindingsMethod` pattern. The package registers each surface only
 * when its method exists here, for the orchestrator, lead and connected tiers (never a worker).
 *
 * 🔒 D2: EVERY group write — every tier, the orchestrator included — is ONE batch human confirm
 * (`BatchConfirmModal`, one row per proposed group or op, DESIGN W1) → ONE `applyGroups` command
 * carrying only the approved rows → ONE undo step. Grouping draws outlines only: no board moves,
 * resizes or runs. Per row:
 *  - validated against the LIVE mirror first: unknown or docked board, unknown group, a name that
 *    sanitizes to nothing ⇒ `rejected` with a `detail`, and never shown to the human;
 *  - re-resolved AFTER the human answers (the board may have gone while the modal was open);
 *  - audited, whatever the outcome.
 * The result is a per-row array, positionally 1:1 with the input (the package serializes it).
 *
 * Low-confidence proposals (DESIGN W1) start UNCHECKED: a row's confidence is what C3
 * `deriveContexts` finds among that row's own boards — one linked context covering all of them ⇒ its
 * confidence; anything less ⇒ low. A hub (≥ 3 outgoing cables) links nothing, per C3 rule 4.
 *
 * Pure host module (no electron value import, type-only package import) — unit-tested directly.
 */

/** Rows per `group_boards` / `edit_groups` call (= the package's `MAX_GROUP_BATCH`, parity-pinned). */
export const MAX_GROUP_BATCH = 10
/** Boards per proposed group / per add-remove op (= the package's `MAX_GROUP_MEMBERS`). */
export const MAX_GROUP_MEMBERS = 50

export type GroupRowStatus = 'created' | 'applied' | 'denied' | 'rejected'
export interface GroupRowResult {
  status: GroupRowStatus
  groupId?: string
  detail?: string
}

/** `canvas://contexts` v1 (C6). */
export interface ContextsDigest {
  version: 1
  contexts: DerivedContext[]
  /** Canvas board ids (docked workers excluded) in no Named Group, sorted. */
  ungrouped: string[]
}

export interface GroupBoardsHostInput {
  groups: Array<{ name: string; boardIds: string[] }>
  /** 🔒 A lead / connected caller's token-derived board id (audit only — D2 gates every tier). */
  sourceBoardId?: string
}
export interface EditGroupsHostInput {
  ops: GroupEditOp[]
  sourceBoardId?: string
}

/** The registry seams the group methods read and write through. */
export type GroupsRegistry = Pick<
  BoardRegistry,
  'listBoards' | 'listConnectors' | 'sendCommand' | 'confirmBatch' | 'currentProjectDir'
>
export interface GroupsMethodOpts {
  /** The Named-Group mirror (`buildOrchestrator`'s shared projection). */
  listGroups: () => ContextGroupInput[]
  audit: (input: {
    type: string
    targetId: string
    prompt: string
    nonce: string
    status: DispatchStatus
    detail?: string
  }) => Promise<void>
  /** How cwd / file paths compare for the C3 signals. Default: case-sensitive on Linux only. */
  pathCase?: 'insensitive' | 'sensitive'
}

/** A mirror board. `cwd` rides the C1 mirror but is not on the registry's declared type. */
type MirrorBoard = ReturnType<BoardRegistry['listBoards']>[number] & { cwd?: string }

/** A row the human will see: its index in the input, the command payload, and its confirm row. */
interface Shown<T> {
  index: number
  payload: T
  item: ConfirmBatchItem
}
type Checked<T> = { ok: true; payload: T; item: ConfirmBatchItem } | { ok: false; error: string }

const TYPE_LABEL: Readonly<Record<string, string>> = {
  terminal: 'Terminal',
  browser: 'Browser',
  planning: 'Plan',
  file: 'File',
  kanban: 'Kanban',
  command: 'Command',
  dataflow: 'Data Flow',
  swarm: 'Swarm'
}
/** "linked by:" words per C3 signal, in C3's canonical signal order. Never a raw path. */
const SIGNAL_LABEL: Readonly<Record<ContextSignal, string>> = {
  group: 'existing group',
  preview: 'preview',
  orchestration: 'orchestration cable',
  port: 'port',
  dataflow: 'data flow',
  cwd: 'same folder',
  fileRef: 'file reference',
  title: 'similar titles'
}
const SIGNAL_ORDER = Object.keys(SIGNAL_LABEL) as ContextSignal[]
const AUDIT_STATUS: Readonly<Record<GroupRowStatus, DispatchStatus>> = {
  created: 'applied',
  applied: 'applied',
  denied: 'denied',
  rejected: 'rejected'
}
const CREATE_BLURB =
  'An agent proposes grouping these boards. Grouping only draws a named outline around them — ' +
  'nothing moves, nothing runs. All approved groups undo together with one Ctrl+Z.'
const EDIT_BLURB =
  'An agent proposes changing these groups. Only the named outlines change — no board moves, ' +
  'nothing runs. All approved changes undo together with one Ctrl+Z.'
const EMPTY_NAME = 'the name is empty once control and invisible characters are removed'
/**
 * Display clamp for a BOARD TITLE in a row's member summary (code points). Group names are never
 * clamped for display: the human approves a name, so they see all of it (sanitized, it is already
 * one line of at most GROUP_NAME_MAX).
 */
const TITLE_SHOWN_MAX = 40

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const boardCount = (n: number): string => plural(n, 'board')
/** An agent-supplied id echoed in a detail: bounded so a hostile id cannot flood the result. */
const clipId = (id: unknown): string => String(id).slice(0, 64)

/** A sanitized, single-line group name ('' when nothing visible is left). */
const nameOf = (raw: unknown): string => sanitizeGroupName(typeof raw === 'string' ? raw : '')
const quoted = (raw: unknown, fallback: string): string => {
  const name = nameOf(raw)
  return name ? `"${name}"` : fallback
}
/** A board title for the member summary: sanitized, then clamped to TITLE_SHOWN_MAX with "…". */
function shownTitle(raw: unknown): string {
  const points = [...nameOf(raw)]
  return points.length <= TITLE_SHOWN_MAX
    ? points.join('')
    : `${points.slice(0, TITLE_SHOWN_MAX - 1).join('')}…`
}

const isDocked = (b: MirrorBoard): boolean =>
  b.type === 'terminal' && typeof b.dockedIn === 'string' && b.dockedIn !== ''

/** W1 member summary: one entry per board type, `Terminal "title"` or `Terminal ×2`. */
function membersLine(ids: readonly string[], byId: ReadonlyMap<string, MirrorBoard>): string {
  const byType = new Map<string, MirrorBoard[]>()
  for (const id of ids) {
    const board = byId.get(id)
    if (!board) continue
    byType.set(board.type, [...(byType.get(board.type) ?? []), board])
  }
  const parts = [...byType].map(([type, boards]) => {
    const label = TYPE_LABEL[type] ?? 'Board'
    if (boards.length > 1) return `${label} ×${boards.length}`
    const title = shownTitle(boards[0].title)
    return title && !GENERIC_BOARD_TITLES.has(title.toLowerCase()) ? `${label} "${title}"` : label
  })
  return parts.length > 0 ? parts.join(' · ') : boardCount(ids.length)
}

/** Dedupe an id list and check the 1..MAX_GROUP_MEMBERS bound. */
function idList(raw: unknown): { ids: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: 'boardIds must list at least one board' }
  const ids = [...new Set(raw)]
  if (ids.length > MAX_GROUP_MEMBERS)
    return { error: `at most ${MAX_GROUP_MEMBERS} boards per row` }
  const bad = ids.find((id) => typeof id !== 'string' || id === '')
  return bad === undefined
    ? { ids: ids as string[] }
    : { error: `invalid board id: ${clipId(bad)}` }
}

/** Every id must be a board ON the canvas (a docked worker has no geometry to outline). */
function onCanvasError(
  ids: readonly string[],
  byId: ReadonlyMap<string, MirrorBoard>
): string | null {
  for (const id of ids) {
    const board = byId.get(id)
    if (!board) return `unknown board id: ${clipId(id)}`
    if (isDocked(board)) return `board ${clipId(id)} is docked in a swarm board, not on the canvas`
  }
  return null
}

/** The batch-shape check the package's zod schema already ran — repeated for a raw caller. */
function rowsOf(raw: unknown, tool: string, field: string): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GROUP_BATCH) {
    throw new McpToolError(
      'invalid_input',
      `${tool}: '${field}' must hold 1..${MAX_GROUP_BATCH} entries`
    )
  }
  return raw
}

export function createGroupsMethods(
  registry: GroupsRegistry,
  opts: GroupsMethodOpts
): {
  describeContexts(): Promise<ContextsDigest>
  groupBoards(input: GroupBoardsHostInput): Promise<GroupRowResult[]>
  editGroups(input: EditGroupsHostInput): Promise<GroupRowResult[]>
} {
  const pathCase = opts.pathCase ?? (process.platform === 'linux' ? 'sensitive' : 'insensitive')
  const snapshot = (): {
    byId: Map<string, MirrorBoard>
    groups: ContextGroupInput[]
    connectors: ContextConnectorInput[]
  } => ({
    byId: new Map((registry.listBoards() as MirrorBoard[]).map((b) => [b.id, b])),
    groups: opts.listGroups(),
    connectors: registry
      .listConnectors()
      .flatMap((c): ContextConnectorInput[] =>
        c.kind === 'preview' || c.kind === 'orchestration'
          ? [{ sourceId: c.sourceId, targetId: c.targetId, kind: c.kind }]
          : []
      )
  })
  const projectRoot = (): string | undefined => registry.currentProjectDir?.() ?? undefined

  /** W1 "linked by:" line + whether the row starts checked (low confidence ⇒ unchecked). */
  function linkOf(
    ids: readonly string[],
    snap: ReturnType<typeof snapshot>
  ): { line: string; preselected: boolean } {
    if (ids.length === 1) return { line: 'a single board', preselected: true }
    const inRow = new Set(ids)
    const found = deriveContexts(
      ids.map((id) => snap.byId.get(id)!),
      snap.connectors.filter((c) => inRow.has(c.sourceId) && inRow.has(c.targetId)),
      [],
      { projectRoot: projectRoot(), pathCase, titleSignal: true }
    )
    const signals = new Set(found.flatMap((c) => c.signals))
    const words = SIGNAL_ORDER.filter((s) => signals.has(s))
      .map((s) => SIGNAL_LABEL[s])
      .join(', ')
    const whole = found.length === 1 && found[0].boardIds.length === ids.length
    if (whole && found[0].confidence !== 'low')
      return { line: `linked by: ${words}`, preselected: true }
    if (whole) return { line: `linked by: ${words} (low confidence)`, preselected: false }
    return {
      line: words
        ? `linked by: ${words}, but not every board is linked (low confidence)`
        : 'no link between these boards was detected (low confidence)',
      preselected: false
    }
  }

  function checkCreate(
    row: unknown,
    snap: ReturnType<typeof snapshot>
  ): Checked<{ name: string; boardIds: string[] }> {
    if (row === null || typeof row !== 'object') return { ok: false, error: 'not a group object' }
    const { name: rawName, boardIds: rawIds } = row as { name?: unknown; boardIds?: unknown }
    const name = sanitizeGroupName(typeof rawName === 'string' ? rawName : '')
    if (!name) return { ok: false, error: EMPTY_NAME }
    const list = idList(rawIds)
    if ('error' in list) return { ok: false, error: list.error }
    const missing = onCanvasError(list.ids, snap.byId)
    if (missing) return { ok: false, error: missing }
    const link = linkOf(list.ids, snap)
    return {
      ok: true,
      payload: { name, boardIds: list.ids },
      item: {
        label: `${name} · ${boardCount(list.ids.length)}`,
        body: `${membersLine(list.ids, snap.byId)}\n${link.line}`,
        preselected: link.preselected
      }
    }
  }

  function checkEdit(raw: unknown, snap: ReturnType<typeof snapshot>): Checked<GroupEditOp> {
    if (raw === null || typeof raw !== 'object') return { ok: false, error: 'not an edit op' }
    const op = raw as { op?: unknown; groupId?: unknown; name?: unknown; boardIds?: unknown }
    const group = snap.groups.find((g) => g.id === op.groupId)
    if (!group) return { ok: false, error: `unknown group id: ${clipId(op.groupId)}` }
    const groupId = group.id
    const current = quoted(group.name, 'the unnamed group')
    const members = new Set(group.boardIds)
    switch (op.op) {
      case 'rename': {
        const name = sanitizeGroupName(typeof op.name === 'string' ? op.name : '')
        if (!name) return { ok: false, error: EMPTY_NAME }
        if (name === group.name) return { ok: false, error: `the group is already named "${name}"` }
        return {
          ok: true,
          payload: { op: 'rename', groupId, name },
          item: {
            label: `Rename ${current} → "${name}"`,
            body: membersLine(group.boardIds, snap.byId)
          }
        }
      }
      case 'add': {
        const list = idList(op.boardIds)
        if ('error' in list) return { ok: false, error: list.error }
        const missing = onCanvasError(list.ids, snap.byId)
        if (missing) return { ok: false, error: missing }
        const fresh = list.ids.filter((id) => !members.has(id))
        if (fresh.length === 0) return { ok: false, error: 'every board is already in the group' }
        return {
          ok: true,
          payload: { op: 'add', groupId, boardIds: fresh },
          item: {
            label: `Add ${boardCount(fresh.length)} to ${current}`,
            body: membersLine(fresh, snap.byId)
          }
        }
      }
      case 'remove': {
        const list = idList(op.boardIds)
        if ('error' in list) return { ok: false, error: list.error }
        const outsider = list.ids.find((id) => !members.has(id))
        if (outsider !== undefined)
          return { ok: false, error: `board ${clipId(outsider)} is not in the group` }
        // The ids are deduped members, so the same count means every member goes.
        const empties = list.ids.length === members.size
        return {
          ok: true,
          payload: { op: 'remove', groupId, boardIds: list.ids },
          item: {
            label: `Remove ${boardCount(list.ids.length)} from ${current}${empties ? ' (the group ends)' : ''}`,
            body: membersLine(list.ids, snap.byId)
          }
        }
      }
      case 'ungroup':
        return {
          ok: true,
          payload: { op: 'ungroup', groupId },
          item: {
            label: `Ungroup ${current} (boards stay put)`,
            body: membersLine(group.boardIds, snap.byId)
          }
        }
      default:
        return { ok: false, error: `unknown op: ${clipId(op.op)}` }
    }
  }

  /** W1 disclose: members already in other groups (multi-membership) + rows never shown. */
  function discloseFor(
    boardIds: readonly string[],
    snap: ReturnType<typeof snapshot>,
    hidden: number,
    noun: string
  ): string | undefined {
    const notes: string[] = []
    const already = new Set<string>()
    const names = new Set<string>()
    for (const g of snap.groups) {
      const overlap = g.boardIds.filter((id) => boardIds.includes(id))
      if (overlap.length === 0) continue
      overlap.forEach((id) => already.add(id))
      names.add(quoted(g.name, 'an unnamed group'))
    }
    if (already.size > 0) {
      const where = names.size === 1 ? [...names][0] : `other groups (${[...names].join(', ')})`
      notes.push(
        already.size === 1
          ? `1 board is already in ${where} and stays there too.`
          : `${already.size} boards are already in ${where} and stay there too.`
      )
    }
    if (hidden > 0) {
      notes.push(
        `${plural(hidden, `more proposed ${noun}`)} could not be used and ${hidden === 1 ? 'is' : 'are'} not shown.`
      )
    }
    return notes.length > 0 ? notes.join(' ') : undefined
  }

  /** ONE batch confirm; fail-closed (no confirm seam / short reply ⇒ that row is denied). */
  async function decide(
    title: string,
    blurb: string,
    items: ConfirmBatchItem[],
    disclose?: string
  ): Promise<boolean[]> {
    if (items.length === 0) return []
    const decision = registry.confirmBatch
      ? await registry.confirmBatch({ title, blurb, items, ...(disclose ? { disclose } : {}) })
      : null
    return items.map((_, k) => decision?.decisions?.[k]?.approved === true)
  }

  /** The command channel never throws to the caller: a throw reads as a failed ack. */
  async function send(
    create: GroupBoardsHostInput['groups'],
    edits: GroupEditOp[]
  ): Promise<McpCommandAck> {
    try {
      return await registry.sendCommand({ type: 'applyGroups', create, edits })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // BUG-008 discipline (mcpFindings): an audit append that fails AFTER the groups landed must not
  // turn a real write into a thrown error — the agent would retry and group the boards twice.
  async function record(
    type: string,
    targetId: string,
    status: DispatchStatus,
    detail: string
  ): Promise<void> {
    try {
      await opts.audit({ type, targetId, prompt: '', nonce: '', status, detail })
    } catch (err) {
      console.error(
        `[mcp-audit] ${type}: row audit append failed; forensic gap (not re-thrown)`,
        err
      )
    }
  }

  /** Validate → ONE confirm → re-resolve the approved rows → (caller sends) — shared by both tools. */
  async function gate<T>(
    rows: unknown[],
    check: (row: unknown, snap: ReturnType<typeof snapshot>) => Checked<T>,
    ask: (shownRows: Array<Shown<T>>, snap: ReturnType<typeof snapshot>) => Promise<boolean[]>
  ): Promise<{ results: GroupRowResult[]; approved: Array<Shown<T>> }> {
    const snap = snapshot()
    const results: GroupRowResult[] = rows.map(() => ({ status: 'rejected' }))
    const visible: Array<Shown<T>> = []
    rows.forEach((row, index) => {
      const c = check(row, snap)
      if (c.ok) visible.push({ index, payload: c.payload, item: c.item })
      else results[index] = { status: 'rejected', detail: c.error }
    })
    const yes = await ask(visible, snap)
    // TOCTOU: the human may have taken minutes. Re-check each approved row against the canvas NOW.
    const after = snapshot()
    const approved: Array<Shown<T>> = []
    visible.forEach((row, k) => {
      if (!yes[k]) {
        results[row.index] = { status: 'denied' }
        return
      }
      const again = check(rows[row.index], after)
      if (again.ok) approved.push({ ...row, payload: again.payload })
      else
        results[row.index] = {
          status: 'rejected',
          detail: `the canvas changed while the confirm was open: ${again.error}`
        }
    })
    return { results, approved }
  }

  const caller = (sourceBoardId: unknown): string =>
    typeof sourceBoardId === 'string' ? `by=${clipId(sourceBoardId)}` : 'by=orchestrator'

  return {
    async describeContexts() {
      // Read-only (C6): C3 over the live mirror. deriveContexts caps at MAX_CONTEXTS itself.
      const snap = snapshot()
      const boards = [...snap.byId.values()]
      const contexts = deriveContexts(boards, snap.connectors, snap.groups, {
        projectRoot: projectRoot(),
        pathCase
      })
      const grouped = new Set(snap.groups.flatMap((g) => g.boardIds))
      const ungrouped = boards
        .filter((b) => !isDocked(b) && !grouped.has(b.id))
        .map((b) => b.id)
        .sort()
      return { version: 1, contexts, ungrouped }
    },

    async groupBoards(input) {
      const rows = rowsOf(input?.groups, 'group_boards', 'groups')
      const { results, approved } = await gate(rows, checkCreate, (visible, snap) => {
        const n = visible.length
        return decide(
          `Group ${plural(n, 'set')} of boards`,
          CREATE_BLURB,
          visible.map((v) => v.item),
          discloseFor(
            visible.flatMap((v) => v.payload.boardIds),
            snap,
            rows.length - n,
            'group'
          )
        )
      })
      const failed = new Set<number>()
      if (approved.length > 0) {
        const ack = await send(
          approved.map((a) => a.payload),
          []
        )
        approved.forEach((a, k) => {
          const groupId = ack.ok ? ack.groupIds?.[k] : undefined
          if (ack.ok) {
            results[a.index] =
              typeof groupId === 'string' ? { status: 'created', groupId } : { status: 'created' }
          } else {
            failed.add(a.index)
            results[a.index] = {
              status: 'rejected',
              detail: `the canvas did not apply it: ${ack.error}`
            }
          }
        })
      }
      for (const [i, r] of results.entries()) {
        const row = rows[i] as { name?: unknown; boardIds?: unknown } | null
        const what = `name=${JSON.stringify(nameOf(row?.name))} boards=${Array.isArray(row?.boardIds) ? row.boardIds.map(clipId).join(',') : '?'}`
        await record(
          'group_boards',
          r.groupId ?? '',
          failed.has(i) ? 'failed' : AUDIT_STATUS[r.status],
          [what, caller(input.sourceBoardId), r.detail].filter(Boolean).join(' · ')
        )
      }
      return results
    },

    async editGroups(input) {
      const rows = rowsOf(input?.ops, 'edit_groups', 'ops')
      const { results, approved } = await gate(rows, checkEdit, (visible, snap) => {
        const n = visible.length
        const touched = visible.flatMap((v) =>
          'boardIds' in v.payload && v.payload.op === 'add' ? v.payload.boardIds : []
        )
        return decide(
          `Edit groups · ${plural(n, 'change')}`,
          EDIT_BLURB,
          visible.map((v) => v.item),
          discloseFor(touched, snap, rows.length - n, 'change')
        )
      })
      // The approved ops apply IN ORDER: one that follows an approved ungroup (or a remove that
      // emptied the group) has nothing left to act on — reject it rather than send a doomed op.
      const live = new Map(snapshot().groups.map((g) => [g.id, new Set(g.boardIds)]))
      const sendable: Array<Shown<GroupEditOp>> = []
      for (const a of approved) {
        const members = live.get(a.payload.groupId)
        if (!members) {
          results[a.index] = {
            status: 'rejected',
            detail: 'an earlier change in this batch removed the group'
          }
          continue
        }
        if (a.payload.op === 'add') a.payload.boardIds.forEach((id) => members.add(id))
        if (a.payload.op === 'remove') a.payload.boardIds.forEach((id) => members.delete(id))
        if (a.payload.op === 'ungroup' || members.size === 0) live.delete(a.payload.groupId)
        sendable.push(a)
      }
      const failed = new Set<number>()
      if (sendable.length > 0) {
        const ack = await send(
          [],
          sendable.map((a) => a.payload)
        )
        for (const a of sendable) {
          if (ack.ok) results[a.index] = { status: 'applied' }
          else {
            failed.add(a.index)
            results[a.index] = {
              status: 'rejected',
              detail: `the canvas did not apply it: ${ack.error}`
            }
          }
        }
      }
      for (const [i, r] of results.entries()) {
        const op = rows[i] as {
          op?: unknown
          groupId?: unknown
          name?: unknown
          boardIds?: unknown
        } | null
        const what = [
          `op=${clipId(op?.op)}`,
          op?.name !== undefined ? `name=${JSON.stringify(nameOf(op.name))}` : '',
          Array.isArray(op?.boardIds) ? `boards=${op.boardIds.map(clipId).join(',')}` : ''
        ]
          .filter(Boolean)
          .join(' ')
        await record(
          'edit_groups',
          typeof op?.groupId === 'string' ? clipId(op.groupId) : '',
          failed.has(i) ? 'failed' : AUDIT_STATUS[r.status],
          [what, caller(input.sourceBoardId), r.detail].filter(Boolean).join(' · ')
        )
      }
      return results
    }
  }
}
