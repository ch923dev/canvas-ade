# Smart Alignment Guides — Slice 3 (Resize snapping) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. BUILDS ON slices 1/2a/2b
> (committed `lib/alignmentGuides.ts`, the overlay, the Canvas drag-snap wiring).

**Goal:** While RESIZING a board (NodeResizer handles), snap the moving edge(s) to other boards'
edges/centers (align line) or a flush/16px gutter (gap pill), and draw the guide — the same feedback
drag gives, now for resize. Distribution and the overlap tint do NOT apply to resize (per decision).

**Architecture:** Add a pure `computeResizeSnap(old, proposed, others, threshold, min)` to
`lib/alignmentGuides.ts`: it detects which edges moved (compare proposed vs old rect) and snaps only
those, returning a corrected `{x,y,w,h}` + reused `AlignGuide`/`GapGuide`s, never shrinking below
`min`. `Canvas.onNodesChange` intercepts the resize (`dimensions` change with `resizing`, plus the
N/W `position` change), mutates them to the snapped values BEFORE `nodeChangesToIntents`, sets the
guides, and clears them on the `resizing:false` settle. The overlay is unchanged (it already renders
align lines + gap pills).

**Tech Stack:** React 18, TypeScript (strict), `@xyflow/react` v12 (`NodeResizer`, `NodeChange`),
Vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-alignment-guides.md`. **Decisions:** resize → edge
align lines + gap-snap; no distribution, no overlap tint on resize; Ctrl/⌘ still suppresses.

---

## File Structure

- **Modify** `src/renderer/src/lib/alignmentGuides.ts` — `ResizeResult`, `snapEdge`,
  `computeResizeSnap`.
- **Modify** `src/renderer/src/lib/alignmentGuides.test.ts` — resize-snap tests.
- **Modify** `src/renderer/src/canvas/Canvas.tsx` — resize-snap pass in `onNodesChange` + clear on
  resize settle.
- (No overlay/CSS change — align lines + gap pills already render.)

---

### Task 1: Pure resize-edge snapping — `snapEdge` + `computeResizeSnap`

**Files:**
- Modify: `src/renderer/src/lib/alignmentGuides.ts`
- Test: `src/renderer/src/lib/alignmentGuides.test.ts`

- [ ] **Step 1: Add the failing tests**

Append:

```ts
describe('computeResizeSnap — moving-edge snapping', () => {
  const MIN = { w: 40, h: 40 }
  const other = { x: 300, y: 0, w: 100, h: 100 } // left=300, right=400

  test('right edge (E handle) snaps to another board left edge', () => {
    // old 0..100; resize right to 295 (right edge moved). other.left 300, diff 5 → snap right to 300.
    const r = computeResizeSnap(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 295, h: 100 },
      [other],
      8,
      MIN
    )
    expect(r.x).toBe(0)
    expect(r.w).toBe(300) // right at 300, left fixed 0
    expect(r.guides.some((g) => g.kind === 'align' && g.axis === 'x' && g.pos === 300)).toBe(true)
  })

  test('left edge (W handle) snaps to another board right edge; origin + width adjust', () => {
    // old at x=300..400 (w100). other left=0..100 (right=100). Drag LEFT edge out to x=105 (right fixed 400).
    const left = { x: 0, y: 0, w: 100, h: 100 }
    const r = computeResizeSnap(
      { x: 300, y: 0, w: 100, h: 100 },
      { x: 105, y: 0, w: 295, h: 100 },
      [left],
      8,
      MIN
    )
    expect(r.x).toBe(100) // snapped to other's right edge
    expect(r.w).toBe(300) // right stays at 400 → 400-100
    expect(r.guides.some((g) => g.kind === 'align' && g.pos === 100)).toBe(true)
  })

  test('bottom edge gap-snaps to a 16px gutter above a board below', () => {
    const below = { x: 0, y: 300, w: 100, h: 100 } // top=300
    // resize bottom from 100 down to 285; gutter target = 300 - 16 = 284, diff 1 → snap to 284.
    const r = computeResizeSnap(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 100, h: 285 },
      [below],
      8,
      MIN
    )
    expect(r.h).toBe(284) // bottom at 284 → height 284 (top fixed 0)
    expect(r.guides.some((g) => g.kind === 'gap' && g.axis === 'y' && g.distance === 16)).toBe(true)
  })

  test('does not snap an edge that did not move', () => {
    // Only the right edge moves; the left edge sits 3px from other.right=100 but must NOT snap.
    const left = { x: 0, y: 0, w: 100, h: 100 }
    const r = computeResizeSnap(
      { x: 103, y: 0, w: 100, h: 100 }, // left at 103 (near other.right 100)
      { x: 103, y: 0, w: 150, h: 100 }, // right moved 203→253; left UNCHANGED
      [left],
      8,
      MIN
    )
    expect(r.x).toBe(103) // left untouched (it didn't move)
  })

  test('skips a snap that would shrink below the minimum size', () => {
    const near = { x: 60, y: 0, w: 100, h: 100 } // left=60
    // resize right edge to 58; snapping to other.left 60 would make w=58 (< min 40? no). Use min 80 to force skip:
    const r = computeResizeSnap(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 58, h: 100 },
      [near],
      8,
      { w: 80, h: 40 }
    )
    expect(r.w).toBe(58) // snap to 60 would give w=60 ≥ 80? no, 60<80 → skipped, stays 58
    expect(r.guides.some((g) => g.kind === 'align')).toBe(false)
  })

  test('no snap when no edge is near a target', () => {
    const r = computeResizeSnap(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 0, y: 0, w: 150, h: 100 },
      [{ x: 500, y: 0, w: 100, h: 100 }],
      8,
      MIN
    )
    expect(r.w).toBe(150)
    expect(r.guides).toEqual([])
  })
})
```

Add `computeResizeSnap` to the test import:
```ts
import { computeAlignment, computeResizeSnap, projectGuide, projectGapGuide, projectRect, SNAP_THRESHOLD_PX, GAP_SNAP_PX, type Rect } from './alignmentGuides'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — `computeResizeSnap` undefined.

