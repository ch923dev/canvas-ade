/**
 * Apply the MCP `applyGroups` command (spatial-awareness C5, I1): the APPROVED rows of ONE
 * `group_boards` / `edit_groups` batch confirm, landed through `canvasStore.applyGroupOps` as ONE undo
 * step. Routed here from `spatialMcpApply` (the `kanbanMcpApply` pattern) so the groups case stays
 * out of the tidy lane's file.
 *
 * Same contract as every applier case: React-free (unit-testable directly), MAIN is the trust
 * boundary (it validated, sanitized and human-confirmed every row), and the command is RE-VALIDATED
 * here as defense in depth. It is ALL-OR-NOTHING: one bad name, one unknown or docked board, one
 * edit on a group that is gone ⇒ `{ok:false}` and the canvas is untouched — MAIN reports every
 * approved row as rejected rather than half a batch landing under one undo step.
 */
import { useCanvasStore } from './canvasStore'
import { isDockedTerminal } from '../lib/boardSchema'
import { sanitizeGroupName } from '../../../shared/groupName'
import type { McpCommand, McpCommandAck } from '../../../shared/mcpTypes'

type ApplyGroupsCommand = Extract<McpCommand, { type: 'applyGroups' }>

export function applyGroupsCommand(command: ApplyGroupsCommand): McpCommandAck {
  const { create, edits } = command
  if (!Array.isArray(create) || !Array.isArray(edits)) {
    return { ok: false, error: 'applyGroups: create and edits must be arrays' }
  }
  if (create.length === 0 && edits.length === 0) {
    return { ok: false, error: 'applyGroups: nothing to apply' }
  }
  const store = useCanvasStore.getState()
  const live = new Map(store.boards.map((b) => [b.id, b]))
  // A group member must be ON the canvas: a docked worker has no canvas geometry to outline.
  const onCanvas = (id: unknown): boolean => {
    const board = typeof id === 'string' ? live.get(id) : undefined
    return board !== undefined && !isDockedTerminal(board)
  }
  const isId = (id: unknown): boolean => typeof id === 'string' && id.length > 0
  const idList = (ids: unknown, ok: (id: unknown) => boolean): ids is string[] =>
    Array.isArray(ids) && ids.length > 0 && ids.every(ok)
  // MAIN already sanitized the name; anything the shared sanitizer would still change was tampered.
  const cleanName = (name: unknown): name is string =>
    typeof name === 'string' && name.length > 0 && sanitizeGroupName(name) === name

  for (const [i, row] of create.entries()) {
    if (row === null || typeof row !== 'object' || !cleanName(row.name)) {
      return { ok: false, error: `applyGroups: invalid group name in create[${i}]` }
    }
    if (!idList(row.boardIds, onCanvas)) {
      return { ok: false, error: `applyGroups: unknown or docked board in create[${i}]` }
    }
  }
  // Edits fold IN ORDER (as applyGroupOps applies them), so an op after an ungroup of the same
  // group — or after a remove that emptied it — finds no group and the command is refused.
  const members = new Map(store.groups.map((g) => [g.id, new Set(g.boardIds)]))
  for (const [i, op] of edits.entries()) {
    const bad: McpCommandAck = { ok: false, error: `applyGroups: invalid edits[${i}]` }
    const group =
      op !== null && typeof op === 'object' && typeof op.groupId === 'string'
        ? members.get(op.groupId)
        : undefined
    if (!group) return { ok: false, error: `applyGroups: unknown group in edits[${i}]` }
    switch (op.op) {
      case 'rename':
        if (!cleanName(op.name)) return bad
        break
      case 'add':
        if (!idList(op.boardIds, onCanvas)) return bad
        for (const id of op.boardIds) group.add(id)
        break
      case 'remove':
        // Removing a docked or since-deleted board from a group is a cleanup — any id is fine.
        if (!idList(op.boardIds, isId)) return bad
        for (const id of op.boardIds) group.delete(id)
        if (group.size === 0) members.delete(op.groupId)
        break
      case 'ungroup':
        members.delete(op.groupId)
        break
      default:
        return bad
    }
  }
  const groupIds = store.applyGroupOps(create, edits)
  return { ok: true, type: 'applyGroups', groupIds }
}
