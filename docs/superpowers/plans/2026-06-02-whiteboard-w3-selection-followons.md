# Whiteboard W3 — Selection follow-ons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add alt-drag duplicate, align/distribute, per-element lock, and lightweight grouping to the Planning whiteboard — all surfaced through one right-click ElementContextMenu, building on W2's selection set.

**Architecture:** Pure, unit-tested element transforms (`elements.ts` additions + new `align.ts`) layered under a presentational portal menu (`ElementContextMenu.tsx`) wired into `PlanningBoard.tsx`. Schema gains two optional `ElementCommon` fields (v2 → v3, additive no-op migration). A single `isLocked` gate is applied at all four mutation entry points (drag, keyboard-delete, per-element X, erase). One undo checkpoint per gesture via the existing deferred-`beginChange()` discipline.

**Tech Stack:** TypeScript (strict), React 18, Zustand, Vitest (unit), the `CANVAS_SMOKE=e2e` in-process Electron harness (e2e). Spec: `docs/superpowers/specs/2026-06-02-whiteboard-w3-selection-followons-design.md`.

**Worktree (all paths absolute):** `Z:\canvas-ade-whiteboard-w3` on branch `feat/whiteboard-w3`. Use `git -C "Z:\canvas-ade-whiteboard-w3"` and `pnpm -C "Z:\canvas-ade-whiteboard-w3"` — never `cd` (memory `parallel-agent-worktrees`). Commits via the Bash tool: a quoted heredoc `git commit -F -` (backticks in `-m` get shell-substituted — memory `bash-tool-commit-backticks`).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/renderer/src/lib/boardSchema.ts` | `locked?`/`groupId?` on `ElementCommon`; `SCHEMA_VERSION=3`; `MIGRATIONS[2]`; assert | 1 |
| `src/renderer/src/lib/boardSchema.test.ts` | migration + assert tests | 1 |
| `src/renderer/src/canvas/boards/planning/elements.ts` | `isLocked`, `expandGroups`, `duplicateElements`, `groupElements`, `ungroupElements`, `setLocked` | 2 |
| `src/renderer/src/canvas/boards/planning/elements.test.ts` | mutator tests | 2 |
| `src/renderer/src/canvas/boards/planning/align.ts` *(new)* | `alignElements`, `distributeElements` | 3 |
| `src/renderer/src/canvas/boards/planning/align.test.ts` *(new)* | align/distribute math tests | 3 |
| `src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx` *(new)* | portal menu (position clamp, outside/Escape close, entries) | 4 |
| `src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx` *(new)* | menu render/close/disabled tests | 4 |
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` | lock gate, alt-drag, group-expand, context-menu wiring | 5 |
| `src/main/e2e/probes/whiteboard.ts` | 4 new W3 probes | 6 |
| `src/main/e2e/index.ts` | register probes in PLAYLIST before `seed` | 6 |

**Dependency order:** Task 1 first (others import the new types). Tasks 2, 3, 4 are file-disjoint and depend only on Task 1 → parallelizable. Task 5 depends on 1–4. Task 6 depends on 5.

---

## Task 1: Schema v3 — `locked?` + `groupId?`

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts` (`ElementCommon` :57, `SCHEMA_VERSION` :15, `MIGRATIONS` :216, `assertPlanningElement` :293)
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `boardSchema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fromObject, migrate, SCHEMA_VERSION, type CanvasDoc } from './boardSchema'

describe('W3 schema v3', () => {
  it('SCHEMA_VERSION is 3', () => {
    expect(SCHEMA_VERSION).toBe(3)
  })

  it('migrates a v2 doc to v3 without mutating elements', () => {
    const v2: CanvasDoc = {
      schemaVersion: 2,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [{ id: 'n1', kind: 'note', x: 10, y: 10, w: 156, h: 96, tint: 'yellow', text: '' }]
        }
      ]
    }
    const out = migrate(structuredClone(v2))
    expect(out.schemaVersion).toBe(3)
    expect(out.boards[0]).toMatchObject({ type: 'planning' })
    const planning = out.boards[0]
    if (planning.type !== 'planning') throw new Error('expected planning')
    expect(planning.elements[0]).not.toHaveProperty('locked')
    expect(planning.elements[0]).not.toHaveProperty('groupId')
  })

  it('round-trips an element carrying locked + groupId', () => {
    const doc = {
      schemaVersion: 3,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [
            { id: 'n1', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'blue', text: '', locked: true, groupId: 'g1' }
          ]
        }
      ]
    }
    const out = fromObject(doc)
    const b = out.boards[0]
    if (b.type !== 'planning') throw new Error('expected planning')
    expect(b.elements[0]).toMatchObject({ locked: true, groupId: 'g1' })
  })

  it('rejects a non-boolean locked and a non-string groupId', () => {
    const bad = (extra: Record<string, unknown>): unknown => ({
      schemaVersion: 3,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [{ id: 'n1', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'plain', text: '', ...extra }]
        }
      ]
    })
    expect(() => fromObject(bad({ locked: 'yes' }))).toThrow(/locked/)
    expect(() => fromObject(bad({ groupId: 42 }))).toThrow(/groupId/)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: FAIL (`SCHEMA_VERSION` is 2; no locked/groupId validation).

- [ ] **Step 3: Implement the schema changes**

In `boardSchema.ts`, change the version constant:

```ts
export const SCHEMA_VERSION = 3
```

Extend `ElementCommon` (currently :57):

```ts
interface ElementCommon {
  id: string
  x: number
  y: number
  /** W3: resist move/erase/delete. Absent ⇒ unlocked (read as `el.locked ?? false`). */
  locked?: boolean
  /** W3: lightweight grouping (move/delete-together). Absent ⇒ ungrouped. */
  groupId?: string
}
```

Add the v2 → v3 migration to `MIGRATIONS` (additive no-op — the fields are optional, nothing to backfill):

```ts
const MIGRATIONS: Record<number, Migration> = {
  // v1 had no camera. v2 adds `viewport` (null = fit on load).
  1: (doc) => ({ ...doc, schemaVersion: 2, viewport: (doc as CanvasDoc).viewport ?? null }),
  // v3 adds OPTIONAL element `locked?`/`groupId?` (W3). No backfill: absent reads as
  // unlocked/ungrouped, so the migration only bumps the version.
  2: (doc) => ({ ...doc, schemaVersion: 3 })
}
```

In `assertPlanningElement` (:293), after the `x`/`y` check and before the `switch (el.kind)`:

```ts
if (el.locked !== undefined && typeof el.locked !== 'boolean') {
  fail('planning element has a non-boolean locked')
}
if (el.groupId !== undefined && typeof el.groupId !== 'string') {
  fail('planning element has a non-string groupId')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/lib/boardSchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git -C "Z:\canvas-ade-whiteboard-w3" add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
feat(w3): schema v2->v3 with optional locked?/groupId?

Additive no-op MIGRATIONS[2]; no default-inject (absent reads as
unlocked/ungrouped). assertPlanningElement validates the new fields.
EOF
```

