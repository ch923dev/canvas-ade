# Whiteboard W1 — Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three W1 quick wins for the Planning whiteboard — an atomic swipe **eraser**, board-scoped **letter tool shortcuts** (s/n/c/a/p/e), and an explicit **scene/session no-persist guardrail** (doc only).

**Architecture:** All three ride the existing board-local pointer loop in `PlanningBoard.tsx` and add **zero persisted schema**. The eraser's cross-kind hit-testing goes into a new pure, unit-tested `planning/erase.ts` (the helpers W2 multi-select + snapping later reuse). The shortcut key→tool map goes into a new pure `planning/tools.ts` (also the new home of the shared `PlanTool` type). The guardrail is comment-only.

**Tech Stack:** React 18 + TypeScript (strict), Zustand store (`useCanvasStore`), Vitest + @testing-library, `@xyflow/react`. Whiteboard elements are a discriminated union on `kind` (`note`/`text`/`arrow`/`stroke`/`checklist`) stored in board-local px on `board.elements`.

**Roadmap source:** [`../../roadmap-whiteboard.md`](../../roadmap-whiteboard.md) › Phase W1. Why/how/risk depth: [`../../research/excalidraw-feature-borrowing.md`](../../research/excalidraw-feature-borrowing.md).

---

## Non-negotiable constraints (apply to every task)

