/**
 * Group slice — the 8 named-group actions extracted from canvasStore via DI seam.
 *
 * HISTORY INVARIANT (read before touching):
 *   Every action here passes `reflectPresent: false` → NONE of them touch `lastRecorded`.
 *   `lastRecorded` and `trackedChange` are OWNED by canvasStore; this slice receives
 *   `trackedChange` by reference and MUST NOT copy, re-implement, or move it. The
 *   `reflectPresent: false` flag keeps these group ops granularly undoable (same contract
 *   as add/remove/duplicate board); their post-no-op phantom step is the same tolerated
 *   edge (#BUG M3).
 */
import type { NamedGroup } from '../../lib/boardSchema'
import type { GroupEditOp } from '../../../../shared/mcpTypes'
import type { CanvasState } from '../canvasStore'
import type { SetCanvasState, GetCanvasState, SliceDeps } from './sliceTypes'

/**
 * Strip `boardId` from every group's membership, then DROP any group left with zero members
 * (empty groups never persist — deleting a group's last board deletes the group too). Returns a
 * NEW groups array on change, or `null` when the board belongs to no group — null lets callers
 * keep the EXISTING groups ref (`prune(...) ?? s.groups`), which trackedChange's same-ref no-op
 * path depends on. Shared by canvasStore.removeBoard (the delete sweep) and
 * groupSlice.removeBoardFromAllGroups.
 */
export function pruneBoardFromGroups(groups: NamedGroup[], boardId: string): NamedGroup[] | null {
  if (!groups.some((g) => g.boardIds.includes(boardId))) return null
  return groups
    .map((g) =>
      g.boardIds.includes(boardId) ? { ...g, boardIds: g.boardIds.filter((b) => b !== boardId) } : g
    )
    .filter((g) => g.boardIds.length > 0)
}

/**
 * The batch group write behind the MCP `applyGroups` command (spatial C5): create new groups, then
 * apply edit ops IN ORDER, as ONE tracked step. Returns the new group ids, 1:1 with `create`.
 */
export type ApplyGroupOps = (
  create: ReadonlyArray<{ name: string; boardIds: readonly string[] }>,
  edits: readonly GroupEditOp[]
) => string[]

/**
 * Pure fold behind {@link ApplyGroupOps}: append `created`, then apply each edit op in order. An op
 * on a group that no longer exists (an earlier op removed it) is skipped; `remove` that empties a
 * group drops it (empty groups never persist). Returns the INPUT ref when nothing changed, so the
 * caller's trackedChange no-op path holds. Callers validate ids and names first (the MCP applier).
 */
export function foldGroupOps(
  groups: NamedGroup[],
  created: NamedGroup[],
  edits: readonly GroupEditOp[]
): NamedGroup[] {
  let next = created.length > 0 ? [...groups, ...created] : groups
  const patch = (id: string, change: Partial<NamedGroup>): void => {
    next = next.map((g) => (g.id === id ? { ...g, ...change } : g))
  }
  for (const op of edits) {
    const g = next.find((x) => x.id === op.groupId)
    if (!g) continue
    switch (op.op) {
      case 'rename':
        if (g.name !== op.name) patch(g.id, { name: op.name })
        break
      case 'add': {
        const merged = [...new Set([...g.boardIds, ...op.boardIds])]
        if (merged.length !== g.boardIds.length) patch(g.id, { boardIds: merged })
        break
      }
      case 'remove': {
        const drop = new Set(op.boardIds)
        const kept = g.boardIds.filter((b) => !drop.has(b))
        if (kept.length === g.boardIds.length) break
        if (kept.length === 0) next = next.filter((x) => x.id !== g.id)
        else patch(g.id, { boardIds: kept })
        break
      }
      case 'ungroup':
        next = next.filter((x) => x.id !== g.id)
        break
    }
  }
  return next
}

export function createGroupSlice(
  set: SetCanvasState,
  _get: GetCanvasState,
  deps: SliceDeps
): Pick<
  CanvasState,
  | 'addGroup'
  | 'removeGroup'
  | 'renameGroup'
  | 'addBoardsToGroup'
  | 'addBoardsToGroupReflowed'
  | 'removeBoardFromGroup'
  | 'removeBoardFromAllGroups'
  | 'applyGroupOps'