---

## Task 2: `elements.ts` mutators

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/elements.ts` (append after `translateMany`, :343)
- Test: `src/renderer/src/canvas/boards/planning/elements.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `elements.test.ts`:

```ts
import {
  isLocked,
  expandGroups,
  duplicateElements,
  groupElements,
  ungroupElements,
  setLocked
} from './elements'
import type { PlanningElement } from '../../../lib/boardSchema'

const note = (id: string, x = 0, y = 0, extra: Partial<PlanningElement> = {}): PlanningElement => ({
  id,
  kind: 'note',
  x,
  y,
  w: 100,
  h: 60,
  tint: 'yellow',
  text: '',
  ...extra
}) as PlanningElement

let counter = 0
const seqId = (): string => `new-${counter++}`

describe('W3 mutators', () => {
  it('isLocked reads the optional flag', () => {
    expect(isLocked(note('a'))).toBe(false)
    expect(isLocked(note('b', 0, 0, { locked: true }))).toBe(true)
  })

  it('expandGroups pulls in siblings sharing a groupId', () => {
    const els = [note('a', 0, 0, { groupId: 'g' }), note('b', 0, 0, { groupId: 'g' }), note('c')]
    expect([...expandGroups(els, ['a'])].sort()).toEqual(['a', 'b'])
    expect([...expandGroups(els, ['c'])]).toEqual(['c']) // ungrouped passes through
  })

  it('groupElements / ungroupElements set and clear groupId', () => {
    const els = [note('a'), note('b')]
    const grouped = groupElements(els, ['a', 'b'], 'g1')
    expect(grouped.every((e) => e.groupId === 'g1')).toBe(true)
    const ungrouped = ungroupElements(grouped, ['a', 'b'])
    expect(ungrouped.every((e) => e.groupId === undefined)).toBe(true)
  })

  it('setLocked sets and removes the flag', () => {
    const els = [note('a'), note('b')]
    const locked = setLocked(els, ['a'], true)
    expect(isLocked(locked.find((e) => e.id === 'a')!)).toBe(true)
    expect(isLocked(locked.find((e) => e.id === 'b')!)).toBe(false)
    const unlocked = setLocked(locked, ['a'], false)
    expect(unlocked.find((e) => e.id === 'a')).not.toHaveProperty('locked')
  })

  it('duplicateElements clones, shifts, fresh ids, fresh per-group groupId, originals untouched', () => {
    counter = 0
    const els = [note('a', 0, 0, { groupId: 'g' }), note('b', 10, 10, { groupId: 'g' }), note('c', 50, 50)]
    const { elements, newIds } = duplicateElements(els, ['a', 'b', 'c'], 12, 12, seqId)
    expect(elements).toHaveLength(6)
    expect(newIds).toHaveLength(3)
    // originals untouched
    expect(elements.slice(0, 3)).toEqual(els)
    const copies = elements.slice(3)
    // shifted
    expect(copies[0].x).toBe(12)
    expect(copies[0].y).toBe(12)
    // a and b shared a group → their copies share ONE fresh group, distinct from 'g'
    const ga = copies[0].groupId
    const gb = copies[1].groupId
    expect(ga).toBe(gb)
    expect(ga).not.toBe('g')
    expect(ga).toBeTruthy()
    // c had no group → its copy has none
    expect(copies[2].groupId).toBeUndefined()
  })

  it('duplicateElements shifts arrows by both endpoints', () => {
    counter = 0
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 0, y: 0, x2: 30, y2: 40 }
    const { elements } = duplicateElements([arrow], ['ar'], 5, 7, seqId)
    expect(elements[1]).toMatchObject({ kind: 'arrow', x: 5, y: 7, x2: 35, y2: 47 })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: FAIL (`isLocked` etc. not exported).

- [ ] **Step 3: Implement the mutators**

Append to `elements.ts` (after `translateMany`):

```ts
// ── W3: lock + group + duplicate ───────────────────────────────────────────────

/** The single lock predicate. Absent flag ⇒ unlocked. */
export function isLocked(el: PlanningElement): boolean {
  return el.locked === true
}

/** Drop the `groupId` key from a copy (immutable, key removed not set-undefined). */
function withoutGroup<E extends PlanningElement>(el: E): E {
  if (el.groupId === undefined) return el
  const next = { ...el }
  delete next.groupId
  return next
}

/**
 * Expand a selection to whole groups: for every selected element that has a
 * `groupId`, add all elements sharing that id. Ungrouped ids pass through.
 * Idempotent. Returns a superset of `ids`.
 */
export function expandGroups(els: PlanningElement[], ids: Iterable<string>): Set<string> {
  const set = new Set(ids)
  const groups = new Set<string>()
  for (const el of els) if (set.has(el.id) && el.groupId) groups.add(el.groupId)
  if (groups.size === 0) return set
  for (const el of els) if (el.groupId && groups.has(el.groupId)) set.add(el.id)
  return set
}

/** Assign one fresh `groupId` to every element in `ids`. */
export function groupElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  groupId: string
): PlanningElement[] {
  const set = new Set(ids)
  return els.map((el) => (set.has(el.id) ? { ...el, groupId } : el))
}

/** Clear `groupId` on every element belonging to a group represented in `ids`. */
export function ungroupElements(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = new Set(ids)
  const groups = new Set<string>()
  for (const el of els) if (set.has(el.id) && el.groupId) groups.add(el.groupId)
  return els.map((el) => (el.groupId && groups.has(el.groupId) ? withoutGroup(el) : el))
}

/** Set (or remove) the `locked` flag across `ids`. */
export function setLocked(
  els: PlanningElement[],
  ids: Iterable<string>,
  locked: boolean
): PlanningElement[] {
  const set = new Set(ids)
  return els.map((el) => {
    if (!set.has(el.id)) return el
    if (locked) return { ...el, locked: true }
    if (el.locked === undefined) return el
    const next = { ...el }
    delete next.locked
    return next
  })
}

/**
 * Clone every element in `ids` (caller expands groups first), assigning a fresh id
 * per copy and shifting by (dx,dy). Each ORIGINAL group becomes ONE fresh group
 * among the copies. Originals are left untouched. Returns the full new array
 * (originals + copies) plus the copy ids (for reselection).
 */