- **One undo checkpoint per gesture** + the `lastRecorded` phantom-undo discipline. **Deviation from the research, deliberate:** the research said `beginChange()` ONCE on eraser pointer-**down**. We instead defer `beginChange()` to pointer-**up**, inside the commit branch, only when something was actually erased. Calling `beginChange()` on down would push a snapshot even for an empty swipe — the exact phantom-undo class of open finding **WB-1** and memory `undo-lastrecorded-phantom`. The move path already defers for this reason (`PlanningBoard.tsx:209-211, 311-314`); we mirror it.
- **Letters only** for shortcuts — never the number row (dodges the live global `1`=fit / `0`=recenter / `t`=tidy bindings in `Canvas.tsx:596-616`).
- **`e.stopPropagation()` on a handled shortcut.** React 18 attaches its listeners at the root container; a synthetic `stopPropagation()` calls the native `stopPropagation()`, which prevents the event from bubbling up to the `window` keydown listener in `Canvas.tsx:572`. The global typing-guard there only suppresses INPUT/TEXTAREA/contentEditable — NOT this focusable `<div>` — so without the stop, bare keys would double-fire.
- **Atomic erase only** — a hit removes the WHOLE element; never erase part of a stroke/arrow (Excalidraw #4904 is out of scope).
- Calm aesthetic, one accent. No new persisted fields.

---

## File Structure

**Create:**
- `src/renderer/src/canvas/boards/planning/erase.ts` — pure cross-kind hit-test helpers (`eraseHitTest` + internals). One responsibility: "does this board-local point hit this element?"
- `src/renderer/src/canvas/boards/planning/erase.test.ts` — unit tests for the above.
- `src/renderer/src/canvas/boards/planning/tools.ts` — the shared `PlanTool` type + the pure `shortcutTool(key, mods)` map.
- `src/renderer/src/canvas/boards/planning/tools.test.ts` — unit tests for `shortcutTool`.

**Modify:**
- `src/renderer/src/canvas/Icon.tsx:9-38` (add `'erase'` to `IconName`) + `:43` (add the glyph path).
- `src/renderer/src/canvas/boards/PlanningBoard.tsx` — import `PlanTool` from `./planning/tools` (drop the inline type at `:61`), add the eraser tool wiring, the letter-shortcut handler, focus-on-empty-press.
- `src/renderer/src/lib/boardSchema.ts:195` — one-line scene/session contract comment on `toObject`.
- `src/renderer/src/store/canvasStore.ts:211-221` — one-line note on `PATCHABLE_KEYS`.
- `CLAUDE.md` — one sentence on the scene/session split.

---

## Task 1: Pure eraser hit-test helpers (`erase.ts`)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/erase.ts`
- Test: `src/renderer/src/canvas/boards/planning/erase.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/boards/planning/erase.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { eraseHitTest, ERASE_TOL, TEXT_HIT } from './erase'
import { makeNote, makeChecklist, makeArrow, makeStroke, makeText } from './elements'

describe('eraseHitTest — cards (rect + tolerance)', () => {
  it('hits a note inside its rect and within the tolerance band', () => {
    const note = makeNote('n', { x: 100, y: 100 }, 0) // w156 h96, x=22 y=80
    expect(eraseHitTest(note, { x: note.x + 10, y: note.y + 10 })).toBe(true)
    // just outside, but within ERASE_TOL → still a hit
    expect(eraseHitTest(note, { x: note.x - (ERASE_TOL - 1), y: note.y + 10 })).toBe(true)
    // well outside → miss
    expect(eraseHitTest(note, { x: note.x - 100, y: note.y })).toBe(false)
  })

  it('uses a nominal height for a checklist (schema h is 0)', () => {
    const cl = makeChecklist('cl', 'i0', { x: 200, y: 200 }) // h:0 in schema
    // a point a couple rows below the anchor must still hit the rendered card
    expect(eraseHitTest(cl, { x: cl.x + 10, y: cl.y + 40 })).toBe(true)
  })

  it('uses a nominal box for auto-sized text', () => {
    const t = makeText('t', { x: 50, y: 50 })
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w / 2, y: 50 + TEXT_HIT.h / 2 })).toBe(true)
    expect(eraseHitTest(t, { x: 50 + TEXT_HIT.w + 50, y: 50 })).toBe(false)
  })
})

describe('eraseHitTest — vectors (distance)', () => {
  it('hits near an arrow and misses far from it', () => {
    const a = { ...makeArrow('a', { x: 0, y: 0 }), x2: 100, y2: 0 }
    expect(eraseHitTest(a, { x: 50, y: 2 })).toBe(true) // on the line
    expect(eraseHitTest(a, { x: 50, y: 60 })).toBe(false) // far below
  })

  it('hits near a stroke polyline and misses far from it', () => {
    const s = makeStroke('s', [0, 0, 50, 0, 100, 0])
    expect(eraseHitTest(s, { x: 25, y: 3 })).toBe(true)
    expect(eraseHitTest(s, { x: 25, y: 40 })).toBe(false)
  })

  it('handles a single-point (dot) stroke', () => {
    const s = makeStroke('s', [10, 10])
    expect(eraseHitTest(s, { x: 12, y: 12 })).toBe(true)
    expect(eraseHitTest(s, { x: 40, y: 40 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/erase.test.ts`
Expected: FAIL — `Failed to resolve import "./erase"` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/canvas/boards/planning/erase.ts`:

```ts
/**
 * Pure cross-kind hit-testing for the Planning whiteboard's eraser (W1.1) — and,
 * later, multi-select's marquee + snapping anchors (W2). No React, no DOM: takes
 * an element + a board-local point and answers "is this point on/near it?" so a
 * swipe can collect the ids to delete atomically. Unit-tested like elements.test.ts.
 *
 * Atomic only: a hit removes the WHOLE element — partial stroke/arrow erasing
 * (Excalidraw #4904) is out of scope.
 */
import type { ArrowElement, PlanningElement, StrokeElement } from '../../../lib/boardSchema'

/** A board-local point (same coordinate space as element x/y). */
export interface HitPoint {
  x: number
  y: number
}

/**
 * Hit tolerance in BOARD-LOCAL px. Zoom-stable: the caller maps the screen pointer
 * to board space (÷ camera zoom) before calling, so this band stays constant on the
 * board regardless of camera zoom.
 */
export const ERASE_TOL = 8

/**
 * Auto-sized text persists no w/h, so give it a nominal hit box anchored at its
 * top-left. Approximate; W2 refines this with a DOM-measured bbox.
 */
export const TEXT_HIT = { w: 96, h: 24 } as const

/** Point-in-rectangle with a tolerance band (board-local). */
function inRect(p: HitPoint, x: number, y: number, w: number, h: number, tol: number): boolean {
  return p.x >= x - tol && p.x <= x + w + tol && p.y >= y - tol && p.y <= y + h + tol
}

/** Shortest distance from point p to the segment a→b. */
function distToSegment(p: HitPoint, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - ax, p.y - ay)
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy))
}

