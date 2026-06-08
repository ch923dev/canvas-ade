/**
 * Pure geometry for the group outline boxes (no React/DOM). Each group becomes one
 * world-space rect framing its member boards, expanded outward by a `pad`. When a board
 * belongs to multiple groups the boxes would overlap, so a box that is fully contained
 * within another group's bounds gets a higher `depth` and a smaller effective pad — the
 * boxes draw concentric (largest-outer), one accent, no per-group colour (DESIGN: one accent).
 *
 * Unit-tested in isolation; the GroupBoxLayer just renders what this returns.
 */
import type { Board, NamedGroup } from './boardSchema'
import { boardsBounds, type BoardRect, type Bounds } from './boardGeometry'

export interface GroupBox {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** Nesting depth (0 = outermost). Drives the concentric inset. */
  depth: number
}

export interface GroupBoxOpts {
  /** World-px the box extends beyond its member bounds at depth 0. */
  pad: number
  /** World-px the pad shrinks per nesting level so nested boxes sit visibly inside. */
  insetStep: number
}

/** True when bounds `a` is fully inside bounds `b` (used to order nesting). */
function contains(b: Bounds, a: Bounds): boolean {
  return a.minX >= b.minX && a.minY >= b.minY && a.maxX <= b.maxX && a.maxY <= b.maxY
}

function area(b: Bounds): number {
  return (b.maxX - b.minX) * (b.maxY - b.minY)
}

/**
 * Is `o` an OUTER box relative to `self` (so `self` nests one level deeper)?
 * `o` must geometrically contain `self`. Identical bounds mutually contain — that would
 * make both boxes depth-1 and overlap exactly instead of nesting, so break the tie by id:
 * the lexicographically-smaller id stays the outer box, the other nests inside it.
 */
function isOuter(
  o: { group: NamedGroup; bounds: Bounds },
  self: { group: NamedGroup; bounds: Bounds }
): boolean {
  if (o.group.id === self.group.id) return false
  if (!contains(o.bounds, self.bounds)) return false
  const ao = area(o.bounds)
  const as = area(self.bounds)
  // Strict containment implies ao > as; equal area + containment ⟺ identical bounds → tie-break.
  return ao > as || (ao === as && o.group.id < self.group.id)
}

export function computeGroupBoxes(
  groups: NamedGroup[],
  boards: BoardRect[],
  opts: GroupBoxOpts
): GroupBox[] {
  const byId = new Map(boards.map((b) => [b.id, b]))
  const resolved = groups
    .map((g) => {
      const rects = g.boardIds.map((id) => byId.get(id)).filter((b): b is BoardRect => !!b)
      const bb = rects.length ? boardsBounds(rects) : null
      return bb ? { group: g, bounds: bb } : null
    })
    .filter((r): r is { group: NamedGroup; bounds: Bounds } => !!r)

  return resolved.map((self) => {
    const { group, bounds } = self
    const depth = resolved.filter((o) => isOuter(o, self)).length
    const pad = Math.max(0, opts.pad - depth * opts.insetStep)
    return {
      id: group.id,
      name: group.name,
      x: bounds.minX - pad,
      y: bounds.minY - pad,
      w: bounds.maxX - bounds.minX + pad * 2,
      h: bounds.maxY - bounds.minY + pad * 2,
      depth
    }
  })
}

/**
 * The fitView maxZoom for a group: capped at 1 when ANY member is a raster board
 * (terminal/browser bitmap content blurs when upscaled past 100%), else the vector cap.
 * Generalizes the single-board focus rule in Canvas.focusBoard.
 */
export function groupFitMaxZoom(members: Board[], vectorMax: number): number {
  const anyRaster = members.some((b) => b.type === 'terminal' || b.type === 'browser')
  return anyRaster ? 1 : vectorMax
}
