/**
 * Role-aware tidy (spatial-awareness C10, `tidy_canvas mode:'roles'`) — pure, deterministic,
 * screen-aware arrangement by board ROLE (no React, no Zustand, no DOM). The caller (Wave 3's
 * I2) passes the boards, the C9 role map (`deriveRoles`) and units (`buildRoleUnits`); this
 * returns placements, the zoom + camera that frame the STAGE unit, and a self-explaining
 * `units[]` ack. Rules: docs/specs/spatial-awareness/ROLE-LAYOUT.md §1 + §4–§8, SPEC C10.
 *
 *  1. Units: the caller's units, made canonical (scoped, docked dropped, every board in exactly
 *     one unit — the leftovers become singles) and re-classified with C9's `classifyScene`.
 *  2. Stage: `primary`'s unit > the lead's > the selection's > the last-focused board's > the
 *     largest (§1). The stage fills the pane; every other unit is laid out COMPACT at its own
 *     scene (the same templates, solved at the tightest zoom its minimums allow) and placed beside
 *     the stage by C4's shelf packer (`fitLayout` over one box per unit — the stage box first, so
 *     it lands at the anchor), `FIT_UNIT_GAP` apart, so units never interleave.
 *  3. Template per scene (§3–§4): lead / hub / single hero → `hero-rail` (A ≥ 1.3) or
 *     `hero-strip`; co-heroes → `duo-strip` / `duo-rail`; peers → `grid`; docs → `shelf`;
 *     1 board → `single` (size and position kept). Slots fill heroes first, then the boards
 *     linked to a hero (its preview source first), then rank order (C9 `rankBoards`).
 *  4. Sizing (§5, D7): flexible boards take their slot (≥ role minimum), previews keep their
 *     w:h, rigid boards are never resized. Overflow (§6): denser variant first, then D4 —
 *     `report` (default), `pages` (off-stage units paginated after the stage), `shrink`
 *     (flexible floor drops to `MIN_BOARD_SIZE` so the stage reaches `readableZoom`).
 *  5. Anchored at the arranged boards' current top-left ("nudge, don't teleport").
 *
 * D8 (a): under `implicit`, a unit of plain shells keeps its sizes (C4 in-unit packing).
 * `resize:false` keeps the role ORDER only — positions from C4's shelf, no w/h.
 */
import {
  classifyScene,
  rankBoards,
  type BoardRole,
  type BoardRoleInfo,
  type RoleBoardInput,
  type RoleUnit,
  type Scene
} from '../../../shared/boardRoles'
import { READABLE_ZOOM, fitZoom, type Rect } from '../../../shared/spatialGeometry'
import { FIT_UNIT_GAP, fitLayout, type FitOverflow } from './fitLayout'
import {
  availOf,
  gridColumns,
  memberOf,
  quantizeZoom,
  shelfLayout,
  sizeOf,
  solveGrid,
  solveTree,
  type Cell,
  type Solved
} from './roleSizing'
import {
  COMPACT_MAX_ZOOM,
  DUO_RAIL_MIN_ASPECT,
  HERO_RAIL_MIN_ASPECT,
  ROLE_GAP,
  ULTRAWIDE_MIN_ASPECT,
  duoRailVariants,
  duoStripVariants,
  heroRailVariants,
  heroStripVariants,
  type Member,
  type Variant
} from './roleTemplates'
import { unitWhy, type WhyContext, type WhyInput } from './roleWhy'

export interface RoleLayoutOptions {
  /** Visible canvas pane in screen px (C1 view). */
  pane: { w: number; h: number }
  /** Force the hero (S14) — its unit becomes the stage. */
  primary?: string
  /** Arrange only these boards (S12); everything else gets no placement. */
  scope?: 'all' | { boardIds: string[] }
  /** D4. Default `report`. */
  overflow?: FitOverflow
  /** D7. Default true; false ⇒ role ORDER only, positions via C4, no w/h. */
  resize?: boolean
  /** Default `READABLE_ZOOM`. */
  readableZoom?: number
  /** D8 (a): true when `roles` was chosen implicitly (agent omitted `mode`, or the `t` key). */
  implicit?: boolean
  /** ADDITIVE (deviation): the live selection — stage rule 3 (§1). */
  selectedIds?: string[]
  /** ADDITIVE (deviation): board titles, echoed (sanitized) into `units[].why`. */
  titles?: Readonly<Record<string, string>>
}

