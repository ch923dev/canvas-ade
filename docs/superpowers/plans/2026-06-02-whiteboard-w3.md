# Whiteboard W3 — Selection follow-ons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four W3 selection follow-ons — alt-drag duplicate, align/distribute, `locked?`, and lightweight `groupId` grouping — surfaced through a right-click element context menu, on top of the W2 selection core.

**Architecture:** Pure, unit-tested helpers (`align.ts`, plus `duplicateElements`/`expandGroups`/`groupElements`/`ungroupElements`/`setLocked`/`notLocked` in `elements.ts`) carry all geometry + array transforms. Two new optional persisted fields (`locked?`, `groupId?`) on `ElementCommon` behind a `2→3` schema migration. A portal-rendered `ElementContextMenu` is the single action surface; `PlanningBoard` wires gestures (alt-drag dup, lock gating, group-aware selection) to the helpers. Every committing action is one `beginChange()` checkpoint (phantom-undo discipline); selection/group-expansion/menu stay ephemeral.

**Tech Stack:** TypeScript (strict), React 18, Zustand, Vitest (unit), the `CANVAS_SMOKE=e2e` headless harness (behavioral). React Flow `useOnViewportChange` for menu-close-on-camera-move.

**Spec:** `docs/superpowers/specs/2026-06-02-whiteboard-w3-design.md`

**Branch / worktree:** `feat/whiteboard-w3` at `Z:\canvas-ade-whiteboard-w3` (off `feat/whiteboard` @ `8505a81`). Merges into `feat/whiteboard`, NOT `main`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/renderer/src/lib/boardSchema.ts` | `locked?`/`groupId?` fields, `SCHEMA_VERSION=3`, `MIGRATIONS[2]`, asserts | Modify |
| `src/renderer/src/lib/boardSchema.test.ts` | migration + assert tests | Modify |
| `src/renderer/src/canvas/boards/planning/elements.ts` | `duplicateElements`, `expandGroups`, `groupElements`, `ungroupElements`, `setLocked`, `notLocked` | Modify |
| `src/renderer/src/canvas/boards/planning/elements.test.ts` | tests for the above | Modify |
| `src/renderer/src/canvas/boards/planning/align.ts` | `alignElements`, `distributeElements` | Create |
| `src/renderer/src/canvas/boards/planning/align.test.ts` | align/distribute tests | Create |
| `src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx` | portal menu: positioning, close, preview-detach, dynamic rows | Create |
| `src/renderer/src/canvas/boards/PlanningBoard.tsx` | wire menu + alt-drag dup + lock gating + group selection + chords | Modify |
| `src/renderer/src/canvas/boards/planning/NoteCard.tsx` · `FreeText.tsx` · `ChecklistCard.tsx` | `locked` prop → affordance + `onContextMenu` | Modify |
| `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` | locked vector affordance + `onContextMenu` | Modify |
| `src/renderer/src/canvas/Icon.tsx` | additive align/distribute glyphs | Modify |
| `src/main/e2eSmoke.ts` | W3 probes (dup/align/distribute/lock/group/menu) | Modify |
| `docs/roadmap-whiteboard.md` | mark W3 done | Modify |

**Conventions to follow (read before starting):** `elements.ts` factory/transform style (caller-supplied ids, immutable `els.map`); the phantom-undo rule (memory `undo-lastrecorded-phantom` — `beginChange()` lazily, once, at commit); the e2e probe idiom at `e2eSmoke.ts:1014-1163` (re-seed per sub-test, drive DOM on `.pl-well`/`.pl-note-grip`, assert via `getBoards()`).

---

## Task 1: Schema — `locked?` + `groupId?` + v2→v3 migration

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts` (`ElementCommon:57`, `SCHEMA_VERSION:15`, `MIGRATIONS:216`, `assertPlanningElement:293`)
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `boardSchema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { SCHEMA_VERSION, migrate, fromObject, toObject } from './boardSchema'

describe('W3 schema: locked?/groupId? + v3', () => {
  it('SCHEMA_VERSION is 3', () => {
    expect(SCHEMA_VERSION).toBe(3)
  })

  it('migrates a v2 doc to v3 unchanged except version', () => {
    const v2 = { schemaVersion: 2, viewport: null, boards: [] }
    expect(migrate(v2).schemaVersion).toBe(3)
  })

  it('loads a v2 planning board (no locked/groupId) → fields absent', () => {
    const doc = {
      schemaVersion: 2,
      viewport: null,
      boards: [
        { id: 'p', type: 'planning', x: 0, y: 0, w: 300, h: 300, title: 'P',
          elements: [{ id: 'n', kind: 'note', x: 1, y: 1, w: 156, h: 96, tint: 'yellow', text: '' }] }
      ]
    }
    const out = fromObject(doc)
    expect(out.schemaVersion).toBe(3)
    const el = (out.boards[0] as { elements: Array<Record<string, unknown>> }).elements[0]
    expect(el.locked).toBeUndefined()
    expect(el.groupId).toBeUndefined()
  })

  it('round-trips locked + groupId through toObject', () => {
    const board = {
      id: 'p', type: 'planning' as const, x: 0, y: 0, w: 300, h: 300, title: 'P',
      elements: [{ id: 'n', kind: 'note' as const, x: 1, y: 1, w: 156, h: 96, tint: 'yellow' as const, text: '', locked: true, groupId: 'g1' }]
    }
    const doc = toObject([board], null)
    const back = fromObject(doc)
    const el = (back.boards[0] as typeof board).elements[0]
    expect(el.locked).toBe(true)
    expect(el.groupId).toBe('g1')
  })

  it('rejects a non-boolean locked', () => {
    const doc = { schemaVersion: 3, viewport: null, boards: [
      { id: 'p', type: 'planning', x: 0, y: 0, w: 300, h: 300, title: 'P',
        elements: [{ id: 'n', kind: 'note', x: 1, y: 1, w: 156, h: 96, tint: 'yellow', text: '', locked: 'yes' }] }
    ] }
    expect(() => fromObject(doc)).toThrow(/locked/)
  })

  it('rejects a non-string groupId', () => {
    const doc = { schemaVersion: 3, viewport: null, boards: [
      { id: 'p', type: 'planning', x: 0, y: 0, w: 300, h: 300, title: 'P',
        elements: [{ id: 'n', kind: 'note', x: 1, y: 1, w: 156, h: 96, tint: 'yellow', text: '', groupId: 7 }] }
    ] }
    expect(() => fromObject(doc)).toThrow(/groupId/)
  })
})
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `pnpm test src/renderer/src/lib/boardSchema.test.ts`
Expected: FAIL (`SCHEMA_VERSION` is 2; locked/groupId not asserted).

- [ ] **Step 3: Implement**

In `boardSchema.ts`:

1. Bump the constant (`:15`):
```ts
export const SCHEMA_VERSION = 3
```

2. Add the two optional fields to `ElementCommon` (`:57`):
```ts
interface ElementCommon {
  id: string
  x: number
  y: number
  /** W3: pinned — selectable but not movable/deletable/erasable. Absent = unlocked. */
  locked?: boolean
  /** W3: lightweight grouping — elements sharing a groupId move/delete together. Absent = ungrouped. */
  groupId?: string
}
```

3. Add the migration (`MIGRATIONS`, `:216`) — the v1 step stays; add the v2 step:
```ts
const MIGRATIONS: Record<number, Migration> = {
  // v1 had no camera. v2 adds `viewport` (null = fit on load).
  1: (doc) => ({ ...doc, schemaVersion: 2, viewport: (doc as CanvasDoc).viewport ?? null }),
  // v2 → v3: W3 adds OPTIONAL element fields locked?/groupId? — absent is valid, so this is a
  // pure version marker (no field injection needed).
  2: (doc) => ({ ...doc, schemaVersion: 3 })
}
```

4. In `assertPlanningElement` (`:293`), after the `id`/`x`/`y` checks and BEFORE the `kind` switch (these are common fields):
```ts
  if (el.locked !== undefined && typeof el.locked !== 'boolean') fail('planning element locked is not a boolean')
  if (el.groupId !== undefined && typeof el.groupId !== 'string') fail('planning element groupId is not a string')
