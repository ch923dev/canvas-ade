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
 *
 * Version 2 (spatial awareness C2) is ADDITIVE — every v1 field stays: per-board `groupIds` (every
 * group, G8) + `onScreen`, the Named Groups with their bboxes, the user's `screen` (the C1 view +
 * the MAIN-side display) and `fit` (the zoom at which everything fits the pane, and whether that is
 * still readable). Without a view, `screen` and `fit.zoomToFitAll` are null and nothing is on screen.
 * C9 (L11) adds each placed board's `role` (`boardRoles.deriveRoles`) — lead, agent, preview, server,
 * … — from the mirror's classified signals, the preview/orchestration connectors and MAIN's own lead
 * designation (`leadAuthority`; never the renderer's).
 */
import { READABLE_ZOOM, fitZoom, rectsIntersect, type Rect } from '../shared/spatialGeometry'
import type { BoardContextFields, CanvasView, DisplayInfo } from '../shared/spatialTypes'
import { deriveRoles, type BoardRole, type RoleBoardInput } from '../shared/boardRoles'

/**
 * A board as the digest reads it — geometry is optional (a pre-P1 board / a non-placed stub omits it).
 * The C9 role signals (mirror-sanitized classifications, D9) are optional: absent ⇒ no signal.
 */
export interface LayoutBoardInput extends Pick<
  BoardContextFields,
  'previewSourceId' | 'sourceBoardId' | 'agent' | 'ports' | 'callsPorts' | 'lastFocusedAt'
> {
  id: string
  type: string
  x?: number
  y?: number
  w?: number
  h?: number
  /** A worker terminal docked in a swarm board (C1 mirror) — NOT canvas geometry: its x/y are stale
   *  parking coordinates, so it is never placed (the tidy / C3 / C4 rule). */
  dockedIn?: string
}

/** A mirrored connector (C9 input). Only `preview` / `orchestration` edges carry role links. */
export interface LayoutConnectorInput {
  sourceId: string
  targetId: string
  kind: string
}

/** The role inputs beyond the boards (C9): the connector graph + MAIN's designated lead board. */
export interface LayoutRoleInput {
  connectors?: readonly LayoutConnectorInput[]
  /** MAIN's lead authority (`leadAuthority.designated()`) — never taken from the renderer. */
  leadBoardId?: string | null
}

/** The user's view the digest projects (C2): the sanitized C1 `view` + MAIN's display (both optional). */
export interface LayoutViewInput {
  view?: CanvasView | null
  display?: DisplayInfo | null
}

/** A Named Group (feature zone) the digest joins onto each board as `groupIds` (+ v1 `groupId`). */
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
  /** The FIRST Named Group this board belongs to (a board may be in several); absent when ungrouped.
   *  Kept for v1 readers — {@link LayoutBoard.groupIds} is the complete membership. */
  groupId?: string
  /** EVERY Named Group this board belongs to, in group input order (G8 — multi-membership is
   *  allowed); `[]` when ungrouped. `groupIds[0]` is always `groupId`. */
  groupIds: string[]
  /** Intersects `screen.visibleWorld` (false when `screen` is null). */
  onScreen: boolean
  /** C9: what this board IS on the canvas (ROLE-LAYOUT §2), derived over the placed boards. */
  role: BoardRole
}

/** A Named Group in the digest (v2): its membership as published + the bbox of its PLACED members. */
export interface LayoutGroup {
  id: string
  name: string
  boardIds: string[]
  /** Union bbox of the group's placed members (world px); null when none of them is placed. */
  bbox: Rect | null
}

/** The user's screen in the digest (v2): the C1 view + the display holding the window, when known. */
export type LayoutScreen = CanvasView & { display?: DisplayInfo }

/** Whether the whole canvas fits the user's pane readably (v2). */
export interface LayoutFit {
  /** Zoom at which ALL placed boards fit the pane (FIT_FRAME rules); null without a view (or boards). */
  zoomToFitAll: number | null
  /** zoomToFitAll >= READABLE_ZOOM (false when zoomToFitAll is null). */
  readable: boolean
  /** READABLE_ZOOM (= the renderer's LOD_ZOOM: below it boards render as placeholders). */
  readableZoom: number
}

/**
 * A coarse read of how the placed boards currently sit, so the agent can pick a tidy orientation:
 * `row` = one horizontal band (side by side) · `column` = one vertical stack · `grid` = multiple
 * rows AND columns, non-overlapping · `scattered` = overlapping or irregular · `single`/`empty` = <2.
 */
export type LayoutArrangement = 'empty' | 'single' | 'row' | 'column' | 'grid' | 'scattered'

/** The read-only spatial digest served as `canvas://layout` (v2 — every v1 field kept). */
export interface LayoutDigestV2 {
  version: 2
  /** Number of PLACED boards: finite geometry and not docked in a swarm. */
  count: number
  /** Union bounding box of all placed boards (world px); null when none are placed. */
  bbox: Rect | null
  /** Placed boards, in input order, each with finite geometry + group membership + on-screen flag. */
  boards: LayoutBoard[]
  /** Board-id pairs whose rectangles overlap (a tidy trigger). Each unordered pair once, `a`<`b`. */
  overlaps: Array<{ a: string; b: string }>
  /** How the placed boards currently sit — the orientation hint for a tidy/visualize proposal. */
  arrangement: LayoutArrangement
  /** Every Named Group, in input order, with the bbox of its placed members. */
  groups: LayoutGroup[]
  /** The user's view (pane · dpr · camera · visible world + display); null without a view. */
  screen: LayoutScreen | null
  /** Does everything fit the pane at a readable zoom? */
  fit: LayoutFit
}