- [ ] **Step 3: Implement `snapEdge` + `computeResizeSnap`**

Add to `alignmentGuides.ts` (after `computeAlignment`; reuses `OtherAxis`, `stops`, `rangesOverlap`,
`GAP_SNAP_PX`, the `Guide` types):

```ts
/** One snapped edge: the corrected edge coordinate + the guide to draw. */
interface EdgeSnap {
  value: number
  guide: Guide
}

/**
 * Snap a single moving edge (at `edgeVal`, with perpendicular extent [perpMin,perpMax]) on `axis`
 * to the nearest other-board edge/center (align line) or a 16px gutter beside a perpendicular
 * neighbor (gap pill). `others` is the axis-mapped neighbor list. Nearest qualifying wins; align
 * beats gap on ties (added first, strict `<`).
 */
function snapEdge(
  axis: 'x' | 'y',
  edgeVal: number,
  perpMin: number,
  perpMax: number,
  others: OtherAxis[],
  threshold: number
): EdgeSnap | null {
  let best: (EdgeSnap & { diff: number }) | null = null
  const consider = (diff: number, value: number, guide: Guide): void => {
    if (diff > threshold) return
    if (best && diff >= best.diff) return
    best = { diff, value, guide }
  }
  for (const o of others) {
    // Align: edge → other's near/center/far edge (any board, no neighbor requirement).
    for (const os of stops(o.origin, o.size)) {
      consider(Math.abs(edgeVal - os), os, {
        kind: 'align',
        axis,
        pos: os,
        start: Math.min(perpMin, o.perpMin),
        end: Math.max(perpMax, o.perpMax)
      })
    }
    // Gap: a 16px gutter to a facing edge — only between perpendicular neighbors.
    if (rangesOverlap(perpMin, perpMax, o.perpMin, o.perpMax)) {
      const g = GAP_SNAP_PX
      const perp = (Math.max(perpMin, o.perpMin) + Math.min(perpMax, o.perpMax)) / 2
      const leftVal = o.origin - g // edge sits a gutter to the LEFT of the other's near edge
      consider(Math.abs(edgeVal - leftVal), leftVal, {
        kind: 'gap',
        axis,
        pos: o.origin - g / 2,
        perp,
        distance: g
      })
      const rightVal = o.origin + o.size + g // a gutter to the RIGHT of the other's far edge
      consider(Math.abs(edgeVal - rightVal), rightVal, {
        kind: 'gap',
        axis,
        pos: o.origin + o.size + g / 2,
        perp,
        distance: g
      })
    }
  }
  return best ? { value: best.value, guide: best.guide } : null
}

/** Result of resize snapping: a corrected rect + the guides to draw. */
export interface ResizeResult {
  x: number
  y: number
  w: number
  h: number
  guides: Guide[]
}

/**
 * Snap the MOVING edge(s) of a resize. `old` is the pre-resize rect, `prop` the proposed rect from
 * React Flow (dimensions ± N/W position shift). Only edges whose coordinate differs from `old` snap;
 * a snap that would shrink the board below `min` is skipped. Returns the corrected rect + guides.
 */
export function computeResizeSnap(
  old: Rect,
  prop: Rect,
  others: Rect[],
  threshold: number,
  min: { w: number; h: number }
): ResizeResult {
  let { x, y, w, h } = prop
  const right0 = prop.x + prop.w
  const bottom0 = prop.y + prop.h
  const guides: Guide[] = []

  const xOthers = others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h }))
  const yOthers = others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w }))

  // X edges (perpendicular extent = the board's current vertical span).
  if (prop.x !== old.x) {
    const m = snapEdge('x', prop.x, prop.y, prop.y + prop.h, xOthers, threshold)
    if (m && right0 - m.value >= min.w) {
      x = m.value
      w = right0 - x
      guides.push(m.guide)
    }
  }
  if (right0 !== old.x + old.w) {
    const m = snapEdge('x', right0, prop.y, prop.y + prop.h, xOthers, threshold)
    if (m && m.value - x >= min.w) {
      w = m.value - x
      guides.push(m.guide)
    }
  }
  // Y edges (perpendicular extent = the board's current horizontal span).
  if (prop.y !== old.y) {
    const m = snapEdge('y', prop.y, prop.x, prop.x + prop.w, yOthers, threshold)
    if (m && bottom0 - m.value >= min.h) {
      y = m.value
      h = bottom0 - y
      guides.push(m.guide)
    }
  }
  if (bottom0 !== old.y + old.h) {
    const m = snapEdge('y', bottom0, prop.x, prop.x + prop.w, yOthers, threshold)
    if (m && m.value - y >= min.h) {
      h = m.value - y
      guides.push(m.guide)
    }
  }

  return { x, y, w, h, guides }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS (resize group + all prior groups).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): moving-edge resize snapping (slice 3)"
```