/**
 * Sample the arrow's cubic bezier (SAME control points as `arrowPath` in
 * svgPaths.ts) and test the min distance from the swipe point to the sampled
 * polyline. Keeps the eraser's notion of "on the arrow" identical to what's drawn.
 */
function nearArrow(a: ArrowElement, p: HitPoint, tol: number): boolean {
  const c1x = a.x + (a.x2 - a.x) * 0.4
  const c1y = a.y + (a.y2 - a.y) * 0.1
  const c2x = a.x + (a.x2 - a.x) * 0.6
  const c2y = a.y2 - (a.y2 - a.y) * 0.1
  const STEPS = 16
  let prevX = a.x
  let prevY = a.y
  for (let i = 1; i <= STEPS; i++) {
    const t = i / STEPS
    const mt = 1 - t
    const x = mt * mt * mt * a.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * a.x2
    const y = mt * mt * mt * a.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * a.y2
    if (distToSegment(p, prevX, prevY, x, y) <= tol) return true
    prevX = x
    prevY = y
  }
  return false
}

/** Test the min distance from the swipe point to any segment of the polyline. */
function nearStroke(s: StrokeElement, p: HitPoint, tol: number): boolean {
  const pts = s.points
  if (pts.length < 2) return false
  if (pts.length === 2) return Math.hypot(p.x - pts[0], p.y - pts[1]) <= tol
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (distToSegment(p, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= tol) return true
  }
  return false
}

/**
 * True if the board-local point hits the element (within `tol`). Cards use a
 * tolerance-padded rect (checklist uses a nominal height since its schema h is 0);
 * arrows sample the bezier; strokes test the polyline; text uses a nominal box.
 */