export function duplicateElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  dx: number,
  dy: number,
  newId: () => string
): { elements: PlanningElement[]; newIds: string[] } {
  const set = new Set(ids)
  const groupRemap = new Map<string, string>()
  const newIds: string[] = []
  const copies: PlanningElement[] = []
  for (const el of els) {
    if (!set.has(el.id)) continue
    const id = newId()
    newIds.push(id)
    let copy = shiftElement({ ...el, id }, dx, dy)
    if (el.groupId) {
      let g = groupRemap.get(el.groupId)
      if (!g) {
        g = newId()
        groupRemap.set(el.groupId, g)
      }
      copy = { ...copy, groupId: g }
    }
    copies.push(copy)
  }
  return { elements: [...els, ...copies], newIds }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git -C "Z:\canvas-ade-whiteboard-w3" add src/renderer/src/canvas/boards/planning/elements.ts src/renderer/src/canvas/boards/planning/elements.test.ts
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
feat(w3): element mutators — lock, group, duplicate

isLocked / expandGroups / groupElements / ungroupElements / setLocked /
duplicateElements (fresh ids + fresh per-group groupId, originals untouched).
EOF
```

---

## Task 3: `align.ts` — align + distribute (new pure module)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/align.ts`
- Test: `src/renderer/src/canvas/boards/planning/align.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `align.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { alignElements, distributeElements } from './align'
import type { PlanningElement } from '../../../lib/boardSchema'

const note = (id: string, x: number, y: number, w = 100, h = 60): PlanningElement =>
  ({ id, kind: 'note', x, y, w, h, tint: 'yellow', text: '' }) as PlanningElement

const byId = (els: PlanningElement[], id: string): PlanningElement => els.find((e) => e.id === id)!

describe('alignElements', () => {
  const els = [note('a', 0, 0), note('b', 50, 100), note('c', 200, 30)]

  it('left aligns every selected element to the min-left', () => {
    const out = alignElements(els, ['a', 'b', 'c'], 'left')
    expect(byId(out, 'a').x).toBe(0)
    expect(byId(out, 'b').x).toBe(0)
    expect(byId(out, 'c').x).toBe(0)
  })

  it('right aligns to the max-right edge', () => {
    const out = alignElements(els, ['a', 'b', 'c'], 'right')
    // max right edge = c: 200 + 100 = 300 → each x = 300 - w(100) = 200
    expect(byId(out, 'a').x).toBe(200)
    expect(byId(out, 'b').x).toBe(200)
  })

  it('top aligns y, leaving x untouched', () => {
    const out = alignElements(els, ['a', 'b', 'c'], 'top')
    expect(byId(out, 'b').y).toBe(0)
    expect(byId(out, 'b').x).toBe(50) // x unchanged for a vertical-edge align
  })

  it('is a no-op for fewer than 2 selected', () => {
    expect(alignElements(els, ['a'], 'left')).toBe(els)
  })

  it('aligns an arrow by its bbox, not its raw endpoints', () => {
    const arrow: PlanningElement = { id: 'ar', kind: 'arrow', x: 300, y: 0, x2: 360, y2: 40 }
    const out = alignElements([note('a', 0, 0), arrow], ['a', 'ar'], 'left')
    // arrow bbox left = 300; union left = 0 → shift arrow x by -300
    const a2 = byId(out, 'ar')
    if (a2.kind !== 'arrow') throw new Error('arrow')
    expect(a2.x).toBe(0)
    expect(a2.x2).toBe(60)
  })
})

describe('distributeElements', () => {
  it('equalizes horizontal gaps, pinning the endpoints', () => {
    // three 100-wide notes at x = 0, 130, 400 → span 0..500 (500), sizes 300,
    // gap = (500 - 300) / 2 = 100 → middle box left = 0 + 100 + 100 = 200
    const els = [note('a', 0, 0), note('m', 130, 0), note('b', 400, 0)]
    const out = distributeElements(els, ['a', 'm', 'b'], 'h')
    expect(byId(out, 'a').x).toBe(0) // endpoint pinned
    expect(byId(out, 'b').x).toBe(400) // endpoint pinned
    expect(byId(out, 'm').x).toBe(200)
  })

  it('is a no-op for fewer than 3 selected', () => {
    const els = [note('a', 0, 0), note('b', 100, 0)]
    expect(distributeElements(els, ['a', 'b'], 'h')).toBe(els)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/canvas/boards/planning/align.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `align.ts`**

Create `align.ts`:

```ts
/**
 * Pure align + distribute math for the Planning whiteboard (W3). Operates on the
 * selection set via the existing bbox/anchor helpers in `elements.ts`, so every
 * kind (note/text/checklist/arrow/stroke) aligns by its BOUNDING BOX — never by a
 * raw top-left (arrows/strokes have none). No React, no store; unit-tested in
 * isolation. Shifts are applied through `shiftElement` so vectors keep their shape.
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { anchors, elementBBox, shiftElement, unionBBox, type BBox, type Measured } from './elements'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeAxis = 'h' | 'v'

const HORIZONTAL_EDGES: readonly AlignEdge[] = ['left', 'centerX', 'right']

/**
 * Align every selected element's `edge` anchor to the selection's union `edge`.
 * Horizontal edges move x only; vertical edges move y only. <2 selected ⇒ no-op
 * (returns the input array by reference, so callers can skip a checkpoint).
 */
export function alignElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  edge: AlignEdge,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = new Set(ids)
  const selected = els.filter((e) => set.has(e.id))
  if (selected.length < 2) return els
  const boxById = new Map<string, BBox>(selected.map((e) => [e.id, elementBBox(e, measured?.get(e.id))]))
  const target = anchors(unionBBox([...boxById.values()]))[edge]
  const horizontal = HORIZONTAL_EDGES.includes(edge)
  return els.map((el) => {
    const box = boxById.get(el.id)
    if (!box) return el
    const delta = target - anchors(box)[edge]
    return horizontal ? shiftElement(el, delta, 0) : shiftElement(el, 0, delta)
  })
}

/**
 * Distribute the selection so the GAPS between successive bounding boxes are equal
 * along the axis. The two extreme elements are pinned; only the interior elements
 * move. <3 selected ⇒ no-op (returns the input array by reference).
 */
export function distributeElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  axis: DistributeAxis,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = new Set(ids)
  const horizontal = axis === 'h'
  const lo = (b: BBox): number => (horizontal ? b.x : b.y)
  const size = (b: BBox): number => (horizontal ? b.w : b.h)
  const items = els
    .filter((e) => set.has(e.id))
    .map((e) => ({ id: e.id, box: elementBBox(e, measured?.get(e.id)) }))
    .sort((p, q) => lo(p.box) - lo(q.box))
  if (items.length < 3) return els
  const first = items[0].box
  const last = items[items.length - 1].box
  const span = lo(last) + size(last) - lo(first)
  const totalSize = items.reduce((s, it) => s + size(it.box), 0)
  const gap = (span - totalSize) / (items.length - 1)
  const shifts = new Map<string, number>()
  let cursor = lo(first) + size(first) + gap
  for (let i = 1; i < items.length - 1; i++) {
    shifts.set(items[i].id, cursor - lo(items[i].box))
    cursor += size(items[i].box) + gap
  }
  return els.map((el) => {
    const s = shifts.get(el.id)
    if (s === undefined) return el
    return horizontal ? shiftElement(el, s, 0) : shiftElement(el, 0, s)
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/canvas/boards/planning/align.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git -C "Z:\canvas-ade-whiteboard-w3" add src/renderer/src/canvas/boards/planning/align.ts src/renderer/src/canvas/boards/planning/align.test.ts
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
feat(w3): align + distribute math (planning/align.ts)

Pure bbox-based align (L/C/R/T/M/B) + equal-gap distribute (H/V) over
the selection; <2 / <3 selected are no-ops.
EOF
```

---

## Task 4: `ElementContextMenu.tsx` (new presentational portal menu)

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx`
- Test: `src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx`

The menu is purely presentational: it takes pre-built `entries` and a screen position, renders into a `document.body` portal, clamps to the viewport, and closes on Escape / outside-pointerdown. The board (Task 5) builds the entries and owns all element mutations.

- [ ] **Step 1: Write the failing tests**

Create `ElementContextMenu.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ElementContextMenu, type MenuEntry } from './ElementContextMenu'

const actions = (onSelect = vi.fn()): MenuEntry[] => [
  { kind: 'action', id: 'lock', label: 'Lock', onSelect },
  { kind: 'action', id: 'group', label: 'Group', disabled: true, onSelect },
  {
    kind: 'iconRow',
    id: 'align',
    label: 'Align',
    buttons: [{ id: 'left', title: 'Align left', icon: 'align-left', onSelect }]
  }
]

describe('ElementContextMenu', () => {
  it('renders entries and fires onSelect + onClose on an action click', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions(onSelect)} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('w3-menu-lock'))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does not fire a disabled action', () => {
    const onSelect = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions(onSelect)} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('w3-menu-group'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions()} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('renders an icon-row button that fires + closes', () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(<ElementContextMenu x={10} y={10} entries={actions(onSelect)} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('w3-menu-align-left'))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `ElementContextMenu.tsx`**

Create `ElementContextMenu.tsx`:

```tsx
/**
 * Right-click context menu for Planning whiteboard elements (W3). PURELY
 * presentational: the board builds `entries` + element mutations; this renders them
 * into a `document.body` portal positioned at the pointer's RAW screen coords
 * (clientX/clientY — never mapped through `toBoard`, so the camera-transform
 * coordinate trap can't bite), clamped to the viewport, and closing on
 * Escape / outside-pointerdown. Calm one-accent styling via existing tokens.
 *
 * Known minor limitation: a Browser board's native WebContentsView elsewhere on the
 * canvas paints above this HTML menu if it opens directly over one (rare, transient);
 * fully solving it would touch previewStore (out of this branch's zone).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../Icon'

export interface MenuActionEntry {
  kind: 'action'
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

export interface MenuIconRowEntry {
  kind: 'iconRow'
  id: string
  label: string
  disabled?: boolean
  buttons: { id: string; title: string; icon: string; onSelect: () => void }[]
}

export type MenuEntry = MenuActionEntry | MenuIconRowEntry

interface Props {
  x: number
  y: number
  entries: MenuEntry[]
  onClose: () => void
}

const MENU_W = 184

export function ElementContextMenu({ x, y, entries, onClose }: Props): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Clamp to the viewport after first layout (flip up/left near an edge).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const nx = x + r.width > window.innerWidth ? Math.max(4, x - r.width) : x
    const ny = y + r.height > window.innerHeight ? Math.max(4, y - r.height) : y
    setPos({ x: nx, y: ny })
  }, [x, y, entries.length])

  // Escape + outside-pointerdown close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  const pick = (fn: () => void): void => {
    fn()
    onClose()
  }

  return createPortal(
    <div
      ref={ref}
      data-w3-menu
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: MENU_W,
        zIndex: 9999,
        padding: 4,
        background: 'var(--surface-raised, var(--surface))',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-inner)',
        boxShadow: 'var(--shadow-pop, 0 6px 24px rgba(0,0,0,0.35))',
        font: 'inherit'
      }}
    >
      {entries.map((entry) =>
        entry.kind === 'action' ? (
          <button
            key={entry.id}
            data-testid={`w3-menu-${entry.id}`}
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => !entry.disabled && pick(entry.onSelect)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '6px 8px',
              border: 'none',
              borderRadius: 'var(--r-inner)',
              background: 'transparent',
              color: entry.disabled
                ? 'var(--text-faint)'
                : entry.danger
                  ? 'var(--danger, #e5484d)'
                  : 'var(--text)',
              cursor: entry.disabled ? 'default' : 'pointer',
              font: 'inherit'
            }}
          >
            {entry.label}
          </button>
        ) : (
          <div
            key={entry.id}
            data-w3-menu-row={entry.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              opacity: entry.disabled ? 0.4 : 1
            }}
          >
            <span style={{ color: 'var(--text-faint)', fontSize: 11, minWidth: 56 }}>
              {entry.label}
            </span>
            {entry.buttons.map((b) => (
              <button
                key={b.id}
                data-testid={`w3-menu-${entry.id}-${b.id}`}
                title={b.title}
                disabled={entry.disabled}
                onClick={() => !entry.disabled && pick(b.onSelect)}
                style={{
                  display: 'inline-flex',
                  padding: 3,
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-inner)',
                  background: 'var(--inset)',
                  cursor: entry.disabled ? 'default' : 'pointer'
                }}
              >
                <Icon name={b.icon} size={13} />
              </button>
            ))}
          </div>
        )
      )}
    </div>,
    document.body
  )
}
```

> **Note on `Icon`:** confirm `src/renderer/src/canvas/Icon.tsx` exports `Icon` with a `name`/`size` prop and has glyphs for the align/distribute icons used in Task 5 (`align-left`, `align-center-h`, `align-right`, `align-top`, `align-middle`, `align-bottom`, `distribute-h`, `distribute-v`). If a glyph is missing, add it in `Icon.tsx` (in-zone) following the existing glyph pattern, OR fall back to a text label in the icon-row button. Do this as the first sub-step of Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\canvas-ade-whiteboard-w3" exec vitest run src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git -C "Z:\canvas-ade-whiteboard-w3" add src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx src/renderer/src/canvas/boards/planning/ElementContextMenu.test.tsx
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
feat(w3): ElementContextMenu — portal menu (position clamp, Escape/outside close)

Presentational only; renders action items + icon rows from entries.
Positioned by raw screen coords (no toBoard) to sidestep the transform trap.
EOF
```

---

## Task 5: Wire W3 into `PlanningBoard.tsx`

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`
- (If needed) Modify: `src/renderer/src/canvas/Icon.tsx` (add missing align glyphs — see Task 4 note)

This task is verified end-to-end by the e2e probes in Task 6 (the wiring is interaction code; unit-testing a 700-line board component in jsdom is low-value vs the real-input harness). Commit in three logical sub-steps.

- [ ] **Step 0: Confirm/extend icon glyphs**

Open `src/renderer/src/canvas/Icon.tsx`. Confirm glyphs exist for: `align-left`, `align-center-h`, `align-right`, `align-top`, `align-middle`, `align-bottom`, `distribute-h`, `distribute-v`. Add any missing ones following the existing `<path>` glyph pattern (simple line/rect motifs are fine — calm aesthetic). Commit if changed:

```
git -C "Z:\canvas-ade-whiteboard-w3" add src/renderer/src/canvas/Icon.tsx
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
feat(w3): align/distribute menu glyphs in Icon
EOF
```

- [ ] **Step 1: Imports + new state**

Add to the `elements` import block (:48-64):

```ts
import {
  // …existing…
  isLocked,
  expandGroups,
  duplicateElements,
  groupElements,
  ungroupElements,
  setLocked
} from './planning/elements'
import { alignElements, distributeElements, type AlignEdge } from './planning/align'
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'
```

Add `MouseEvent as ReactMouseEvent` to the `react` type import. Add state beside `marqueeRect` (:146):

```ts
const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
```

- [ ] **Step 2: Lock gate at all four mutation points**

(a) `startElementDrag` (:258) — block locked, expand groups, lock-filter the moving set, capture alt:

```ts
const startElementDrag = useCallback(
  (e: PointerEvent, id: string) => {
    const el = elements.find((x) => x.id === id)
    if (!el || isLocked(el)) return // a locked element can't initiate a drag
    const sel = selectedIds
    const base = sel.has(id) ? [...sel] : [id]
    const expanded = expandGroups(elements, base)
    const movingIds = [...expanded].filter((mid) => {
      const m = elements.find((x) => x.id === mid)
      return m !== undefined && !isLocked(m) // lock wins over group membership
    })
    if (movingIds.length === 0) return
    const p = toBoard(e)
    drag.current = { mode: 'move', ids: movingIds, grabX: p.x, grabY: p.y, alt: e.altKey }
    wellRef.current?.setPointerCapture(e.pointerId)
  },
  [elements, toBoard, selectedIds]
)
```

(b) `deleteEl` (:199) — early-return if locked:

```ts
const deleteEl = useCallback(
  (id: string) => {
    const el = elements.find((x) => x.id === id)
    if (el && isLocked(el)) return // locked resists the per-element X (closes the prior bypass)
    beginChange()
    commit(removeElement(elements, id))
  },
  [beginChange, commit, elements]
)
```

(c) Keyboard Delete handler (:594) — expand groups, lock-filter:

```ts
if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
  e.stopPropagation()
  e.preventDefault()
  const expanded = expandGroups(elements, selectedIds)
  const removable = new Set(
    [...expanded].filter((rid) => {
      const el = elements.find((x) => x.id === rid)
      return el !== undefined && !isLocked(el)
    })
  )
  if (removable.size > 0) {
    beginChange()
    commit(elements.filter((el) => !removable.has(el.id)))
  }
  clearSel()
  return
}
```

(d) Erase hit-test — skip locked at down (:339) and move (:395):

```ts
// down
for (const el of elements) if (!isLocked(el) && eraseHitTest(el, p)) removed.add(el.id)
// move
if (!d.removed.has(el.id) && !isLocked(el) && eraseHitTest(el, p)) {
  d.removed.add(el.id)
  grew = true
}
```

- [ ] **Step 3: Alt-drag duplicate (drag type, view render, commit)**

Update the `drag` ref move variant (:137) and `dragPos` state (:133):

```ts
const [dragPos, setDragPos] = useState<{
  ids: string[]
  dx: number
  dy: number
  alt: boolean
} | null>(null)
// …
const drag = useRef<
  | { mode: 'move'; ids: string[]; grabX: number; grabY: number; alt: boolean }
  | { mode: 'arrow'; id: string }
  // …unchanged…
>(null)
```

In `onWellPointerMove` move branch (:386), carry alt:

```ts
setDragPos({ ids: d.ids, dx, dy, alt: d.alt })
```

In `onWellPointerUp` move branch (:436), duplicate on alt:

```ts
if (pos && (pos.dx !== 0 || pos.dy !== 0)) {
  beginChange()
  if (pos.alt) {
    const { elements: withCopies, newIds } = duplicateElements(
      elements,
      pos.ids,
      pos.dx,
      pos.dy,
      newId
    )
    commit(withCopies)
    setSelectedIds(new Set(newIds))
  } else {
    commit(translateMany(elements, pos.ids, pos.dx, pos.dy))
  }
}
```

Render ghost copies during an alt-drag (replace the `viewElements` block at :557):

```ts
const movedView = dragPos ? translateMany(elements, dragPos.ids, dragPos.dx, dragPos.dy) : null
// During a normal move the originals shift; during an ALT drag the originals stay put
// and translated GHOST copies (temporary ids, never committed) preview the duplicate.
const ghostCopies =
  dragPos && dragPos.alt && movedView
    ? movedView
        .filter((e) => dragPos.ids.includes(e.id))
        .map((e) => ({ ...e, id: `__ghost__${e.id}` }) as PlanningElement)
    : []
const baseView =
  dragPos && !dragPos.alt && movedView
    ? movedView
    : pendingErase && pendingErase.size > 0
      ? elements.filter((el) => !pendingErase.has(el.id))
      : elements
const viewElements = [...baseView, ...ghostCopies]
```

(Ghost copies only render while the pointer is captured mid-alt-drag; their `__ghost__` ids never reach `commit`, and the captured pointer means `onSelect`/`onDragStart` never fire on them.)

- [ ] **Step 4: Context-menu trigger (select-then-act) + entries + render**

Add the handler (after `onWellDoubleClick`):

```ts
const onWellContextMenu = useCallback(
  (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const p = toBoard(e)
    // Topmost hit under the cursor (later elements render above; reuse the erase hit-test).
    const hits = elements.filter((el) => eraseHitTest(el, p))
    const targetId = hits.length > 0 ? hits[hits.length - 1].id : null
    if (targetId) {
      // select-then-act: a right-click on an UNSELECTED element selects just it;
      // a right-click on one already in a multi-selection keeps the whole set.
      setSelectedIds((prev) => (prev.has(targetId) ? prev : new Set([targetId])))
    }
    // Open only if there will be something to act on.
    if (targetId || selectedIds.size > 0) setContextMenu({ x: e.clientX, y: e.clientY })
  },
  [elements, toBoard, selectedIds]
)
```

Add `onContextMenu={onWellContextMenu}` to the `.pl-well` div (beside `onDoubleClick`, :592).

Build entries + render the menu (just before the closing `</BoardFrame>`):

```ts
const buildMenuEntries = (): MenuEntry[] => {
  const sel = selectedIds
  const selEls = elements.filter((e) => sel.has(e.id))
  const allLocked = selEls.length > 0 && selEls.every(isLocked)
  const anyGrouped = selEls.some((e) => !!e.groupId)
  const groupIds = new Set(selEls.map((e) => e.groupId).filter(Boolean))
  const isOneGroup = sel.size >= 2 && groupIds.size === 1 && selEls.every((e) => !!e.groupId)
  const run = (next: PlanningElement[]): void => {
    beginChange()
    commit(next)
  }
  const alignBtns = (['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] as AlignEdge[]).map(
    (edge) => ({
      id: edge,
      title: `Align ${edge}`,
      icon: `align-${edge === 'centerX' ? 'center-h' : edge === 'centerY' ? 'middle' : edge}`,
      onSelect: () => run(alignElements(elements, sel, edge, measuredRef.current))
    })
  )
  const entries: MenuEntry[] = [
    {
      kind: 'action',
      id: 'lock',
      label: allLocked ? 'Unlock' : 'Lock',
      onSelect: () => run(setLocked(elements, sel, !allLocked))
    },
    {
      kind: 'action',
      id: 'group',
      label: 'Group',
      disabled: sel.size < 2 || isOneGroup,
      onSelect: () => run(groupElements(elements, sel, newId()))
    },
    {
      kind: 'action',
      id: 'ungroup',
      label: 'Ungroup',
      disabled: !anyGrouped,
      onSelect: () => run(ungroupElements(elements, sel))
    },
    {
      kind: 'action',
      id: 'duplicate',
      label: 'Duplicate',
      onSelect: () => {
        beginChange()
        const { elements: wc, newIds } = duplicateElements(
          elements,
          expandGroups(elements, sel),
          12,
          12,
          newId
        )
        commit(wc)
        setSelectedIds(new Set(newIds))
      }
    },
    { kind: 'iconRow', id: 'align', label: 'Align', disabled: sel.size < 2, buttons: alignBtns },
    {
      kind: 'iconRow',
      id: 'distribute',
      label: 'Distribute',
      disabled: sel.size < 3,
      buttons: [
        {
          id: 'h',
          title: 'Distribute horizontally',
          icon: 'distribute-h',
          onSelect: () => run(distributeElements(elements, sel, 'h', measuredRef.current))
        },
        {
          id: 'v',
          title: 'Distribute vertically',
          icon: 'distribute-v',
          onSelect: () => run(distributeElements(elements, sel, 'v', measuredRef.current))
        }
      ]
    },
    {
      kind: 'action',
      id: 'delete',
      label: 'Delete',
      danger: true,
      onSelect: () => {
        const expanded = expandGroups(elements, sel)
        const removable = new Set(
          [...expanded].filter((rid) => {
            const el = elements.find((x) => x.id === rid)
            return el !== undefined && !isLocked(el)
          })
        )
        if (removable.size > 0) {
          beginChange()
          commit(elements.filter((el) => !removable.has(el.id)))
        }
        clearSel()
      }
    }
  ]
  return entries
}
```

Render (inside the JSX, after the `.pl-well` closing `</div>` but still inside `BoardFrame`, or as a sibling — it portals out regardless):

```tsx
{contextMenu && (
  <ElementContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    entries={buildMenuEntries()}
    onClose={() => setContextMenu(null)}
  />
)}
```

- [ ] **Step 5: Verify the gate (typecheck + lint + unit) and commit**

Run:
```
pnpm -C "Z:\canvas-ade-whiteboard-w3" typecheck
pnpm -C "Z:\canvas-ade-whiteboard-w3" lint
pnpm -C "Z:\canvas-ade-whiteboard-w3" test
```
Expected: all green (no new failures; W3 unit suites pass).

Commit:
```
git -C "Z:\canvas-ade-whiteboard-w3" add src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/Icon.tsx
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
feat(w3): wire lock gate, alt-drag duplicate, grouping + context menu

Lock gate at all 4 mutation points (drag/keyboard-delete/X/erase);
expandGroups before move/delete with lock winning; alt-drag duplicates
the selection with a live ghost preview; right-click ElementContextMenu
(select-then-act) drives lock/group/ungroup/duplicate/align/distribute/delete.
Each operation is one undo checkpoint.
EOF
```

---

## Task 6: e2e probes

**Files:**
- Modify: `src/main/e2e/probes/whiteboard.ts` (append 4 probes)
- Modify: `src/main/e2e/index.ts` (import + register in PLAYLIST before `seed`)

**Testing strategy (avoid the false-green trap, memory `e2e-sendinputevent-vs-dispatchevent`):**
- **Alt-drag duplicate** maps through the camera transform → use REAL OS input
  (`ctx.win.webContents.sendInputEvent` with `modifiers: ['alt']`) and POLL for the post-action count.
- **Align / lock / group** are driven through the actual HTML context menu (which has no transform):
  dispatch a synthetic `contextmenu` on `.pl-well` at the element's computed screen point (toBoard maps
  clientX/Y correctly for a single-transform board — the W2 probes rely on the same), then click the
  menu item in `document.body` by its `data-testid`. Lock's "resists drag" sub-check uses the
  W2 synthetic grip-drag (proven on the fitView board). All effects read off `getBoards()`.

- [ ] **Step 1: Write the probes**

Append to `src/main/e2e/probes/whiteboard.ts`:

```ts
// ── W3 selection follow-ons. alt-dup uses REAL OS input (transform-dependent);
// align/lock/group drive the real HTML context menu (transform-free) after a synthetic
// selection. All effects read off getBoards() (selection is ephemeral). Order-bound:
// read ctx.ids.planId, run before `seed`, mutate only the planning board's elements.

export const whiteboardAltDup: E2EProbe = {
  name: 'whiteboard-alt-dup',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-alt-dup', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 460, elements: [
         { id: 'ad-a', kind: 'note', x: 60, y: 60, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 }
       ] })`
    )
    await ctx.delay(160)
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    const fitted = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `(() => { const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(JSON.stringify(planId))} + ']'); const w = n && n.querySelector('.pl-well'); return !!(w && w.offsetWidth > 0 && w.getBoundingClientRect().width / w.offsetWidth > 1.0); })()`
        ),
      4000
    )
    if (!fitted) return { name: 'whiteboard-alt-dup', ok: false, detail: 'fitView did not settle' }
    await ctx.delay(60)
    // Compute screen points for the note grip (board-local ~138,108) and a drag target +60,+60.
    const pts = await ctx.evalIn<{ fx: number; fy: number; tx: number; ty: number; start: number }>(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
         return { fx: r.left + 138 * s, fy: r.top + 108 * s, tx: r.left + 198 * s, ty: r.top + 168 * s, start: b.elements.length };
       })()`
    )
    // First select the note (synthetic click on its grip is fine — selection effect read later).
    await ctx.evalIn(
      `(() => { const id = ${JSON.stringify(planId)}; const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']'); const g = n.querySelector('.pl-note-grip'); const w = n.querySelector('.pl-well'); const r = w.getBoundingClientRect(); const s = r.width / w.offsetWidth; const p = { clientX: r.left + 138 * s, clientY: r.top + 108 * s, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true }; try { g.dispatchEvent(new PointerEvent('pointerdown', p)); w.dispatchEvent(new PointerEvent('pointerup', p)); } catch (e) {} })()`
    )
    await ctx.delay(40)
    // REAL alt-drag: mouseDown(alt) on the grip point → moves → mouseUp(alt) at the target.
    const send = (type: 'mouseDown' | 'mouseMove' | 'mouseUp', x: number, y: number): void =>
      ctx.win.webContents.sendInputEvent({
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        modifiers: ['alt']
      })
    send('mouseDown', pts.fx, pts.fy)
    for (let i = 1; i <= 4; i++)
      send('mouseMove', pts.fx + ((pts.tx - pts.fx) * i) / 4, pts.fy + ((pts.ty - pts.fy) * i) / 4)
    send('mouseUp', pts.tx, pts.ty)
    const dupCount = await ctx.poll(
      () =>
        ctx
          .evalIn<number>(
            `(() => { const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)}); return b && b.type === 'planning' ? b.elements.length : -1; })()`
          )
          .then((c) => (c === pts.start + 1 ? true : null)),
      3000
    )
    const afterCount = await ctx.evalIn<number>(
      `(() => { const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)}); return b.elements.length; })()`
    )
    await ctx.evalIn(`window.__canvasE2E.undo()`)
    await ctx.delay(80)
    const afterUndo = await ctx.evalIn<number>(
      `(() => { const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)}); return b.elements.length; })()`
    )
    const ok = !!dupCount && afterCount === pts.start + 1 && afterUndo === pts.start
    return {
      name: 'whiteboard-alt-dup',
      ok,
      detail: ok
        ? 'real alt-drag duplicates the note; one undo removes the copy'
        : JSON.stringify({ start: pts.start, afterCount, afterUndo })
    }
  }
}

export const whiteboardLock: E2EProbe = {
  name: 'whiteboard-lock',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-lock', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 460, elements: [
         { id: 'lk-a', kind: 'note', x: 60, y: 60, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0, locked: true }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{ stage: string; movedX: number; afterErase: number; afterX: number }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const board = () => window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = () => board().elements;
         const note = () => els().find((e) => e.id === 'lk-a');
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const at = (bx, by) => ({ clientX: r.left + bx * s, clientY: r.top + by * s, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true });
         const grip = n.querySelector('.pl-note-grip');
         const x0 = note().x;
         // (1) drag the locked note via its grip → must NOT move.
         try { grip.dispatchEvent(new PointerEvent('pointerdown', at(138, 108))); for (let i=1;i<=4;i++){ w.dispatchEvent(new PointerEvent('pointermove', at(138+20*i,108+20*i))); await sleep(12);} w.dispatchEvent(new PointerEvent('pointerup', at(218,188))); } catch(e){}
         await sleep(60);
         const movedX = note() ? note().x - x0 : -999;
         // (2) erase swipe over the locked note → count unchanged.
         w.focus(); w.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); await sleep(30);
         try { w.dispatchEvent(new PointerEvent('pointerdown', at(138,108))); w.dispatchEvent(new PointerEvent('pointermove', at(140,110))); w.dispatchEvent(new PointerEvent('pointerup', at(140,110))); } catch(e){}
         await sleep(60);
         const afterErase = els().length;
         // (3) per-element X on the locked note → must NOT delete (the prior bypass).
         w.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true })); await sleep(20);
         const del = n.querySelector('.pl-note-del') || n.querySelector('[data-el-del]');
         if (del) { try { del.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch(e){} }
         await sleep(60);
         const afterX = els().length;
         return { stage: 'done', movedX, afterErase, afterX };
       })()`
    )
    const ok = Math.abs(res.movedX) < 1 && res.afterErase === 1 && res.afterX === 1
    return {
      name: 'whiteboard-lock',
      ok,
      detail: ok ? 'locked note resists drag, erase, and the per-element X' : JSON.stringify(res)
    }
  }
}

