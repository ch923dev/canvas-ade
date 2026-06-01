# Smart Alignment Guides — Slice 2a (Gap-snap + Overlap deterrent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax. This slice BUILDS ON slice 1 (already committed: `lib/alignmentGuides.ts`,
> `canvas/AlignmentGuides.tsx`, the `Canvas.tsx` wiring).

**Goal:** While dragging a board, in addition to slice-1 edge/center alignment, snap it to a clean
16px gutter beside a neighbor, show a gap pill with the distance, and tint any live overlap with
another board — a soft "don't stack" nudge that never blocks the drop.

**Architecture:** Extend the pure `lib/alignmentGuides.ts`: the `Guide` becomes a tagged union
(`align` | `gap`); `computeAlignment` gains 16px gap-snap candidates between axis-neighbors and now
also returns the world-space `overlaps` (rect intersections of the snapped dragged rect vs every
other board). The overlay (`AlignmentGuides.tsx`) branches on guide kind — align line, gap
ticks+connector+pill, overlap tint rect — all projected world→screen the same way. `Canvas.tsx`
threads the new `overlaps` into the overlay.

**Tech Stack:** React 18, TypeScript (strict), `@xyflow/react` v12, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-alignment-guides.md` (§ "Slice 2a design").
**Builds on:** `docs/superpowers/plans/2026-05-31-alignment-guides.md` (slice 1).

---

## File Structure

- **Modify** `src/renderer/src/lib/alignmentGuides.ts` — `Guide` union, `GAP_SNAP_PX`, gap-snap +
  overlap in `computeAlignment`, gap/rect projection helpers.
- **Modify** `src/renderer/src/lib/alignmentGuides.test.ts` — update slice-1 expectations for the
  `kind` field; add gap-snap, overlap, projection tests.
- **Modify** `src/renderer/src/canvas/AlignmentGuides.tsx` — render gap indicators + overlap tints.
- **Modify** `src/renderer/src/index.css` — gap pill / tick / overlap-wash styles.
- **Modify** `src/renderer/src/canvas/Canvas.tsx` — thread `overlaps` into the overlay.

---

### Task 1: Extend detection — `Guide` union, gap-snap, overlaps

**Files:**
- Modify: `src/renderer/src/lib/alignmentGuides.ts`
- Test: `src/renderer/src/lib/alignmentGuides.test.ts`

- [ ] **Step 1: Update the failing tests**

First, update the EXISTING slice-1 assertions for the new `kind` field, then add new cases. Replace
the whole `computeAlignment — edge + center` describe block's guide assertions to expect
`kind: 'align'`, and append the new blocks. Full replacement test file content for the
`computeAlignment` group + new groups:

```ts
// ── append these describe blocks; and in the existing edge+center block, every
//    guide assertion gains `kind: 'align'`. Concretely update the two spots:
//    expect(g!.pos)... stays; add: expect(g!.kind).toBe('align')
//    and the "both axes" test: expect(r.guides.every(g => g.kind === 'align')).toBe(true)