export function eraseHitTest(el: PlanningElement, p: HitPoint, tol = ERASE_TOL): boolean {
  switch (el.kind) {
    case 'note':
      return inRect(p, el.x, el.y, el.w, el.h, tol)
    case 'checklist': {
      // Approximate the rendered card height: header + item rows + add-item button.
      const h = 30 + el.items.length * 24 + 24
      return inRect(p, el.x, el.y, el.w, h, tol)
    }
    case 'text':
      return inRect(p, el.x, el.y, TEXT_HIT.w, TEXT_HIT.h, tol)
    case 'arrow':
      return nearArrow(el, p, tol)
    case 'stroke':
      return nearStroke(el, p, tol)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/erase.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/erase.ts src/renderer/src/canvas/boards/planning/erase.test.ts
git commit -m "feat(whiteboard): pure cross-kind eraser hit-test helpers (W1.1)"
```

---

## Task 2: Shared `PlanTool` type + pure `shortcutTool` map (`tools.ts`)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/tools.ts`
- Test: `src/renderer/src/canvas/boards/planning/tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/boards/planning/tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shortcutTool } from './tools'

const NONE = { ctrl: false, meta: false, alt: false }

describe('shortcutTool', () => {
  it('maps each whiteboard letter to its tool', () => {
    expect(shortcutTool('s', NONE)).toBe('select')
    expect(shortcutTool('n', NONE)).toBe('note')
    expect(shortcutTool('c', NONE)).toBe('check')
    expect(shortcutTool('a', NONE)).toBe('arrow')
    expect(shortcutTool('p', NONE)).toBe('pen')
    expect(shortcutTool('e', NONE)).toBe('erase')
  })

  it('is case-insensitive', () => {
    expect(shortcutTool('S', NONE)).toBe('select')
    expect(shortcutTool('E', NONE)).toBe('erase')
  })

  it('returns null for any modified chord (so Ctrl/Cmd/Alt shortcuts pass through)', () => {
    expect(shortcutTool('s', { ctrl: true, meta: false, alt: false })).toBeNull()
    expect(shortcutTool('a', { ctrl: false, meta: true, alt: false })).toBeNull()
    expect(shortcutTool('p', { ctrl: false, meta: false, alt: true })).toBeNull()
  })

  it('returns null for unmapped keys', () => {
    expect(shortcutTool('t', NONE)).toBeNull() // global tidy — never a board tool
    expect(shortcutTool('1', NONE)).toBeNull()
    expect(shortcutTool('z', NONE)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/tools.test.ts`
Expected: FAIL — `Failed to resolve import "./tools"`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/canvas/boards/planning/tools.ts`:

```ts
/**
 * The Planning whiteboard's tool set + pure keyboard mapping (W1.2). Lives in its
 * own module so the `PlanTool` type is shareable (PlanningBoard + this map) and the
 * key→tool logic is unit-testable without React.
 *
 * Letters ONLY (s/n/c/a/p/e): the number row is deliberately avoided so a board
 * shortcut never collides with the live global 1=fit / 0=recenter / t=tidy canvas
 * bindings (Canvas.tsx). The board-internal tool set; distinct from the dock's
 * add-board tool.
 */

export type PlanTool = 'select' | 'note' | 'check' | 'arrow' | 'pen' | 'erase'

const SHORTCUTS: Record<string, PlanTool> = {
  s: 'select',
  n: 'note',
  c: 'check',
  a: 'arrow',
  p: 'pen',
  e: 'erase'
}

/**
 * Map a bare letter key to a tool. Returns null for an unmapped key OR any modified
 * chord (Ctrl/Cmd/Alt) so app-level shortcuts like Ctrl+A / Cmd+Z pass straight
 * through to the global handler.
 */
export function shortcutTool(
  key: string,
  mods: { ctrl: boolean; meta: boolean; alt: boolean }
): PlanTool | null {
  if (mods.ctrl || mods.meta || mods.alt) return null
  return SHORTCUTS[key.toLowerCase()] ?? null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/tools.ts src/renderer/src/canvas/boards/planning/tools.test.ts
git commit -m "feat(whiteboard): shared PlanTool type + pure shortcutTool map (W1.2)"
```

---

## Task 3: Add the `erase` icon glyph

**Files:**
- Modify: `src/renderer/src/canvas/Icon.tsx:9-38` (type) + `:43-76` (PATHS)

- [ ] **Step 1: Add `'erase'` to the `IconName` union**

In `src/renderer/src/canvas/Icon.tsx`, add `| 'erase'` to the `IconName` union (after `'pen'` at line 23):

```ts
  | 'arrow'
  | 'pen'
  | 'erase'
  | 'refresh'
```

- [ ] **Step 2: Add the glyph path**

In the `PATHS` record, add an `erase` entry after the `pen` line (`:57`). A tilted eraser block + baseline, matching the 1.5px / 24-unit-viewBox functional style:

```ts
  pen: 'M5 19l2-6 9-9 4 4-9 9-6 2zM14 6l4 4',
  erase: 'M16 7l5 5-9 9H7l-3-3z M9 21h12',
  refresh: 'M4 12a8 8 0 1 0 2.3-5.6M5 4v3.5H8.5',
```

- [ ] **Step 3: Verify typecheck still passes**

Run: `pnpm typecheck:web`
Expected: PASS (no type errors — the new union member is consumed in Task 4).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/Icon.tsx
git commit -m "feat(icons): add eraser glyph"
```

---

## Task 4: Wire the eraser tool into `PlanningBoard`

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`

This task has no new unit test (the logic is pure-tested in Task 1); it is verified by typecheck + the manual/e2e gate in Task 7. Make the edits in order.

- [ ] **Step 1: Import the shared type + the hit-test helper; drop the inline `PlanTool`**

Replace the inline type definition at `PlanningBoard.tsx:60-61`:

```ts
/** The whiteboard tools (board-internal; distinct from the dock add-board tool). */
type PlanTool = 'select' | 'note' | 'check' | 'arrow' | 'pen'
```

with an import. Add to the existing `./planning/elements` import block a sibling import (place after the `WhiteboardSvg` import at `:43`):

```ts
import { WhiteboardSvg } from './planning/WhiteboardSvg'
import { eraseHitTest } from './planning/erase'
import type { PlanTool } from './planning/tools'
```

(Delete the old `type PlanTool = ...` line at `:60-61`.)

- [ ] **Step 2: Add `erase` to the `TOOLS` cluster**

Extend the `TOOLS` array type + entries (`:63-72`) to include the eraser:

```ts
const TOOLS: ReadonlyArray<{
  tool: PlanTool
  icon: 'select' | 'note' | 'check' | 'arrow' | 'pen' | 'erase'
}> = [
  { tool: 'select', icon: 'select' },
  { tool: 'note', icon: 'note' },
  { tool: 'check', icon: 'check' },
  { tool: 'arrow', icon: 'arrow' },
  { tool: 'pen', icon: 'pen' },
  { tool: 'erase', icon: 'erase' }
]
```

- [ ] **Step 3: Add the erase drag mode + the `pendingErase` state**

Extend the `drag` ref union (`:106-111`) with an erase mode:

```ts
  const drag = useRef<
    | { mode: 'move'; id: string; grabX: number; grabY: number }
    | { mode: 'arrow'; id: string }
    | { mode: 'pen'; points: number[] }
    | { mode: 'erase'; removed: Set<string> }
    | null
  >(null)
```

Add a `pendingErase` state next to the other draft state (after `dragPos` at `:103`):

```ts
  // Ids the in-flight erase swipe has marked for deletion. While set, those
  // elements are hidden from the render (immediate feedback) and committed as ONE
  // checkpoint on pointer-up. Null when not erasing.
  const [pendingErase, setPendingErase] = useState<Set<string> | null>(null)
```

- [ ] **Step 4: Add the erase branch to `onWellPointerDown`**

In `onWellPointerDown`, after the `if (tool === 'pen') { … }` block (`:257-264`) and before the trailing comment, add:

```ts
      if (tool === 'erase') {
        // Do NOT beginChange() here — an empty swipe must not push a phantom undo
        // snapshot (the move/draw paths defer for the same reason; WB-1 class). The
        // checkpoint is taken in onWellPointerUp only if something was erased.
        const removed = new Set<string>()
        for (const el of elements) if (eraseHitTest(el, p)) removed.add(el.id)
        drag.current = { mode: 'erase', removed }
        setPendingErase(new Set(removed))
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
```

- [ ] **Step 5: Add the erase branch to `onWellPointerMove`**

In `onWellPointerMove`, extend the `if (d.mode === …)` chain (`:276-285`) with:

```ts
      } else if (d.mode === 'erase') {
        let grew = false
        for (const el of elements) {
          if (!d.removed.has(el.id) && eraseHitTest(el, p)) {
            d.removed.add(el.id)
            grew = true
          }
        }
        if (grew) setPendingErase(new Set(d.removed))
      }
```

- [ ] **Step 6: Add the erase branch to `onWellPointerUp`**

In `onWellPointerUp`, extend the `if (d.mode === …)` chain (`:310-334`) with an erase branch (the eraser STAYS active afterward — it's a mode, like Excalidraw — so no `setTool('select')`):

```ts
    } else if (d.mode === 'erase') {
      const removed = d.removed
      setPendingErase(null)
      if (removed.size > 0) {
        // One checkpoint for the whole swipe (phantom-undo discipline).
        beginChange()
        commit(elements.filter((el) => !removed.has(el.id)))
      }
    }
```

Also add `pendingErase` is NOT needed in the dep array (the branch reads `d.removed`, `elements`, `beginChange`, `commit` — all already deps or stable). Verify the existing `useCallback` dep array `[draftArrow, dragPos, commit, elements, beginChange]` is unchanged and sufficient.

- [ ] **Step 7: Hide erased elements from the live render**

Replace the `viewElements` derivation (`:373-375`) so an in-flight erase swipe hides its candidates immediately (arrows/strokes derive from `viewElements`, so they vanish too):

```ts
  const viewElements = dragPos
    ? translateElement(elements, dragPos.id, dragPos.dx, dragPos.dy)
    : pendingErase && pendingErase.size > 0
      ? elements.filter((el) => !pendingErase.has(el.id))
      : elements
```

- [ ] **Step 8: Add the eraser cursor**

In the well's `style.cursor` ternary (`:420`), add the erase case:

```ts
          cursor:
            tool === 'erase'
              ? 'cell'
              : drawing
                ? 'crosshair'
                : tool === 'note' || tool === 'check'
                  ? 'copy'
                  : 'default',
```

- [ ] **Step 9: Verify typecheck + full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS — no type errors; all existing tests + Tasks 1-2 green.

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(whiteboard): swipe eraser tool — atomic, one undo step (W1.1)"
```

---

## Task 5: Wire the letter shortcuts + focus-on-empty-press

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`

- [ ] **Step 1: Import `shortcutTool`**

Add to the import added in Task 4 Step 1:

```ts
import { eraseHitTest } from './planning/erase'
import { shortcutTool, type PlanTool } from './planning/tools'
```

(Merge the type + value import into one line; remove the separate `import type { PlanTool }` line.)

- [ ] **Step 2: Focus the well on an empty-well press so shortcuts are reachable**

In `onWellPointerDown`, right after the select-guard return (`:230`) and before `setSelectedElId(null)` (`:231`), add a focus call for the empty-well case:

```ts
      if (tool === 'select' && e.target !== e.currentTarget) return
      // An empty-well press focuses the well so the board-scoped letter shortcuts
      // (onKeyDown below) have a focus target. A press on a card focuses that card.
      if (e.target === e.currentTarget) e.currentTarget.focus()
      setSelectedElId(null)
```

- [ ] **Step 3: Add the shortcut branch to the well's `onKeyDown`**

Replace the well's `onKeyDown` handler (`:407-415`) with one that also maps letter shortcuts:

```ts
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElId) {
            e.stopPropagation()
            e.preventDefault()
            beginChange()
            commit(removeElement(elements, selectedElId))
            setSelectedElId(null)
            return
          }
          const next = shortcutTool(e.key, {
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            alt: e.altKey
          })
          if (next) {
            // Stop the bare key from ALSO firing the global Canvas window-keydown
            // bindings: React dispatches at the root container, so this native stop
            // prevents the bubble up to window (the global typing-guard only covers
            // INPUT/TEXTAREA/contentEditable, not this focusable div).
            e.stopPropagation()
            e.preventDefault()
            setTool(next)
            setSelectedElId(null)
          }
        }}
