/**
 * 🔒 P1b canvas-awareness digest — a PURE, host-computed summary of the canvas's SPATIAL layout, so
 * an orchestrator agent reasons over STRUCTURE (bounding box · overlaps · rows/columns · a coarse
 * arrangement) instead of raw per-board coordinates. This is the "smart grid" fuel: the agent reads
 * it to decide whether to tidy, which orientation to propose, and where a new plan/Kanban should land
 * in open space.
 *
 * Served (P1b wiring) as the orchestrator-tier `canvas://layout` MCP resource via
 * `Orchestrator.describeLayout()`, which wraps this builder over the injected board/group mirror —
 * exactly the `buildAppModel` pattern. PURE (no electron / @expanse-ade/mcp imports): it takes the
 * live data and returns a plain object, so it unit-tests in isolation and carries no runtime coupling.
 */

/** A board as the digest reads it — geometry is optional (a pre-P1 board / a non-placed stub omits it). */
export interface LayoutBoardInput {
  id: string
  type: string
  x?: number
  y?: number
  w?: number
  h?: number
}

/** A Named Group (feature zone) the digest joins onto each board as `groupId`. */
export interface LayoutGroupInput {
  id: string
  name: string
  boardIds: string[]
}

/** A placed board in the digest — geometry is guaranteed finite (unplaced boards are dropped). */
export interface LayoutBoard {
  id: string
  type: string
  x: number
  y: number
  w: number
  h: number
  /** The FIRST Named Group this board belongs to (a board may be in several); absent when ungrouped. */
  groupId?: string
}

/**
 * A coarse read of how the placed boards currently sit, so the agent can pick a tidy orientation:
 * `row` = one horizontal band (side by side) · `column` = one vertical stack · `grid` = multiple
 * rows AND columns, non-overlapping · `scattered` = overlapping or irregular · `single`/`empty` = <2.
 */
export type LayoutArrangement = 'empty' | 'single' | 'row' | 'column' | 'grid' | 'scattered'

/** The read-only spatial digest served as `canvas://layout`. */
export interface LayoutDigest {
  version: 1
  /** Number of boards carrying finite geometry (the only ones the digest can place). */
  count: number
  /** Union bounding box of all placed boards (world px); null when none are placed. */
  bbox: { x: number; y: number; w: number; h: number } | null
  /** Placed boards, in input order, each with finite geometry + optional group membership. */
  boards: LayoutBoard[]
  /** Board-id pairs whose rectangles overlap (a tidy trigger). Each unordered pair once, `a`<`b`. */
  overlaps: Array<{ a: string; b: string }>
  /** How the placed boards currently sit — the orientation hint for a tidy/visualize proposal. */
  arrangement: LayoutArrangement
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Two rectangles overlap iff they intersect on BOTH axes (touching edges do NOT count). */
function rectsOverlap(a: LayoutBoard, b: LayoutBoard): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Do two boards share a horizontal band (their y-intervals intersect)? → same ROW. */
function sameRow(a: LayoutBoard, b: LayoutBoard): boolean {
  return a.y < b.y + b.h && b.y < a.y + a.h
}

/** Do two boards share a vertical band (their x-intervals intersect)? → same COLUMN. */
function sameColumn(a: LayoutBoard, b: LayoutBoard): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w
}

/**
 * Count connected components over the graph where an edge joins any pair for which `connected` is
 * true. Interval overlap is NOT transitive (A–B overlap, B–C overlap, A–C may not), so this uses
 * union-find rather than a sort — three staggered-but-chained boards are correctly ONE cluster.
 */
function componentCount(
  boards: LayoutBoard[],
  connected: (a: LayoutBoard, b: LayoutBoard) => boolean
): number {
  const parent = boards.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]] // path halving
      i = parent[i]
    }
    return i
  }
  const union = (i: number, j: number): void => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      if (connected(boards[i], boards[j])) union(i, j)
    }
  }
  const roots = new Set<number>()
  for (let i = 0; i < boards.length; i++) roots.add(find(i))
  return roots.size
}

/** Classify the arrangement of the placed boards (see {@link LayoutArrangement}). */
function classify(boards: LayoutBoard[], hasOverlap: boolean): LayoutArrangement {
  if (boards.length === 0) return 'empty'
  if (boards.length === 1) return 'single'
  // Any overlap → not a clean row/column/grid; the agent should tidy.
  if (hasOverlap) return 'scattered'
  const rows = componentCount(boards, sameRow)
  const columns = componentCount(boards, sameColumn)
  if (rows === 1) return 'row' // one horizontal band → boards sit side by side
  if (columns === 1) return 'column' // one vertical band → boards are stacked
  if (rows > 1 && columns > 1) return 'grid'
  return 'scattered'
}

/**
 * Build the {@link LayoutDigest} from the live board + group mirrors. Boards without finite geometry
 * are dropped (they can't be placed); everything else is derived deterministically. Pure — safe to
 * call on every `canvas://layout` read.
 */
export function buildLayoutDigest(
  boardsInput: readonly LayoutBoardInput[],
  groups: readonly LayoutGroupInput[] = []
): LayoutDigest {
  // groupId = the FIRST group (input order) whose membership includes the board.
  const groupOf = (id: string): string | undefined =>
    groups.find((g) => g.boardIds.includes(id))?.id

  const boards: LayoutBoard[] = []
  for (const b of boardsInput) {
    if (!isFiniteNum(b.x) || !isFiniteNum(b.y) || !isFiniteNum(b.w) || !isFiniteNum(b.h)) continue
    const gid = groupOf(b.id)
    boards.push({
      id: b.id,
      type: b.type,
      x: b.x,
      y: b.y,
      w: b.w,
      h: b.h,
      ...(gid ? { groupId: gid } : {})
    })
  }

  // Union bounding box (null when nothing is placed).
  let bbox: LayoutDigest['bbox'] = null
  if (boards.length > 0) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const b of boards) {
      if (b.x < minX) minX = b.x
      if (b.y < minY) minY = b.y
      if (b.x + b.w > maxX) maxX = b.x + b.w
      if (b.y + b.h > maxY) maxY = b.y + b.h
    }
    bbox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }

  // Overlapping pairs (each unordered pair once, `a` < `b` for a stable, dedup-friendly shape).
  const overlaps: Array<{ a: string; b: string }> = []
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      if (rectsOverlap(boards[i], boards[j])) {
        const [a, b] =
          boards[i].id < boards[j].id ? [boards[i].id, boards[j].id] : [boards[j].id, boards[i].id]
        overlaps.push({ a, b })
      }
    }
  }

  return {
    version: 1,
    count: boards.length,
    bbox,
    boards,
    overlaps,
    arrangement: classify(boards, overlaps.length > 0)
  }
}