describe('computeAlignment — gap-snap (16px gutter between neighbors)', () => {
  // Two boards that vertically overlap (axis-neighbors on X): dragged to the RIGHT of other.
  test('snaps to a 16px gutter on the right of a vertical-neighbor', () => {
    // other at x=100..200, y=0..100. dragged 100x100 approaching other's right edge (200)
    // with a ~16px gap: dragged.left target = 200 + 16 = 216. Put it at 214 (diff 2).
    const r = computeAlignment({ x: 214, y: 0, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(216) // snapped to other.right + 16
    const gap = r.guides.find((g) => g.kind === 'gap')
    expect(gap).toBeDefined()
    expect(gap).toMatchObject({ kind: 'gap', axis: 'x', distance: 16 })
  })

  test('snaps to a 16px gutter on the left of a vertical-neighbor', () => {
    // other x=300..400. dragged.right target = 300 - 16 = 284 ⇒ x = 184. approach at 186 (diff 2)
    const r = computeAlignment({ x: 186, y: 0, w: 100, h: 100 }, [{ x: 300, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(184)
    expect(r.guides.some((g) => g.kind === 'gap' && g.axis === 'x' && g.distance === 16)).toBe(true)
  })

  test('does NOT gap-snap to a non-neighbor (perpendicular ranges do not overlap)', () => {
    // other is far below (y 500..600) — no Y overlap with dragged (y 0..100) → no gutter meaning.
    const r = computeAlignment({ x: 214, y: 0, w: 100, h: 100 }, [{ x: 100, y: 500, w: 100, h: 100 }], 8)
    expect(r.x).toBe(214) // unchanged
    expect(r.guides.some((g) => g.kind === 'gap')).toBe(false)
  })

  test('edge/center ALIGN wins over a gap candidate at equal proximity', () => {
    // Construct a case where an align stop and a gap target are both in range; align must win.
    // other x=100..200,y=0..100. dragged left=205 → align(left↔right=200) diff5;
    // gap right+16=216 vs dragged.left 205 diff 11. Align closer → align wins.
    const r = computeAlignment({ x: 205, y: 0, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(200) // aligned dragged.left to other.right (edge touch), NOT the gutter
    expect(r.guides.some((g) => g.kind === 'align')).toBe(true)
  })
})

describe('computeAlignment — overlap detection', () => {
  test('returns the intersection rect of the snapped dragged board vs an overlapped board', () => {
    // dragged sits on top of other with no near snap (threshold tiny) → overlap reported.
    const r = computeAlignment({ x: 150, y: 50, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 0)
    expect(r.overlaps).toHaveLength(1)
    expect(r.overlaps[0]).toEqual({ x: 150, y: 50, w: 50, h: 50 })
  })

  test('flush/touching boards are NOT an overlap (zero area)', () => {
    // dragged.left = other.right exactly → edges touch, area 0.
    const r = computeAlignment({ x: 200, y: 0, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 0)
    expect(r.overlaps).toEqual([])
  })

  test('no overlap when boards are apart', () => {
    const r = computeAlignment({ x: 400, y: 400, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 0)
    expect(r.overlaps).toEqual([])
  })
})

describe('GAP_SNAP_PX', () => {
  test('is the documented 16', () => {
    expect(GAP_SNAP_PX).toBe(16)
  })
})
```

Also update the import line of the test to include `GAP_SNAP_PX`:
```ts
import { computeAlignment, projectGuide, SNAP_THRESHOLD_PX, GAP_SNAP_PX, type Rect } from './alignmentGuides'
```
And in the existing edge+center tests, add `expect(g!.kind).toBe('align')` where a guide is checked,
and change the "both axes" assertion to `expect(r.guides.every((g) => g.kind === 'align')).toBe(true)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — `GAP_SNAP_PX` undefined, `r.overlaps` undefined, `kind` missing.

- [ ] **Step 3: Rewrite `alignmentGuides.ts` (detection half)**

Replace the file's type + detection section (keep `projectGuide` at the bottom; it will be narrowed
in Task 2). New content from the top through `computeAlignment`:

```ts
/**
 * Pure smart-alignment detection (Canva/Figma "helper lines"). Given the dragged board's
 * candidate rect and the other boards, find — within `threshold` (WORLD units) — the nearest
 * per-axis EDGE/CENTER alignment (slice 1) or a 16px GUTTER beside an axis-neighbor (slice 2a),
 * return the snapped top-left, the guide(s) to draw, and any live overlap rectangles. No React,
 * no store — unit-tested like the other lib/*.ts.
 *
 * Snap math: a stop is `origin + offset`; to land it on `target`, shift origin by `target - stop`.
 * The single smallest qualifying diff per axis wins; edge/center alignment beats a gap candidate at
 * equal diff (aligning edges is primary, the gutter is the keep-apart fallback). Threshold is a
 * screen-px value divided by zoom by the caller so the feel is constant across zoom.
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** An edge/center alignment line in WORLD coords (slice 1). `axis:'x'` = vertical line at world-x
 *  `pos` spanning world-y [start,end]; `axis:'y'` = horizontal at world-y `pos` spanning [start,end]. */
export interface AlignGuide {
  kind: 'align'
  axis: 'x' | 'y'
  pos: number
  start: number
  end: number
}

/** A gutter/gap indicator in WORLD coords (slice 2a). The gutter runs along `axis`, centered at
 *  `pos` with width `distance`; `perp` is the perpendicular coordinate to anchor the connector+pill. */
export interface GapGuide {
  kind: 'gap'
  axis: 'x' | 'y'
  pos: number
  perp: number
  distance: number
}

export type Guide = AlignGuide | GapGuide

export interface AlignResult {
  /** Snapped top-left (unchanged on an axis with no match). */
  x: number
  y: number
  /** 0–2 guide lines/indicators (≤1 per axis). */
  guides: Guide[]
  /** World-space intersection rects of the snapped dragged board vs overlapped boards. */
  overlaps: Rect[]
}

/** Screen px the dragged edge must be within to snap (caller divides by zoom). */
export const SNAP_THRESHOLD_PX = 8
/** Gutter width the gap-snap offers beside a neighbor (flush=0 is handled by edge alignment). */
export const GAP_SNAP_PX = 16

interface OtherAxis {
  origin: number
  size: number
  perpMin: number
  perpMax: number
}

/** Internal winner for one axis: the snapped origin + the guide to draw. */
interface AxisMatch {
  origin: number
  guide: Guide
  diff: number
}

/** Stops along an axis: [near edge, center, far edge]. */
function stops(origin: number, size: number): [number, number, number] {
  return [origin, origin + size / 2, origin + size]
}

/** Do two [min,max] ranges overlap (strictly)? Used to gate gap-snap to real axis-neighbors. */
function rangesOverlap(aMin: number, aMax: number, bMin: number, bMax: number): boolean {
  return Math.max(aMin, bMin) < Math.min(aMax, bMax)
}

function bestAxisMatch(
  axis: 'x' | 'y',
  dragOrigin: number,
  dragSize: number,
  dragPerpMin: number,
  dragPerpMax: number,
  others: OtherAxis[],
  threshold: number
): AxisMatch | null {
  const dStops = stops(dragOrigin, dragSize)
  let best: AxisMatch | null = null
  const consider = (diff: number, origin: number, guide: Guide): void => {
    if (diff > threshold) return
    // Strict `<` keeps the first-found winner on ties → align (added first) beats gap.
    if (best && diff >= best.diff) return
    best = { diff, origin, guide }
  }

  for (const o of others) {
    const oStops = stops(o.origin, o.size)
    const perpOverlap = rangesOverlap(dragPerpMin, dragPerpMax, o.perpMin, o.perpMax)
    // 1) ALIGN candidates (edge/center vs edge/center).
    for (const ds of dStops) {
      for (const os of oStops) {
        consider(Math.abs(ds - os), dragOrigin + (os - ds), {
          kind: 'align',
          axis,
          pos: os,
          start: Math.min(dragPerpMin, o.perpMin),
          end: Math.max(dragPerpMax, o.perpMax)
        })
      }
    }
    // 2) GAP candidates (16px gutter), only between axis-neighbors.
    if (perpOverlap) {
      const perp = (Math.max(dragPerpMin, o.perpMin) + Math.min(dragPerpMax, o.perpMax)) / 2
      const g = GAP_SNAP_PX
      // dragged to the LEFT of other: dragged far-edge (origin+size) == other.near-edge - g.
      const leftOrigin = o.origin - g - dragSize
      consider(Math.abs(dragOrigin - leftOrigin), leftOrigin, {
        kind: 'gap',
        axis,
        pos: o.origin - g / 2,
        perp,
        distance: g
      })
      // dragged to the RIGHT of other: dragged near-edge (origin) == other.far-edge + g.
      const rightOrigin = o.origin + o.size + g
      consider(Math.abs(dragOrigin - rightOrigin), rightOrigin, {
        kind: 'gap',
        axis,
        pos: o.origin + o.size + g / 2,
        perp,
        distance: g
      })
    }
  }
  return best
}

/** Axis-independent rect intersection, or null if they do not strictly overlap (touching = null). */
function intersect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function computeAlignment(rect: Rect, others: Rect[], threshold: number): AlignResult {
  const xMatch = bestAxisMatch(
    'x',
    rect.x,
    rect.w,
    rect.y,
    rect.y + rect.h,
    others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h })),
    threshold
  )
  const yMatch = bestAxisMatch(
    'y',
    rect.y,
    rect.h,
    rect.x,
    rect.x + rect.w,
    others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w })),
    threshold
  )

  const x = xMatch ? xMatch.origin : rect.x
  const y = yMatch ? yMatch.origin : rect.y
  const guides: Guide[] = []
  if (xMatch) guides.push(xMatch.guide)
  if (yMatch) guides.push(yMatch.guide)

  // Overlaps use the SNAPPED rect so a snapped-flush/gutter board reports none.
  const snapped: Rect = { x, y, w: rect.w, h: rect.h }
  const overlaps: Rect[] = []
  for (const o of others) {
    const hit = intersect(snapped, o)
    if (hit) overlaps.push(hit)
  }

  return { x, y, guides, overlaps }
}
```

> Note on `pos` for a gap guide: it is the MID of the gutter on `axis`. For "dragged left of other"
> the gutter is `[other.left - g, other.left]` → mid `other.left - g/2`. For "dragged right of other"
> the gutter is `[other.right, other.right + g]` → mid `other.right + g/2`. (`o.origin` is the near
> edge, `o.origin + o.size` the far edge, per the axis mapping in `computeAlignment`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS (all groups — slice-1 align with `kind`, gap-snap, overlap, `GAP_SNAP_PX`).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): gap-snap + overlap detection, tagged guide union (slice 2a)"
```

---

### Task 2: Projection helpers — narrow `projectGuide`, add gap + rect projection

**Files:**
- Modify: `src/renderer/src/lib/alignmentGuides.ts` (the projection section at the bottom)
- Test: `src/renderer/src/lib/alignmentGuides.test.ts`

- [ ] **Step 1: Add the failing tests**

Append:

```ts
describe('projectGapGuide + projectRect — world → screen', () => {
  test('x-axis gap: horizontal connector at perp, label at gutter mid', () => {
    const v = projectGapGuide(
      { kind: 'gap', axis: 'x', pos: 100, perp: 50, distance: 16 },
      [10, 20, 2]
    )
    // connector spans pos±d/2 = [92,108] on x, at y = 50*2+20 = 120
    expect(v).toEqual({ ax: 194, ay: 120, bx: 226, by: 120, lx: 210, ly: 120, distance: 16 })
  })

  test('y-axis gap: vertical connector at perp', () => {
    const v = projectGapGuide(
      { kind: 'gap', axis: 'y', pos: 100, perp: 50, distance: 16 },
      [10, 20, 2]
    )
    // connector spans pos±d/2 = [92,108] on y, at x = 50*2+10 = 110
    expect(v).toEqual({ ax: 110, ay: 204, bx: 110, by: 236, lx: 110, ly: 220, distance: 16 })
  })

  test('projectRect maps a world rect to a screen rect', () => {
    const s = projectRect({ x: 100, y: 50, w: 20, h: 30 }, [10, 20, 2])
    expect(s).toEqual({ x: 210, y: 120, w: 40, h: 60 })
  })
})
```

Add the new names to the test import:
```ts
import { computeAlignment, projectGuide, projectGapGuide, projectRect, SNAP_THRESHOLD_PX, GAP_SNAP_PX, type Rect } from './alignmentGuides'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — `projectGapGuide`/`projectRect` undefined.

- [ ] **Step 3: Replace the projection section of `alignmentGuides.ts`**

Replace the existing `ScreenLine` + `projectGuide` block at the bottom with:

```ts
/** An align guide projected into screen-space pixels for SVG. */
export interface ScreenLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Project a WORLD-space ALIGN guide into screen pixels using React Flow's viewport transform
 * `[translateX, translateY, zoom]`: screen = world*zoom + translate. Stroke width stays in screen
 * px at the call site, so the 1px line is crisp at any zoom.
 */
export function projectGuide(g: AlignGuide, transform: [number, number, number]): ScreenLine {
  const [tx, ty, zoom] = transform
  if (g.axis === 'x') {
    const sx = g.pos * zoom + tx
    return { x1: sx, y1: g.start * zoom + ty, x2: sx, y2: g.end * zoom + ty }
  }
  const sy = g.pos * zoom + ty
  return { x1: g.start * zoom + tx, y1: sy, x2: g.end * zoom + tx, y2: sy }
}

/** A gap guide projected to screen: a connector segment (a→b) + a label anchor + the distance. */
export interface GapVisual {
  ax: number
  ay: number
  bx: number
  by: number
  lx: number
  ly: number
  distance: number
}

/** Project a WORLD-space GAP guide to screen pixels (connector + label anchor). */
export function projectGapGuide(g: GapGuide, transform: [number, number, number]): GapVisual {
  const [tx, ty, zoom] = transform
  const half = g.distance / 2
  if (g.axis === 'x') {
    const y = g.perp * zoom + ty
    return {
      ax: (g.pos - half) * zoom + tx,
      ay: y,
      bx: (g.pos + half) * zoom + tx,
      by: y,
      lx: g.pos * zoom + tx,
      ly: y,
      distance: g.distance
    }
  }
  const x = g.perp * zoom + tx
  return {
    ax: x,
    ay: (g.pos - half) * zoom + ty,
    bx: x,
    by: (g.pos + half) * zoom + ty,
    lx: x,
    ly: g.pos * zoom + ty,
    distance: g.distance
  }
}

/** A world rect projected to a screen rect (for overlap tint). */
export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

export function projectRect(r: Rect, transform: [number, number, number]): ScreenRect {
  const [tx, ty, zoom] = transform
  return { x: r.x * zoom + tx, y: r.y * zoom + ty, w: r.w * zoom, h: r.h * zoom }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): gap-guide + rect screen projection (slice 2a)"
```

---

### Task 3: Render gap indicators + overlap tint in the overlay

**Files:**
- Modify: `src/renderer/src/canvas/AlignmentGuides.tsx`
- Modify: `src/renderer/src/index.css`

- [ ] **Step 1: Rewrite `AlignmentGuides.tsx` to branch on guide kind + draw overlaps**

```tsx
// src/renderer/src/canvas/AlignmentGuides.tsx
/**
 * Screen-space SVG overlay for drag-time alignment feedback. Subscribes to the live camera
 * transform (`useStore(s => s.transform)`) so everything tracks pan/zoom and stays crisp (stroke /
 * pill sizes are screen px, NOT scaled by the viewport). `pointer-events:none` — never intercepts
 * the drag. Draws: align lines (slice 1), gap indicators (connector + ticks + Npx pill, slice 2a),
 * and overlap tint rects (slice 2a). Renders nothing when there is nothing active. Must be mounted
 * under <ReactFlowProvider>.
 */
import { type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import {
  projectGuide,
  projectGapGuide,
  projectRect,
  type Guide,
  type Rect
} from '../lib/alignmentGuides'

const TICK = 5 // half-length (screen px) of the perpendicular end ticks on a gap connector

export function AlignmentGuides({
  guides,
  overlaps
}: {
  guides: Guide[]
  overlaps: Rect[]
}): ReactElement | null {
  const transform = useStore((s) => s.transform)
  if (guides.length === 0 && overlaps.length === 0) return null
  return (
    <svg className="align-guides" aria-hidden="true">
      {overlaps.map((o, i) => {
        const r = projectRect(o, transform)
        return <rect key={`o${i}`} className="align-overlap" x={r.x} y={r.y} width={r.w} height={r.h} />
      })}
      {guides.map((g, i) => {
        if (g.kind === 'align') {
          const l = projectGuide(g, transform)
          return <line key={`a${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        }
        const v = projectGapGuide(g, transform)
        // Connector + two perpendicular end ticks. Ticks are perpendicular to the connector axis.
        const vertical = g.axis === 'y'
        const tick = (cx: number, cy: number): ReactElement =>
          vertical ? (
            <line className="align-tick" x1={cx - TICK} y1={cy} x2={cx + TICK} y2={cy} />
          ) : (
            <line className="align-tick" x1={cx} y1={cy - TICK} x2={cx} y2={cy + TICK} />
          )
        return (
          <g key={`g${i}`} className="align-gap">
            <line className="align-connector" x1={v.ax} y1={v.ay} x2={v.bx} y2={v.by} />
            <g>{tick(v.ax, v.ay)}</g>
            <g>{tick(v.bx, v.by)}</g>
            <rect className="align-pill" x={v.lx - 14} y={v.ly - 8} width={28} height={16} rx={3} />
            <text className="align-pill-text" x={v.lx} y={v.ly} textAnchor="middle" dominantBaseline="central">
              {v.distance}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
```

- [ ] **Step 2: Extend the `.align-guides` styles in `index.css`**

Replace the slice-1 `.align-guides` block with:

```css
/* Smart alignment guides (drag-time): screen-space SVG over the canvas, never interactive.
   Dashed accent line = edge/center align; connector + Npx pill = gutter; wash = overlap nudge. */
.align-guides {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
  z-index: 5; /* above board nodes, below floating app chrome */
}
.align-guides line {
  stroke: var(--accent);
  stroke-width: 1;
  stroke-dasharray: 4 6;
  shape-rendering: crispEdges;
}
.align-guides .align-connector,
.align-guides .align-tick {
  stroke: var(--accent);
  stroke-width: 1;
  stroke-dasharray: none; /* gutter marks are solid, distinct from dashed align lines */
}
.align-guides .align-pill {
  fill: var(--accent);
  stroke: none;
}
.align-guides .align-pill-text {
  fill: #fff;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
/* Overlap nudge: a translucent accent wash over the intersection (no border, no force). */
.align-guides .align-overlap {
  fill: rgba(255, 92, 92, 0.18); /* soft red — reads as "you're stacking" without alarm */
  stroke: none;
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck`
Expected: PASS (the overlay's props now include `overlaps`; Task 4 supplies it — but the component
compiles standalone).

- [ ] **Step 4: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/canvas/AlignmentGuides.tsx src/renderer/src/index.css
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): render gap pills + overlap tint in the overlay (slice 2a)"
```

---

### Task 4: Thread `overlaps` through `Canvas.tsx`

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Add overlap state next to the guides state**

Find the slice-1 `const [guides, setGuides] = useState<Guide[]>([])` and add below it:

```ts
  // Live overlap rects (snapped dragged board vs others) — drives the soft overlap tint.
  const [overlaps, setOverlaps] = useState<Rect[]>([])
```

Update the `Guide` import to also bring `Rect`:
```ts
import { computeAlignment, SNAP_THRESHOLD_PX, type Guide, type Rect } from '../lib/alignmentGuides'
```

- [ ] **Step 2: Set overlaps in the snap pass + clear alongside guides**

In `onNodesChange`, the slice-1 snap branch sets `setGuides(snap.guides)`. Add the overlaps set right
after it:
```ts
          setGuides(snap.guides)
          setOverlaps(snap.overlaps)
```
In the `else if (active.length > 0)` clear branch, mirror the guides clear:
```ts
      } else if (active.length > 0) {
        setGuides((g) => (g.length ? [] : g))
        setOverlaps((o) => (o.length ? [] : o))
      }
```
In `onNodeDragStop`, clear overlaps too:
```ts
  const onNodeDragStop = useCallback(() => {
    setNodeGesture(false)
    setGuides((g) => (g.length ? [] : g))
    setOverlaps((o) => (o.length ? [] : o))
  }, [setNodeGesture])
```

- [ ] **Step 3: Pass overlaps to the overlay**

Update the render site:
```tsx
          <AlignmentGuides guides={guides} overlaps={overlaps} />
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck && pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" lint`
Expected: PASS, no unused locals/params.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/canvas/Canvas.tsx
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): thread overlap tint into Canvas overlay (slice 2a)"
```

---

### Task 5: Full verification + manual check + e2e gate

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run`
Expected: PASS — all prior + the new gap-snap/overlap/projection tests.

- [ ] **Step 2: Typecheck + lint (whole repo)**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck && pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" lint`
Expected: PASS.

- [ ] **Step 3: Manual check in dev**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" dev`
1. Drag a board beside another (same row) → it snaps to a 16px gutter, a connector + `16` pill shows.
2. Slide closer → edge-touch (flush) snaps via the slice-1 line (no pill); still no overlap.
3. Drag a board ON TOP of another → the overlap region tints soft red; releasing leaves it (no block).
4. Hold Ctrl/⌘ → gap-snap + guides suppressed (overlap tint also clears — it's part of the snap pass).
5. Zoom in/out → pill text stays ~10px, ticks ~5px, lines 1px.

- [ ] **Step 4: Board e2e harness**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" build`, then set `CANVAS_SMOKE=e2e` and start
electron (`$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" start`).
Expected: `E2E_DONE`, all parts `ok:true`. The browser/browser-gesture/focus-detach trio is the
known env capturePage flake — rerun once for a clean pass; not a regression (this slice only adds an
HTML overlay + a pure-fn snap, no native-view path change).

- [ ] **Step 5: Commit any fixups**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add -A
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "chore(align): slice 2a verified (unit + typecheck + lint + e2e)"
```

---

## Self-Review

**Spec coverage (slice 2a):**
- Gap-snap flush+16 → Task 1 (gap candidates; flush via slice-1 edge align, 16 via gap). ✓
- Gap pill (`Npx`) → Task 2 (projectGapGuide) + Task 3 (pill render). ✓
- Overlap soft tint, never blocks → Task 1 (overlaps from snapped rect) + Task 3 (wash rect) + Task 4
  (no clamp — only `position` already snapped; overlap is render-only). ✓
- Neighbor-only gutter → Task 1 `rangesOverlap` guard. ✓
- Align beats gap on ties → Task 1 strict-`<` ordering, align considered first. ✓
- Constant screen sizes / track zoom → Task 2 projection + Task 3 screen-px stroke/font. ✓
- Reduced-motion safe (instant) → unchanged from slice 1. ✓
- typecheck/lint/unit/e2e → Task 5. ✓

**Placeholder scan:** none — full code per step; commands have expected output.

**Type consistency:** `Guide` union (`AlignGuide` | `GapGuide`), `GapVisual`, `ScreenRect`,
`projectGuide(AlignGuide)`, `projectGapGuide(GapGuide)`, `projectRect(Rect)`, `computeAlignment →
{x,y,guides,overlaps}`, `GAP_SNAP_PX` — defined in Tasks 1–2, consumed unchanged in Tasks 3–4. The
overlay props are `{ guides: Guide[]; overlaps: Rect[] }` in both the component (Task 3) and the call
site (Task 4 Step 3). `Rect` is imported in `Canvas.tsx` (Task 4 Step 1).

**Deferred to Slice 2b:** equal-spacing distribution across 3+ boards (Excalidraw `getVisibleGaps` +
gap dedup + matching-gap snap). Out of scope here.
