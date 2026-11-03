/**
 * Named-group load validation + reconcile, extracted verbatim from boardSchema (max-lines ratchet
 * at the v24 workspaces bump — the kanbanSchema / swarmBoardSchema precedent). Guards are INJECTED
 * and the back-reference to boardSchema is type-only, so this leaf never imports back at runtime.
 */
import type { CanvasDoc, NamedGroup } from './boardSchema'

/** Validate one group (id/name strings + a string[] boardIds); throws on mismatch. */
function assertGroup(
  g: unknown,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>
): void {
  if (!isRecord(g)) fail('group is not an object')
  if (typeof g.id !== 'string') fail('group has a non-string id')
  if (typeof g.name !== 'string') fail('group has a non-string name')
  if (!Array.isArray(g.boardIds)) fail('group boardIds is not an array')
  for (const bid of g.boardIds as unknown[]) {
    if (typeof bid !== 'string') fail('group boardIds contains a non-string entry')
  }
}

/**
 * Reconcile a migrated doc's groups: validates each group, then prunes dangling
 * boardIds (pointing at boards that no longer exist) AND de-duplicates — `boardIds`
 * is set-semantic (a board either belongs or it doesn't), matching the store's
 * `addBoardsToGroup` write-path dedup. Any group left with ZERO members is dropped —
 * empty groups never persist (a group whose boards were all deleted is gone, matching
 * the live delete-sweep in pruneBoardFromGroups; reverses the old named-empty-survives
 * rule). Missing `groups` field (pre-migration or stripped) defaults to `[]`.
 */
export function reconcileGroups(
  doc: CanvasDoc,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>
): NamedGroup[] {
  const raw = Array.isArray(doc.groups) ? doc.groups : []
  raw.forEach((g) => assertGroup(g, fail, isRecord))
  const ids = new Set(doc.boards.map((b) => b.id))
  return (raw as NamedGroup[])
    .map((g) => ({ ...g, boardIds: [...new Set(g.boardIds.filter((bid) => ids.has(bid)))] }))
    .filter((g) => g.boardIds.length > 0)
}