```

5. Extend the scene/session comment in `toObject` (`:196-204`) — append one line:
```
 * W3 adds two PERSISTED element fields: `locked` and `groupId` (durable element
 * data, not ephemeral). Selection/menu-open/drag drafts remain session-only.
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `pnpm test src/renderer/src/lib/boardSchema.test.ts`
Expected: PASS (all, including the pre-existing schema tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -m "feat(whiteboard): W3 schema — locked?/groupId? + v2->v3 migration"
```

---

## Task 2: `align.ts` — `alignElements`

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/align.ts`
- Test: `src/renderer/src/canvas/boards/planning/align.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { alignElements } from './align'
import type { NoteElement } from '../../../lib/boardSchema'

const note = (id: string, x: number, y: number, locked = false): NoteElement => ({
  id, kind: 'note', x, y, w: 100, h: 50, tint: 'yellow', text: '', ...(locked ? { locked } : {})
})

describe('alignElements', () => {
  it('aligns left edges to the minimum left', () => {
    const els = [note('a', 40, 0), note('b', 100, 80), note('c', 70, 160)]
    const out = alignElements(els, ['a', 'b', 'c'], 'left')
    expect(out.map((e) => e.x)).toEqual([40, 40, 40])
  })

  it('aligns horizontal centers to the union center', () => {
    // union spans x:0..200 (a at 0 w100 → right 100; b at 100 w100 → right 200), centerX=100.
    const els = [note('a', 0, 0), note('b', 100, 80)]
    const out = alignElements(els, ['a', 'b'], 'centerX')
    // each centered at 100 → x = 100 - 50 = 50
    expect(out.map((e) => e.x)).toEqual([50, 50])
  })

  it('aligns top edges to the minimum top', () => {
    const els = [note('a', 0, 30), note('b', 0, 90)]
    const out = alignElements(els, ['a', 'b'], 'top')
    expect(out.map((e) => e.y)).toEqual([30, 30])
  })

  it('does not move locked elements', () => {
    const els = [note('a', 40, 0), note('b', 100, 0, true)]
    const out = alignElements(els, ['a', 'b'], 'left')
    expect(out.find((e) => e.id === 'b')!.x).toBe(100) // locked, untouched
    expect(out.find((e) => e.id === 'a')!.x).toBe(40)  // <2 unlocked → no-op
  })

  it('is a no-op for fewer than 2 movable elements', () => {
    const els = [note('a', 40, 0)]
    expect(alignElements(els, ['a'], 'left')).toBe(els)
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm test src/renderer/src/canvas/boards/planning/align.test.ts`
Expected: FAIL (`align.ts` does not exist).

- [ ] **Step 3: Implement `align.ts`**

```ts
/**
 * Pure align/distribute geometry for the Planning whiteboard selection (W3). No
 * React, no store: operate on board-local element arrays + the W2 bbox/anchor
 * helpers so it is unit-testable in isolation. Locked elements in the selection are
 * never moved. `measured` (live DOM sizes for auto-sized text/checklist) refines the
 * boxes; absent → nominal sizes.
 */
import type { PlanningElement } from '../../../lib/boardSchema'
import { elementBBox, anchors, unionBBox, shiftElement, type Measured } from './elements'

export type AlignEdge = 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'
export type DistributeAxis = 'h' | 'v'

function asSet(ids: Iterable<string>): Set<string> {
  return ids instanceof Set ? ids : new Set(ids)
}

/** Align the unlocked selected elements to a shared edge/center. <2 movable → unchanged. */
export function alignElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  edge: AlignEdge,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = asSet(ids)
  const targets = els.filter((el) => set.has(el.id) && !el.locked)
  if (targets.length < 2) return els
  const boxes = targets.map((el) => ({ id: el.id, b: elementBBox(el, measured?.get(el.id)) }))
  const axis: 'x' | 'y' = edge === 'left' || edge === 'centerX' || edge === 'right' ? 'x' : 'y'
  const anchor = (b: (typeof boxes)[number]['b']): number => anchors(b)[edge]

  let target: number
  if (edge === 'left' || edge === 'top') target = Math.min(...boxes.map(({ b }) => anchor(b)))
  else if (edge === 'right' || edge === 'bottom') target = Math.max(...boxes.map(({ b }) => anchor(b)))
  else {
    const u = unionBBox(boxes.map(({ b }) => b))
    target = edge === 'centerX' ? u.x + u.w / 2 : u.y + u.h / 2
  }

  const delta = new Map<string, number>()
  for (const { id, b } of boxes) delta.set(id, Math.round(target - anchor(b)))
  return els.map((el) => {
    const d = delta.get(el.id)
    if (d === undefined || d === 0) return el
    return axis === 'x' ? shiftElement(el, d, 0) : shiftElement(el, 0, d)
  })
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm test src/renderer/src/canvas/boards/planning/align.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/align.ts src/renderer/src/canvas/boards/planning/align.test.ts
git commit -m "feat(whiteboard): W3 alignElements (6 edges, locked-skip)"
```

---

## Task 3: `align.ts` — `distributeElements`

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/align.ts`
- Test: `src/renderer/src/canvas/boards/planning/align.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `align.test.ts`:

```ts
import { distributeElements } from './align'

describe('distributeElements', () => {
  it('spaces 3 elements at equal horizontal center gaps (ends pinned)', () => {
    // centers: a=50, b=150 (will move), c=350. Equal gap = (350-50)/2 = 150 → b center→200 → x=150.
    const els = [note('a', 0, 0), note('b', 100, 0), note('c', 300, 0)]
    const out = distributeElements(els, ['a', 'b', 'c'], 'h')
    const x = (id: string): number => out.find((e) => e.id === id)!.x
    expect(x('a')).toBe(0)
    expect(x('c')).toBe(300)
    expect(x('b')).toBe(150) // center 200 - half-width 50
  })

  it('is a no-op for fewer than 3 movable elements', () => {
    const els = [note('a', 0, 0), note('b', 100, 0)]
    expect(distributeElements(els, ['a', 'b'], 'h')).toBe(els)
  })

  it('ignores locked elements when counting movable', () => {
    const els = [note('a', 0, 0), note('b', 100, 0), note('c', 300, 0, true)]
    expect(distributeElements(els, ['a', 'b', 'c'], 'h')).toBe(els) // only 2 movable
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm test src/renderer/src/canvas/boards/planning/align.test.ts`
Expected: FAIL (`distributeElements` not exported).

- [ ] **Step 3: Implement — append to `align.ts`**

```ts
/**
 * Distribute the unlocked selected elements to equal CENTER spacing along the axis.
 * The extreme (first/last by center) stay pinned; interior elements are evenly
 * spread. <3 movable → unchanged. (Center spacing, not edge-gap — adequate for a
 * sketch surface; edge-gap distribution is intentionally out of scope.)
 */
export function distributeElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  axis: DistributeAxis,
  measured?: Map<string, Measured>
): PlanningElement[] {
  const set = asSet(ids)
  const movable = els.filter((el) => set.has(el.id) && !el.locked)
  if (movable.length < 3) return els
  const items = movable
    .map((el) => {
      const b = elementBBox(el, measured?.get(el.id))
      return { id: el.id, center: axis === 'h' ? b.x + b.w / 2 : b.y + b.h / 2 }
    })
    .sort((p, q) => p.center - q.center)
  const first = items[0].center
  const last = items[items.length - 1].center
  const gap = (last - first) / (items.length - 1)
  const delta = new Map<string, number>()
  items.forEach((it, i) => {
    if (i === 0 || i === items.length - 1) return
    delta.set(it.id, Math.round(first + gap * i - it.center))
  })
  return els.map((el) => {
    const d = delta.get(el.id)
    if (d === undefined || d === 0) return el
    return axis === 'h' ? shiftElement(el, d, 0) : shiftElement(el, 0, d)
  })
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm test src/renderer/src/canvas/boards/planning/align.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/align.ts src/renderer/src/canvas/boards/planning/align.test.ts
git commit -m "feat(whiteboard): W3 distributeElements (h/v equal center spacing)"
```

---

## Task 4: `elements.ts` — `duplicateElements`

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/elements.ts`
- Test: `src/renderer/src/canvas/boards/planning/elements.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `elements.test.ts`:

```ts
import { duplicateElements } from './elements'

describe('duplicateElements', () => {
  const newIdSeq = (): (() => string) => {
    let n = 0
    return () => `clone-${++n}`
  }
  const note = (id: string, x = 0, groupId?: string): NoteElement => ({
    id, kind: 'note', x, y: 0, w: 100, h: 50, tint: 'yellow', text: '', ...(groupId ? { groupId } : {})
  })

  it('clones selected elements with fresh ids, appended after originals', () => {
    const els = [note('a'), note('b')]
    const { next, cloneIds } = duplicateElements(els, ['a'], newIdSeq())
    expect(next).toHaveLength(3)
    expect(next.map((e) => e.id)).toEqual(['a', 'b', 'clone-1'])
    expect(cloneIds).toEqual(['clone-1'])
  })

  it('remaps a shared groupId to ONE new shared group across the clones', () => {
    const els = [note('a', 0, 'g1'), note('b', 0, 'g1'), note('c', 0, 'g2')]
    const { next } = duplicateElements(els, ['a', 'b', 'c'], newIdSeq())
    const clones = next.slice(3)
    // a,b shared g1 → same new group; c had g2 → a different new group; none equal g1/g2.
    expect(clones[0].groupId).toBe(clones[1].groupId)
    expect(clones[2].groupId).not.toBe(clones[0].groupId)
    expect(clones.every((c) => c.groupId !== 'g1' && c.groupId !== 'g2')).toBe(true)
  })

  it('deep-clones (no aliasing of the source array references)', () => {
    const els = [note('a')]
    const { next } = duplicateElements(els, ['a'], newIdSeq())
    expect(next[1]).not.toBe(next[0])
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm test src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: FAIL (`duplicateElements` not exported).

- [ ] **Step 3: Implement — append to `elements.ts`**

```ts
/**
 * Duplicate the selected elements (W3): deep-clone each with a fresh caller-supplied
 * id (deterministic/testable), appended AFTER the originals. A shared groupId is
 * remapped to ONE new shared group per source group, so a duplicated group stays a
 * group but is distinct from the original. `locked` is preserved on the clone.
 */
export function duplicateElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  newId: () => string
): { next: PlanningElement[]; idMap: Map<string, string>; cloneIds: string[] } {
  const set = ids instanceof Set ? ids : new Set(ids)
  const idMap = new Map<string, string>()
  const groupMap = new Map<string, string>()
  const clones: PlanningElement[] = []
  for (const el of els) {
    if (!set.has(el.id)) continue
    const clone = structuredClone(el)
    const nid = newId()
    idMap.set(el.id, nid)
    clone.id = nid
    if (clone.groupId !== undefined) {
      let ng = groupMap.get(clone.groupId)
      if (ng === undefined) {
        ng = newId()
        groupMap.set(clone.groupId, ng)
      }
      clone.groupId = ng
    }
    clones.push(clone)
  }
  return { next: [...els, ...clones], idMap, cloneIds: clones.map((c) => c.id) }
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm test src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/elements.ts src/renderer/src/canvas/boards/planning/elements.test.ts
git commit -m "feat(whiteboard): W3 duplicateElements (fresh ids + group remap)"
```

---

## Task 5: `elements.ts` — `expandGroups`, group/lock mutators, `notLocked`

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/elements.ts`
- Test: `src/renderer/src/canvas/boards/planning/elements.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `elements.test.ts`:

```ts
import { expandGroups, groupElements, ungroupElements, setLocked, notLocked } from './elements'

describe('group + lock helpers', () => {
  const note = (id: string, groupId?: string, locked?: boolean): NoteElement => ({
    id, kind: 'note', x: 0, y: 0, w: 100, h: 50, tint: 'yellow', text: '',
    ...(groupId ? { groupId } : {}), ...(locked ? { locked } : {})
  })

  it('expandGroups pulls in every co-grouped element', () => {
    const els = [note('a', 'g1'), note('b', 'g1'), note('c')]
    expect([...expandGroups(els, ['a'])].sort()).toEqual(['a', 'b'])
  })

  it('expandGroups passes ungrouped ids through unchanged', () => {
    const els = [note('a'), note('b')]
    expect([...expandGroups(els, ['a'])]).toEqual(['a'])
  })

  it('groupElements assigns the shared groupId to the selected', () => {
    const els = [note('a'), note('b'), note('c')]
    const out = groupElements(els, ['a', 'b'], 'gX')
    expect(out.find((e) => e.id === 'a')!.groupId).toBe('gX')
    expect(out.find((e) => e.id === 'b')!.groupId).toBe('gX')
    expect(out.find((e) => e.id === 'c')!.groupId).toBeUndefined()
  })

  it('ungroupElements clears the groupId on the selected', () => {
    const els = [note('a', 'g1'), note('b', 'g1')]
    const out = ungroupElements(els, ['a'])
    expect(out.find((e) => e.id === 'a')!.groupId).toBeUndefined()
    expect(out.find((e) => e.id === 'b')!.groupId).toBe('g1')
  })

  it('setLocked sets/clears the locked flag on the selected', () => {
    const els = [note('a')]
    expect(setLocked(els, ['a'], true)[0].locked).toBe(true)
    expect(setLocked(setLocked(els, ['a'], true), ['a'], false)[0].locked).toBe(false)
  })

  it('notLocked is true for an unlocked element', () => {
    expect(notLocked(note('a'))).toBe(true)
    expect(notLocked(note('a', undefined, true))).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm test src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: FAIL (helpers not exported).

- [ ] **Step 3: Implement — append to `elements.ts`**

```ts
/** True when an element is not pinned (W3 lock). */
export function notLocked(el: PlanningElement): boolean {
  return !el.locked
}

/**
 * Expand a base id set to include every element co-grouped with a selected one
 * (W3 grouping: selecting one member selects the whole group). Ungrouped ids pass
 * through unchanged. Idempotent.
 */
export function expandGroups(els: PlanningElement[], ids: Iterable<string>): Set<string> {
  const set = ids instanceof Set ? new Set(ids) : new Set(ids)
  const groups = new Set<string>()
  for (const el of els) if (set.has(el.id) && el.groupId !== undefined) groups.add(el.groupId)
  if (groups.size === 0) return set
  const out = new Set(set)
  for (const el of els) if (el.groupId !== undefined && groups.has(el.groupId)) out.add(el.id)
  return out
}

/** Assign a shared groupId to the selected elements (W3 group). */
export function groupElements(
  els: PlanningElement[],
  ids: Iterable<string>,
  groupId: string
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  return els.map((el) => (set.has(el.id) ? { ...el, groupId } : el))
}

/** Clear the groupId on the selected elements (W3 ungroup). JSON drops the undefined key on save. */
export function ungroupElements(els: PlanningElement[], ids: Iterable<string>): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  return els.map((el) => (set.has(el.id) && el.groupId !== undefined ? { ...el, groupId: undefined } : el))
}

/** Set or clear the locked flag on the selected elements (W3 lock/unlock). */
export function setLocked(
  els: PlanningElement[],
  ids: Iterable<string>,
  locked: boolean
): PlanningElement[] {
  const set = ids instanceof Set ? ids : new Set(ids)
  return els.map((el) => (set.has(el.id) ? { ...el, locked } : el))
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm test src/renderer/src/canvas/boards/planning/elements.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/elements.ts src/renderer/src/canvas/boards/planning/elements.test.ts
git commit -m "feat(whiteboard): W3 expandGroups + group/ungroup/lock mutators"
```

---

## Task 6: `ElementContextMenu.tsx` shell (Duplicate + Delete)

Prove the menu mechanics (portal, cursor position, close-on-{outside,Esc,camera}, preview-detach) with two simple actions before wiring the rest.

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx`
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx` (state + onContextMenu + render)

- [ ] **Step 1: Implement `ElementContextMenu.tsx`**

```tsx
/**
 * Right-click context menu for the Planning whiteboard selection (W3). The single
 * action surface for duplicate/lock/group/align/distribute/delete. Rendered through a
 * portal to document.body at fixed (clientX, clientY) so it escapes the well's
 * overflow:hidden and the canvas transform. Closes on outside-pointerdown, Escape, an
 * action click, or any camera move. While open it registers a token in
 * previewStore.menuOpen so an overlapping Browser board's native WebContentsView
 * detaches to a snapshot (the always-on-top native layer would otherwise paint over
 * this HTML menu — the PREV-C ref-counted Set pattern).
 */
import { useEffect, useId, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { useOnViewportChange } from '@xyflow/react'
import { usePreviewStore } from '../../store/previewStore'
import { Icon } from '../../Icon'
import type { AlignEdge, DistributeAxis } from './align'

export interface MenuSelectionState {
  count: number
  allLocked: boolean
  grouped: boolean
  canGroup: boolean
}

export interface ElementContextMenuProps {
  x: number
  y: number
  sel: MenuSelectionState
  onDuplicate: () => void
  onToggleLock: () => void
  onGroup: () => void
  onUngroup: () => void
  onAlign: (edge: AlignEdge) => void
  onDistribute: (axis: DistributeAxis) => void
  onDelete: () => void
  onClose: () => void
}

const ALIGN_ITEMS: ReadonlyArray<{ edge: AlignEdge; icon: 'align-left' | 'align-center-x' | 'align-right' | 'align-top' | 'align-center-y' | 'align-bottom'; label: string }> = [
  { edge: 'left', icon: 'align-left', label: 'Left' },
  { edge: 'centerX', icon: 'align-center-x', label: 'Center' },
  { edge: 'right', icon: 'align-right', label: 'Right' },
  { edge: 'top', icon: 'align-top', label: 'Top' },
  { edge: 'centerY', icon: 'align-center-y', label: 'Middle' },
  { edge: 'bottom', icon: 'align-bottom', label: 'Bottom' }
]

export function ElementContextMenu(props: ElementContextMenuProps): ReactElement {
  const { x, y, sel, onClose } = props
  const token = useId()
  const openMenu = usePreviewStore((s) => s.openMenu)
  const closeMenu = usePreviewStore((s) => s.closeMenu)

  // Detach overlapping live previews while the menu is open (PREV-C).
  useEffect(() => {
    openMenu(token)
    return () => closeMenu(token)
  }, [token, openMenu, closeMenu])

  // Close on Escape + on any outside pointerdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement | null
      if (!el?.closest('.pl-ctx-menu')) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [onClose])

  // Close on any camera move (a fixed-position menu would desync from the board).
  useOnViewportChange({ onChange: onClose })

  const run = (fn: () => void) => (): void => {
    fn()
    onClose()
  }

  return createPortal(
    <div
      className="pl-ctx-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 10000,
        minWidth: 184,
        padding: 4,
        background: 'var(--surface-raised, var(--surface))',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--r-inner)',
        boxShadow: 'var(--shadow-pop, 0 8px 28px rgba(0,0,0,0.35))',
        font: 'var(--t-body, 13px system-ui)',
        color: 'var(--text)'
      }}
      // The menu owns its own pointer events; never let them reach the canvas.
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuRow label="Duplicate" hint="⌘D" onClick={run(props.onDuplicate)} />
      <MenuRow
        label={sel.allLocked ? 'Unlock' : 'Lock'}
        hint="⌘L"
        onClick={run(props.onToggleLock)}
      />
      {sel.canGroup && <MenuRow label="Group" hint="⌘G" onClick={run(props.onGroup)} />}
      {sel.grouped && <MenuRow label="Ungroup" hint="⌘⇧G" onClick={run(props.onUngroup)} />}
      {sel.count >= 2 && (
        <>
          <Sep />
          <div className="t-meta" style={{ padding: '4px 8px 2px', color: 'var(--text-faint)' }}>
            Align
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 1, padding: '0 4px 2px' }}>
            {ALIGN_ITEMS.map((a) => (
              <button
                key={a.edge}
                type="button"
                title={a.label}
                onClick={run(() => props.onAlign(a.edge))}
                style={iconBtnStyle}
              >
                <Icon name={a.icon} size={14} />
              </button>
            ))}
          </div>
        </>
      )}
      {sel.count >= 3 && (
        <div style={{ display: 'flex', gap: 4, padding: '2px 4px 4px' }}>
          <MenuRow label="Distribute H" onClick={run(() => props.onDistribute('h'))} />
          <MenuRow label="Distribute V" onClick={run(() => props.onDistribute('v'))} />
        </div>
      )}
      <Sep />
      <MenuRow label="Delete" hint="⌫" danger disabled={sel.allLocked} onClick={run(props.onDelete)} />
    </div>,
    document.body
  )
}

const iconBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 26,
  border: 'none',
  background: 'transparent',
  color: 'var(--text)',
  borderRadius: 4,
  cursor: 'pointer'
}

function Sep(): ReactElement {
  return <div style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }} />
}

function MenuRow({
  label,
  hint,
  onClick,
  danger,
  disabled
}: {
  label: string
  hint?: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        gap: 16,
        padding: '5px 8px',
        border: 'none',
        background: 'transparent',
        textAlign: 'left',
        borderRadius: 4,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        color: danger ? 'var(--danger, #e5484d)' : 'var(--text)'
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--inset)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span>{label}</span>
      {hint && <span className="t-meta" style={{ color: 'var(--text-faint)' }}>{hint}</span>}
    </button>
  )
}
```

> **Pre-req check before Step 2:** confirm `previewStore` exposes `openMenu(token)`/`closeMenu(token)` (the PREV-C ref-counted Set). If the actual names differ (e.g. `addMenu`/`removeMenu`), use those — grep `previewStore.ts` for `menuOpen`. If only a boolean setter exists, extend the store with a `Set<string>` + `openMenu`/`closeMenu` in this task (mirror the BoardFrame ⋯ menu usage). Also confirm `Icon` accepts the six `align-*` names — they are ADDED in Task 9; for THIS task the align grid is gated behind `sel.count >= 2` and the shell test only exercises `count: 1`, so the glyphs are not yet rendered.

- [ ] **Step 2: Wire minimal state + handlers into `PlanningBoard.tsx`**

Add near the other `useState` (after `selectedIds`, ~`:99`):
```tsx
  // W3 right-click menu: screen position + the live selection summary. Ephemeral.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
```

Add an element context-menu opener (after `selectOnPress`, ~`:121`):
```tsx
  const openMenuAt = useCallback(
    (e: { clientX: number; clientY: number; preventDefault: () => void }, id: string, additive: boolean) => {
      e.preventDefault()
      // Right-click selects (group-aware) if the target is not already selected.
      setSelectedIds((prev) => {
        if (prev.has(id)) return prev
        const base = additive ? new Set(prev).add(id) : new Set([id])
        return expandGroups(elements, base)
      })
      setMenu({ x: e.clientX, y: e.clientY })
    },
    [elements]
  )
```

Render the menu just before the closing `</BoardFrame>` of the well's parent (after the `elements.length === 0` block, ~`:724`):
```tsx
        {menu && (
          <ElementContextMenu
            x={menu.x}
            y={menu.y}
            sel={menuSelectionState(elements, selectedIds)}
            onDuplicate={() => duplicateSelection({ inPlace: true })}
            onToggleLock={() => toggleLockSelection()}
            onGroup={() => groupSelection()}
            onUngroup={() => ungroupSelection()}
            onAlign={(edge) => applyAlign(edge)}
            onDistribute={(axis) => applyDistribute(axis)}
            onDelete={() => deleteSelection()}
            onClose={() => setMenu(null)}
          />
        )}
```

For THIS task, implement only `duplicateSelection`/`deleteSelection` and stub the rest as `() => {}` (they land in Tasks 7-9). Add the imports + `menuSelectionState` helper + the two real actions:

```tsx
// imports (extend the existing elements import + add the component/helpers)
import { ElementContextMenu, type MenuSelectionState } from './planning/ElementContextMenu'
import {
  /* …existing… */ duplicateElements, expandGroups, groupElements, ungroupElements,
  setLocked, notLocked
} from './planning/elements'
import { alignElements, distributeElements, type AlignEdge, type DistributeAxis } from './planning/align'

// helper (module scope, bottom of file or above the component)
function menuSelectionState(
  els: PlanningElement[],
  sel: ReadonlySet<string>
): MenuSelectionState {
  const chosen = els.filter((e) => sel.has(e.id))
  const groups = new Set(chosen.map((e) => e.groupId).filter((g): g is string => g !== undefined))
  return {
    count: chosen.length,
    allLocked: chosen.length > 0 && chosen.every((e) => e.locked),
    grouped: groups.size > 0,
    canGroup: chosen.length >= 2 && !(groups.size === 1 && groups.size === new Set(chosen.map((e) => e.groupId)).size && chosen.every((e) => e.groupId))
  }
}

// actions (inside the component, near commit)
const duplicateSelection = useCallback(
  (opts: { inPlace: boolean }) => {
    if (selectedIds.size === 0) return
    const ids = expandGroups(elements, selectedIds)
    const { next, cloneIds } = duplicateElements(elements, ids, newId)
    const placed = opts.inPlace ? translateMany(next, cloneIds, 12, 12) : next
    beginChange()
    commit(placed)
    setSelectedIds(new Set(cloneIds))
  },
  [elements, selectedIds, beginChange, commit]
)
const deleteSelection = useCallback(() => {
  const ids = expandGroups(elements, selectedIds)
  const removable = elements.filter((e) => ids.has(e.id) && notLocked(e)).map((e) => e.id)
  if (removable.length === 0) return
  const rm = new Set(removable)
  beginChange()
  commit(elements.filter((e) => !rm.has(e.id)))
  clearSel()
}, [elements, selectedIds, beginChange, commit, clearSel])
```

Wire `onContextMenu` on the well (add to the well `<div>` props, ~`:580`):
```tsx
        onContextMenu={(e) => {
          // Right-click on the bare well (no element) → no menu; let it through.
          if (e.target === e.currentTarget) return
        }}
```
…and pass an element opener to `WhiteboardSvg` + the cards (Task 7 adds the per-card `onContextMenu`; for now the cards forward it). Minimal: cards call `onContextMenu={(e) => openMenuAt(e, el.id, e.shiftKey)}`.

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS (stubs `() => {}` for the not-yet-wired actions are fine).

- [ ] **Step 4: Manual smoke (build + e2e harness still green)**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: existing E2E_* parts still ok (no regression); `E2E_DONE`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/ElementContextMenu.tsx src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(whiteboard): W3 context-menu shell (duplicate + delete, portal/close/preview-detach)"
```

---

## Task 7: Wire lock (gating + affordance + menu Lock/Unlock + ⌘L)

**Files:**
- Modify: `PlanningBoard.tsx`, `planning/NoteCard.tsx`, `FreeText.tsx`, `ChecklistCard.tsx`, `WhiteboardSvg.tsx`

- [ ] **Step 1: Implement `toggleLockSelection` + gating in `PlanningBoard.tsx`**

```tsx
const toggleLockSelection = useCallback(() => {
  if (selectedIds.size === 0) return
  const ids = expandGroups(elements, selectedIds)
  const chosen = elements.filter((e) => ids.has(e.id))
  const lock = !chosen.every((e) => e.locked) // any unlocked → lock all; all locked → unlock
  beginChange()
  commit(setLocked(elements, ids, lock))
}, [elements, selectedIds, beginChange, commit])
```

Gate **move** in `startElementDrag` (`:268-273`) — filter locked out of the moving set:
```tsx
      const sel = selectedIds
      const wanted = sel.has(id) ? expandGroups(elements, sel) : new Set([id])
      const movingIds = [...wanted].filter((mid) => {
        const el = elements.find((x) => x.id === mid)
        return el ? notLocked(el) : false
      })
      if (movingIds.length === 0) return // pressed a locked element → no drag
```
(Keep the rest: `drag.current = { mode: 'move', ids: movingIds, grabX: p.x, grabY: p.y }`.)

Gate **Backspace/Delete** (`:586-592`) — delete only unlocked:
```tsx
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
            e.stopPropagation()
            e.preventDefault()
            const ids = expandGroups(elements, selectedIds)
            const rm = new Set(elements.filter((el) => ids.has(el.id) && notLocked(el)).map((el) => el.id))
            if (rm.size > 0) {
              beginChange()
              commit(elements.filter((el) => !rm.has(el.id)))
            }
            clearSel()
            return
          }
```

Gate **erase** in `onWellPointerDown` (`:336`) and `onWellPointerMove` (`:392`) — skip locked:
```tsx
        for (const el of elements) if (notLocked(el) && eraseHitTest(el, p)) removed.add(el.id)
```
```tsx
          if (!d.removed.has(el.id) && notLocked(el) && eraseHitTest(el, p)) {
```

Add the **⌘L** chord in the well `onKeyDown` (before `shortcutTool`, after the Delete branch):
```tsx
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'l') {
            e.stopPropagation()
            e.preventDefault()
            toggleLockSelection()
            return
          }
```

- [ ] **Step 2: Lock affordance on the cards**

In each of `NoteCard.tsx`, `FreeText.tsx`, `ChecklistCard.tsx`: add a `locked?: boolean` prop and an `onContextMenu?: (e) => void` prop, render a small lock glyph in the corner when `locked`, and use a muted ring instead of the accent when `locked && selected`:

```tsx
// prop
locked?: boolean
onContextMenu?: (e: ReactMouseEvent) => void
// on the card root element add: onContextMenu={onContextMenu}
// ring color: selected ? (locked ? 'var(--border-strong)' : 'var(--accent)') : …
// corner badge:
{locked && (
  <span style={{ position: 'absolute', top: 2, right: 2, opacity: 0.6, pointerEvents: 'none' }}>
    <Icon name="lock" size={11} />
  </span>
)}
```

Pass `locked={el.locked}` + `onContextMenu={(ev) => openMenuAt(ev, el.id, ev.shiftKey)}` from `PlanningBoard`'s `viewElements.map` (the three card branches). For `WhiteboardSvg`, pass `locked` per arrow/stroke and add an `onContextMenu` that calls back with the element id; render a muted (non-accent) selection stroke when locked.

> **Pre-req:** confirm `Icon` has a `lock` glyph; if not, add it (additive) in this task.

- [ ] **Step 3: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(whiteboard): W3 wire lock — gating (move/delete/erase) + affordance + Lock/Unlock + ⌘L"
```

---

## Task 8: Wire group (group/ungroup + selection expansion + ⌘G/⌘⇧G)

**Files:**
- Modify: `PlanningBoard.tsx`

- [ ] **Step 1: Implement group/ungroup actions + selection expansion**

```tsx
const groupSelection = useCallback(() => {
  if (selectedIds.size < 2) return
  const gid = newId()
  beginChange()
  commit(groupElements(elements, selectedIds, gid))
}, [elements, selectedIds, beginChange, commit])

const ungroupSelection = useCallback(() => {
  if (selectedIds.size === 0) return
  beginChange()
  commit(ungroupElements(elements, expandGroups(elements, selectedIds)))
}, [elements, selectedIds, beginChange, commit])
```

Make plain element-press selection group-aware — wrap `selectOnPress` (`:115-121`) so a non-additive press selects the whole group:
```tsx
  const selectOnPress = useCallback(
    (id: string, additive: boolean) => {
      if (additive) toggleSel(id)
      else setSelectedIds((prev) => (prev.has(id) ? prev : expandGroups(elements, new Set([id]))))
    },
    [toggleSel, elements]
  )
```

Make marquee resolution group-aware — in `onWellPointerUp` marquee branch (`:469-476`), expand hits:
```tsx
        const hits = expandGroups(elements, marqueeHits(elements, rect, measuredRef.current))
```

Add **⌘G / ⌘⇧G** chords in the well `onKeyDown` (near the ⌘L branch):
```tsx
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
            e.stopPropagation()
            e.preventDefault()
            if (e.shiftKey) ungroupSelection()
            else groupSelection()
            return
          }
```

- [ ] **Step 2: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "feat(whiteboard): W3 wire group — group/ungroup + group-aware selection + ⌘G/⌘⇧G"
```

---

## Task 9: Wire align/distribute + alt-drag duplicate + ⌘D + Icon glyphs

**Files:**
- Modify: `PlanningBoard.tsx`, `Icon.tsx`

- [ ] **Step 1: Add the align/distribute Icon glyphs**

In `Icon.tsx`, add the eight additive glyphs used by the menu: `align-left`, `align-center-x`, `align-right`, `align-top`, `align-center-y`, `align-bottom` (and reuse existing `lock` from Task 7). Each is a tiny SVG (a baseline + bars). Keep stroke `currentColor`, `1.5` width, 16-box. Example for `align-left`:
```tsx
'align-left': <><line x1="2" y1="2" x2="2" y2="14" /><rect x="4" y="4" width="9" height="3" rx="1" /><rect x="4" y="9" width="6" height="3" rx="1" /></>,
```
Provide the analogous five (center-x/right/top/center-y/bottom) following the same idiom.

- [ ] **Step 2: Implement align/distribute + alt-drag actions in `PlanningBoard.tsx`**

```tsx
const applyAlign = useCallback(
  (edge: AlignEdge) => {
    const ids = expandGroups(elements, selectedIds)
    const next = alignElements(elements, ids, edge, measuredRef.current)
    if (next === elements) return
    beginChange()
    commit(next)
  },
  [elements, selectedIds, beginChange, commit]
)
const applyDistribute = useCallback(
  (axis: DistributeAxis) => {
    const ids = expandGroups(elements, selectedIds)
    const next = distributeElements(elements, ids, axis, measuredRef.current)
    if (next === elements) return
    beginChange()
    commit(next)
  },
  [elements, selectedIds, beginChange, commit]
)
```

**Alt-drag duplicate** — add a `dup` drag mode to the `drag` ref union (`:136-143`):
```tsx
    | { mode: 'dup'; clones: PlanningElement[]; ids: string[]; grabX: number; grabY: number }
```

In `startElementDrag`, branch on `e.altKey` BEFORE the move setup (initiates only if the pressed element is unlocked):
```tsx
      const el = elements.find((x) => x.id === id)
      if (!el || el.locked) {
        if (e.altKey) return // can't alt-drag from a locked element
      }
      const p = toBoard(e)
      if (e.altKey && el && !el.locked) {
        const ids = expandGroups(elements, selectedIds.has(id) ? selectedIds : new Set([id]))
        const { next, cloneIds } = duplicateElements(elements, ids, newId)
        const clones = next.slice(elements.length)
        drag.current = { mode: 'dup', clones, ids: cloneIds, grabX: p.x, grabY: p.y }
        setDragPos({ ids: cloneIds, dx: 0, dy: 0 })
        wellRef.current?.setPointerCapture(e.pointerId)
        return
      }
```

Handle `dup` in `onWellPointerMove` (same delta math as move; no snap in v1):
```tsx
      if (d.mode === 'move' || d.mode === 'dup') {
        const dx = Math.round(p.x - d.grabX)
        const dy = Math.round(p.y - d.grabY)
        if (d.mode === 'move' && snapEnabled) {
          /* …existing snap block, unchanged… */
        } else {
          setSnapGuides(null)
        }
        setDragPos({ ids: d.ids, dx /* +snap for move */, dy })
      } else if (d.mode === 'arrow') { /* … */ }
```
(Keep the existing snap branch for `move`; `dup` falls to the else and uses the raw delta.)

Render `dup` clones live — replace the `viewElements` derivation (`:549-553`):
```tsx
  const dupDrag = drag.current?.mode === 'dup' ? drag.current : null
  const viewElements = dragPos
    ? dupDrag
      ? translateMany([...elements, ...dupDrag.clones], dragPos.ids, dragPos.dx, dragPos.dy)
      : translateMany(elements, dragPos.ids, dragPos.dx, dragPos.dy)
    : pendingErase && pendingErase.size > 0
      ? elements.filter((el) => !pendingErase.has(el.id))
      : elements
```

Commit `dup` on pointer-up — add a branch in `onWellPointerUp` before the `move` branch handling (or extend it):
```tsx
    if (d.mode === 'dup') {
      const pos = dragPos
      setDragPos(null)
      const dx = pos?.dx ?? 0
      const dy = pos?.dy ?? 0
      beginChange()
      commit([...elements, ...d.clones.map((c) => shiftElement(c, dx, dy))])
      setSelectedIds(new Set(d.ids))
      return
    }
```
(Import `shiftElement` from `./planning/elements`.)

Add **⌘D** (duplicate-in-place) in the well `onKeyDown`:
```tsx
          if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'd') {
            e.stopPropagation()
            e.preventDefault()
            duplicateSelection({ inPlace: true })
            return
          }
```

Replace the Task-6 stub action props in the `<ElementContextMenu>` render with the real `applyAlign`/`applyDistribute`/`groupSelection`/`ungroupSelection`/`toggleLockSelection` (already defined in Tasks 7-9).

- [ ] **Step 3: Typecheck + lint + unit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/Icon.tsx
git commit -m "feat(whiteboard): W3 wire align/distribute + alt-drag duplicate + ⌘D + align glyphs"
```

---

## Task 10: e2e probes + roadmap doc + final gate

**Files:**
- Modify: `src/main/e2eSmoke.ts` (append a `w3` block in the planning section, after the W2 `w2` block at `:1130`)
- Modify: `docs/roadmap-whiteboard.md`

- [ ] **Step 1: Add the W3 e2e probes**

Append after the W2 `parts.push(... 'whiteboard-snap' ...)` block (`:1154`), reusing the same `node`/`well`/`at`/`grip` helpers idiom. Add an `ev` that carries `alt`/`ctrl`:

```ts
  // ── W3 selection follow-ons: dup / align / lock / group / context-menu ──────────
  const w3 = await evalIn<{
    stage: string
    altDupCount: number
    altDupUndo: number
    alignLeftX: string
    lockBlockedMove: boolean
    lockBlockedDel: boolean
    groupMovedBoth: boolean
    menuShown: boolean
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
       const fail = { stage:'no-well', altDupCount:-1, altDupUndo:-1, alignLeftX:'', lockBlockedMove:false, lockBlockedDel:false, groupMovedBoth:false, menuShown:false };
       if (!well) return fail;
       const r = well.getBoundingClientRect();
       const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
       const at = (bx, by) => ({ x: r.left + bx * scale, y: r.top + by * scale });
       const grip = (i) => node.querySelectorAll('.pl-note-grip')[i];
       const ev = (target, type, p, o) => { o = o || {};
         try { target.dispatchEvent(new PointerEvent(type, { bubbles:true, cancelable:true, pointerId:1, isPrimary:true, clientX:p.x, clientY:p.y, shiftKey:!!o.shift, altKey:!!o.alt })); } catch (e) {} };
       const drag = async (from, to, o) => { o = o || {}; const downT = o.downTarget || well;
         ev(downT,'pointerdown',from,o); await sleep(20);
         for (let i=1;i<=4;i++){ ev(well,'pointermove',{x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4},o); await sleep(15);} 
         ev(well,'pointerup',to,o); await sleep(40); };
       const press = (k, o) => { o = o || {}; well.focus(); well.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,ctrlKey:!!o.ctrl,metaKey:!!o.ctrl,shiftKey:!!o.shift})); };
       const seed2 = () => window.__canvasE2E.patchBoard(id, { elements: [
         { id:'w3-a', kind:'note', x:40, y:40, w:156, h:96, tint:'yellow', text:'A', rotation:0 },
         { id:'w3-b', kind:'note', x:260, y:200, w:156, h:96, tint:'blue', text:'B', rotation:0 }
       ] });
       const clearSel = () => { ev(well,'pointerdown',at(560,330)); ev(well,'pointerup',at(560,330)); };
       const fresh = async () => { seed2(); await sleep(140); clearSel(); await sleep(40); well.focus(); await sleep(20); };
       const nx = (nid) => { const n = note(nid); return n ? n.x : -999999; };
       let stage = 'start';
       try {
         // (1) alt-drag duplicate: select A then alt-drag its grip → count grows; undo restores.
         stage = 'alt-dup'; await fresh();
         ev(grip(0),'pointerdown',at(60,60)); ev(well,'pointerup',at(60,60)); await sleep(40); // select A
         await drag(at(60,60), at(140,140), { downTarget: grip(0), alt: true });
         const altDupCount = count();
         window.__canvasE2E.undo(); await sleep(60);
         const altDupUndo = count();

         // (2) align-left: marquee both → ⌘L? no. Open menu via contextmenu on grip → click Align Left.
         //     Simpler deterministic check: select both, call the align action via keyboard? align has no
         //     chord, so drive the menu. Right-click grip(0) → menu appears → click the 'Left' align button.
         stage = 'align'; await fresh();
         await drag(at(10,10), at(440,310)); await sleep(20); // marquee both
         grip(0).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:at(60,60).x,clientY:at(60,60).y}));
         await sleep(60);
         const menuShown = !!document.querySelector('.pl-ctx-menu');
         const leftBtn = document.querySelector('.pl-ctx-menu button[title="Left"]');
         if (leftBtn) leftBtn.click();
         await sleep(60);
         const alignLeftX = nx('w3-a') + '|' + nx('w3-b');

         // (3) lock: select A, lock via ⌘L, attempt drag → no move; attempt Delete → still present.
         stage = 'lock'; await fresh();
         ev(grip(0),'pointerdown',at(60,60)); ev(well,'pointerup',at(60,60)); await sleep(40);
         press('l', { ctrl: true }); await sleep(60);
         const lx0 = nx('w3-a');
         await drag(at(60,60), at(160,160), { downTarget: grip(0) });
         const lockBlockedMove = nx('w3-a') === lx0;
         ev(grip(0),'pointerdown',at(60,60)); ev(well,'pointerup',at(60,60)); await sleep(40);
         press('Delete'); await sleep(60);
         const lockBlockedDel = !!note('w3-a');

         // (4) group: select both, ⌘G, clear, click ONE → drag moves BOTH (group-aware select).
         stage = 'group'; await fresh();
         await drag(at(10,10), at(440,310)); await sleep(20); // select both
         press('g', { ctrl: true }); await sleep(60); // group
         clearSel(); await sleep(40);
         const ga0 = nx('w3-a'), gb0 = nx('w3-b');
         ev(grip(0),'pointerdown',at(60,60)); ev(well,'pointerup',at(60,60)); await sleep(40); // click A → whole group
         await drag(at(60,60), at(120,60), { downTarget: grip(0) });
         const groupMovedBoth = nx('w3-a') - ga0 >= 30 && nx('w3-b') - gb0 >= 30;

         return { stage:'done', altDupCount, altDupUndo, alignLeftX, lockBlockedMove, lockBlockedDel, groupMovedBoth, menuShown };
       } catch (err) {
         return { stage:'ERR@'+stage+':'+String((err&&err.message)||err), altDupCount:-9, altDupUndo:-9, alignLeftX:'', lockBlockedMove:false, lockBlockedDel:false, groupMovedBoth:false, menuShown:false };
       }
     })()`
  )
  const altDupOk = w3.altDupCount === 3 && w3.altDupUndo === 2
  parts.push({ name: 'whiteboard-alt-dup', ok: altDupOk, detail: altDupOk ? 'alt-drag duplicates selection (one undo step)' : JSON.stringify(w3) })
  const alignOk = w3.menuShown && (() => { const [a, b] = w3.alignLeftX.split('|').map(Number); return a === b && a > -999999 })()
  parts.push({ name: 'whiteboard-align', ok: alignOk, detail: alignOk ? 'context menu Align Left shares left x' : JSON.stringify(w3) })
  const lockOk = w3.lockBlockedMove && w3.lockBlockedDel
  parts.push({ name: 'whiteboard-lock', ok: lockOk, detail: lockOk ? 'locked element resists move + delete' : JSON.stringify(w3) })
  const groupOk = w3.groupMovedBoth
  parts.push({ name: 'whiteboard-group', ok: groupOk, detail: groupOk ? 'group → click one selects+moves all' : JSON.stringify(w3) })
```

- [ ] **Step 2: Run the full board e2e**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_WHITEBOARD-ALT-DUP`, `E2E_WHITEBOARD-ALIGN`, `E2E_WHITEBOARD-LOCK`, `E2E_WHITEBOARD-GROUP` all `ok:true`; `E2E_DONE`; exit 0. (Browser-trio flake is the known env issue — rerun if only those fail; memory `e2e-browser-trio-flake`.)

- [ ] **Step 3: Mark W3 done in the roadmap**

In `docs/roadmap-whiteboard.md` Status table, set `W3 — Selection follow-ons` to ✅ done, and add a one-line note under the W3 section: "Shipped 2026-06-_: alt-drag dup · align/distribute · locked? · groupId, via right-click context menu. Schema v3."

- [ ] **Step 4: Full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 5: Commit + open the PR**

```bash
git add src/main/e2eSmoke.ts docs/roadmap-whiteboard.md
git commit -m "test(whiteboard): W3 e2e probes (alt-dup/align/lock/group) + mark W3 done"
git push -u origin feat/whiteboard-w3
gh pr create --base feat/whiteboard --head feat/whiteboard-w3 \
  --title "Whiteboard W3 — selection follow-ons (dup/align/lock/group)" \
  --body "Alt-drag duplicate · align/distribute · locked? · groupId grouping, via a right-click element context menu. Schema v2→v3. Built on the W2 selection set. Gate: typecheck+lint+unit green, board e2e all parts ok. (CI format:check is the known pre-existing repo-wide red.)"
```

---

## Self-review notes (resolved during planning)

- **Spec coverage:** Task 1 = §A; Tasks 2-5 = §B; Task 6 = §C; Tasks 7-9 = §D; Task 10 = §E testing/docs. All four features + the menu prerequisite covered.
- **Type consistency:** `AlignEdge`/`DistributeAxis` defined in Task 2/3 and consumed identically in the menu (Task 6) and wiring (Task 9). `duplicateElements(els, ids, newId)` signature identical in Task 4 and its callers (Tasks 6, 9). `expandGroups`/`notLocked`/`setLocked`/`group*` defined in Task 5, used in 6-9. `dup` drag mode added to the union in Task 9 (the only task that uses it).
- **Pre-req flags to verify at execution time (do not assume):** (1) `previewStore` menu API names (`openMenu`/`closeMenu` vs the actual ref-counted-Set names — grep before Task 6); (2) `Icon` glyph names (`lock` for Task 7, `align-*` added in Task 9); (3) the card components' existing prop/ring structure (Task 7 extends, follow the file's pattern). These are integration points with the shared/W2 surface, not new designs.
- **Undo discipline:** every committing action (`duplicateSelection`, `deleteSelection`, `toggleLockSelection`, `group/ungroupSelection`, `applyAlign/Distribute`, dup pointer-up) calls `beginChange()` exactly once right before `commit`. Selection/menu/group-expansion never checkpoint. No-op guards (`next === elements`, empty removable set) prevent phantom snapshots (WB-1 class).