export const whiteboardGroup: E2EProbe = {
  name: 'whiteboard-group',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-group', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 560, h: 460, elements: [
         { id: 'gp-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'gp-b', kind: 'note', x: 300, y: 40, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{
      stage: string
      grouped: boolean
      bMovedWithA: boolean
      deletedBoth: number
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const els = () => window.__canvasE2E.getBoards().find((x) => x.id === id).elements;
         const note = (nid) => els().find((e) => e.id === nid);
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const at = (bx, by) => ({ x: r.left + bx * s, y: r.top + by * s });
         const ev = (t, type, p, extra) => { try { t.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y }, extra || {}))); } catch(e){} };
         const drag = async (from, to, downT) => { ev(downT || w, 'pointerdown', from); for (let i=1;i<=4;i++){ ev(w,'pointermove',{x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4}); await sleep(12);} ev(w,'pointerup',to); await sleep(40); };
         const grip = (i) => n.querySelectorAll('.pl-note-grip')[i];
         const clickMenu = (testid) => { const el = document.querySelector('[data-testid=' + JSON.stringify(testid) + ']'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
         // select both via marquee, then right-click → Group.
         await drag(at(8, 8), at(470, 150));
         await sleep(30);
         w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at(118,88).x, clientY: at(118,88).y }));
         await sleep(60);
         clickMenu('w3-menu-group'); await sleep(60);
         const grouped = !!note('gp-a').groupId && note('gp-a').groupId === note('gp-b').groupId;
         // drag A's grip → B moves too (group move).
         const ax0 = note('gp-a').x, bx0 = note('gp-b').x;
         // press A first to select the group member, then drag.
         ev(grip(0), 'pointerdown', at(118, 88)); ev(w, 'pointerup', at(118, 88)); await sleep(30);
         await drag(at(118, 88), at(168, 88), grip(0));
         const bMovedWithA = (note('gp-b').x - bx0) >= 30 && (note('gp-a').x - ax0) >= 30;
         // delete one (selected) → both gone (group delete).
         ev(grip(0), 'pointerdown', at(168, 88)); ev(w, 'pointerup', at(168, 88)); await sleep(20);
         w.focus(); w.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); await sleep(60);
         const deletedBoth = els().length;
         return { stage: 'done', grouped, bMovedWithA, deletedBoth };
       })()`
    )
    const ok = res.grouped && res.bMovedWithA && res.deletedBoth === 0
    return {
      name: 'whiteboard-group',
      ok,
      detail: ok
        ? 'group via menu; dragging one moves both; deleting one deletes both'
        : JSON.stringify(res)
    }
  }
}

export const whiteboardAlign: E2EProbe = {
  name: 'whiteboard-align',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-align', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 560, h: 460, elements: [
         { id: 'al-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'al-b', kind: 'note', x: 300, y: 220, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{ stage: string; ax: number; bx: number; undoBx: number }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const els = () => window.__canvasE2E.getBoards().find((x) => x.id === id).elements;
         const note = (nid) => els().find((e) => e.id === nid);
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const at = (bx, by) => ({ x: r.left + bx * s, y: r.top + by * s });
         const ev = (t, type, p) => { try { t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y })); } catch(e){} };
         const drag = async (from, to) => { ev(w, 'pointerdown', from); for (let i=1;i<=4;i++){ ev(w,'pointermove',{x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4}); await sleep(12);} ev(w,'pointerup',to); await sleep(40); };
         await drag(at(8, 8), at(470, 330)); // marquee both
         await sleep(30);
         w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at(118,88).x, clientY: at(118,88).y }));
         await sleep(60);
         const btn = document.querySelector('[data-testid="w3-menu-align-left"]');
         if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(60);
         const ax = note('al-a').x, bx = note('al-b').x;
         window.__canvasE2E.undo(); await sleep(60);
         const undoBx = note('al-b').x;
         return { stage: 'done', ax, bx, undoBx };
       })()`
    )
    const ok = res.ax === res.bx && res.ax === 40 && res.undoBx === 300
    return {
      name: 'whiteboard-align',
      ok,
      detail: ok ? 'align-left via menu shares min-left x; one undo restores' : JSON.stringify(res)
    }
  }
}
```

> **Implementation note for the worker:** Verify the per-element delete selector: read `NoteCard.tsx` for the actual delete-button class (`.pl-note-del` is the assumed name) and adjust the `whiteboard-lock` probe's `del` query to match. Verify the grip class `.pl-note-grip` against `NoteCard.tsx` (W2 used it). These probes run on the normal fitView board — `enterCameraFullView` is NOT involved.

- [ ] **Step 2: Register the probes in the PLAYLIST**

In `src/main/e2e/index.ts`, extend the import (:42):

```ts
import {
  whiteboardErase,
  whiteboardSelection,
  whiteboardFullviewAdd,
  whiteboardAltDup,
  whiteboardLock,
  whiteboardGroup,
  whiteboardAlign
} from './probes/whiteboard'
```

Insert into `PLAYLIST` after `whiteboardSelection` and before `whiteboardFullviewAdd` (so all element-count mutations are restored before `seed`):

```ts
  whiteboardSelection,
  whiteboardAltDup, // W3: real-input alt-drag duplicate
  whiteboardLock, // W3: locked resists drag/erase/X
  whiteboardGroup, // W3: group move + group delete via the menu
  whiteboardAlign, // W3: align-left via the menu
  whiteboardFullviewAdd,
