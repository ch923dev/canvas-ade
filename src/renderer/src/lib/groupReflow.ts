/**
 * Pure geometry for "add a board to a group" — packing the member set into a tight cluster
 * (so the group border hugs them after a board joins) and hit-testing a point against group
 * boxes (the drag-onto-box drop target). No React / no store.
 */
import { tidyLayout, type TidyPlacement } from './tidyLayout'
import type { GroupBox } from './groupBoxes'

/** Board fields the packer reads (a structural subset — the store's Board satisfies it). */
type PackBoard = Parameters<typeof tidyLayout>[0][number]

/** Re-pack a group's members into a tight, non-overlapping cluster anchored at their current
 *  top-left. Thin wrapper over tidyLayout('smart') so links stay grouped. <2 members = []. */
export function packGroupMembers(members: readonly PackBoard[]): TidyPlacement[] {
  if (members.length < 2) return []
  return tidyLayout(members, { mode: 'smart' })
}

/** The id of the group box containing `pt` (world coords), preferring the most specific
 *  (highest depth, then smallest area) when nested — or null. Excludes ids in `exclude`. */
export function groupBoxAt(
  boxes: readonly Pick<GroupBox, 'id' | 'x' | 'y' | 'w' | 'h' | 'depth'>[],
  pt: { x: number; y: number },
  exclude: ReadonlySet<string> = new Set()
): string | null {
  let best: { id: string; depth: number; area: number } | null = null
  for (const b of boxes) {
    if (exclude.has(b.id)) continue
    if (pt.x < b.x || pt.x > b.x + b.w || pt.y < b.y || pt.y > b.y + b.h) continue
    const area = b.w * b.h
    if (!best || b.depth > best.depth || (b.depth === best.depth && area < best.area)) {
      best = { id: b.id, depth: b.depth, area }
    }
  }
  return best ? best.id : null
}