---

### Task 2: Wire resize-snap into `Canvas.tsx`

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Extend the imports**

Update the alignmentGuides import to add `computeResizeSnap`, and import `MIN_BOARD_SIZE`:
```ts
import { computeAlignment, computeResizeSnap, SNAP_THRESHOLD_PX, type Guide, type Rect } from '../lib/alignmentGuides'
```
`MIN_BOARD_SIZE` is already imported from `'../lib/boardSchema'`? If not, add it to that existing
import line:
```ts
import { DEFAULT_BOARD_SIZE, MIN_BOARD_SIZE, type BoardType } from '../lib/boardSchema'
```
(Confirm by reading the current `boardSchema` import in `Canvas.tsx` and only add the missing name.)

- [ ] **Step 2: Add the resize-snap pass in `onNodesChange`**

In `onNodesChange`, AFTER the slice-1/2a drag-snap block (the `if (single && ...) { ... } else if
(active.length > 0) { ... }`) and BEFORE the `let nextSel` intent loop, insert:

```ts
      // Resize-snap pass: snap the MOVING edge(s) of a NodeResizer resize to other boards' edges/
      // centers (align line) or a 16px gutter (gap pill). Mutate the dimensions (+ N/W position)
      // change before nodeChangesToIntents, like the drag pass. Skipped while Ctrl/⌘ is held.
      const resizing = changes.find(
        (c) => c.type === 'dimensions' && c.dimensions && c.resizing
      )
      if (resizing && resizing.type === 'dimensions' && resizing.dimensions && !snapSuppressRef.current) {
        const old = boards.find((b) => b.id === resizing.id)
        if (old) {
          const posChange = changes.find(
            (c) => c.type === 'position' && c.id === resizing.id && c.position
          )
          const px = posChange && posChange.type === 'position' && posChange.position ? posChange.position.x : old.x
          const py = posChange && posChange.type === 'position' && posChange.position ? posChange.position.y : old.y
          const others = boards
            .filter((b) => b.id !== old.id)
            .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
          const prop: Rect = { x: px, y: py, w: resizing.dimensions.width, h: resizing.dimensions.height }
          const snap = computeResizeSnap(
            { x: old.x, y: old.y, w: old.w, h: old.h },
            prop,
            others,
            SNAP_THRESHOLD_PX / rf.getZoom(),
            MIN_BOARD_SIZE
          )
          resizing.dimensions.width = snap.w
          resizing.dimensions.height = snap.h
          if (posChange && posChange.type === 'position' && posChange.position) {
            posChange.position.x = snap.x
            posChange.position.y = snap.y
          }
          setGuides(snap.guides)
        }
      } else if (changes.some((c) => c.type === 'dimensions' && !c.resizing)) {
        // Resize settled (NodeResizer emits a final dimensions change with resizing:false) → clear.
        setGuides((g) => (g.length ? [] : g))
      }
```