export interface RoleLayoutPlacement {
  id: string
  x: number
  y: number
  /** Set only for boards the engine sized (flexible / aspect-locked). */
  w?: number
  h?: number
}

export interface RoleLayoutUnit {
  key: string
  scene: Scene
  heroIds: string[]
  /** `hero-rail`, `hero-rail/2-col`, `hero-strip/2-row`, `duo-strip`, `duo-rail`, `grid/3x2`,
   *  `shelf`, `single`, or `fit` (position-only: implicit shells / resize:false). */
  template: string
  why: string
  /** ADDITIVE (deviation): the unit's arranged boards, sorted. */
  boardIds: string[]
}

export interface RoleLayoutPage {
  index: number
  boardIds: string[]
  bbox: Rect
}

export interface RoleLayoutResult {
  /** One per arranged board, sorted by id. */
  placements: RoleLayoutPlacement[]
  stageKey: string
  /** The zoom the camera frames the stage at (= `camera.zoom`). */
  targetZoom: number
  /** `targetZoom >= readableZoom`. */
  readable: boolean
  camera: { x: number; y: number; zoom: number }
  /** The stage first, then the off-stage units in reading order. */
  units: RoleLayoutUnit[]
  /** ADDITIVE (deviation): only under `overflow:'pages'` with off-stage units; page 0 = stage. */
  pages?: RoleLayoutPage[]
}

interface Ctx {
  boards: Map<string, RoleBoardInput>
  list: RoleBoardInput[]
  roles: ReadonlyMap<string, BoardRoleInfo>
  scoped: string[]
  pane: { w: number; h: number }
  avail: { w: number; h: number }
  aspect: number
  readable: number
  opts: RoleLayoutOptions
  why: WhyContext
}

interface PlanUnit {
  key: string
  boardIds: string[]
  scene: Scene
  heroIds: string[]
}

type Sizing = 'single' | 'keep' | 'sized'

