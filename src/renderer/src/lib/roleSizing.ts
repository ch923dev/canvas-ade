/**
 * Role-aware tidy sizing (spatial-awareness C10, ROLE-LAYOUT §5) — the pure geometry behind
 * `roleLayout`: size classes + minimums, the split-tree solver, the equal-cell `grid`, the
 * size-keeping `shelf`, and the screen → world zoom solve. No React / DOM / store.
 *
 * The §5 mapping: slots are derived from the PANE (screen px, after `FIT_PADDING_PX`), then
 * converted to world units at a target zoom `z` — the frame a unit fills is `avail / z`. `z` is
 * `min(cap, the largest z keeping every slot ≥ its minimum)`; because every minimum is a
 * constant (role minimum, rigid size, board minimum at a preview's aspect), that largest `z` has
 * a closed form: `min(avail.w / minW(tree), avail.h / minH(tree))`.
 *
 * Invariants every layout here keeps (the §8 property tests pin them):
 *  - no two slots overlap: slot boundaries are whole px, cumulative-rounded, `ROLE_GAP` apart;
 *  - a flexible board is never smaller than its floor: a split floors every kid at its minimum
 *    and the root is bumped to its own minimum, so a frame that is too small makes the layout
 *    SPILL past the frame (readable:false) — it never squeezes a board or overlaps two;
 *  - a rigid board is placed at its exact size; a preview keeps its w:h (±1 px).
 */
import type { BoardRole } from '../../../shared/boardRoles'
import { FIT_MIN_ZOOM, FIT_PADDING_PX, type Rect } from '../../../shared/spatialGeometry'
import { MIN_BOARD_SIZE } from './boardDefaults'
import {
  FLEX_MIN,
  ROLE_GAP,
  TERMINAL_MIN,
  ZOOM_STEP,
  type Axis,
  type LNode,
  type Member,
  type SizeClass
} from './roleTemplates'

/** A laid-out board. `sized` ⇒ the engine set its w/h (flexible / aspect only). */
export interface Cell {
  id: string
  x: number
  y: number
  w: number
  h: number
  sized: boolean
}

/** One unit's solved layout, relative to its own frame origin (0, 0). */
export interface Solved {
  /** The zoom the frame was solved for (quantized to `ZOOM_STEP`). */
  z: number
  cells: Cell[]
}

interface Span {
  min: number
  max: number
}

interface Item extends Span {
  weight: number
}

const FLEX_TYPES: ReadonlySet<string> = new Set(['terminal', 'swarm', 'command', 'dataflow'])

const finitePos = (v: number, fallback: number): number =>
  Number.isFinite(v) && v > 0 ? v : fallback

/** A board's size, sanitized (non-finite / non-positive → the board minimum). */
export function sizeOf(b: { w: number; h: number }): { w: number; h: number } {
  return { w: finitePos(b.w, MIN_BOARD_SIZE.w), h: finitePos(b.h, MIN_BOARD_SIZE.h) }
}

/**
 * D7 class by board type: terminal / swarm / command / dataflow are flexible, a browser is
 * aspect-locked, everything else — planning, kanban, file, and any type the role model files as
 * `file` — is rigid and never resized.
 */
export function sizeClassOf(type: string, role: BoardRole | undefined): SizeClass {
  if (role === 'file') return 'rigid'
  if (type === 'browser') return 'aspect'
  return FLEX_TYPES.has(type) ? 'flexible' : 'rigid'
}

/** The readable minimum a flexible board of `type` is held to (terminal 490 × 312). */
export function roleMinimum(type: string): { w: number; h: number } {
  return type === 'terminal' ? TERMINAL_MIN : FLEX_MIN
}

/**
 * A template member. `floor: 'board'` drops a flexible board's floor from its readable minimum
 * to `MIN_BOARD_SIZE` — the D4 `shrink` overflow.
 */