/** The digest every consumer imports — currently {@link LayoutDigestV2}. */
export type LayoutDigest = LayoutDigestV2

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Union bounding box of `rects`; null when empty. */
function unionBox(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.w > maxX) maxX = r.x + r.w
    if (r.y + r.h > maxY) maxY = r.y + r.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

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

type Placed = RoleBoardInput & { type: string }

/** The C9 role of every placed board: `deriveRoles` over them + the preview/orchestration edges. */
function placedRoles(
  placed: readonly Placed[],
  roleInput: LayoutRoleInput
): Map<string, BoardRole> {
  type RoleConnector = { sourceId: string; targetId: string; kind: 'preview' | 'orchestration' }
  const connectors = (roleInput.connectors ?? []).flatMap((c): RoleConnector[] =>
    c.kind === 'preview' || c.kind === 'orchestration'
      ? [{ sourceId: c.sourceId, targetId: c.targetId, kind: c.kind }]
      : []
  )
  const roles = deriveRoles(placed, connectors, { leadBoardId: roleInput.leadBoardId ?? null })
  return new Map([...roles].map(([id, info]) => [id, info.role]))
}

/**
 * Build the {@link LayoutDigest} from the live board + group mirrors, the user's view and the C9
 * role inputs. Boards without finite geometry, and worker terminals docked in a swarm, are dropped
 * (they can't be placed); everything else is derived deterministically. Pure — safe to call on
 * every `canvas://layout` read. `roleInput` is optional: without it roles still derive from the
 * boards' own signals, with no connector links and no lead.
 */
export function buildLayoutDigest(
  boardsInput: readonly LayoutBoardInput[],
  groups: readonly LayoutGroupInput[] = [],
  viewInput: LayoutViewInput = {},
  roleInput: LayoutRoleInput = {}
): LayoutDigest {
  const view = viewInput.view ?? null
  const display = viewInput.display ?? null
  // The user's screen: the C1 view (+ the display holding the window, when MAIN could read it).
  const screen: LayoutScreen | null = view
    ? {
        pane: { ...view.pane },
        dpr: view.dpr,
        camera: { ...view.camera },
        visibleWorld: { ...view.visibleWorld },
        ...(display ? { display } : {})
      }
    : null

  // groupIds = EVERY group (input order) whose membership includes the board (G8); the v1
  // `groupId` stays the FIRST of them so an older reader sees exactly what it saw before.
  const groupsOf = (id: string): string[] =>
    groups.filter((g) => g.boardIds.includes(id)).map((g) => g.id)

  const placed: Placed[] = []
  for (const b of boardsInput) {
    if (!isFiniteNum(b.x) || !isFiniteNum(b.y) || !isFiniteNum(b.w) || !isFiniteNum(b.h)) continue
    if (typeof b.dockedIn === 'string' && b.dockedIn.length > 0) continue // docked: not geometry
    placed.push({ ...b, x: b.x, y: b.y, w: b.w, h: b.h })
  }
  const roleOf = placedRoles(placed, roleInput)

  const boards: LayoutBoard[] = placed.map((b) => {
    const groupIds = groupsOf(b.id)
    const rect = { x: b.x, y: b.y, w: b.w, h: b.h }
    return {
      id: b.id,
      type: b.type,
      ...rect,
      ...(groupIds.length > 0 ? { groupId: groupIds[0] } : {}),
      groupIds,
      onScreen: screen !== null && rectsIntersect(rect, screen.visibleWorld),
      // deriveRoles classifies every placed (non-docked) board; `file` is its own unknown fallback.
      role: roleOf.get(b.id) ?? 'file'
    }
  })

  // Union bounding box (null when nothing is placed).
  const bbox = unionBox(boards)

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

  // Each Named Group with the bbox of its PLACED members (an unplaced / docked member adds nothing).
  const placedById = new Map(boards.map((b) => [b.id, b]))
  const layoutGroups: LayoutGroup[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    boardIds: [...g.boardIds],
    bbox: unionBox(g.boardIds.flatMap((id) => placedById.get(id) ?? []))
  }))

  // Fit: the FIT_FRAME zoom that frames everything in the user's pane, and whether it stays readable.
  const zoomToFitAll = view && bbox ? fitZoom(bbox, view.pane) : null

  return {
    version: 2,
    count: boards.length,
    bbox,
    boards,
    overlaps,
    arrangement: classify(boards, overlaps.length > 0),
    groups: layoutGroups,
    screen,
    fit: {
      zoomToFitAll,
      readable: zoomToFitAll !== null && zoomToFitAll >= READABLE_ZOOM,
      readableZoom: READABLE_ZOOM
    }
  }
}