interface Laid {
  plan: PlanUnit
  heroIds: string[]
  template: string
  why: string
  /** Relative to the unit's own top-left (0, 0). */
  cells: Cell[]
  w: number
  h: number
  sizing: Sizing
  /** The solved zoom (sized templates only). */
  z: number
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const coord = (v: number): number => (Number.isFinite(v) ? v : 0)
const finitePos = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback
const round2 = (v: number): number => Math.round(v * 100) / 100

function makeContext(
  boards: readonly RoleBoardInput[],
  roles: ReadonlyMap<string, BoardRoleInfo>,
  opts: RoleLayoutOptions
): Ctx {
  // Canonical board list: docked dropped, sorted by id (geometry breaks duplicate-id ties so even
  // a malformed input is order-independent), first occurrence of an id kept.
  const sorted = boards
    .filter((b) => !b.dockedIn)
    .sort(
      (a, b) =>
        cmpStr(a.id, b.id) ||
        coord(a.y) - coord(b.y) ||
        coord(a.x) - coord(b.x) ||
        coord(a.w) - coord(b.w) ||
        coord(a.h) - coord(b.h) ||
        cmpStr(a.type, b.type)
    )
  const map = new Map<string, RoleBoardInput>()
  for (const b of sorted) if (!map.has(b.id)) map.set(b.id, b)
  const list = [...map.values()]
  const scope = opts.scope
  const wanted = scope && scope !== 'all' ? new Set(scope.boardIds) : null
  const pane = { w: finitePos(opts.pane?.w, 1), h: finitePos(opts.pane?.h, 1) }
  // Docked workers are never placed; they only explain a swarm hero (`why`).
  const dockedIds = new Map<string, Set<string>>()
  for (const b of boards) {
    if (!b.dockedIn) continue
    dockedIds.set(b.dockedIn, (dockedIds.get(b.dockedIn) ?? new Set()).add(b.id))
  }
  const docked = new Map([...dockedIds].map(([host, ids]) => [host, ids.size]))
  return {
    boards: map,
    list,
    roles,
    scoped: list.filter((b) => !wanted || wanted.has(b.id)).map((b) => b.id),
    pane,
    avail: availOf(pane),
    aspect: pane.w / pane.h,
    readable: finitePos(opts.readableZoom, READABLE_ZOOM),
    opts,
    why: { boards: map, roles, titles: opts.titles, docked }
  }
}

function topLeft(ids: readonly string[], ctx: Ctx): { x: number; y: number } {
  let x = Infinity
  let y = Infinity
  for (const id of ids) {
    const b = ctx.boards.get(id)!
    x = Math.min(x, coord(b.x))
    y = Math.min(y, coord(b.y))
  }
  return { x, y }
}

/** Step 1: every scoped board in exactly one unit; scenes re-asked of C9 for the members. */
function canonicalUnits(units: readonly RoleUnit[], ctx: Ctx): PlanUnit[] {
  const inScope = new Set(ctx.scoped)
  const claimed = new Set<string>()
  const keys = new Set<string>()
  const out: PlanUnit[] = []
  const add = (key: string, ids: string[]): void => {
    let k = key
    while (keys.has(k)) k += '+'
    keys.add(k)
    for (const id of ids) claimed.add(id)
    out.push({ key: k, boardIds: ids, ...classifyScene(ids, ctx.list, ctx.roles) })
  }
  const canon = units.map((u) => ({ key: u.key, ids: [...new Set(u.boardIds)].sort(cmpStr) }))
  canon.sort((a, b) => cmpStr(a.key, b.key) || cmpStr(a.ids.join('\n'), b.ids.join('\n')))
  for (const u of canon) {
    const ids = u.ids.filter((id) => inScope.has(id) && !claimed.has(id))
    if (ids.length > 0) add(u.key, ids)
  }
  for (const id of ctx.scoped) if (!claimed.has(id)) add(`single:${id}`, [id])
  const tl = new Map(out.map((u) => [u.key, topLeft(u.boardIds, ctx)]))
  return out.sort(
    (a, b) =>
      tl.get(a.key)!.y - tl.get(b.key)!.y ||
      tl.get(a.key)!.x - tl.get(b.key)!.x ||
      cmpStr(a.key, b.key)
  )
}

/** Step 2 (§1): primary > lead > selection > last focused > largest. */
function pickStage(plan: readonly PlanUnit[], ctx: Ctx): PlanUnit {
  const holding = (id: string | undefined): PlanUnit | undefined =>
    id === undefined ? undefined : plan.find((u) => u.boardIds.includes(id))
  const byPrimary = holding(ctx.opts.primary)
  if (byPrimary) return byPrimary
  const lead = holding(ctx.scoped.find((id) => ctx.roles.get(id)?.role === 'lead'))
  if (lead) return lead
  const sel = new Set(ctx.opts.selectedIds ?? [])
  const selected = plan.find((u) => u.boardIds.some((id) => sel.has(id)))
  if (selected) return selected
  let focusId: string | undefined
  let focusAt = -Infinity
  for (const id of ctx.scoped) {
    const t = ctx.boards.get(id)!.lastFocusedAt
    if (t !== undefined && Number.isFinite(t) && t > focusAt) {
      focusAt = t
      focusId = id
    }
  }
  const focused = holding(focusId)
  if (focused) return focused
  const area = (u: PlanUnit): number =>
    u.boardIds.reduce((s, id) => {
      const { w, h } = sizeOf(ctx.boards.get(id)!)
      return s + w * h
    }, 0)
  let best = plan[0]
  for (const u of plan) {
    const more = u.boardIds.length - best.boardIds.length
    if (more > 0 || (more === 0 && area(u) > area(best))) best = u
  }
  return best
}

const readingOrder = (ids: readonly string[], ctx: Ctx): string[] =>
  [...ids].sort((a, b) => {
    const A = ctx.boards.get(a)!
    const B = ctx.boards.get(b)!
    return coord(A.y) - coord(B.y) || coord(A.x) - coord(B.x) || cmpStr(a, b)
  })

/**
 * §1 step 3: the non-hero boards in slot order — boards a hero names as its source first
 * (preview → terminal, data-flow → browser), then the heroes' other links in their (reading)
 * order, then boards that link TO a hero, then everything else in C9 rank order.
 */
function orderOthers(heroes: readonly string[], ids: readonly string[], ctx: Ctx): string[] {
  const others = new Set(ids.filter((id) => !heroes.includes(id)))
  const near: string[] = []
  const push = (id: string | undefined): void => {
    if (id !== undefined && others.has(id) && !near.includes(id)) near.push(id)
  }
  for (const h of heroes) {
    const b = ctx.boards.get(h)!
    if (b.type === 'browser') push(b.previewSourceId)
    if (b.type === 'dataflow') push(b.sourceBoardId)
  }
  for (const h of heroes) for (const l of ctx.roles.get(h)?.links ?? []) push(l)
  for (const o of readingOrder([...others], ctx)) {
    if ((ctx.roles.get(o)?.links ?? []).some((l) => heroes.includes(l))) push(o)
  }
  const rest = [...others].filter((id) => !near.includes(id))
  return [...near, ...rankBoards(rest, ctx.list, ctx.roles)]
}

const roleOf = (ctx: Ctx, id: string): BoardRole | undefined => ctx.roles.get(id)?.role

function normalize(cells: Cell[]): { cells: Cell[]; w: number; h: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const c of cells) {
    x0 = Math.min(x0, c.x)
    y0 = Math.min(y0, c.y)
    x1 = Math.max(x1, c.x + c.w)
    y1 = Math.max(y1, c.y + c.h)
  }
  return { cells: cells.map((c) => ({ ...c, x: c.x - x0, y: c.y - y0 })), w: x1 - x0, h: y1 - y0 }
}