> Note: overlaps are intentionally NOT set on resize (decision: no overlap tint on resize). They
> remain whatever the drag pass left, which is `[]` outside a drag.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck && pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" lint`
Expected: PASS. (The `resizing.type === 'dimensions'` / `posChange.type === 'position'` re-checks
narrow the `NodeChange` union so `.dimensions` / `.position` are typed.)

- [ ] **Step 4: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/canvas/Canvas.tsx
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): snap board edges on resize (slice 3)"
```

---

### Task 3: Full verification + manual check + e2e gate

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run`
Expected: PASS — all prior + the new resize group.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck && pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" lint`
Expected: PASS.

- [ ] **Step 3: Manual check in dev**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" dev`
1. Resize a board's RIGHT edge toward another board's left/center/right → it snaps, a dashed line
   shows at the shared edge.
2. Resize the LEFT or TOP edge (N/W handle) → origin shifts and snaps (board doesn't jump).
3. Resize an edge to just shy of a neighbor → 16px gutter snap + `16` pill.
4. Hold Ctrl/⌘ while resizing → no snap, no guides.
5. Release the handle → guides clear immediately.
6. Resizing never lets a board go below its minimum size (no snap that would shrink past it).

- [ ] **Step 4: Board e2e harness**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" build`, then `$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" start`.
Expected: `E2E_DONE`; the only failures should be the known browser/browser-gesture/focus-detach env
trio (rerun once on a fresh electron for a clean pass). This slice mutates resize changes + adds an
HTML overlay path only; no native-view path change. If other parts flake, RERUN on a cooled-down
electron before suspecting a regression (the e2e flake family widens under sustained machine load —
confirm against a reverted baseline before blaming this slice).

- [ ] **Step 5: Commit any fixups**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add -A
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "chore(align): slice 3 verified (unit + typecheck + lint + e2e)"
```

---

## Self-Review

**Spec coverage (slice 3 = resize):**
- Resize moving-edge snaps to align lines → Task 1 `snapEdge` align branch + Task 2 wiring. ✓
- Resize gap-snap (flush/16 gutter) → Task 1 gap branch (neighbor-gated). ✓
- N/W/NW handles (origin shift) snap correctly → Task 1 left/top branches adjust x/y + w/h; Task 2
  mutates the matching `position` change. ✓
- No distribution / no overlap tint on resize → Task 1 omits both; Task 2 doesn't set overlaps. ✓
- Ctrl/⌘ suppress → Task 2 `snapSuppressRef` guard. ✓
- Never shrink below minimum → Task 1 `min` guard; Task 2 passes `MIN_BOARD_SIZE`. ✓
- Guides clear on resize release → Task 2 `resizing:false` settle branch. ✓
- typecheck/lint/unit/e2e → Task 3. ✓

**Placeholder scan:** none — full code per step; commands have expected output. (The `MIN_BOARD_SIZE`
import step says "confirm and add only the missing name" — that is a concrete instruction, not a
placeholder; `MIN_BOARD_SIZE` is an existing export of `boardSchema.ts`.)

**Type consistency:** `ResizeResult`, `computeResizeSnap(old, prop, others, threshold, min)`,
`EdgeSnap`/`snapEdge` reuse `Rect`, `OtherAxis`, `Guide`, `GAP_SNAP_PX`, `stops`, `rangesOverlap`
from earlier slices. `computeResizeSnap` returns `{x,y,w,h,guides}`; Task 2 applies `w/h` to the
`dimensions` change and `x/y` to the `position` change, and reuses the existing `setGuides`. No new
overlay/CSS — the produced guides are `AlignGuide`/`GapGuide`, already rendered.

**Deferred:** distribution-on-resize and overlap-tint-on-resize (explicitly out of scope per the
2026-06-01 decision).