> {
  const { trackedChange, newId } = deps

  return {
    addGroup: (name, boardIds) => {
      const id = newId()
      const group: NamedGroup = { id, name, boardIds: [...new Set(boardIds)] }
      set((s) => trackedChange(s, { groups: [...s.groups, group] }, { reflectPresent: false }))
      return id
    },
    removeGroup: (id) =>
      set((s) => {
        if (!s.groups.some((g) => g.id === id)) return s
        return trackedChange(
          s,
          { groups: s.groups.filter((g) => g.id !== id) },
          { reflectPresent: false }
        )
      }),
    renameGroup: (id, name) =>
      set((s) => {
        const g = s.groups.find((x) => x.id === id)
        if (!g || g.name === name) return s
        return trackedChange(
          s,
          { groups: s.groups.map((x) => (x.id === id ? { ...x, name } : x)) },
          { reflectPresent: false }
        )
      }),
    addBoardsToGroup: (id, boardIds) =>
      set((s) => {
        const g = s.groups.find((x) => x.id === id)
        if (!g) return s
        const merged = [...new Set([...g.boardIds, ...boardIds])]
        // Same length after Set-union ↔ all boardIds were already members — nothing to do.
        if (merged.length === g.boardIds.length) return s
        return trackedChange(
          s,
          { groups: s.groups.map((x) => (x.id === id ? { ...x, boardIds: merged } : x)) },
          { reflectPresent: false }
        )
      }),
    addBoardsToGroupReflowed: (id, boardIds, placements) =>
      set((s) => {
        const g = s.groups.find((x) => x.id === id)
        if (!g) return s
        const mergedIds = [...new Set([...g.boardIds, ...boardIds])]
        const membershipChanged = mergedIds.length !== g.boardIds.length
        // Only ever reposition the group's OWN members in this step — guard against a caller
        // passing a placement for a non-member (the re-pack must not move unrelated boards).
        const memberSet = new Set(mergedIds)
        const pos = new Map(placements.filter((p) => memberSet.has(p.id)).map((p) => [p.id, p]))
        let movedAny = false
        const nextBoards = s.boards.map((b) => {
          const p = pos.get(b.id)
          if (p && (p.x !== b.x || p.y !== b.y)) {
            movedAny = true
            return { ...b, x: p.x, y: p.y }
          }
          return b
        })
        // No-op guard (mirrors addBoardsToGroup): if neither membership nor any position
        // changed, push nothing — keep refs stable so trackedChange's no-op path holds.
        if (!membershipChanged && !movedAny) return s
        const nextGroups = membershipChanged
          ? s.groups.map((x) => (x.id === id ? { ...x, boardIds: mergedIds } : x))
          : s.groups
        // One tracked step covers membership + the re-pack so a single undo restores both.
        // reflectPresent:false matches the other group ops — the absorb stays granularly
        // undoable; its post-no-op phantom is the same tolerated edge (#BUG M3).
        return trackedChange(
          s,
          { boards: nextBoards, groups: nextGroups },
          { reflectPresent: false }
        )
      }),
    removeBoardFromGroup: (id, boardId) =>
      set((s) => {
        const g = s.groups.find((x) => x.id === id)
        if (!g || !g.boardIds.includes(boardId)) return s
        const nextIds = g.boardIds.filter((b) => b !== boardId)
        // Removing the LAST member empties the group → drop it entirely (empty groups never
        // persist). Otherwise rewrite just this group's membership. One tracked step either way.
        const groups =
          nextIds.length === 0
            ? s.groups.filter((x) => x.id !== id)
            : s.groups.map((x) => (x.id === id ? { ...x, boardIds: nextIds } : x))
        return trackedChange(s, { groups }, { reflectPresent: false })
      }),
    removeBoardFromAllGroups: (boardId) =>
      set((s) => {
        // No-op (keep refs stable) when the board belongs to no group — same guard discipline as
        // removeBoard's sweep, so a "remove from group" on an ungrouped board can't push a step.
        const next = pruneBoardFromGroups(s.groups, boardId)
        if (next === null) return s
        return trackedChange(s, { groups: next }, { reflectPresent: false })
      }),
    applyGroupOps: (create, edits) => {
      // Mint outside `set` (like addGroup) so the ids can be returned to the caller.
      const ids = create.map(() => newId())
      const created = create.map((c, i) => ({
        id: ids[i],
        name: c.name,
        boardIds: [...new Set(c.boardIds)]
      }))
      set((s) => {
        const groups = foldGroupOps(s.groups, created, edits)
        if (groups === s.groups) return s
        // ONE tracked step for every approved row, so one undo reverts the whole batch.
        return trackedChange(s, { groups }, { reflectPresent: false })
      })
      return ids
    }
  }
}