/** Position-only cells from a C4 `fitLayout` run (sizes kept). */
function fitCells(
  ctx: Ctx,
  placements: ReadonlyArray<{ id: string; x: number; y: number }>
): Cell[] {
  return placements.map((p) => ({ ...p, ...sizeOf(ctx.boards.get(p.id)!), sized: false }))
}

function familyOf(scene: Scene, heroes: Member[], others: Member[], aspect: number): Variant[] {
  if (heroes.length >= 2) {
    const rail = scene === 'pair' ? aspect >= ULTRAWIDE_MIN_ASPECT : aspect >= DUO_RAIL_MIN_ASPECT
    return rail ? duoRailVariants(heroes, others) : duoStripVariants(heroes, others)
  }
  return aspect >= HERO_RAIL_MIN_ASPECT
    ? heroRailVariants(heroes, others, aspect)
    : heroStripVariants(heroes, others)
}

/** §6 step 1: the first variant that stays readable, else the most readable one. */
function pickVariant(
  variants: readonly Variant[],
  ctx: Ctx,
  zMax: number
): { v: Variant; s: Solved } {
  let best: { v: Variant; s: Solved } | null = null
  for (const v of variants) {
    const s = solveTree(v.root, ctx.avail, zMax, ctx.readable)
    if (s.z >= ctx.readable) return { v, s }
    if (best === null || s.z > best.s.z) best = { v, s }
  }
  return best!
}