export function memberOf(
  b: { id: string; type: string; w: number; h: number },
  role: BoardRole | undefined,
  floor: 'role' | 'board' = 'role'
): Member {
  const { w, h } = sizeOf(b)
  const cls = sizeClassOf(b.type, role)
  if (cls === 'rigid') return { id: b.id, cls, w, h, minW: Math.ceil(w), minH: Math.ceil(h) }
  if (cls === 'aspect') {
    const r = w / h
    return {
      id: b.id,
      cls,
      w,
      h,
      minW: Math.ceil(Math.max(MIN_BOARD_SIZE.w, MIN_BOARD_SIZE.h * r)),
      minH: Math.ceil(Math.max(MIN_BOARD_SIZE.h, MIN_BOARD_SIZE.w / r))
    }
  }
  const min = floor === 'board' ? MIN_BOARD_SIZE : roleMinimum(b.type)
  return { id: b.id, cls, w, h, minW: min.w, minH: min.h }
}

/** The pane area a frame may fill: the pane minus `FIT_PADDING_PX` on every side (≥ 1 px). */
export function availOf(pane: { w: number; h: number }): { w: number; h: number } {
  return {
    w: Math.max(1, pane.w - 2 * FIT_PADDING_PX),
    h: Math.max(1, pane.h - 2 * FIT_PADDING_PX)
  }
}

/** The world frame the pane shows at zoom `z` (whole px; the epsilon absorbs float error so a
 *  frame solved to be exactly a minimum never floors one px short of it). */
export function frameAt(avail: { w: number; h: number }, z: number): { w: number; h: number } {
  return { w: Math.floor(avail.w / z + 1e-6), h: Math.floor(avail.h / z + 1e-6) }
}

/** Floor `z` to `ZOOM_STEP` (never past the camera floor). Flooring only GROWS the frame, so a
 *  feasible zoom stays feasible. */
export function quantizeZoom(z: number): number {
  const q = Math.floor(z / ZOOM_STEP + 1e-9) * ZOOM_STEP
  return Math.max(FIT_MIN_ZOOM, Number(q.toFixed(4)))
}

// ── Split-tree solver ─────────────────────────────────────────────────────────────────────────

/**
 * How long a node may be along `axis` when its other side is `cross` (undefined = not known
 * yet). `max` is Infinity for anything that stretches; an aspect board's natural length is its
 * size at the full cross length.
 */
function measure(n: LNode, axis: Axis, cross?: number): Span {
  if (n.kind === 'leaf') {
    const m = n.m
    const min = axis === 'x' ? m.minW : m.minH
    if (m.cls === 'rigid') return { min, max: min }
    if (m.cls === 'flexible' || cross === undefined) return { min, max: Infinity }
    const natural = axis === 'x' ? cross * (m.w / m.h) : cross / (m.w / m.h)
    return { min, max: Math.max(min, natural) }
  }
  const gaps = ROLE_GAP * (n.kids.length - 1)
  if (n.axis === axis) {
    let min = gaps
    let max = gaps
    for (const k of n.kids) {
      const s = measure(k, axis, cross)
      min += s.min
      max += s.max
    }
    return { min, max }
  }
  // Kids sit across `axis`: each spans the full length; their own cross is allotted later.
  let min = 0
  let max = 0
  for (const k of n.kids) {
    const s = measure(k, axis, undefined)
    min = Math.max(min, s.min)
    max = Math.max(max, s.max)
  }
  return { min, max }
}

/** The smallest frame a tree fits in without spilling. */
export function treeMin(root: LNode): { w: number; h: number } {
  return { w: measure(root, 'x').min, h: measure(root, 'y').min }
}

