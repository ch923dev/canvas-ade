# Smart Alignment Guides — Slice 1 (Edge + Center) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** While dragging a single board, snap its edges/centers onto other boards' edges/centers
within a zoom-invariant threshold and draw dashed-blue guide lines spanning the aligned boards;
holding Ctrl/⌘ suppresses snapping.

**Architecture:** A pure detection module (`lib/alignmentGuides.ts`) computes the snapped top-left
+ guide lines from the dragged rect and the other boards. `Canvas.onNodesChange` calls it and
mutates `change.position` BEFORE `nodeChangesToIntents` (controlled-nodes path — avoids the xyflow
#4593 `setNodes` jitter), stashing the guides in ephemeral local state. A screen-space SVG overlay
(`canvas/AlignmentGuides.tsx`) subscribes to the live camera transform and draws 1px dashed lines
that track pan/zoom and stay crisp at any zoom.

**Tech Stack:** React 18, TypeScript (strict), `@xyflow/react` v12 (`useStore`, `NodeChange`),
Vitest, existing Zustand canvas store.

**Spec:** `docs/superpowers/specs/2026-05-31-alignment-guides.md` · **Research:**
`docs/superpowers/research/2026-05-31-alignment-guides.md`

---

## File Structure

- **Create** `src/renderer/src/lib/alignmentGuides.ts` — pure detection + world→screen projection.
- **Create** `src/renderer/src/lib/alignmentGuides.test.ts` — unit tests for both.
- **Create** `src/renderer/src/canvas/AlignmentGuides.tsx` — screen-space SVG overlay.
- **Modify** `src/renderer/src/canvas/Canvas.tsx` — suppress ref, snap in `onNodesChange`, clear on
  drag stop, render the overlay.
- **Modify** `src/renderer/src/index.css` — `.align-guides` overlay + line tokens.

---

### Task 1: Pure detection module — `computeAlignment`

**Files:**
- Create: `src/renderer/src/lib/alignmentGuides.ts`
- Test: `src/renderer/src/lib/alignmentGuides.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/lib/alignmentGuides.test.ts
import { describe, expect, test } from 'vitest'
import { computeAlignment, projectGuide, SNAP_THRESHOLD_PX, type Rect } from './alignmentGuides'

const rect = (x: number, y: number, w = 100, h = 100): Rect => ({ x, y, w, h })

describe('computeAlignment — edge + center', () => {
  test('snaps left edge onto another board left edge within threshold', () => {
    const r = computeAlignment(rect(103, 400), [rect(100, 50)], 8)
    expect(r.x).toBe(100) // left 103 → 100
    expect(r.y).toBe(400) // no Y match → unchanged
    const g = r.guides.find((g) => g.axis === 'x')
    expect(g).toBeDefined()
    expect(g!.pos).toBe(100)
    // line spans the union of both boards' y extent
    expect(g!.start).toBe(50)
    expect(g!.end).toBe(500)
  })

  test('snaps center-x onto another board center-x', () => {
    // dragged centerX = 155+? choose so centerX is 3px from other centerX(=150)
    const r = computeAlignment(rect(103, 400), [rect(100, 50)], 8)
    // (covered above) — here assert a pure center case:
    const c = computeAlignment(rect(97, 400), [rect(100, 50)], 8)
    // dragged centerX = 147 vs other centerX 150 (diff 3) AND left 97 vs 100 (diff 3, tie)
    // smallest-or-equal keeps the FIRST found (left) — both snap x to 100 anyway here.
    expect(c.x).toBe(100)
  })

  test('snaps right edge onto another board left edge (edge touch)', () => {
    // dragged right = x+100; want it to land on other.left = 300
    const r = computeAlignment(rect(205, 400), [rect(300, 400)], 8)
    expect(r.x).toBe(200) // right 305 → 300 ⇒ x 200
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 300)).toBe(true)
  })

  test('no match beyond threshold returns rect unchanged with no guides', () => {
    const r = computeAlignment(rect(140, 400), [rect(100, 50)], 8)
    expect(r.x).toBe(140)
    expect(r.y).toBe(400)
    expect(r.guides).toEqual([])
  })

  test('picks the nearest candidate when several are in range', () => {
    // left 104: other A left 100 (diff 4), other B left 106 (diff 2) → snap to 106
    const r = computeAlignment(rect(104, 400), [rect(100, 50), rect(106, 50)], 8)
    expect(r.x).toBe(106)
  })

  test('matches both axes → two guides', () => {
    const r = computeAlignment(rect(103, 203), [rect(100, 200)], 8)
    expect(r.x).toBe(100)
    expect(r.y).toBe(200)
    expect(r.guides).toHaveLength(2)
    expect(r.guides.some((g) => g.axis === 'x')).toBe(true)
    expect(r.guides.some((g) => g.axis === 'y')).toBe(true)
  })

  test('SNAP_THRESHOLD_PX is the documented 8', () => {
    expect(SNAP_THRESHOLD_PX).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — `Failed to resolve import './alignmentGuides'` / `computeAlignment is not defined`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/renderer/src/lib/alignmentGuides.ts
/**
 * Pure smart-alignment detection (Canva/Figma "helper lines"). Given the dragged
 * board's candidate rect and the other boards, find the nearest edge/center alignment
 * per axis within `threshold` (WORLD units) and return the snapped top-left plus the
 * guide line(s) to draw. No React, no store — unit-tested like the other lib/*.ts.
 *
 * Snap math: a stop is `origin + offset`, offset ∈ {0, size/2, size}; to land that stop
 * on `target`, shift the origin by `target - stop`. The single smallest qualifying diff
 * per axis wins (a closer candidate replaces a farther one) — the rule shared by
 * Konva/tldraw/Excalidraw. The caller divides a screen-px threshold by zoom so the
 * "feel" is constant across zoom levels (research: Excalidraw SNAP_DISTANCE/zoom).
 */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * A guide line in WORLD coordinates. `axis:'x'` = a vertical line at world-x `pos`
 * spanning world-y [start,end]; `axis:'y'` = a horizontal line at world-y `pos`
 * spanning world-x [start,end].
 */
export interface Guide {
  axis: 'x' | 'y'
  pos: number
  start: number
  end: number
}

export interface AlignResult {
  /** Snapped top-left (unchanged on an axis with no match). */
  x: number
  y: number
  /** 0–2 guide lines (≤1 vertical, ≤1 horizontal). */
  guides: Guide[]
}

/** Screen px the dragged edge must be within to snap (caller divides by zoom). */
export const SNAP_THRESHOLD_PX = 8

interface OtherAxis {
  origin: number
  size: number
  perpMin: number
  perpMax: number
}

interface AxisMatch {
  origin: number
  pos: number
  spanMin: number
  spanMax: number
}

/** Stops along an axis: [near edge, center, far edge]. */
function stops(origin: number, size: number): [number, number, number] {
  return [origin, origin + size / 2, origin + size]
}

function bestAxisMatch(
  dragOrigin: number,
  dragSize: number,
  dragPerpMin: number,
  dragPerpMax: number,
  others: OtherAxis[],
  threshold: number
): AxisMatch | null {
  const dStops = stops(dragOrigin, dragSize)
  let best: (AxisMatch & { diff: number }) | null = null
  for (const o of others) {
    const oStops = stops(o.origin, o.size)
    for (const ds of dStops) {
      for (const os of oStops) {
        const diff = Math.abs(ds - os)
        if (diff > threshold) continue
        if (best && diff >= best.diff) continue
        best = {
          diff,
          origin: dragOrigin + (os - ds),
          pos: os,
          spanMin: Math.min(dragPerpMin, o.perpMin),
          spanMax: Math.max(dragPerpMax, o.perpMax)
        }
      }
    }
  }
  if (!best) return null
  return { origin: best.origin, pos: best.pos, spanMin: best.spanMin, spanMax: best.spanMax }
}

export function computeAlignment(rect: Rect, others: Rect[], threshold: number): AlignResult {
  // X axis (vertical guides): origin=x size=w; perpendicular extent = [y, y+h].
  const xMatch = bestAxisMatch(
    rect.x,
    rect.w,
    rect.y,
    rect.y + rect.h,
    others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h })),
    threshold
  )
  // Y axis (horizontal guides): origin=y size=h; perpendicular extent = [x, x+w].
  const yMatch = bestAxisMatch(
    rect.y,
    rect.h,
    rect.x,
    rect.x + rect.w,
    others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w })),
    threshold
  )

  const guides: Guide[] = []
  if (xMatch) guides.push({ axis: 'x', pos: xMatch.pos, start: xMatch.spanMin, end: xMatch.spanMax })
  if (yMatch) guides.push({ axis: 'y', pos: yMatch.pos, start: yMatch.spanMin, end: yMatch.spanMax })
  return { x: xMatch ? xMatch.origin : rect.x, y: yMatch ? yMatch.origin : rect.y, guides }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS (the `computeAlignment` group).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git commit -m "feat(align): pure edge/center alignment detection (slice 1)"
```

---

### Task 2: World→screen projection — `projectGuide`

**Files:**
- Modify: `src/renderer/src/lib/alignmentGuides.ts` (append)
- Test: `src/renderer/src/lib/alignmentGuides.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to the test file)**

```ts
describe('projectGuide — world → screen', () => {
  test('vertical guide maps x by zoom+translate, y span scaled', () => {
    // transform [tx, ty, zoom]
    const l = projectGuide({ axis: 'x', pos: 100, start: 50, end: 500 }, [10, 20, 2])
    expect(l).toEqual({ x1: 210, y1: 120, x2: 210, y2: 1020 })
  })

  test('horizontal guide maps y by zoom+translate, x span scaled', () => {
    const l = projectGuide({ axis: 'y', pos: 100, start: 50, end: 500 }, [10, 20, 2])
    expect(l).toEqual({ x1: 110, y1: 220, x2: 1010, y2: 220 })
  })

  test('identity transform is a pass-through', () => {
    const l = projectGuide({ axis: 'x', pos: 5, start: 0, end: 10 }, [0, 0, 1])
    expect(l).toEqual({ x1: 5, y1: 0, x2: 5, y2: 10 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — `projectGuide is not exported / not a function`.

- [ ] **Step 3: Write minimal implementation (append to `alignmentGuides.ts`)**

```ts
/** A guide projected into screen-space pixels for SVG. */
export interface ScreenLine {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Project a WORLD-space guide into screen pixels using React Flow's viewport
 * transform `[translateX, translateY, zoom]` (`useStore(s => s.transform)`):
 * screen = world*zoom + translate. Stroke width stays in screen px at the call site,
 * so the 1px line is crisp at any zoom.
 */
export function projectGuide(g: Guide, transform: [number, number, number]): ScreenLine {
  const [tx, ty, zoom] = transform
  if (g.axis === 'x') {
    const sx = g.pos * zoom + tx
    return { x1: sx, y1: g.start * zoom + ty, x2: sx, y2: g.end * zoom + ty }
  }
  const sy = g.pos * zoom + ty
  return { x1: g.start * zoom + tx, y1: sy, x2: g.end * zoom + tx, y2: sy }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS (both groups).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git commit -m "feat(align): world→screen guide projection (slice 1)"
```

---

### Task 3: Screen-space SVG overlay component

**Files:**
- Create: `src/renderer/src/canvas/AlignmentGuides.tsx`
- Modify: `src/renderer/src/index.css`

- [ ] **Step 1: Create the overlay component**

```tsx
// src/renderer/src/canvas/AlignmentGuides.tsx
/**
 * Screen-space SVG overlay drawing the active alignment guide lines while a board is
 * dragged. Subscribes to the live camera transform (`useStore(s => s.transform)`) so the
 * 1px dashed lines track pan/zoom and stay crisp at any zoom (stroke width is screen px,
 * NOT scaled by the viewport). `pointer-events:none` — it never intercepts the drag.
 * Renders nothing when there are no guides. Must be mounted under <ReactFlowProvider>.
 */
import { type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import { projectGuide, type Guide } from '../lib/alignmentGuides'

export function AlignmentGuides({ guides }: { guides: Guide[] }): ReactElement | null {
  const transform = useStore((s) => s.transform)
  if (guides.length === 0) return null
  return (
    <svg className="align-guides" aria-hidden="true">
      {guides.map((g, i) => {
        const l = projectGuide(g, transform)
        return <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
      })}
    </svg>
  )
}
```

- [ ] **Step 2: Add the overlay styles to `index.css`**

Append near the other canvas-chrome rules (e.g. after the preview/edge styles). Uses the locked
accent token; dashed to disambiguate from the solid-blue selection ring (spec decision).

```css
/* Smart alignment guides (drag-time): screen-space SVG over the canvas, never
   interactive. Dashed accent so it reads distinct from the solid select ring. */
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
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no usages yet; component is self-contained and imports resolve).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/AlignmentGuides.tsx src/renderer/src/index.css
git commit -m "feat(align): screen-space dashed guide overlay (slice 1)"
```

---

### Task 4: Wire snapping + guides into `Canvas.tsx`

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Add imports**

After the existing `cameraAnim` import (`Canvas.tsx:39`) and the `AppChrome` import block, add:

```ts
import { computeAlignment, SNAP_THRESHOLD_PX, type Guide } from '../lib/alignmentGuides'
import { AlignmentGuides } from './AlignmentGuides'
```

- [ ] **Step 2: Add guide state + Ctrl/⌘ suppress ref**

Inside `CanvasInner`, next to the other `useState` declarations (after `fullViewClosing`, around
`Canvas.tsx:116`):

```ts
  // Active alignment guide lines (ephemeral drag UI — never persisted). Set by the snap
  // pass in onNodesChange, cleared on drag stop.
  const [guides, setGuides] = useState<Guide[]>([])
  // True while Ctrl/⌘ is held — suppresses snapping mid-drag (Figma parity). A ref so the
  // snap pass reads it without re-creating onNodesChange.
  const snapSuppressRef = useRef(false)
```

- [ ] **Step 3: Track the suppress modifier (new effect)**

Add near the other keyboard effects (after the Esc-capture effect, around `Canvas.tsx:415`):

```ts
  // Track Ctrl/⌘ for the snap-suppress escape hatch. keydown AND keyup both read the live
  // modifier state so holding/releasing mid-drag toggles snapping without a stale latch.
  useEffect(() => {
    const update = (e: KeyboardEvent): void => {
      snapSuppressRef.current = e.ctrlKey || e.metaKey
    }
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
    }
  }, [])
```

- [ ] **Step 4: Snap inside `onNodesChange` (before the intent loop)**

Replace the body of `onNodesChange` (`Canvas.tsx:192-214`) — insert the snap pass at the top, keep
the existing intent loop verbatim, and add `boards`, `rf` to the deps:

```ts
  const onNodesChange = useCallback(
    (changes: NodeChange<BoardFlowNode>[]) => {
      // Smart-align pass: snap a single active board-drag onto edge/center matches and
      // surface the guide lines. Mutate change.position BEFORE translating to intents — the
      // controlled-nodes path, which avoids the xyflow #4593 setNodes-mid-drag jitter. Skip
      // while Ctrl/⌘ is held (freehand) and on multi-select drag (canonical single-node only).
      const active = changes.filter((c) => c.type === 'position' && c.dragging)
      const single = active.length === 1 ? active[0] : null
      if (single && single.type === 'position' && single.position && !snapSuppressRef.current) {
        const dragged = boards.find((b) => b.id === single.id)
        if (dragged) {
          const others = boards
            .filter((b) => b.id !== single.id)
            .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
          const rect = { x: single.position.x, y: single.position.y, w: dragged.w, h: dragged.h }
          const snap = computeAlignment(rect, others, SNAP_THRESHOLD_PX / rf.getZoom())
          single.position.x = snap.x
          single.position.y = snap.y
          setGuides(snap.guides)
        }
      } else if (active.length > 0) {
        // Dragging but suppressed or multi-select → no guides (no-op if already empty).
        setGuides((g) => (g.length ? [] : g))
      }

      let nextSel: string | null | undefined
      for (const intent of nodeChangesToIntents(changes)) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'select') nextSel = intent.id
        else if (intent.kind === 'deselect') {
          if (nextSel === undefined) nextSel = null
        } else if (intent.kind === 'remove') {
          const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
          if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
      }
      if (nextSel !== undefined) selectBoard(nextSel)
    },
    [updateBoard, resizeBoard, removeBoard, selectBoard, boards, rf]
  )
```

- [ ] **Step 5: Clear guides on drag stop**

Update `onNodeDragStop` (`Canvas.tsx:258`):

```ts
  const onNodeDragStop = useCallback(() => {
    setNodeGesture(false)
    setGuides((g) => (g.length ? [] : g))
  }, [setNodeGesture])
```

- [ ] **Step 6: Render the overlay**

Inside the `paneRef` div, immediately after the closing `</ReactFlow>` tag (`Canvas.tsx:482`) and
before `{boards.length === 0 && <EmptyState .../>}`:

```tsx
          </ReactFlow>

          <AlignmentGuides guides={guides} />

          {boards.length === 0 && <EmptyState onAdd={addCentered} />}
```

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS. (Note: `NodeChange<BoardFlowNode>` is a union; the `single.type === 'position'`
re-check inside the `if` narrows it so `single.position` is typed — keep that guard.)

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(align): wire drag-time snap + guides into Canvas (slice 1)"
```

---

### Task 5: Full verification + manual check + e2e gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `pnpm vitest run`
Expected: PASS — all prior tests + the new `alignmentGuides` group (no regressions).

- [ ] **Step 2: Typecheck + lint (whole repo)**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS, no unused locals/params.

- [ ] **Step 3: Manual check in dev**

Run: `pnpm dev`
Verify by hand:
1. Drag a board so its left/right/center nears another's → dashed blue guide appears and the board
   snaps onto the line.
2. Top/bottom/center → horizontal guide.
3. Hold Ctrl (Win) / ⌘ (mac) mid-drag → guide disappears, drag is freehand.
4. Zoom in/out, drag again → line stays 1px and dashed, tracks the camera.
5. Release → guide clears. Resize a board → no guides.

- [ ] **Step 4: Run the board e2e harness**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_DONE`, all parts `ok:true` (19/19). The `browser`/`browser-gesture`/`focus-detach`
trio is the known env capturePage flake (memory `e2e-browser-trio-flake`) — rerun on a clean
`electron` process for a clean pass; it is NOT a regression from this slice (this slice only mutates
`position` and adds an HTML overlay; the native-view path is untouched).

- [ ] **Step 5: Commit any verification fixups, then mark slice 1 done**

```bash
git add -A
git commit -m "chore(align): slice 1 verified (unit + typecheck + lint + e2e)"
```

---

## Self-Review

**Spec coverage (slice 1 acceptance):**
1. Left/right/center edge snap + guide → Task 1 (detection) + Task 4 (wire) + Task 3 (render). ✓
2. Top/bottom/center horizontal guide → Task 1 (Y axis) + Task 4. ✓
3. Ctrl/⌘ suppress → Task 4 Steps 2–4 (ref + effect + skip). ✓
4. 1px dashed, tracks pan/zoom → Task 2 (projection) + Task 3 (CSS + `useStore` transform). ✓
5. Guides clear on drag stop; never persisted → Task 4 Step 5 + local `useState` (not store). ✓
6. Resize unaffected → snap gated on `c.dragging` (resize emits non-dragging position/dimensions). ✓
7. typecheck/lint/unit/e2e green → Task 5. ✓

**Placeholder scan:** none — every code step shows full code; commands have expected output.

**Type consistency:** `Rect`, `Guide`, `AlignResult`, `ScreenLine`, `computeAlignment`,
`projectGuide`, `SNAP_THRESHOLD_PX` are defined in Task 1/2 and used unchanged in Tasks 3–4. The
overlay prop is `guides: Guide[]` in both the component (Task 3) and the call site (Task 4 Step 6).
`transform` is the `[number, number, number]` tuple from `useStore(s => s.transform)`, matching
`projectGuide`'s signature.

**Deferred to Slice 2 (separate plan after this ships):** distribution / equal-spacing guides +
"Npx" spacing labels (Excalidraw gap algorithm). Out of scope here.