```

- [ ] **Step 4: Verify typecheck + full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(whiteboard): board-scoped letter tool shortcuts s/n/c/a/p/e (W1.2)"
```

---

## Task 6: Scene/session no-persist guardrail (doc only)

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts:195`
- Modify: `src/renderer/src/store/canvasStore.ts:211-216`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Comment the serialization contract on `toObject`**

In `boardSchema.ts`, replace the `toObject` doc comment (`:195`):

```ts
/** Boards + camera → a versioned document. Deep-clones so the doc owns its data. */
```

with:

```ts
/**
 * Boards + camera → a versioned document. Deep-clones so the doc owns its data.
 *
 * SCENE/SESSION CONTRACT: this is the ONLY thing persisted — {schemaVersion,
 * viewport, boards}. Ephemeral session state (selected tool, selected element,
 * in-flight draft/erase, hover) lives in React/Zustand and MUST NEVER be routed
 * into `board.elements[]` or a board patch key, or it bloats every autosave and
 * resurrects stale tool/selection state on reload. (Excalidraw's
 * cleanAppStateForExport discipline, enforced here by omission.)
 */
```

- [ ] **Step 2: Comment the patch-key allowlist**

In `canvasStore.ts`, extend the `PATCHABLE_KEYS` doc comment (`:211-216`) with a sentence on ephemeral state. Replace:

```ts
/**
 * Patch keys a board of each type may accept — id/type are never patchable, and an
 * off-type field (e.g. `url`) must never land on a board it doesn't belong to (that
 * would forge a cross-type hybrid the discriminated union forbids). The common,
 * geometry/title keys are mergeable on every type.
 */