/** Largest `t` in [lo, hi] with `f(t) <= target` (f monotone non-decreasing). */
function bisectBelow(f: (t: number) => number, target: number, lo: number, hi: number): number {
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) <= target) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Share `total` between `items` (ROLE-LAYOUT §5): everyone starts at its floor; aspect-locked
 * kids then grow toward their natural length by ONE common factor (co-heroes stay level) before
 * any stretch kid grows — so a preview takes its device aspect and the leftover goes to its
 * neighbours (no letterbox gap); stretch kids finally split what is left by weight
 * (water-filling over their floors). A short `total` leaves everyone at its floor.
 */
export function distribute(total: number, items: readonly Item[]): number[] {
  const sizes = items.map((it) => it.min)
  let budget = total - sizes.reduce((s, v) => s + v, 0)
  if (budget <= 0) return sizes
  const bounded = items.flatMap((it, i) => (it.max > it.min && Number.isFinite(it.max) ? [i] : []))
  const room = bounded.reduce((s, i) => s + items[i].max - items[i].min, 0)
  if (room <= budget) {
    for (const i of bounded) sizes[i] = items[i].max
    budget -= room
  } else {
    const grown = (k: number): number =>
      bounded.reduce(
        (s, i) => s + Math.min(items[i].max, Math.max(items[i].min, items[i].max * k)),
        0
      )
    const target = budget + bounded.reduce((s, i) => s + items[i].min, 0)
    const k = bisectBelow(grown, target, 0, 1)
    for (const i of bounded) {
      sizes[i] = Math.min(items[i].max, Math.max(items[i].min, items[i].max * k))
    }
    budget = 0
  }
  const stretch = items.flatMap((it, i) => (it.max === Infinity ? [i] : []))
  if (stretch.length === 0 || budget <= 0) return sizes
  const fill = (t: number): number =>
    stretch.reduce((s, i) => s + Math.max(items[i].min, items[i].weight * t), 0)
  const target = budget + stretch.reduce((s, i) => s + items[i].min, 0)
  // fill(t) ≥ Σweight × t, so t = target / Σweight already reaches the target.
  const weights = stretch.reduce((s, i) => s + items[i].weight, 0)
  const t = bisectBelow(fill, target, 0, target / Math.max(1e-9, weights))
  for (const i of stretch) sizes[i] = Math.max(items[i].min, items[i].weight * t)
  return sizes
}

/** Place one member inside its slot: flexible fills it, rigid keeps its size at the slot's
 *  top-left, aspect takes the largest box of its own w:h that fits (top-left). */
function fitMember(m: Member, slot: Rect): Cell {
  if (m.cls === 'flexible') return { id: m.id, ...slot, sized: true }
  if (m.cls === 'rigid') return { id: m.id, x: slot.x, y: slot.y, w: m.w, h: m.h, sized: false }
  const r = m.w / m.h
  if (slot.w / slot.h >= r) {
    return {
      id: m.id,
      x: slot.x,
      y: slot.y,
      w: Math.min(slot.w, Math.round(slot.h * r)),
      h: slot.h,
      sized: true
    }
  }
  return {
    id: m.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: Math.min(slot.h, Math.round(slot.w / r)),
    sized: true
  }
}

/** Lay `n` into `rect` (whole px). Returns false when a hero region fell short of its share. */
function place(n: LNode, rect: Rect, out: Cell[]): boolean {
  if (n.kind === 'leaf') {
    out.push(fitMember(n.m, rect))
    return true
  }
  const along = n.axis === 'x' ? rect.w : rect.h
  const cross = n.axis === 'x' ? rect.h : rect.w
  const items = n.kids.map((k, i) => ({ ...measure(k, n.axis, cross), weight: n.weights[i] }))
  const budget = along - ROLE_GAP * (n.kids.length - 1)
  const sizes = distribute(budget, items)
  let ok = n.share === undefined || items[0].max !== Infinity || sizes[0] >= n.share * budget - 1e-6
  const start = n.axis === 'x' ? rect.x : rect.y
  const stretches = items.some((it) => it.max === Infinity)
  let acc = start
  n.kids.forEach((k, i) => {
    const s0 = Math.round(acc)
    const last = i === n.kids.length - 1
    // A stretching split fills its rect exactly — pin the last edge against float drift.
    const s1 = last && stretches ? start + along : Math.round(acc + sizes[i])
    const kid =
      n.axis === 'x'
        ? { x: s0, y: rect.y, w: s1 - s0, h: rect.h }
        : { x: rect.x, y: s0, w: rect.w, h: s1 - s0 }
    ok = place(k, kid, out) && ok
    acc += sizes[i] + ROLE_GAP
  })
  return ok
}