```

- [ ] **Step 3: Run the full gate + e2e harness**

```
pnpm -C "Z:\canvas-ade-whiteboard-w3" typecheck
pnpm -C "Z:\canvas-ade-whiteboard-w3" lint
pnpm -C "Z:\canvas-ade-whiteboard-w3" run format:check
pnpm -C "Z:\canvas-ade-whiteboard-w3" test
pnpm -C "Z:\canvas-ade-whiteboard-w3" build
```
Then the e2e harness (kill stray electron first):
```
$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\canvas-ade-whiteboard-w3" start
```
Expected: `E2E_DONE` line with `ok:true`, including `E2E_WHITEBOARD-ALT-DUP`, `E2E_WHITEBOARD-LOCK`, `E2E_WHITEBOARD-GROUP`, `E2E_WHITEBOARD-ALIGN` all `ok:true`. The `browser`/`browser-gesture`/`focus-detach` trio may flake on a contended host (memory `e2e-browser-trio-flake`) — rerun for clean; not a regression.

- [ ] **Step 4: Commit**

```
git -C "Z:\canvas-ade-whiteboard-w3" add src/main/e2e/probes/whiteboard.ts src/main/e2e/index.ts
git -C "Z:\canvas-ade-whiteboard-w3" commit -F - <<'EOF'
test(w3): e2e probes — alt-dup (real input), lock, group, align