```

with the same plus a final line:

```ts
/**
 * Patch keys a board of each type may accept — id/type are never patchable, and an
 * off-type field (e.g. `url`) must never land on a board it doesn't belong to (that
 * would forge a cross-type hybrid the discriminated union forbids). The common,
 * geometry/title keys are mergeable on every type.
 *
 * SCENE/SESSION CONTRACT: never add an ephemeral key here (selected tool/element,
 * in-flight draft/erase, hover). Those stay in component/Zustand session state and
 * are never serialized — see boardSchema.toObject.
 */
```

- [ ] **Step 3: Add one sentence to CLAUDE.md**

In `CLAUDE.md`, under the `### Persistence` section, add a bullet after the existing persistence bullets:

```markdown
- **Scene/session split (whiteboard + boards):** only `{schemaVersion, viewport, boards}` is
  serialized (`boardSchema.toObject`). Ephemeral session state — selected tool/element, in-flight
  draft/erase, hover — stays in React/Zustand and is NEVER routed into `elements[]` or a board patch
  key (`PATCHABLE_KEYS`). Borrowed from Excalidraw's `cleanAppStateForExport` discipline.
```

- [ ] **Step 4: Verify typecheck (comments only — no behavior change)**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/store/canvasStore.ts CLAUDE.md
git commit -m "docs(whiteboard): make the scene/session no-persist contract explicit (W1.3)"
```

---

## Task 7: Final gate — full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run`
Expected: typecheck clean, lint clean, all tests pass (≥ 482 prior + the new `erase.test.ts` + `tools.test.ts` cases).