/** Lay a tree into a `frame` (bumped to the tree's minimum, so it spills rather than squeeze). */
export function layoutTree(
  root: LNode,
  frame: { w: number; h: number }
): { cells: Cell[]; shareOk: boolean } {
  const min = treeMin(root)
  const cells: Cell[] = []
  const shareOk = place(
    root,
    { x: 0, y: 0, w: Math.max(frame.w, min.w), h: Math.max(frame.h, min.h) },
    cells
  )
  return { cells, shareOk }
}

const hasShare = (n: LNode): boolean =>
  n.kind === 'split' && (n.share !== undefined || n.kids.some(hasShare))

/**
 * Solve a template tree against the pane. `zHard` = the closed-form largest zoom whose frame
 * holds every minimum (capped at `zMax`). A FLEXIBLE hero region's share (§4: 62 / 50 / 45 / 65 /
 * 70 %) is soft: the zoom drops further to honour it, but only while that stays readable — a
 * share that can only be met below `readable` (or never) is waived instead of costing legibility.
 */
export function solveTree(
  root: LNode,
  avail: { w: number; h: number },
  zMax: number,
  readable: number
): Solved {
  const min = treeMin(root)
  const zHard = Math.max(FIT_MIN_ZOOM, Math.min(zMax, avail.w / min.w, avail.h / min.h))
  let z = zHard
  if (hasShare(root)) {
    const ok = (t: number): boolean => layoutTree(root, frameAt(avail, t)).shareOk
    if (!ok(zHard) && ok(FIT_MIN_ZOOM)) {
      // ok() holds at the floor and fails at zHard: bisect the boundary (lo stays feasible).
      let lo = FIT_MIN_ZOOM
      let hi = zHard
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        if (ok(mid)) lo = mid
        else hi = mid
      }
      if (lo >= Math.min(readable, zHard)) z = lo
    }
  }
  const zq = quantizeZoom(z)
  return { z: zq, cells: layoutTree(root, frameAt(avail, zq)).cells }
}

// ── grid (peers) ─────────────────────────────────────────────────────────────────────────────

function gridMin(
  ms: readonly Member[],
  cols: number
): { w: number; h: number; cw: number; ch: number } {
  // Linear scans, not Math.max(...spread) (V8's argument ceiling, BUG-015).
  const cw = ms.reduce((v, m) => Math.max(v, m.minW), 0)
  const ch = ms.reduce((v, m) => Math.max(v, m.minH), 0)
  const rowsN = Math.ceil(ms.length / cols)
  return { w: cols * cw + (cols - 1) * ROLE_GAP, h: rowsN * ch + (rowsN - 1) * ROLE_GAP, cw, ch }
}

/** §4 `grid`: the column count whose smallest cell reads at the highest (uncapped) zoom on this
 *  pane; ties keep fewer columns. */
export function gridColumns(ms: readonly Member[], avail: { w: number; h: number }): number {
  let best = 1
  let bestZ = -Infinity
  for (let c = 1; c <= ms.length; c++) {
    const min = gridMin(ms, c)
    const z = Math.min(avail.w / min.w, avail.h / min.h)
    if (z > bestZ + 1e-12) {
      best = c
      bestZ = z
    }
  }
  return best
}