alt-dup uses real OS input (transform-dependent); align/group drive the
real HTML context menu; lock proves resist-drag/erase/X. Registered in
the PLAYLIST before seed.
EOF
```

---

## Final: holistic review + format

- [ ] Run a holistic review pass over the whole W3 diff (`git -C "Z:\canvas-ade-whiteboard-w3" diff feat/whiteboard...feat/whiteboard-w3`). Specifically re-verify: the lock gate covers ALL FOUR points (drag, keyboard-delete, per-element X, erase) — the prior attempt's bug was a lock-delete-via-X bypass; ghost-copy `__ghost__` ids never reach `commit`; every W3 operation takes exactly ONE undo checkpoint and a no-op gesture pushes none (phantom-undo discipline); `measuredRef` is passed to align/distribute so auto-sized kinds align correctly.
- [ ] `pnpm -C "Z:\canvas-ade-whiteboard-w3" run format` to normalize, then re-run `format:check` + `test`; commit any formatting.
- [ ] Update `docs/roadmap-whiteboard.md` Status table: W3 → done. Update the coordination row `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (note cross-zone schema-v3 status). Commit.
- [ ] Finish via `superpowers:finishing-a-development-branch` (push `feat/whiteboard-w3`, open a PR targeting `feat/whiteboard`, NOT `main`).

## Self-review notes (plan author)

- **Spec coverage:** schema v3 (T1) · lock predicate/group/dup mutators (T2) · align/distribute (T3) · context menu (T4) · all wiring incl. select-then-act, lock gate ×4, alt-drag, group precedence (T5) · 4 e2e probes with real-input where transform-dependent (T6). Lock×group precedence (lock wins) is enforced in T5 Step 2(a)/(c) + the Delete entry by filtering locked AFTER `expandGroups`. ✓
- **Known follow-ups flagged for the worker:** confirm Icon glyph names (T4 note / T5 Step 0); confirm NoteCard delete/grip class names (T6 note); strip the placeholder line in `whiteboardAltDup` (T6 note).
- **Out of scope (unchanged):** cross-kind z-order, nested groups, resize/rotate, keyboard Ctrl+G/D, previewStore occlusion fix.