/** Lay one unit out on its own — `stage` fills the pane (zoom ≤ 1), the rest go compact. */
function layoutUnit(u: PlanUnit, ctx: Ctx, stage: boolean): Laid {
  const ids = u.boardIds
  const primary =
    ctx.opts.primary !== undefined && ids.length > 1 && ids.includes(ctx.opts.primary)
      ? ctx.opts.primary
      : undefined
  const heroes = primary !== undefined ? [primary] : u.heroIds.filter((id) => ids.includes(id))
  const zMax = stage ? 1 : COMPACT_MAX_ZOOM
  const shrink = stage && ctx.opts.overflow === 'shrink'
  const member = (floor: 'role' | 'board') => (id: string) =>
    memberOf(ctx.boards.get(id)!, roleOf(ctx, id), floor)
  const done = (
    kind: WhyInput['kind'],
    template: string,
    cells: Cell[],
    sizing: Sizing,
    heroIds: string[],
    z = 1,
    grid?: WhyInput['grid']
  ): Laid => {
    const n = normalize(cells)
    const why = unitWhy(ctx.why, { kind, boardIds: ids, heroIds, primary, grid })
    return { plan: u, heroIds, template, why, cells: n.cells, w: n.w, h: n.h, sizing, z }
  }

  if (ids.length === 1) {
    const b = ctx.boards.get(ids[0])!
    return done(
      'single',
      'single',
      [{ id: b.id, x: 0, y: 0, ...sizeOf(b), sized: false }],
      'single',
      [...ids]
    )
  }
  if (ctx.opts.resize === false) {
    const order =
      heroes.length > 0
        ? [...heroes, ...orderOthers(heroes, ids, ctx)]
        : u.scene === 'docs'
          ? readingOrder(ids, ctx)
          : rankBoards(ids, ctx.list, ctx.roles)
    const tidy = order.map((id, i) => ({ id, x: 0, y: i, ...sizeOf(ctx.boards.get(id)!) }))
    const res = fitLayout(tidy, { pane: ctx.pane, unitGap: ROLE_GAP })
    return done('order', 'fit', fitCells(ctx, res.placements), 'keep', heroes)
  }
  if (
    ctx.opts.implicit &&
    primary === undefined &&
    ids.every((id) => roleOf(ctx, id) === 'shell')
  ) {
    const tidy = ids.map((id) => {
      const b = ctx.boards.get(id)!
      return { id, x: coord(b.x), y: coord(b.y), ...sizeOf(b), type: 'terminal' as const }
    })
    const res = fitLayout(tidy, { pane: ctx.pane, units: [{ id: u.key, boardIds: [...ids] }] })
    return done('implicit', 'fit', fitCells(ctx, res.placements), 'keep', [])
  }
  if (primary === undefined && u.scene === 'docs') {
    const items = readingOrder(ids, ctx).map((id) => ({
      id,
      ...sizeOf(ctx.boards.get(id)!),
      tracker: roleOf(ctx, id) === 'tracker'
    }))
    return done('shelf', 'shelf', shelfLayout(items, ctx.pane), 'keep', [])
  }
  if (primary === undefined && (u.scene === 'peers' || heroes.length === 0)) {
    const order = rankBoards(ids, ctx.list, ctx.roles)
    const run = (floor: 'role' | 'board', cap: number): { cols: number; s: Solved } => {
      const ms = order.map(member(floor))
      const cols = gridColumns(ms, ctx.avail)
      return { cols, s: solveGrid(ms, cols, ctx.avail, cap) }
    }
    let g = run('role', zMax)
    if (shrink && g.s.z < ctx.readable) g = run('board', ctx.readable)
    const grid = { cols: g.cols, rows: Math.ceil(ids.length / g.cols) }
    return done('grid', `grid/${grid.cols}x${grid.rows}`, g.s.cells, 'sized', [], g.s.z, grid)
  }
  const others = orderOthers(heroes, ids, ctx)
  const run = (floor: 'role' | 'board', cap: number): { v: Variant; s: Solved } =>
    pickVariant(
      familyOf(u.scene, heroes.map(member(floor)), others.map(member(floor)), ctx.aspect),
      ctx,
      cap
    )
  let best = run('role', zMax)
  if (shrink && best.s.z < ctx.readable) best = run('board', ctx.readable)
  return done('hero', best.v.name, best.s.cells, 'sized', heroes, best.s.z)
}

/** The camera zoom that frames a laid-out unit as the stage. */
function stageZoom(l: Laid, ctx: Ctx): number {
  const fit = fitZoom({ x: 0, y: 0, w: l.w, h: l.h }, ctx.pane)
  // A lone board is framed like "zoom to fit" (S11, capped at FIT_MAX_ZOOM); everything else
  // never zooms past 100 % (§5: boards look like 100 % scale whenever they fit). Floored to
  // ZOOM_STEP so it never exceeds the fit.
  if (l.sizing === 'single') return quantizeZoom(fit)
  return quantizeZoom(Math.min(l.sizing === 'sized' ? l.z : 1, fit))
}

const EMPTY: RoleLayoutResult = {
  placements: [],
  stageKey: '',
  targetZoom: 1,
  readable: true,
  camera: { x: 0, y: 0, zoom: 1 },
  units: []
}