/** Equal cells, `cols` per row in member order; a short last row is centred (S8: 3 + 2). */
export function solveGrid(
  ms: readonly Member[],
  cols: number,
  avail: { w: number; h: number },
  zMax: number
): Solved {
  const min = gridMin(ms, cols)
  const z = quantizeZoom(Math.max(FIT_MIN_ZOOM, Math.min(zMax, avail.w / min.w, avail.h / min.h)))
  const frame = frameAt(avail, z)
  const rowsN = Math.ceil(ms.length / cols)
  const cw = Math.max(min.cw, (frame.w - (cols - 1) * ROLE_GAP) / cols)
  const ch = Math.max(min.ch, (frame.h - (rowsN - 1) * ROLE_GAP) / rowsN)
  const cells = ms.map((m, i) => {
    const row = Math.floor(i / cols)
    const inRow = Math.min(cols, ms.length - row * cols)
    const offset = ((cols - inRow) * (cw + ROLE_GAP)) / 2
    const left = offset + (i - row * cols) * (cw + ROLE_GAP)
    const top = row * (ch + ROLE_GAP)
    const x = Math.round(left)
    const y = Math.round(top)
    return fitMember(m, { x, y, w: Math.round(left + cw) - x, h: Math.round(top + ch) - y })
  })
  return { z, cells }
}

// ── shelf (docs) ─────────────────────────────────────────────────────────────────────────────

/** Row-width multipliers tried by `shelf` (C4's 0.6 … 1.6, built from integers). */
const SHELF_FACTORS: readonly number[] = Array.from({ length: 11 }, (_, i) => (6 + i) / 10)

export interface ShelfItem {
  id: string
  w: number
  h: number
  /** A kanban: when at least half a row wide it takes a row of its own (§4). */
  tracker: boolean
}

function shelfPack(
  items: readonly ShelfItem[],
  targetW: number
): { cells: Cell[]; w: number; h: number; rows: number } {
  const cells: Cell[] = []
  let x = 0
  let y = 0
  let rowH = 0
  let inRow = 0
  let rowsN = 1
  let w = 0
  const breakRow = (): void => {
    if (inRow === 0) return
    y += rowH + ROLE_GAP
    x = 0
    rowH = 0
    inRow = 0
    rowsN++
  }
  for (const it of items) {
    const alone = it.tracker && it.w * 2 >= targetW
    if (alone || (inRow > 0 && x + it.w > targetW)) breakRow()
    cells.push({ id: it.id, x, y, w: it.w, h: it.h, sized: false })
    w = Math.max(w, x + it.w)
    x += it.w + ROLE_GAP
    rowH = Math.max(rowH, it.h)
    inRow++
    if (alone) breakRow()
  }
  if (inRow === 0 && rowsN > 1) rowsN--
  return { cells, w, h: inRow === 0 ? y - ROLE_GAP : y + rowH, rows: rowsN }
}

/**
 * §4 `shelf`: rows in the given (reading) order, sizes kept, a wide tracker on a row of its own.
 * Tries C4's row widths toward the pane aspect and keeps the one that fits the pane best (tie ⇒
 * fewer rows ⇒ the earlier candidate).
 */
export function shelfLayout(items: readonly ShelfItem[], pane: { w: number; h: number }): Cell[] {
  const avail = availOf(pane)
  const area = items.reduce((s, it) => s + it.w * it.h, 0)
  const base = Math.sqrt(area * (pane.w / pane.h))
  let best: ReturnType<typeof shelfPack> | null = null
  let bestScore = -Infinity
  for (const targetW of [...SHELF_FACTORS.map((f) => base * f), Infinity, 0]) {
    const s = shelfPack(items, targetW)
    const score = Math.min(avail.w / Math.max(1, s.w), avail.h / Math.max(1, s.h))
    if (best === null || score > bestScore || (score === bestScore && s.rows < best.rows)) {
      best = s
      bestScore = score
    }
  }
  return best ? best.cells : []
}
