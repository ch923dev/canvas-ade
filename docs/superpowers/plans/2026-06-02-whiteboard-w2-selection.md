# Whiteboard W2 — Selection core (multi-select + snapping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the Planning whiteboard a real selection set — marquee box-select, Shift-click additive,
multi-drag, group-delete — plus live edge/center snapping with alignment guides while dragging.

**Architecture:** Widen the board-local `selectedElId: string|null` to `selectedIds: Set<string>`; extend
the existing `drag.current` pointer state machine with a `marquee` mode and a multi-id `move`; add three
pure, unit-tested helper modules (`elementBBox`/`anchors`/`translateMany` in `elements.ts`, a new
`marquee.ts`, a new `snapping.ts`); render the marquee rect + snap guides in the existing `WhiteboardSvg`
draft slot. **No store changes** — W2 only calls the unchanged `beginChange()` / `updateBoard()` /
`growBoardHeight()` API (see "Base" below).

**Tech Stack:** TypeScript (strict), React 18, `@xyflow/react`, Zustand store, Vitest, the
`CANVAS_SMOKE=e2e` DOM-driven harness. pnpm.

**Base (D1.1 already integrated):** This branch (`feat/whiteboard-w2`) sits on `feat/whiteboard`
@ `cef80d4` = W1 with `origin/main` merged in, so the foundation carries **D1.1 (`trackedChange`
undo-rail refactor, PR #18)**. W2's store API (`beginChange`/`updateBoard`/`growBoardHeight`) is
byte-identical post-D1.1, and `trackedChange` is an internal helper W2 never calls. **Do not edit
`canvasStore.ts`.** The phantom-undo rule is gesture-layer: one `beginChange()` per gesture, deferred to
the actual commit (the WB-1/W1 pattern; D1.1 confirmed this cannot be done at the store layer). Spec:
`docs/superpowers/specs/2026-06-02-whiteboard-w2-selection-design.md`.

**Conventions:** TypeScript strict, no unused locals/params. Run all commands from the worktree root
`Z:\canvas-ade-whiteboard-w2`. Pure helpers are unit-tested with Vitest; React/DOM wiring is verified by
typecheck + lint + the e2e harness (selection is ephemeral component state, so e2e asserts the *effects*
via `getBoards()`, never internal state). Keep each task green before committing.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/renderer/src/canvas/boards/planning/elements.ts` | element factories/transforms + **new** bbox/anchors/union/translateMany | modify |
| `src/renderer/src/canvas/boards/planning/marquee.ts` | **new** pure box-select geometry (rect normalize + intersect + hit collection) | create |
| `src/renderer/src/canvas/boards/planning/snapping.ts` | **new** pure snap math (edge/center delta + guide lines) | create |
| `src/renderer/src/canvas/boards/planning/marquee.test.ts` | unit tests for marquee | create |
| `src/renderer/src/canvas/boards/planning/snapping.test.ts` | unit tests for snapping | create |
| `src/renderer/src/canvas/boards/planning/elements.test.ts` | extend with bbox/anchors/union/translateMany | modify |
| `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` | Set selection; render marquee rect + snap guides | modify |
| `src/renderer/src/canvas/boards/planning/NoteCard.tsx` | `selected` ring + `onSelect(id, additive)` | modify |
| `src/renderer/src/canvas/boards/planning/FreeText.tsx` | `selected` ring + `onSelect` + `onMeasure` | modify |
| `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx` | `selected` ring + `onSelect` + report `{w,h}` | modify |
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` | selection set, marquee, multi-drag, snap, snap pill, measured map | modify (heavy) |
| `src/renderer/src/canvas/Icon.tsx` | one `magnet` glyph for the snap pill | modify (additive) |
| `src/main/e2eSmoke.ts` | `drag()` helper + 3 W2 probes | modify |
| `docs/roadmap-whiteboard.md` | mark W2 done | modify (final task) |

**Shared types** (defined in Task 1, used everywhere after):
```ts
export interface BBox { x: number; y: number; w: number; h: number }
export interface Measured { w: number; h: number }
export interface Anchors { left: number; centerX: number; right: number; top: number; centerY: number; bottom: number }
// snapping.ts:
export interface Guide { axis: 'x' | 'y'; at: number; from: number; to: number } // axis:'x' = a VERTICAL guide at x=at
export interface SnapResult { dx: number; dy: number; guides: Guide[] }
```

---

## Task 1: Pure bbox / anchors / union / translateMany (`elements.ts`)

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/elements.ts`
- Test: `src/renderer/src/canvas/boards/planning/elements.test.ts`

- [ ] **Step 1: Write failing tests** — append to `elements.test.ts`:

```ts
import {
  elementBBox,
  anchors,
  unionBBox,
  translateMany,
  shiftElement,
  nominalChecklistHeight,
  TEXT_NOMINAL
} from './elements'

describe('elementBBox (per-kind, ± measured) — W2', () => {
  it('note uses schema x/y/w/h', () => {
    const n = makeNote('n', { x: 100, y: 100 }, 0)
    expect(elementBBox(n)).toEqual({ x: n.x, y: n.y, w: n.w, h: n.h })
  })
  it('text falls back to TEXT_NOMINAL, or uses measured when given', () => {
    const t = makeText('t', { x: 10, y: 20 })
    expect(elementBBox(t)).toEqual({ x: 10, y: 20, w: TEXT_NOMINAL.w, h: TEXT_NOMINAL.h })
    expect(elementBBox(t, { w: 80, h: 40 })).toEqual({ x: 10, y: 20, w: 80, h: 40 })
  })
  it('checklist uses nominal height from item count, or measured h', () => {
    const cl = makeChecklist('cl', 'i0', { x: 0, y: 0 }) // 1 item
    expect(elementBBox(cl)).toEqual({ x: cl.x, y: cl.y, w: cl.w, h: nominalChecklistHeight(1) })
    expect(elementBBox(cl, { w: cl.w, h: 222 }).h).toBe(222)
  })
  it('arrow returns the endpoint extent box (no top-left assumption)', () => {
    const a = { ...makeArrow('a', { x: 30, y: 50 }), x2: 10, y2: 90 }
    expect(elementBBox(a)).toEqual({ x: 10, y: 50, w: 20, h: 40 })
  })
  it('stroke returns the min/max extent of its points', () => {
    const s = makeStroke('s', [5, 5, 25, 15, 15, 35])
    expect(elementBBox(s)).toEqual({ x: 5, y: 5, w: 20, h: 30 })
  })
})

describe('anchors / unionBBox — W2', () => {
  it('anchors derives edges + centers', () => {
    expect(anchors({ x: 10, y: 20, w: 100, h: 40 })).toEqual({
      left: 10, centerX: 60, right: 110, top: 20, centerY: 40, bottom: 60
    })
  })
  it('unionBBox spans all boxes; single box is itself; empty is a zero box', () => {
    expect(unionBBox([{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 30 }]))
      .toEqual({ x: 0, y: 0, w: 30, h: 35 })
    expect(unionBBox([])).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })
})

describe('shiftElement / translateMany — W2', () => {
  it('shiftElement moves a note top-left, an arrow both ends, a stroke all points', () => {
    expect(shiftElement(makeNote('n', { x: 0, y: 0 }, 0), 5, 7)).toMatchObject({ x: 5, y: 7 })
    expect(shiftElement({ ...makeArrow('a', { x: 1, y: 2 }), x2: 3, y2: 4 }, 10, 10))
      .toMatchObject({ x: 11, y: 12, x2: 13, y2: 14 })
    expect((shiftElement(makeStroke('s', [0, 0, 2, 2]), 1, 1) as { points: number[] }).points)
      .toEqual([1, 1, 3, 3])
  })
  it('translateMany shifts only ids in the set, in one immutable pass', () => {
    const els: PlanningElement[] = [
      makeNote('a', { x: 0, y: 0 }, 0),
      makeNote('b', { x: 50, y: 0 }, 1),
      makeNote('c', { x: 100, y: 0 }, 2)
    ]
    const out = translateMany(els, new Set(['a', 'c']), 10, 20)
    expect(out).not.toBe(els)
    expect(out.map((e) => e.x)).toEqual([10, 50, 110])
    expect(out.map((e) => e.y)).toEqual([20, 0, 20])
  })
  it('translateMany accepts an array of ids and is a no-op for an empty set', () => {
    const els: PlanningElement[] = [makeNote('a', { x: 0, y: 0 }, 0)]
    expect(translateMany(els, [], 9, 9)[0].x).toBe(0)
    expect(translateMany(els, ['a'], 3, 0)[0].x).toBe(3)
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: FAIL — `elementBBox`, `anchors`, `unionBBox`, `translateMany`, `shiftElement`,
`nominalChecklistHeight`, `TEXT_NOMINAL` are not exported.

- [ ] **Step 3: Implement** — add to the bottom of `elements.ts` (after `checklistProgress`):

```ts
// ── Bounding boxes + anchors (W2: marquee selection + snapping) ───────────────

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}
export interface Measured {
  w: number
  h: number
}
export interface Anchors {
  left: number
  centerX: number
  right: number
  top: number
  centerY: number
  bottom: number
}

/** Nominal box for an auto-sized free-text element when no live DOM measurement exists. */
export const TEXT_NOMINAL: Measured = { w: 120, h: 22 }

// Approx ChecklistCard row metrics (kept in step with erase.ts's copy).
const CHECKLIST_HEADER_H = 30
const CHECKLIST_ROW_H = 24
const CHECKLIST_FOOTER_H = 24

/** Approximate rendered checklist height from its item count (board-local px). */
export function nominalChecklistHeight(itemCount: number): number {
  return CHECKLIST_HEADER_H + itemCount * CHECKLIST_ROW_H + CHECKLIST_FOOTER_H
}

/**
 * Board-local bounding box for any element kind. `measured` (a live DOM size) refines
 * the auto-sized kinds — text has no persisted w/h; checklist persists h:0 and grows.
 * Pure: tests pass `measured` explicitly; the board supplies it from a ref map at runtime.
 * Arrows/strokes have NO single top-left → use the point/endpoint extent (never w/h).
 */
export function elementBBox(el: PlanningElement, measured?: Measured): BBox {
  switch (el.kind) {
    case 'note':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
    case 'checklist':
      return {
        x: el.x,
        y: el.y,
        w: el.w,
        h: measured?.h ?? nominalChecklistHeight(el.items.length)
      }
    case 'text': {
      const m = measured ?? TEXT_NOMINAL
      return { x: el.x, y: el.y, w: m.w, h: m.h }
    }
    case 'arrow':
      return {
        x: Math.min(el.x, el.x2),
        y: Math.min(el.y, el.y2),
        w: Math.abs(el.x2 - el.x),
        h: Math.abs(el.y2 - el.y)
      }
    case 'stroke': {
      const pts = el.points
      if (pts.length < 2) return { x: el.x, y: el.y, w: 0, h: 0 }
      let minX = pts[0]
      let minY = pts[1]
      let maxX = pts[0]
      let maxY = pts[1]
      for (let i = 0; i + 1 < pts.length; i += 2) {
        if (pts[i] < minX) minX = pts[i]
        if (pts[i] > maxX) maxX = pts[i]
        if (pts[i + 1] < minY) minY = pts[i + 1]
        if (pts[i + 1] > maxY) maxY = pts[i + 1]
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    }
  }
}

/** Six alignment anchors (edges + centers) of a box. */
export function anchors(b: BBox): Anchors {
  return {
    left: b.x,
    centerX: b.x + b.w / 2,
    right: b.x + b.w,
    top: b.y,
    centerY: b.y + b.h / 2,
    bottom: b.y + b.h
  }
}

/** Smallest box covering every input box. Empty input → a zero box at the origin. */
export function unionBBox(boxes: BBox[]): BBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
    if (b.y + b.h > maxY) maxY = b.y + b.h
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Shift one element by a board-local delta, correctly per kind (the shared core of
 * translateElement + translateMany): note/text/checklist move their top-left; arrow
 * moves both endpoints; stroke moves every point pair (and keeps x/y in lockstep).
 */
export function shiftElement<E extends PlanningElement>(el: E, dx: number, dy: number): E {
  if (el.kind === 'arrow') {
    return { ...el, x: el.x + dx, y: el.y + dy, x2: el.x2 + dx, y2: el.y2 + dy }
  }
  if (el.kind === 'stroke') {
    return { ...el, x: el.x + dx, y: el.y + dy, points: el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) }
  }
  return { ...el, x: el.x + dx, y: el.y + dy }
}

/** Translate EVERY element whose id is in `ids` by (dx,dy); others untouched. Immutable. */
export function translateMany(
  els: PlanningElement[],
  ids: Iterable<string>,
  dx: number,
  dy: number
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  return els.map((el) => (set.has(el.id) ? shiftElement(el, dx, dy) : el))
}
```

- [ ] **Step 4: Refactor `translateElement` to reuse `shiftElement`** (DRY; behavior identical, existing
  tests stay green). Replace the body of the existing `translateElement` with:

```ts
export function translateElement(
  els: PlanningElement[],
  id: string,
  dx: number,
  dy: number
): PlanningElement[] {
  return els.map((el) => (el.id === id ? shiftElement(el, dx, dy) : el))
}
```

(Delete the old inline per-kind branches in `translateElement`; keep its doc comment.)

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: PASS (new W2 tests + all pre-existing `translateElement`/factory tests still green).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/elements.ts src/renderer/src/canvas/boards/planning/elements.test.ts
git commit -m "feat(whiteboard): W2 elementBBox/anchors/unionBBox/translateMany pure helpers"
```

---

## Task 2: Pure marquee geometry (`marquee.ts`)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/marquee.ts`
- Test: `src/renderer/src/canvas/boards/planning/marquee.test.ts`

- [ ] **Step 1: Write failing tests** — create `marquee.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { PlanningElement } from '../../../lib/boardSchema'
import { makeNote, makeArrow, makeStroke } from './elements'
import { rectFromPoints, rectIntersectsBBox, marqueeHits } from './marquee'

describe('rectFromPoints', () => {
  it('normalizes any corner order to a positive box', () => {
    expect(rectFromPoints(30, 40, 10, 10)).toEqual({ x: 10, y: 10, w: 20, h: 30 })
  })
})

describe('rectIntersectsBBox (intersect/touch predicate)', () => {
  const b = { x: 10, y: 10, w: 20, h: 20 } // 10..30
  it('true when overlapping', () => expect(rectIntersectsBBox({ x: 0, y: 0, w: 15, h: 15 }, b)).toBe(true))
  it('true when merely touching an edge', () => expect(rectIntersectsBBox({ x: 30, y: 10, w: 5, h: 5 }, b)).toBe(true))
  it('false when fully disjoint', () => expect(rectIntersectsBBox({ x: 40, y: 40, w: 5, h: 5 }, b)).toBe(false))
})

describe('marqueeHits', () => {
  const note = makeNote('n', { x: 0, y: 0 }, 0) // 0..156 x, 0..96 y
  const arrow = { ...makeArrow('a', { x: 300, y: 300 }), x2: 360, y2: 340 }
  const stroke = makeStroke('s', [500, 500, 520, 540])
  const els: PlanningElement[] = [note, arrow, stroke]
  it('returns exactly the ids whose bbox the rect intersects (incl. arrow + stroke)', () => {
    expect(marqueeHits(els, { x: -10, y: -10, w: 400, h: 400 })).toEqual(['n', 'a'])
    expect(marqueeHits(els, { x: 490, y: 490, w: 40, h: 60 })).toEqual(['s'])
    expect(marqueeHits(els, { x: 1000, y: 1000, w: 5, h: 5 })).toEqual([])
  })
  it('uses a measured override for an auto-sized element', () => {
    const text = makeText('t', { x: 200, y: 0 })
    const big = new Map([['t', { w: 400, h: 400 }]]) // measured spans into the rect
    expect(marqueeHits([text], { x: 0, y: 0, w: 250, h: 50 }, big)).toEqual(['t'])
  })
})
```

(Add `makeText` to the import from `./elements` in this test.)

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/marquee.test.ts`
Expected: FAIL — module `./marquee` not found.

- [ ] **Step 3: Implement** — create `marquee.ts`:

```ts
/**
 * Pure marquee (box-select) geometry for the Planning whiteboard (W2.1). No React/DOM.
 * The SIBLING of erase.ts's point-near hit-test: box-select needs rect-overlaps-bbox
 * (intersect), not point-distance. Unit-tested like elements.test.ts.
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, type BBox, type Measured } from './elements'

/** Normalize two corner points (any order) to a positive-size box. */
export function rectFromPoints(ax: number, ay: number, bx: number, by: number): BBox {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** Axis-aligned overlap. Touching edges count as a hit (intersect predicate). */
export function rectIntersectsBBox(r: BBox, b: BBox): boolean {
  return r.x <= b.x + b.w && r.x + r.w >= b.x && r.y <= b.y + b.h && r.y + r.h >= b.y
}

/** Ids of every element whose bbox the marquee rect intersects; `measured` refines auto-sized kinds. */
export function marqueeHits(
  els: PlanningElement[],
  rect: BBox,
  measured?: Map<string, Measured>
): string[] {
  return els
    .filter((el) => rectIntersectsBBox(rect, elementBBox(el, measured?.get(el.id))))
    .map((el) => el.id)
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/marquee.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/marquee.ts src/renderer/src/canvas/boards/planning/marquee.test.ts
git commit -m "feat(whiteboard): W2 pure marquee geometry (rect normalize + intersect + hits)"
```

---

## Task 3: Pure snapping math (`snapping.ts`)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/snapping.ts`
- Test: `src/renderer/src/canvas/boards/planning/snapping.test.ts`

- [ ] **Step 1: Write failing tests** — create `snapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeSnap, SNAP_TOL } from './snapping'

describe('computeSnap (edge/center, board-local, axis-independent)', () => {
  // static neighbor: left edge at x=100, top at y=0, 50x50
  const neighbor = { x: 100, y: 0, w: 50, h: 50 }

  it('snaps a left edge within tol to the neighbor left edge', () => {
    const moving = { x: 100 + 4, y: 300, w: 50, h: 50 } // 4px off → within SNAP_TOL
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect(r.dx).toBe(-4) // pulls left edge back to 100
    expect(r.dy).toBe(0)
    expect(r.guides.some((g) => g.axis === 'x' && g.at === 100)).toBe(true)
  })

  it('snaps center-to-center', () => {
    const moving = { x: 100 + 3, y: 300, w: 50, h: 50 } // centerX 128 vs neighbor 125 → -3
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect(r.dx).toBe(-3)
  })

  it('does not snap when the nearest anchor is outside tol', () => {
    const moving = { x: 100 + SNAP_TOL + 5, y: 300, w: 50, h: 50 }
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('snaps both axes independently and emits a guide per axis', () => {
    const moving = { x: 104, y: 2, w: 50, h: 50 } // left+4 off 100, top+2 off 0
    const r = computeSnap(moving, [neighbor], SNAP_TOL)
    expect([r.dx, r.dy]).toEqual([-4, -2])
    expect(r.guides.map((g) => g.axis).sort()).toEqual(['x', 'y'])
  })

  it('no neighbors → no snap', () => {
    expect(computeSnap({ x: 0, y: 0, w: 10, h: 10 }, [], SNAP_TOL)).toEqual({ dx: 0, dy: 0, guides: [] })
  })
})
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/snapping.test.ts`
Expected: FAIL — module `./snapping` not found.

- [ ] **Step 3: Implement** — create `snapping.ts`:

```ts
/**
 * Pure in-board snapping (W2.2). Aligns a dragged element's union box to neighbor
 * edges/centers within a BOARD-LOCAL tolerance, returning the delta correction to ADD
 * to the raw drag delta + the guide lines to draw. Zoom-stable because every input is
 * board-local px (the caller maps screen→board before calling). No React/DOM.
 */
import { anchors, type BBox } from './elements'

/** A guide line. `axis:'x'` = a VERTICAL line at x=`at` (snapping the X coordinate). */
export interface Guide {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}
export interface SnapResult {
  dx: number
  dy: number
  guides: Guide[]
}

/** Snap radius in board-local px (zoom-stable). */
export const SNAP_TOL = 6

const X_KEYS = ['left', 'centerX', 'right'] as const
const Y_KEYS = ['top', 'centerY', 'bottom'] as const

type AnchorKey = keyof ReturnType<typeof anchors>

/** Nearest in-tolerance alignment of `moving`'s anchors to any static neighbor's anchors, one axis. */
function bestAxis(
  moving: BBox,
  statics: BBox[],
  keys: readonly AnchorKey[],
  tol: number
): { delta: number; at: number | null; neighbor: BBox | null } {
  const mv = anchors(moving)
  let delta = 0
  let dist = tol + 1
  let at: number | null = null
  let neighbor: BBox | null = null
  for (const s of statics) {
    const sa = anchors(s)
    for (const mk of keys) {
      for (const sk of keys) {
        const d = sa[sk] - mv[mk]
        const ad = Math.abs(d)
        if (ad <= tol && ad < dist) {
          dist = ad
          delta = d
          at = sa[sk]
          neighbor = s
        }
      }
    }
  }
  return { delta, at, neighbor }
}

/**
 * @param moving  union bbox of the moving set AFTER the raw drag delta is applied.
 * @param statics bboxes of the static (non-moving) neighbor elements.
 * @param tol     snap radius (board-local px).
 */
export function computeSnap(moving: BBox, statics: BBox[], tol: number): SnapResult {
  const sx = bestAxis(moving, statics, X_KEYS, tol)
  const sy = bestAxis(moving, statics, Y_KEYS, tol)
  const guides: Guide[] = []
  if (sx.at !== null && sx.neighbor) {
    guides.push({
      axis: 'x',
      at: sx.at,
      from: Math.min(moving.y, sx.neighbor.y),
      to: Math.max(moving.y + moving.h, sx.neighbor.y + sx.neighbor.h)
    })
  }
  if (sy.at !== null && sy.neighbor) {
    guides.push({
      axis: 'y',
      at: sy.at,
      from: Math.min(moving.x, sy.neighbor.x),
      to: Math.max(moving.x + moving.w, sy.neighbor.x + sy.neighbor.w)
    })
  }
  return { dx: sx.delta, dy: sy.delta, guides }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/snapping.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/snapping.ts src/renderer/src/canvas/boards/planning/snapping.test.ts
git commit -m "feat(whiteboard): W2 pure snapping math (edge/center delta + guides)"
```

---

## Task 4: Selection set + Set plumbing + selected ring + group-delete

Migrate `selectedElId: string|null` → `selectedIds: Set<string>` atomically across `PlanningBoard`,
`WhiteboardSvg`, and the three cards; add a selected outline; make Delete remove the whole set in one
undo step. (Shift-click and marquee land in Tasks 5–6; this task selects a single element on press and
replaces the set.)

**Files:**
- Modify: `PlanningBoard.tsx`, `WhiteboardSvg.tsx`, `NoteCard.tsx`, `FreeText.tsx`, `ChecklistCard.tsx`

- [ ] **Step 1: `WhiteboardSvg` — accept a Set + an additive `onSelect`.** In `WhiteboardSvgProps`
  replace `selectedId?: string | null` and `onSelect?: (id: string) => void` with:

```ts
  /** Ids of the currently selected vector elements (arrows/strokes). */
  selectedIds?: ReadonlySet<string>
  /** Called when a committed arrow/stroke is pressed; `additive` = Shift was held. */
  onSelect?: (id: string, additive: boolean) => void
```

  Update the destructure (`selectedId` → `selectedIds`, default `undefined`). At each arrow/stroke render,
  replace `a.id === selectedId` with `selectedIds?.has(a.id)` (and `strokes[i].id === selectedId` with
  `selectedIds?.has(strokes[i].id)`). In both `onPointerDown` handlers replace `onSelect?.(a.id)` with
  `onSelect?.(a.id, e.shiftKey)` (and the stroke equivalent).

- [ ] **Step 2: Cards — add `selected` + `onSelect`.** In each of `NoteCard.tsx`, `FreeText.tsx`,
  `ChecklistCard.tsx`:
  - Add to the props interface:
    ```ts
      /** True when this element is in the board selection set (draws the accent ring). */
      selected?: boolean
      /** Select this element on grip press; `additive` = Shift held. */
      onSelect?: (id: string, additive: boolean) => void
    ```
  - Destructure `selected` and `onSelect`.
  - In the **grip** `onPointerDown` (the one that calls `onDragStart`), call `onSelect` FIRST, before
    `onDragStart`, e.g. in `NoteCard`'s `.pl-note-grip`:
    ```ts
        if (!interactive) return
        e.stopPropagation()
        onSelect?.(note.id, e.shiftKey)   // ← add this line
        dragging.current = true
        onDragStart(e, note.id)
    ```
    `FreeText` (`.pl-text-grip`): `onSelect?.(element.id, e.shiftKey)` before `onDragStart(e, element.id)`.
    `ChecklistCard` (`.pl-check-head`): `onSelect?.(element.id, e.shiftKey)` before `onDragStart(e, element.id)`.
  - Add the selected ring. `NoteCard` — add to the `.pl-note` div `style`:
    ```ts
        outline: selected ? '1.5px solid var(--accent)' : 'none',
        outlineOffset: 2,
    ```
    `FreeText` — add the same two style props to the outer `.pl-text` div.
    `ChecklistCard` — add the same two style props to the `.pl-check` card div (alongside its `border`).

- [ ] **Step 3: `PlanningBoard` — selection set state.** Replace line 91
  (`const [selectedElId, setSelectedElId] = useState<string | null>(null)`) with:

```ts
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // Selection mutators (board-local, ephemeral — never serialized).
  const replaceSel = useCallback((id: string) => setSelectedIds(new Set([id])), [])
  const toggleSel = useCallback(
    (id: string) =>
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )
  const clearSel = useCallback(() => setSelectedIds(new Set()), [])
  // Select on element press: additive (Shift) toggles; plain press replaces unless already selected.
  const selectOnPress = useCallback(
    (id: string, additive: boolean) => {
      if (additive) toggleSel(id)
      else setSelectedIds((prev) => (prev.has(id) ? prev : new Set([id])))
    },
    [toggleSel]
  )
```

- [ ] **Step 4: `PlanningBoard` — replace every `setSelectedElId` use.**
  - Tool-button `onClick` (line ~414) `setSelectedElId(null)` → `clearSel()`.
  - `onWellPointerDown` (line 240) `setSelectedElId(null)` → leave as `clearSel()` for now (marquee replaces
    this in Task 6).
  - `WhiteboardSvg` usage: `selectedId={selectedElId}` → `selectedIds={selectedIds}`; `onSelect={(id) => {
    setSelectedElId(id); wellRef.current?.focus() }}` → `onSelect={(id, additive) => { selectOnPress(id,
    additive); wellRef.current?.focus() }}`.
  - The well `onKeyDown` Delete/Backspace branch (lines 462-469): replace with the group-delete:
    ```ts
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
            e.stopPropagation()
            e.preventDefault()
            beginChange()
            commit(elements.filter((el) => !selectedIds.has(el.id)))
            clearSel()
            return
          }
    ```
  - The letter-shortcut branch's `setSelectedElId(null)` (line 485) → `clearSel()`.

- [ ] **Step 5: `PlanningBoard` — thread `selected` + `onSelect` into the three cards.** In the
  `viewElements.map(...)` render, add to each card the two props:
  ```tsx
            selected={selectedIds.has(el.id)}
            onSelect={selectOnPress}
  ```
  (on `<NoteCard>`, `<FreeText>`, `<ChecklistCard>`).

- [ ] **Step 6: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: PASS (no `selectedElId` references remain; all green).

- [ ] **Step 7: Add the `drag()` e2e helper + group-delete probe.** In `src/main/e2eSmoke.ts`, AFTER the
  existing W1 `whiteboard-shortcut` push (line ~1011) and BEFORE `const count = ...` (line 1013), insert:

```ts
  // ── W2 selection core (multi-select + snapping). Seed two notes, drive the REAL
  // DOM on .pl-well, and assert the EFFECTS via getBoards() (selection is ephemeral
  // component state). A marquee that selects both is proven by the group it then
  // deletes / drags; snapping is proven by the committed coordinate.
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
       { id: 'w2-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: '', rotation: 0 },
       { id: 'w2-b', kind: 'note', x: 260, y: 40, w: 156, h: 96, tint: 'blue', text: '', rotation: 0 }
     ] })`
  )
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
  await delay(200)
  const w2 = await evalIn<{
    marqueeDel: number
    afterDelUndo: number
    multiMovedBoth: boolean
    afterMoveUndo: boolean
    snapX: number
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const id = ${JSON.stringify(planId)};
       const board = () => window.__canvasE2E.getBoards().find((x) => x.id === id);
       const els = () => { const b = board(); return b && b.type === 'planning' ? b.elements : []; };
       const note = (nid) => els().find((e) => e.id === nid);
       const count = () => els().length;
       const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
       const well = node && node.querySelector('.pl-well');
       if (!well) return { marqueeDel: -1, afterDelUndo: -1, multiMovedBoth: false, afterMoveUndo: false, snapX: -1 };
       const r = well.getBoundingClientRect();
       const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
       const at = (bx, by) => ({ x: r.left + bx * scale, y: r.top + by * scale });
       const noteEl = (i) => node.querySelectorAll('.pl-note')[i];
       const ev = (target, type, p, shift) => {
         try { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y, shiftKey: !!shift })); } catch (e) {}
       };
       // down on downTarget, then N moves + up on the WELL (it owns pointer capture).
       const drag = async (from, to, opts) => {
         const o = opts || {};
         const downT = o.downTarget || well;
         ev(downT, 'pointerdown', from, o.shift); await sleep(20);
         const steps = 4;
         for (let i = 1; i <= steps; i++) {
           const t = i / steps;
           ev(well, 'pointermove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, o.shift);
           await sleep(15);
         }
         ev(well, 'pointerup', to, o.shift); await sleep(40);
       };
       const press = (k) => { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };

       well.focus(); await sleep(20);
       // (1) marquee a box over BOTH notes from an empty corner, then Delete the group.
       await drag(at(10, 10), at(440, 150)); // empty start, covers w2-a + w2-b
       press('Delete'); await sleep(60);
       const marqueeDel = count();
       window.__canvasE2E.undo(); await sleep(60);
       const afterDelUndo = count();

       // (2) re-marquee both, then drag note A by board-local (40,40): BOTH move (one undo step).
       await drag(at(10, 10), at(440, 150)); await sleep(20);
       const ax0 = note('w2-a').x, bx0 = note('w2-b').x;
       await drag(at(118, 88), at(158, 128), { downTarget: noteEl(0) }); // press the (selected) note A
       const a1 = note('w2-a'), b1 = note('w2-b');
       const multiMovedBoth = a1.x - ax0 >= 30 && b1.x - bx0 >= 30;
       window.__canvasE2E.undo(); await sleep(60);
       const a2 = note('w2-a'), b2 = note('w2-b');
       const afterMoveUndo = a2.x === ax0 && b2.x === bx0;

       return { marqueeDel, afterDelUndo, multiMovedBoth, afterMoveUndo, snapX: 0 };
     })()`
  )
  const groupDeleteOk = w2.marqueeDel === 0 && w2.afterDelUndo === 2
  parts.push({
    name: 'whiteboard-group-delete',
    ok: groupDeleteOk,
    detail: groupDeleteOk ? 'marquee selects 2 → Delete removes both; undo restores both in one step' : JSON.stringify(w2)
  })
  const multidragOk = w2.multiMovedBoth && w2.afterMoveUndo
  parts.push({
    name: 'whiteboard-multidrag',
    ok: multidragOk,
    detail: multidragOk ? 'marquee 2 → drag one moves both; undo restores both in one step' : JSON.stringify(w2)
  })
```

  > NOTE: `whiteboard-multidrag` depends on Task 5 (additive is irrelevant here) and Task 6 (marquee).
  > In THIS task only the `whiteboard-group-delete` assertion can pass yet — but the marquee `drag()`
  > won't select anything until Task 6, so expect both W2 probes to FAIL here. That is acceptable: this
  > task's gate is typecheck+lint+unit (Step 6). The e2e probes are added now (one diff) and turn green
  > in Task 6. Do NOT block this commit on the e2e probes.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx src/renderer/src/canvas/boards/planning/NoteCard.tsx src/renderer/src/canvas/boards/planning/FreeText.tsx src/renderer/src/canvas/boards/planning/ChecklistCard.tsx src/renderer/src/canvas/boards/PlanningBoard.tsx src/main/e2eSmoke.ts
git commit -m "feat(whiteboard): W2.1 selection set + Set plumbing + selected ring + group-delete"
```

---

## Task 5: Shift-click additive selection

The plumbing from Task 4 already passes `additive` (Shift) through `onSelect` → `selectOnPress` →
`toggleSel`. This task just verifies the additive path and locks it with a focused behavior note. No new
production code beyond confirming Task 4's `selectOnPress` toggles on Shift. (Kept as its own task so the
reviewer explicitly checks the additive grammar before marquee builds on it.)

**Files:** none (verification task), unless review finds a gap.

- [ ] **Step 1: Manual reasoning check** — confirm in `PlanningBoard.tsx` that `selectOnPress(id, true)`
  routes to `toggleSel(id)` (add/remove) and `selectOnPress(id, false)` replaces unless already selected.
  Confirm all three cards + both `WhiteboardSvg` handlers pass `e.shiftKey` as `additive`.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: (No commit if no code change.)** If the review surfaced a missing `e.shiftKey` pass-through,
  fix it and commit:
  ```bash
  git commit -am "fix(whiteboard): W2.1 thread Shift through all onSelect call sites"
  ```

---

## Task 6: Marquee gesture (box-select on the empty well)

Wire the `marquee` drag mode + render the dashed rect. After this, the Task-4 e2e probes go green.

**Files:**
- Modify: `PlanningBoard.tsx`, `WhiteboardSvg.tsx`

- [ ] **Step 1: `PlanningBoard` — add ONLY the marquee variant to the drag union** (leave `move` as the
  existing single-id shape — Task 7 converts it to a set). In the `drag` ref union (lines 106-112):

```ts
  const drag = useRef<
    | { mode: 'move'; id: string; grabX: number; grabY: number }
    | { mode: 'arrow'; id: string }
    | { mode: 'pen'; points: number[] }
    | { mode: 'erase'; removed: Set<string> }
    | { mode: 'marquee'; startX: number; startY: number; additive: boolean }
    | null
  >(null)
```

  Add transient marquee state near `dragPos` (line ~103):
```ts
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
```

- [ ] **Step 2: `PlanningBoard` — import marquee helpers.** Add:
```ts
import { rectFromPoints, marqueeHits } from './planning/marquee'
```

- [ ] **Step 3: `PlanningBoard` — start a marquee on an empty-well press in select mode.** In
  `onWellPointerDown`, replace the early select-mode handling. The current top of the handler is:

```ts
      if (tool === 'select' && e.target !== e.currentTarget) return
      if (e.target === e.currentTarget) e.currentTarget.focus()
      setSelectedElId(null)   // (was already changed to clearSel() in Task 4)
      const p = toBoard(e)
```

  Replace those four lines with:

```ts
      if (tool === 'select' && e.target !== e.currentTarget) return
      if (e.target === e.currentTarget) e.currentTarget.focus()
      const p = toBoard(e)
      if (tool === 'select') {
        // Empty-well press → begin a marquee (Shift = additive). Selection is resolved
        // on pointer-up (a no-move click clears unless Shift).
        drag.current = { mode: 'marquee', startX: p.x, startY: p.y, additive: e.shiftKey }
        setMarqueeRect({ x: p.x, y: p.y, w: 0, h: 0 })
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
```

  (Delete the now-unreachable `clearSel()` that used to sit here; selection clearing happens on marquee up.)

- [ ] **Step 4: `PlanningBoard` — grow the marquee on move.** In `onWellPointerMove`, add a branch
  (after the `erase` branch):

```ts
      } else if (d.mode === 'marquee') {
        setMarqueeRect(rectFromPoints(d.startX, d.startY, p.x, p.y))
      }
```

- [ ] **Step 5: `PlanningBoard` — resolve the marquee on up.** `onWellPointerUp` has no pointer event in
  scope, so read the rect from `marqueeRect` (it was updated on every move). In `onWellPointerUp`, add a
  branch after the `erase` branch:

```ts
    } else if (d.mode === 'marquee') {
      const rect = marqueeRect ?? { x: d.startX, y: d.startY, w: 0, h: 0 }
      setMarqueeRect(null)
      const moved = rect.w > 2 || rect.h > 2
      if (moved) {
        const hits = marqueeHits(elements, rect) // → marqueeHits(elements, rect, measuredRef.current) in Task 8
        setSelectedIds((prev) => {
          if (!d.additive) return new Set(hits)
          const next = new Set(prev)
          for (const id of hits) next.add(id)
          return next
        })
      } else if (!d.additive) {
        clearSel()
      }
    }
```

  Add `marqueeRect` to the `onWellPointerUp` `useCallback` deps array. (`measuredRef` does not exist yet —
  Task 8 adds it and swaps the `marqueeHits` call to pass `measuredRef.current`.)

- [ ] **Step 6: `PlanningBoard` — clear the marquee on cancel.** In `onWellPointerCancel`, before the
  final `onWellPointerUp()` call, add: `if (drag.current?.mode === 'marquee') { drag.current = null;
  setMarqueeRect(null); return }`.

- [ ] **Step 7: `PlanningBoard` — pass the marquee rect to the SVG.** On `<WhiteboardSvg .../>` add:
  `marquee={marqueeRect}`.

- [ ] **Step 8: `WhiteboardSvg` — render the marquee rect.** Add to `WhiteboardSvgProps`:
```ts
  /** Live marquee box (board-local) while box-selecting; null when idle. */
  marquee?: { x: number; y: number; w: number; h: number } | null
```
  Destructure `marquee`. Just before the closing `</svg>`, add:
```tsx
      {marquee && (marquee.w > 0 || marquee.h > 0) && (
        <rect
          x={marquee.x}
          y={marquee.y}
          width={marquee.w}
          height={marquee.h}
          fill="var(--accent)"
          fillOpacity={0.08}
          stroke="var(--accent)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      )}
```

- [ ] **Step 9: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: PASS.

- [ ] **Step 10: e2e — group-delete + multidrag now pass**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_WHITEBOARD-GROUP-DELETE` ok:true and `E2E_WHITEBOARD-MULTIDRAG` ok:true in the output.
(The `browser`/`browser-gesture`/`focus-detach` trio may flake — rerun; memory `e2e-browser-trio-flake`.)

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx
git commit -m "feat(whiteboard): W2.1 marquee box-select on the empty well"
```

---

## Task 7: Multi-drag (move the whole selection as one undo step)

**Files:**
- Modify: `PlanningBoard.tsx`

- [ ] **Step 1a: Convert the `move` drag variant to a set.** In the `drag` ref union, change the `move`
  line from `{ mode: 'move'; id: string; grabX: number; grabY: number }` to
  `{ mode: 'move'; ids: string[]; grabX: number; grabY: number }`.

- [ ] **Step 1: `startElementDrag` — compute the moving set + select on press.** Replace the body of
  `startElementDrag` (lines 211-227) with:

```ts
  const startElementDrag = useCallback(
    (e: PointerEvent, id: string) => {
      const el = elements.find((x) => x.id === id)
      if (!el) return
      // Selection-aware moving set (Figma grammar). Pressing an already-selected element
      // drags the whole set; pressing an unselected one (no Shift) replaces the selection
      // with just it. (The card/vector onSelect already ran selectOnPress with the Shift
      // flag, so read the resulting intent here off the live set.)
      const sel = selectedIds
      const movingIds = sel.has(id) ? [...sel] : [id]
      const p = toBoard(e)
      drag.current = { mode: 'move', ids: movingIds, grabX: p.x, grabY: p.y }
      wellRef.current?.setPointerCapture(e.pointerId)
    },
    [elements, toBoard, selectedIds]
  )
```

  > Ordering note: `onSelect`/`selectOnPress` fires on the SAME pointerdown BEFORE `onDragStart` (the
  > cards call them in that order). React state updates are async, so `selectedIds` read here is the
  > PRE-press set. That is correct for the grammar: pressing an already-selected element keeps the set;
  > pressing an unselected element → `sel.has(id)` is false → `movingIds=[id]` (and `selectOnPress` has
  > queued the replace for the next render). Shift-press of an unselected element toggles it in AND drags
  > only it this gesture — acceptable.

- [ ] **Step 2: `dragPos` → multi-id.** Replace line 103:
```ts
  const [dragPos, setDragPos] = useState<{ ids: string[]; dx: number; dy: number } | null>(null)
```

- [ ] **Step 3: move-branch in `onWellPointerMove`.** Replace the `if (d.mode === 'move')` body:
```ts
      if (d.mode === 'move') {
        setDragPos({ ids: d.ids, dx: Math.round(p.x - d.grabX), dy: Math.round(p.y - d.grabY) })
      }
```

- [ ] **Step 4: move-branch in `onWellPointerUp`.** Replace the `if (d.mode === 'move')` body:
```ts
    if (d.mode === 'move') {
      const pos = dragPos
      setDragPos(null)
      if (pos && (pos.dx !== 0 || pos.dy !== 0)) {
        beginChange()
        commit(translateMany(elements, pos.ids, pos.dx, pos.dy))
      }
    }
```

- [ ] **Step 5: `viewElements` — render the dragged set shifted.** Replace the `dragPos` branch of
  `viewElements` (lines 425-429). Import `translateMany` (extend the existing import from `./planning/elements`):
```ts
  const viewElements = dragPos
    ? translateMany(elements, dragPos.ids, dragPos.dx, dragPos.dy)
    : pendingErase && pendingErase.size > 0
      ? elements.filter((el) => !pendingErase.has(el.id))
      : elements
```

- [ ] **Step 6: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: PASS.

- [ ] **Step 7: e2e — multidrag stays green**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_WHITEBOARD-MULTIDRAG` ok:true, `E2E_WHITEBOARD-GROUP-DELETE` ok:true.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(whiteboard): W2.1 multi-drag the selection as one undo step"
```

---

## Task 8: Measured-size map for auto-sized kinds (text + checklist)

Feed live DOM sizes into `elementBBox` so marquee/snap on text + checklist are accurate.

**Files:**
- Modify: `PlanningBoard.tsx`, `FreeText.tsx`, `ChecklistCard.tsx`

- [ ] **Step 1: `PlanningBoard` — a measured map ref + setter.** Near the refs (line ~92) add:
```ts
  // Live DOM sizes (board-local px) for the auto-sized kinds (text, checklist), fed by
  // the cards. Refines elementBBox for marquee/snap; a plain ref (no re-render needed —
  // reads happen at gesture time). Stale-on-first-frame is bounded by elementBBox's nominal fallback.
  const measuredRef = useRef<Map<string, { w: number; h: number }>>(new Map())
  const reportMeasure = useCallback((id: string, w: number, h: number) => {
    measuredRef.current.set(id, { w, h })
  }, [])
```

- [ ] **Step 2: `PlanningBoard` — use it in marquee + (later) snap.** In `onWellPointerUp`'s marquee
  branch, change `marqueeHits(elements, rect)` → `marqueeHits(elements, rect, measuredRef.current)`.

- [ ] **Step 3: `FreeText` — report its measured box.** Add to `FreeTextProps`:
```ts
  /** Report the rendered board-local size for selection/snap bbox (W2). */
  onMeasure?: (id: string, w: number, h: number) => void
```
  Destructure `onMeasure`. In the existing auto-size `useEffect` (after it sets width/height), append:
```ts
    if (onMeasure) {
      const host = el.parentElement // the .pl-text flex row
      if (host) onMeasure(element.id, host.offsetWidth, host.offsetHeight)
    }
```
  Add `onMeasure` + `element.id` to that effect's dep array.

- [ ] **Step 4: `ChecklistCard` — report `{w,h}` alongside the existing bottom report.** Add to
  `ChecklistCardProps`:
```ts
  /** Report the rendered board-local size for selection/snap bbox (W2). */
  onMeasure?: (id: string, w: number, h: number) => void
```
  Destructure `onMeasure`. In the existing `ResizeObserver` effect's `report` closure (line ~111) add a
  second call:
```ts
    const report = (): void => {
      onMeasureBottom?.(element.id, element.y + el.offsetHeight)
      onMeasure?.(element.id, el.offsetWidth, el.offsetHeight)
    }
```
  Add `onMeasure` to that effect's dep array.

- [ ] **Step 5: `PlanningBoard` — pass `onMeasure` to both cards.** On `<FreeText>` and `<ChecklistCard>`
  add `onMeasure={reportMeasure}`.

- [ ] **Step 6: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/boards/planning/FreeText.tsx src/renderer/src/canvas/boards/planning/ChecklistCard.tsx
git commit -m "feat(whiteboard): W2 live measured-size map for text/checklist bbox"
```

---

## Task 9: Snapping wiring + snap pill + guides

**Files:**
- Modify: `Icon.tsx`, `PlanningBoard.tsx`, `WhiteboardSvg.tsx`

- [ ] **Step 1: `Icon.tsx` — add a `magnet` glyph.** Add `'magnet'` to the `IconName` union (after
  `'globe'`), and to `PATHS`:
```ts
  magnet: 'M7 4v7a5 5 0 0 0 10 0V4M7 4h3.5M13.5 4H17M7 9h3.5M13.5 9H17'
```

- [ ] **Step 2: `PlanningBoard` — snap state + imports.** Add import:
```ts
import { computeSnap, SNAP_TOL, type Guide } from './planning/snapping'
import { elementBBox, unionBBox } from './planning/elements' // extend the existing elements import
```
  Add state (near `tool`, line ~90):
```ts
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [snapGuides, setSnapGuides] = useState<Guide[] | null>(null)
```

- [ ] **Step 3: `PlanningBoard` — snap during a move.** In `onWellPointerMove`'s `move` branch (from
  Task 7) replace with:
```ts
      if (d.mode === 'move') {
        let dx = Math.round(p.x - d.grabX)
        let dy = Math.round(p.y - d.grabY)
        if (snapEnabled) {
          const moving = new Set(d.ids)
          const movingUnion = unionBBox(
            d.ids
              .map((mid) => elements.find((el) => el.id === mid))
              .filter((el): el is PlanningElement => !!el)
              .map((el) => {
                const b = elementBBox(el, measuredRef.current.get(el.id))
                return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }
              })
          )
          const statics = elements
            .filter((el) => !moving.has(el.id))
            .map((el) => elementBBox(el, measuredRef.current.get(el.id)))
          const snap = computeSnap(movingUnion, statics, SNAP_TOL)
          dx += snap.dx
          dy += snap.dy
          setSnapGuides(snap.guides.length > 0 ? snap.guides : null)
        }
        setDragPos({ ids: d.ids, dx, dy })
      }
```
  Add `snapEnabled` to the `onWellPointerMove` dep array.

- [ ] **Step 4: `PlanningBoard` — clear guides when a move ends.** In `onWellPointerUp`'s move branch and
  in `onWellPointerCancel`, add `setSnapGuides(null)` (so guides never linger). In the move branch of
  `onWellPointerUp`, after `setDragPos(null)` add `setSnapGuides(null)`.

- [ ] **Step 5: `PlanningBoard` — the snap pill.** In the `actions` cluster (the `TOOLS.map(...)` block),
  after the closing `))}` of the map and before the wrapping `</div>`, add a divider + the pill:
```tsx
      {TOOLS.map(({ tool: t, icon }) => (
        /* …existing… */
      ))}
      <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-subtle)', margin: '0 2px' }} />
      <IconBtn
        name="magnet"
        title={snapEnabled ? 'Snapping on' : 'Snapping off'}
        size={15}
        active={snapEnabled}
        onClick={() => setSnapEnabled((v) => !v)}
      />
```

- [ ] **Step 6: `PlanningBoard` — pass guides to the SVG.** On `<WhiteboardSvg .../>` add `guides={snapGuides}`.

- [ ] **Step 7: `WhiteboardSvg` — render guides.** Add to props:
```ts
  /** Live alignment guides (board-local) while dragging; null when idle. */
  guides?: { axis: 'x' | 'y'; at: number; from: number; to: number }[] | null
```
  Destructure `guides`. Before `</svg>` (after the marquee rect), add:
```tsx
      {guides?.map((g, i) =>
        g.axis === 'x' ? (
          <line key={i} x1={g.at} y1={g.from} x2={g.at} y2={g.to} stroke="var(--accent)" strokeWidth={1} />
        ) : (
          <line key={i} x1={g.from} y1={g.at} x2={g.to} y2={g.at} stroke="var(--accent)" strokeWidth={1} />
        )
      )}
```

- [ ] **Step 8: Add the snap e2e probe.** In `e2eSmoke.ts`, the W2 eval already seeds `w2-a` (x=40) and
  `w2-b` (x=260). Extend the W2 eval's returned object to also drag `w2-b`'s LEFT edge to within tol of
  `w2-a`'s left (x=40) and report the committed x. After the multidrag block (before `return {...}`), add:
```ts
       // (3) Snap: drag note B so its left edge lands within tol of A's left (x=40).
       // After the multidrag undo, both notes are at their seeded positions (A x=40, B x=260).
       // Clear selection with an empty-well click, then press B alone and drag it left.
       ev(well, 'pointerdown', at(560, 300)); ev(well, 'pointerup', at(560, 300)); await sleep(30);
       // B center board ≈ (338,88). Drag to board (122,88): raw dx ≈ -216 → B.x ≈ 44,
       // within SNAP_TOL(6) of A's left (40) → committed B.x snaps to 40.
       await drag(at(338, 88), at(122, 88), { downTarget: noteEl(1) });
       const snapX = note('w2-b').x;
```
  And change the returned object's `snapX: 0` to `snapX`.
  Then after the `multidrag` push, add:
```ts
  const snapOk = Math.abs(w2.snapX - 40) <= 1
  parts.push({
    name: 'whiteboard-snap',
    ok: snapOk,
    detail: snapOk ? "drag aligns B's left edge to neighbor (x=40)" : JSON.stringify(w2)
  })
```

- [ ] **Step 9: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: PASS.

- [ ] **Step 10: e2e — all three W2 probes green**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_WHITEBOARD-GROUP-DELETE`, `E2E_WHITEBOARD-MULTIDRAG`, `E2E_WHITEBOARD-SNAP` all ok:true.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/src/canvas/Icon.tsx src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx src/main/e2eSmoke.ts
git commit -m "feat(whiteboard): W2.2 in-board snapping + alignment guides + snap pill"
```

---

## Task 10: Roadmap status + full gate + holistic review

**Files:**
- Modify: `docs/roadmap-whiteboard.md`

- [ ] **Step 1: Mark W2 done.** In `docs/roadmap-whiteboard.md`'s Status table, change the
  `W2 — Selection core` row from `not started` to:
  `✅ done (2026-06-02) — multi-select (marquee intersect + Shift-add + multi-drag + group-delete) · in-board snapping (edge/center guides, snap pill). Pure helpers elementBBox/anchors/translateMany + marquee.ts + snapping.ts unit-tested; e2e whiteboard-group-delete/multidrag/snap green. Branch feat/whiteboard-w2.`

- [ ] **Step 2: Full gate.**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: all PASS. Note the unit count (should be ~520+).

- [ ] **Step 3: Full board e2e.**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_DONE` with the three W2 probes + `whiteboard-erase`/`whiteboard-shortcut` (W1) +
`seed` (4 boards) all ok. The `browser`/`browser-gesture`/`focus-detach` trio is a known capturePage env
flake (memory `e2e-browser-trio-flake`) — rerun for a clean pass; not a regression.

- [ ] **Step 4: Commit the roadmap + run the review skills.**

```bash
git add docs/roadmap-whiteboard.md
git commit -m "docs(whiteboard): mark W2 selection core done"
```

  Then invoke the review skills per the handoff process: `superpowers:requesting-code-review` (two-stage
  spec-then-quality) + a holistic pass (`pr-review-toolkit` agents on the diff). Address findings on this
  branch before opening the PR.

- [ ] **Step 5: Open the PR into the umbrella (NOT main).**

```bash
git push -u origin feat/whiteboard-w2
gh pr create --base feat/whiteboard --head feat/whiteboard-w2 --title "Whiteboard W2 — selection core (multi-select + snapping)" --body "Implements docs/superpowers/specs/2026-06-02-whiteboard-w2-selection-design.md. Multi-select (marquee + Shift-add + multi-drag + group-delete) and in-board snapping. Pure helpers unit-tested; e2e probes green. Base carries D1.1 (no canvasStore edits)."
```

  After merge, mark the W2 row `done` in `.claude/coordination/ACTIVE-WORK.md` and tear down the worktree
  via `.claude/tools/remove-worktree.ps1`.

---

## Self-review (filled in by the plan author)

- **Spec coverage:** §3.3 helpers → Tasks 1-3; §3.4 pointer machine → Tasks 6 (marquee) + 7 (multi-drag) +
  9 (snap); §3.5 threading/visuals → Tasks 4 (ring + Set) + 8 (measured) + 9 (pill/guides); §3.2 state →
  Tasks 4/6/7/9; §4 undo discipline → group-delete (T4) + multi-drag (T7) one-checkpoint, marquee 0
  (T6); §5 unit → T1-3, e2e → T4/6/9; §0/base (no canvasStore) → honored throughout. ✅ all covered.
- **Placeholders:** none — every code step shows complete code; e2e probe code is concrete.
- **Type consistency:** `BBox`/`Measured`/`Anchors` (T1) used by `marquee.ts` (T2), `snapping.ts` (T3),
  `PlanningBoard` (T6-9); `Guide` (T3) used by `WhiteboardSvg` (T9) + `PlanningBoard` (T9);
  `selectedIds: ReadonlySet<string>` consistent across `PlanningBoard`/`WhiteboardSvg`/cards;
  `onSelect(id, additive)` consistent; `drag.move.ids` set in T6/T7 and read in T7; `translateMany`/
  `unionBBox`/`elementBBox` signatures stable. ✅
```