/**
 * Arrange `boards` by role so the stage unit fills `opts.pane`. Deterministic for any input
 * order; one placement per arranged board; docked boards are ignored.
 */
export function roleLayout(
  boards: readonly RoleBoardInput[],
  roles: ReadonlyMap<string, BoardRoleInfo>,
  units: readonly RoleUnit[],
  opts: RoleLayoutOptions
): RoleLayoutResult {
  const ctx = makeContext(boards, roles, opts)
  if (ctx.scoped.length === 0) return { ...EMPTY, camera: { ...EMPTY.camera }, units: [] }
  const plan = canonicalUnits(units, ctx)
  const stagePlan = pickStage(plan, ctx)
  const laid = plan.map((u) => layoutUnit(u, ctx, u === stagePlan))
  const stage = laid.find((l) => l.plan === stagePlan)!
  const others = laid.filter((l) => l !== stage)
  const anchor = topLeft(ctx.scoped, ctx)
  const pos = new Map<string, { x: number; y: number }>()
  let pages: RoleLayoutPage[] | undefined

  if (ctx.scoped.length === 1) {
    // Nothing to arrange: the lone board keeps its position (C4 step 7, S11).
    pos.set(stage.plan.key, anchor)
  } else if (others.length === 0) {
    pos.set(stage.plan.key, anchor)
  } else if (opts.overflow === 'pages') {
    pos.set(stage.plan.key, anchor)
    const boxes = others.map((l, i) => ({ id: l.plan.key, x: 0, y: i, w: l.w, h: l.h }))
    const res = fitLayout(boxes, { pane: ctx.pane, overflow: 'pages' })
    const ox = anchor.x + stage.w + 2 * FIT_UNIT_GAP
    const oy = anchor.y
    for (const p of res.placements) pos.set(p.id, { x: ox + p.x, y: oy + p.y })
    const idsOf = (keys: readonly string[]): string[] =>
      keys.flatMap((k) => others.find((l) => l.plan.key === k)!.plan.boardIds).sort(cmpStr)
    const offPages = res.pages ?? [{ index: 0, boardIds: boxes.map((b) => b.id), bbox: res.bbox }]
    pages = [
      { index: 0, boardIds: [...stage.plan.boardIds], bbox: { ...anchor, w: stage.w, h: stage.h } },
      ...offPages.map((pg) => ({
        index: pg.index + 1,
        boardIds: idsOf(pg.boardIds),
        bbox: { x: ox + pg.bbox.x, y: oy + pg.bbox.y, w: pg.bbox.w, h: pg.bbox.h }
      }))
    ]
  } else {
    const boxes = [stage, ...others].map((l, i) => ({ id: l.plan.key, x: 0, y: i, w: l.w, h: l.h }))
    const res = fitLayout(boxes, { pane: ctx.pane })
    for (const p of res.placements) pos.set(p.id, { x: anchor.x + p.x, y: anchor.y + p.y })
  }

  const placements: RoleLayoutPlacement[] = []
  for (const l of laid) {
    const at = pos.get(l.plan.key)!
    for (const c of l.cells) {
      const p: RoleLayoutPlacement = { id: c.id, x: at.x + c.x, y: at.y + c.y }
      if (c.sized) {
        p.w = c.w
        p.h = c.h
      }
      placements.push(p)
    }
  }
  placements.sort((a, b) => cmpStr(a.id, b.id))

  const zoom = stageZoom(stage, ctx)
  const at = pos.get(stage.plan.key)!
  const camera = {
    x: round2(ctx.pane.w / 2 - (at.x + stage.w / 2) * zoom),
    y: round2(ctx.pane.h / 2 - (at.y + stage.h / 2) * zoom),
    zoom
  }
  const result: RoleLayoutResult = {
    placements,
    stageKey: stage.plan.key,
    targetZoom: zoom,
    readable: zoom >= ctx.readable,
    camera,
    units: [stage, ...others].map((l) => ({
      key: l.plan.key,
      scene: l.plan.scene,
      heroIds: l.heroIds,
      template: l.template,
      why: l.why,
      boardIds: [...l.plan.boardIds]
    }))
  }
  if (pages && pages.length > 1) result.pages = pages
  return result
}