- [ ] **Step 2: Build + board e2e smoke (PowerShell)**

Run:
```powershell
pnpm build
$env:CANVAS_SMOKE='e2e'; pnpm start
```
Expected: prints `E2E_*` lines and `E2E_DONE`. The 3 documented browser-trio `WebContentsView` capturePage flakes (memory `e2e-browser-trio-flake`) are acceptable; nothing planning-related should regress. (Clear the env var after: `Remove-Item Env:\CANVAS_SMOKE`.)

- [ ] **Step 3: Manual verification (the behaviors unit tests can't cover)**

Run `pnpm dev`, add a Planning board, then verify:
1. **Eraser:** select the eraser tool (or press `e`) → swipe across notes/text/checklist/arrow/stroke → they vanish under the swipe and stay gone on release → **one** Ctrl+Z restores ALL of them in a single step.
2. **Empty swipe:** pick the eraser, click empty well, release (no element hit) → Ctrl+Z does NOT produce a no-op undo (no phantom checkpoint).
3. **Shortcuts:** click the board's empty well (focuses it) → press `n` (note tool), `a` (arrow), `p` (pen), `s` (select), `e` (erase) → the active tool changes; pressing `t`/`1`/`0` does NOT trigger the global tidy/fit/recenter while a tool letter has focus on the well... confirm `1`/`0` still work when the board is NOT focused (click empty canvas first).
4. **No regression:** notes/checklists/arrows/pen still create, move (one undo step), and edit as before.

- [ ] **Step 4: Update the roadmap status**

In `docs/roadmap-whiteboard.md`, change the W1 status row from `not started` to `✅ done`, and tick W1.1/W1.2/W1.3 in the phase body if you added per-slice markers.

```bash
git add docs/roadmap-whiteboard.md
git commit -m "docs: mark whiteboard W1 shipped"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** W1.1 eraser → Tasks 1,3,4. W1.2 shortcuts → Tasks 2,5. W1.3 guardrail → Task 6. All three W1 slices covered.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
- **Type consistency:** `PlanTool` defined once in `tools.ts` (Task 2), imported by `PlanningBoard` (Task 4/5); `IconName 'erase'` added in Task 3 before its use in Task 4; `eraseHitTest`/`ERASE_TOL`/`TEXT_HIT` signatures match between `erase.ts` (Task 1) and its test + the `PlanningBoard` call sites. `shortcutTool(key, {ctrl,meta,alt})` signature matches between `tools.ts`, its test, and the `onKeyDown` call site.
- **Deviation noted:** eraser defers `beginChange()` to pointer-up (vs the research's literal "on down") to honor the locked phantom-undo discipline — documented in constraints + Task 4 Step 4.
