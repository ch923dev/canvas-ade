# Testing T3 — Push-Down Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate redundant `CANVAS_SMOKE=e2e` probe coverage by moving it DOWN to fast Vitest unit/integration tests, then deleting the migrated probe code — shrinking the brittle homegrown harness to the irreducible native/real-instance "slivers" that defer to the T4 Playwright keep-set.

**Architecture:** Five e2e probe areas (`whiteboard` / `menu` / `layout` / `planning` / `previewLink`) are triaged per sub-probe into ALREADY-COVERED (delete now), MIGRATE (write a new Vitest test, then delete the probe), or SLIVER-KEEP (genuinely needs the real app — keep in the harness, defer to T4). Whiteboard interaction probes migrate to a new jsdom integration test that renders the real `PlanningBoard` inside `<ReactFlowProvider>` and drives synthetic `PointerEvent`/`KeyboardEvent` on `.pl-well`, asserting effects off the Zustand store (selection/tool are ephemeral; only `elements`/positions are serialized). Menu/layout/planning/previewLink migrate to existing test files or `canvasStore.test.ts`.

**Tech Stack:** TypeScript (strict), Vitest 2.1.9 (unit/integration workspace projects from T0), @testing-library/react, @xyflow/react v12. **No new dependencies.** All new tests run in the CI `check` job (`pnpm test`).

**Branch:** `testing-strategy` (single branch / PR #37 — no new branch). Spec: `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` (§T3). Disposition map: produced 2026-06-03 by parallel probe audit (see Self-Review).

---

## Baseline & invariants

- **Baseline before this work:** Vitest **662 tests** / 48 files green (post-T2: unit 577, integration 85), typecheck clean, lint 0 errors (one pre-existing `PlanningBoard.tsx` `no-console` WARNING — ignore). Confirm with `pnpm test` before starting.
- **Count discipline differs from T0/T2.** T3 *grows* the Vitest count (each MIGRATE adds tests) and *shrinks* the e2e harness (deleted probes). The e2e harness is **FROZEN / not a CI gate** (CLAUDE.md Status), so deleting probes does not touch the `check` gate. Every task records the new Vitest total in its verify step; if a count *drops*, a test was lost — STOP and fix.
- **No new dependency.** Do not `pnpm add` anything.
- **Never weaken the locked security model** (contextIsolation/sandbox/nodeIntegration) to make a test pass.
- **SLIVER-KEEP probes stay verbatim in the harness.** Do not delete `whiteboardFullviewAdd`, `whiteboardPasteImage`, `whiteboardExport` (png path), `menuChrome`, `menuPreviewDetach`, `previewConnectGesture`. They defer to T4.
- **Order-coupling contract (e2e PLAYLIST).** `menuChrome` narrows the terminal board to `w:150`; `previewConnectGesture` widens it back to `w:360`; the final `seed` probe asserts the board count returned to 4. Both coupled probes are SLIVER-KEEP → the contract is preserved automatically. After EVERY probe deletion, re-run a typecheck (catches dangling imports) and confirm the deleted sub-probe was **board-count-neutral** (it mutated only `elements`/positions or did a net-zero add+remove) so the final `seed` count assertion still holds.
- **e2e is best-effort, not a gate (memory `e2e-before-handoff` is superseded by the freeze).** After harness edits, run `pnpm build` + one `CANVAS_SMOKE=e2e` run to confirm the harness still *loads and completes structurally* (no import/throw crash); known env flakes (`e2e-browser-trio-flake`) are acceptable. Do not block on e2e pass/fail.
- **Commit on `testing-strategy`; `git push` updates PR #37.** Backtick-free commit messages here → plain `-m` is fine (memory `bash-tool-commit-backticks`).
- **Leave untracked files alone:** `canvas.json*` (now gitignored), `.claude/coordination/*` are runtime/session artifacts — never stage them.

---

## File Structure

- **Create** `src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx` — jsdom integration test: renders real `PlanningBoard` in a store-subscribed `<ReactFlowProvider>` harness and drives whiteboard interactions (erase, shortcut, marquee-select, multidrag, shift-add, snap, alt-dup, lock, group, align, group-align). One responsibility: whiteboard interaction → store-effect contracts.
- **Modify** `src/renderer/src/canvas/BoardMenu.integration.test.tsx` — append 5 menu-behavior tests (dup/delete count, item labels, ⋯ stroke-width/restColor, viewport-clamp algo, setMenuOpen flag).
- **Modify** `src/renderer/src/store/canvasStore.test.ts` — append a tidy span-reduction test + a planning addChecklist/round-trip test.
- **Modify** `src/renderer/src/canvas/edges/PreviewEdge.test.ts` — append stale-styling render tests; this file becomes jsdom (`.tsx` rename) because it now renders.
- **Modify** `src/main/e2e/probes/whiteboard.ts` — delete migrated/covered sub-probes, keep the 3 slivers.
- **Modify** `src/main/e2e/probes/menu.ts` — delete `boardMenu`, trim `menuChrome`/`menuPreviewDetach` to slivers.
- **Modify** `src/main/e2e/probes/previewLink.ts` — delete `previewEdgeStale`/`duplicateKeepsLink`, keep `previewConnectGesture`.
- **Delete** `src/main/e2e/probes/layout.ts` and `src/main/e2e/probes/planning.ts` (fully migrated).
- **Modify** `src/main/e2e/index.ts` — update imports + PLAYLIST after each deletion.
- **Modify** `docs/testing/TESTING.md` — record the push-down result + the remaining sliver keep-set.

---

## Task 1: Whiteboard interaction harness + erase/shortcut (spike)

This is the **spike** that proves the `PlanningBoard` jsdom render harness works end-to-end before the bulk migration. It establishes the reactive store-subscribed wrapper and the synthetic-input recipe the rest of Task 2 copies.

**Why the harness works in jsdom:** `PlanningBoard` reads `board` from its prop (`PlanningBoard.tsx:155`), commits via `updateBoard(board.id, …)` (`:214-217`), and maps pointer→board with `toBoard` → `screenScale(rect.width, offsetWidth, zoom)` (`:220-231`). In jsdom `getBoundingClientRect()` and `offsetWidth` are `0`, so `screenScale(0,0,1)` returns the fallback `1` (`pen.ts:61-64`) and the well origin is `(0,0)` → a `PointerEvent` with `clientX=bx, clientY=by` maps directly to board-local `(bx,by)`. `useStore((s)=>s.transform[2])` (`:124`) needs a React Flow context → wrap in `<ReactFlowProvider>` (default transform `[0,0,1]` → zoom `1`). A store-subscribed wrapper re-passes a fresh `board` prop after each commit, mirroring production's `BoardNode` re-render.

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx`
- Modify: `src/main/e2e/probes/whiteboard.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Write the harness + erase/shortcut tests**

Create `src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'
import { PlanningBoard } from '../PlanningBoard'
import { useCanvasStore } from '../../../store/canvasStore'
import type { PlanningBoard as PlanningBoardData, NoteElement } from '../../../lib/boardSchema'

afterEach(cleanup)

// Render the REAL PlanningBoard, subscribed to the store so a commit re-passes a fresh
// `board` prop (mirrors BoardNode in production). ReactFlowProvider supplies the
// transform store PlanningBoard reads for the screen→board zoom (defaults to zoom 1).
function Harness({ id }: { id: string }): ReactElement | null {
  const board = useCanvasStore((s) => s.boards.find((b) => b.id === id))
  if (!board || board.type !== 'planning') return null
  return (
    <ReactFlowProvider>
      <PlanningBoard
        board={board as PlanningBoardData}
        selected
        hovered={false}
        dimmed={false}
      />
    </ReactFlowProvider>
  )
}

/** Seed a planning board with the given elements; returns its id. Resets the store. */
function seedPlanning(elements: NoteElement[]): string {
  useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
  useCanvasStore.getState().updateBoard(id, { elements } as never)
  return id
}

/** Current planning-board elements from the store (the serialized truth). */
function els(id: string): readonly { id: string; kind: string; x: number; y: number }[] {
  const b = useCanvasStore.getState().boards.find((x) => x.id === id)
  return b && b.type === 'planning' ? (b.elements as never) : []
}

function note(id: string, over: Partial<NoteElement>): NoteElement {
  return {
    id,
    kind: 'note',
    x: 40,
    y: 40,
    w: 156,
    h: 96,
    tint: 'yellow',
    text: '',
    rotation: 0,
    ...over
  } as NoteElement
}

const well = (): HTMLElement => document.querySelector('.pl-well') as HTMLElement
function press(k: string): void {
  well().focus()
  well().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
}
/** Tap = pointerdown+pointerup at board-local (bx,by) (== client coords in jsdom). */
function tap(bx: number, by: number): void {
  for (const t of ['pointerdown', 'pointerup']) {
    well().dispatchEvent(
      new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, clientX: bx, clientY: by })
    )
  }
}

describe('PlanningBoard interaction — erase + shortcut (migrated from e2e whiteboard-erase)', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
  })

  it("'e' erases the tapped note; undo restores it in one step", () => {
    const id = seedPlanning([note('n1', { x: 40, y: 40, w: 156, h: 96 })])
    render(<Harness id={id} />)
    expect(els(id).length).toBe(1)

    press('e') // eraser tool (shortcutTool)
    tap(118, 88) // board-local centre of the note → erase swipe removes it on pointer-up
    expect(els(id).length).toBe(0)

    useCanvasStore.getState().undo()
    expect(els(id).length).toBe(1)
  })

  it("'n' selects the note tool → a tap on empty space creates a note", () => {
    const id = seedPlanning([note('n1', { x: 40, y: 40 })])
    render(<Harness id={id} />)

    press('n')
    tap(230, 210) // empty spot → note tool creates a fresh note
    expect(els(id).length).toBe(2)
  })
})
```

- [ ] **Step 2: Run the new test — verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx`
Expected: PASS, 2 tests.

> If the well isn't found: `PlanningBoard` may gate `.pl-well` behind `interactive`/zoom. Confirm the `selected` prop is set and no `lod` prop is passed (LOD card has no well). If `useStore` throws "must be used within ReactFlowProvider", the provider wrapper is missing. If erase/create counts are off, the synthetic coords don't hit the element — confirm jsdom scale is 1 (well rect zeroed) and the note's board-local centre is `(x+w/2, y+h/2)`.

- [ ] **Step 3: Delete the migrated `whiteboardErase` probe**

In `src/main/e2e/probes/whiteboard.ts`, delete the entire `export const whiteboardErase: E2EProbe = { … }` block (lines ~36-104, the comment header `── W1.1 Eraser …` through its closing `}`).

- [ ] **Step 4: Drop it from the e2e registry**

In `src/main/e2e/index.ts`: remove `whiteboardErase` from the `import { … } from './probes/whiteboard'` list, and remove the `whiteboardErase, // W1: …` line from the `PLAYLIST` array.

- [ ] **Step 5: Verify the harness still typechecks (no dangling import)**

Run: `pnpm typecheck`
Expected: clean. (This proves the probe deletion + index edit are consistent.)

Run: `pnpm test`
Expected: PASS, **664 tests** (662 + 2). Record this.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx src/main/e2e/probes/whiteboard.ts src/main/e2e/index.ts
git commit -m "test(planning): migrate whiteboard erase/shortcut e2e probe to jsdom integration (T3)"
```

---

## Task 2: Remaining whiteboard migrations + delete covered/migrated probes

Migrates the 9 remaining whiteboard interaction parts and **deletes** the 5 already-covered paste/export parts, leaving only the 3 slivers in `whiteboard.ts`.

**Translation recipe (probe DOM block → jsdom test):** the probes' inline `evalIn` JS blocks are the source of truth — mirror each one's *interaction sequence* and *assertion*, applying:
1. `at(bx,by)` → in jsdom the well rect is zeroed and scale is 1, so a screen point equals the board-local point → dispatch `PointerEvent` with `clientX=bx, clientY=by` directly.
2. `well.dispatchEvent(new PointerEvent(...))` / `KeyboardEvent` → keep verbatim (use the `well()`, `tap`, `press` helpers from Task 1; add a `drag` helper below).
3. grips: `node.querySelectorAll('.pl-note-grip')[i]` → `document.querySelectorAll('.pl-note-grip')[i]` (single board in the test).
4. assertions read `window.__canvasE2E.getBoards()` → use `els(id)` / a `noteX(id, nid)` reader off `useCanvasStore.getState()`.
5. `await sleep(...)` between synthetic events → drop them; React state updates are synchronous under `@testing-library/react` `act` (wrap multi-event gestures in `act(() => { … })` if a warning appears). Re-seed fresh elements per sub-test exactly as the probe's `fresh()` does (avoids the `undo-lastrecorded-phantom` churn).

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx`
- Modify: `src/main/e2e/probes/whiteboard.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Add a `drag` helper + the selection tests**

Append to `PlanningBoard.interaction.test.tsx`. The `drag` helper mirrors the probe's `drag()` (`whiteboard.ts:157-168`): pointerdown on `downTarget` (grip or well), N moves + up on the well (it owns capture).

```tsx
import { act } from '@testing-library/react'

const grip = (i: number): HTMLElement =>
  document.querySelectorAll('.pl-note-grip')[i] as HTMLElement

function ev(target: EventTarget, type: string, x: number, y: number, mods?: { shift?: boolean; alt?: boolean }): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      clientX: x,
      clientY: y,
      shiftKey: !!mods?.shift,
      altKey: !!mods?.alt
    })
  )
}

/** Drag from (fx,fy) to (tx,ty); down on `downTarget` (default well), moves+up on well. */
function drag(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  opts?: { downTarget?: EventTarget; shift?: boolean; alt?: boolean }
): void {
  const downT = opts?.downTarget ?? well()
  act(() => {
    ev(downT, 'pointerdown', fx, fy, opts)
    for (let i = 1; i <= 4; i++) {
      const t = i / 4
      ev(well(), 'pointermove', fx + (tx - fx) * t, fy + (ty - fy) * t, opts)
    }
    ev(well(), 'pointerup', tx, ty, opts)
  })
}

function noteX(id: string, nid: string): number {
  const n = els(id).find((e) => e.id === nid)
  return n ? n.x : -999999
}

/** The two-note W2 fixture (text so a no-move grip click never prunes an empty note). */
function seedTwo(): string {
  return seedPlanning([
    note('w2-a', { x: 40, y: 40, w: 156, h: 96, text: 'A', tint: 'yellow' }),
    note('w2-b', { x: 260, y: 40, w: 156, h: 96, text: 'B', tint: 'blue' })
  ])
}

describe('PlanningBoard interaction — selection core (migrated from whiteboard-selection)', () => {
  it('marquee selects both → Delete removes both; one undo restores both', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // marquee over w2-a + w2-b
    act(() => press('Delete'))
    expect(els(id).length).toBe(0)
    useCanvasStore.getState().undo()
    expect(els(id).length).toBe(2)
  })

  it('marquee 2 → drag one grip moves both; undo restores both', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // select both
    const ax0 = noteX(id, 'w2-a')
    const bx0 = noteX(id, 'w2-b')
    drag(118, 88, 158, 128, { downTarget: grip(0) }) // drag w2-a's grip +40,+40
    expect(noteX(id, 'w2-a') - ax0).toBeGreaterThanOrEqual(30)
    expect(noteX(id, 'w2-b') - bx0).toBeGreaterThanOrEqual(30)
    useCanvasStore.getState().undo()
    expect(noteX(id, 'w2-a')).toBe(ax0)
    expect(noteX(id, 'w2-b')).toBe(bx0)
  })

  it('click A + Shift-click B selects both; dragging A moves both (additive element select)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    act(() => {
      ev(grip(0), 'pointerdown', 60, 60)
      ev(well(), 'pointerup', 60, 60)
    })
    act(() => {
      ev(grip(1), 'pointerdown', 280, 60, { shift: true })
      ev(well(), 'pointerup', 280, 60, { shift: true })
    })
    const a0 = noteX(id, 'w2-a')
    const b0 = noteX(id, 'w2-b')
    drag(60, 60, 100, 60, { downTarget: grip(0) })
    expect(noteX(id, 'w2-a') - a0).toBeGreaterThanOrEqual(30)
    expect(noteX(id, 'w2-b') - b0).toBeGreaterThanOrEqual(30)
  })

  it("drags B's left edge within tolerance of A's left → committed B.x snaps to 40", () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(338, 88, 122, 88, { downTarget: grip(1) }) // B toward A's left edge (x=40)
    expect(Math.abs(noteX(id, 'w2-b') - 40)).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Add alt-dup + lock tests**

Mirror `whiteboardAltDup` (`whiteboard.ts:433-…`, alt-drag of a single note's grip → count+1, original unmoved, undo removes the copy) and `whiteboardLock` (read the probe for the exact lock fixture + the `.pl-del` selector it asserts absent). Append:

```tsx
describe('PlanningBoard interaction — alt-dup + lock (migrated from W3 probes)', () => {
  it('alt-drag of a note grip duplicates it; original stays; undo removes the copy', () => {
    const id = seedPlanning([note('ad-a', { x: 60, y: 60, w: 156, h: 96, text: 'A' })])
    render(<Harness id={id} />)
    const x0 = noteX(id, 'ad-a')
    drag(138, 108, 198, 168, { downTarget: grip(0), alt: true }) // alt-drag → duplicate
    expect(els(id).length).toBe(2)
    expect(noteX(id, 'ad-a')).toBe(x0) // original unmoved
    useCanvasStore.getState().undo()
    expect(els(id).length).toBe(1)
  })

  it('a locked note resists drag, erase, and inline delete', () => {
    // Mirror whiteboardLock's fixture: a note with locked:true. Read the probe for the
    // exact assertions it makes (x unchanged after drag, count unchanged after erase +
    // after the context-menu Delete, and `.pl-del` absent on a locked note).
    const id = seedPlanning([note('lk', { x: 60, y: 60, w: 156, h: 96, text: 'L' })])
    useCanvasStore.getState().updateBoard(id, {
      elements: [{ ...els(id)[0], locked: true }]
    } as never)
    render(<Harness id={id} />)
    const x0 = noteX(id, 'lk')
    drag(138, 108, 220, 108, { downTarget: grip(0) }) // drag attempt
    expect(noteX(id, 'lk')).toBe(x0) // locked → unmoved
    act(() => {
      press('e')
      tap(138, 108)
    })
    expect(els(id).length).toBe(1) // locked → not erased
    expect(document.querySelector('.pl-del')).toBeNull() // no inline delete affordance
  })
})
```

> Read `whiteboardAltDup` / `whiteboardLock` in `whiteboard.ts` before finalizing — match the exact grip index, board-local coords, and the locked-note selectors the probe used so the migrated assertions are faithful. If `locked` is not a `NoteElement` field, set it via the same shape the probe uses.

- [ ] **Step 3: Add group / align / group-align tests**

These drive the real HTML context menu (transform-free — the probe notes synthetic selection + a real context menu is sufficient). Mirror `whiteboardGroup`, `whiteboardAlign`, `whiteboardGroupAlign` in `whiteboard.ts`: marquee-select, dispatch a `contextmenu` event on the well/grip, then click the menu item (`w3-menu-group` / `w3-menu-align-left`). Append (adjust selectors to the probe's actual `data-*`/text):

```tsx
function openContextMenuAt(x: number, y: number, target: EventTarget = well()): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
    )
  })
}
function clickMenuItem(testid: string): void {
  const item = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement
  if (!item) throw new Error(`menu item ${testid} not found`)
  act(() => item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))
}

describe('PlanningBoard interaction — group / align (migrated from W3 menu probes)', () => {
  it('marquee + context-menu Group assigns both a shared groupId; drag/delete act on the group', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150) // select both
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-group') // ← confirm this testid against whiteboardGroup in the probe
    const e = els(id) as readonly { groupId?: string }[]
    expect(e[0].groupId && e[0].groupId === e[1].groupId).toBeTruthy()
  })

  it('marquee + context-menu Align-left sets both x to the align pad; one undo restores B', () => {
    const id = seedPlanning([
      note('al-a', { x: 12, y: 40, text: 'A' }),
      note('al-b', { x: 300, y: 40, text: 'B' })
    ])
    render(<Harness id={id} />)
    drag(0, 10, 470, 150) // marquee both
    openContextMenuAt(40, 60, grip(0))
    clickMenuItem('w3-menu-align-left') // ← confirm testid against whiteboardAlign
    expect(noteX(id, 'al-a')).toBe(noteX(id, 'al-b')) // both flushed left to the same x
    useCanvasStore.getState().undo()
    expect(noteX(id, 'al-b')).toBe(300)
  })

  it('right-clicking ONE grouped element aligns the WHOLE group (group-align regression)', () => {
    const id = seedTwo()
    render(<Harness id={id} />)
    drag(10, 10, 440, 150)
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-group')
    // clear selection, then right-click only one grouped element → align expands the group
    tap(560, 300)
    openContextMenuAt(120, 80, grip(0))
    clickMenuItem('w3-menu-align-left')
    expect(noteX(id, 'w2-a')).toBe(noteX(id, 'w2-b')) // both moved, not just the clicked one
  })
})
```

> The exact menu-item selector (`data-testid` vs visible text) and the align pad value live in `whiteboardGroup`/`whiteboardAlign`/`whiteboardGroupAlign` and the `ElementContextMenu` component — read them and make the assertions exact before running. If the context menu renders via a portal to `document.body`, the `document.querySelector` lookups already cover it.

- [ ] **Step 4: Run the whole new file**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx`
Expected: PASS, **11 tests** (2 from Task 1 + 9 here). Fix any false-green by confirming the store actually changed (not just component state).

- [ ] **Step 5: Delete the migrated + already-covered whiteboard probes**

In `src/main/e2e/probes/whiteboard.ts`, delete these exports entirely:
- `whiteboardSelection`, `whiteboardAltDup`, `whiteboardLock`, `whiteboardGroup`, `whiteboardAlign`, `whiteboardGroupAlign` (migrated above).
- From `whiteboardPasteImage`: delete the **paste-reload**, **paste-asset-dedup**, **paste-asset-gc** sub-parts (already covered by `projectStore.test.ts` round-trip/dedup/gc tests) **but keep the `whiteboard-paste-image` clipboard part** (sliver — real `sendInputEvent` Ctrl+V). If the parts are interwoven in one probe, keep the probe but trim its emitted parts to just `whiteboard-paste-image`.
- From `whiteboardExport`: delete the **export-image-embed** and **export-missing-asset** sub-parts (covered by `whiteboardExport.test.ts:117-135`) and the **export-svg** part (covered by `whiteboardExport.test.ts`) **but keep the `whiteboard-export-png` part** (sliver — native raster).

**KEEP** `whiteboardFullviewAdd` (sliver — real OS click through the live camera transform). Leave it untouched.

- [ ] **Step 6: Update the e2e registry**

In `src/main/e2e/index.ts`: from the `./probes/whiteboard` import remove `whiteboardSelection, whiteboardAltDup, whiteboardLock, whiteboardGroup, whiteboardAlign, whiteboardGroupAlign`; keep `whiteboardFullviewAdd, whiteboardPasteImage, whiteboardExport`. Remove the matching lines from `PLAYLIST`. Leave `whiteboardFullviewAdd`, `whiteboardPasteImage`, `whiteboardExport` in the PLAYLIST.

- [ ] **Step 7: Verify**

Run: `pnpm typecheck` → clean (no dangling probe imports).
Run: `pnpm test` → PASS, **673 tests** (664 + 9). Record this.
Run: `pnpm lint` → 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/PlanningBoard.interaction.test.tsx src/main/e2e/probes/whiteboard.ts src/main/e2e/index.ts
git commit -m "test(planning): migrate remaining whiteboard interaction probes to jsdom; drop covered paste/export parts (T3)"
```

---

## Task 3: Menu migration + trim probe to slivers

**Disposition:** `boardMenu` portal + dup-through-click are ALREADY-COVERED (`BoardMenu.integration.test.tsx:11-36`). MIGRATE: dup/delete store count, menu-item labels, ⋯ stroke-width/restColor props, viewport-clamp algo, `setMenuOpen` flag. SLIVER-KEEP: `menuChrome` Bug13/14 (real layout rects — jsdom `getBoundingClientRect` is 0) and `menuPreviewDetach` `runtime.live` (native `WebContentsView` IPC).

**Files:**
- Modify: `src/renderer/src/canvas/BoardMenu.integration.test.tsx`
- Modify: `src/main/e2e/probes/menu.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Append the menu tests**

Read `menu.ts` (`boardMenu`, `menuChrome`, `menuPreviewDetach`) for the exact asserted values (menu item label list, the `restColor`/stroke-width values, the clamp formula). Then append to `BoardMenu.integration.test.tsx` (it already imports `render, screen, fireEvent, cleanup` + `BoardMenu` from `./BoardFrame`):

```tsx
describe('BoardMenu — migrated chrome/menu contracts (from e2e menu probes)', () => {
  it('lists exactly Full view / Duplicate / Delete', () => {
    render(<BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />)
    fireEvent.click(screen.getByTitle('More'))
    expect(screen.getByText('Full view')).toBeTruthy()
    expect(screen.getByText('Duplicate')).toBeTruthy()
    expect(screen.getByText('Delete')).toBeTruthy()
  })

  it('fires Duplicate then Delete exactly once each (store round-trip equivalent)', () => {
    const onDuplicate = vi.fn()
    const onDelete = vi.fn()
    render(<BoardMenu onDuplicate={onDuplicate} onDelete={onDelete} onFull={() => {}} />)
    fireEvent.click(screen.getByTitle('More'))
    const dup = screen.getByText('Duplicate')
    fireEvent.pointerDown(dup)
    fireEvent.click(dup)
    fireEvent.click(screen.getByTitle('More'))
    const del = screen.getByText('Delete')
    fireEvent.pointerDown(del)
    fireEvent.click(del)
    expect(onDuplicate).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('renders the More (⋯) icon with the chrome stroke-width', () => {
    render(<BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />)
    const svg = screen.getByTitle('More').querySelector('svg') as SVGElement
    // ← confirm the exact value against menuChrome (the probe asserts stroke-width ≥ 2).
    expect(Number(svg.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(2)
  })
})
```

> If `setMenuOpen`-flag and viewport-clamp are cleanly unit-testable, add them here too: render `BoardMenu`/`BoardFrame`, toggle the menu, assert `usePreviewStore.getState().menuOpen` flips `false→true→false`; and unit-test the clamp formula with mocked trigger/menu rects (the algorithm in `BoardFrame.tsx` viewport-clamp `useLayoutEffect`). If either proves to need real layout (jsdom rects are 0), leave that specific assertion as a SLIVER in `menuChrome` and note it.

- [ ] **Step 2: Run the menu tests**

Run: `pnpm exec vitest run src/renderer/src/canvas/BoardMenu.integration.test.tsx`
Expected: PASS — the existing tests + the new ones (record the added count).

- [ ] **Step 3: Delete `boardMenu`; trim `menuChrome`/`menuPreviewDetach` to slivers**

In `src/main/e2e/probes/menu.ts`:
- Delete the `boardMenu` probe entirely (portal + dup-through-click + dup/delete count — all covered/migrated).
- In `menuChrome`: keep ONLY the Bug13 (⋯ stays within the title-bar right edge at `w:150`) and Bug14 (popover clamps back inside the viewport after `panBy`) real-layout assertions. Delete the menu-item-list / stroke-width / restColor assertions (migrated). **Preserve the `w:150` terminal-narrowing mutation** — `previewConnectGesture` restores it (order-coupling contract).
- In `menuPreviewDetach`: keep ONLY the `runtime.live` true→false→true native-detach lifecycle. Delete the `setMenuOpen` store-flag assertion if migrated.

- [ ] **Step 4: Update the registry**

In `src/main/e2e/index.ts`: remove `boardMenu` from the `./probes/menu` import + PLAYLIST. Keep `menuChrome` and `menuPreviewDetach`.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck` → clean.
Run: `pnpm test` → PASS (record new total = 673 + N menu tests).
Run: `pnpm lint` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/BoardMenu.integration.test.tsx src/main/e2e/probes/menu.ts src/main/e2e/index.ts
git commit -m "test(menu): migrate board-menu contracts to jsdom; trim e2e menu probes to native slivers (T3)"
```

---

## Task 4: Layout + Planning migration (delete two probe files)

**Disposition:** `tile` ALREADY-COVERED (`canvasStore.test.ts:735` + `tileLayout.test.ts`). `tidy` MIGRATE one missing assertion (horizontal-span reduction). `planning` MIGRATE the seed→addChecklist→round-trip pipeline. After migration both `layout.ts` and `planning.ts` are fully redundant → delete.

**Files:**
- Modify: `src/renderer/src/store/canvasStore.test.ts`
- Delete: `src/main/e2e/probes/layout.ts`, `src/main/e2e/probes/planning.ts`
- Modify: `src/main/e2e/index.ts`

- [ ] **Step 1: Add the tidy span-reduction test**

In `src/renderer/src/store/canvasStore.test.ts`, inside the existing `describe('tidyBoards', …)` block (after the test at ~line 729), add:

```ts
  it('packs scattered boards into a tighter horizontal span (smart)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 3000, y: 0 })
    st.addBoard('browser', { x: 6000, y: 0 })
    const span = (): number => {
      const bs = get().boards
      return Math.max(...bs.map((b) => b.x + b.w)) - Math.min(...bs.map((b) => b.x))
    }
    const before = span()
    get().tidyBoards('smart')
    expect(span()).toBeLessThan(before)
  })
```

- [ ] **Step 2: Add the planning addChecklist + round-trip test**

The `planning` probe calls `addChecklist` (which is `updateBoard(id, { elements: [...b.elements, makeChecklist(...)] })`, `e2eHooks.ts:147-153`) then `roundTripOk()` (`fromObject(toObject())` no-throw, `:177-184`). Mirror it. Add a new `describe` near the tidy/tile blocks:

```ts
import { makeChecklist } from '../canvas/boards/planning/elements'
import { fromObject } from '../lib/boardSchema'

describe('planning board — addChecklist + schema round-trip (migrated from e2e planning)', () => {
  it('appends a checklist element and the whole canvas still round-trips', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const id = get().addBoard('planning', { x: 0, y: 0 })
    const b = get().boards.find((x) => x.id === id)!
    if (b.type !== 'planning') throw new Error('expected planning board')
    const cl = makeChecklist(crypto.randomUUID(), crypto.randomUUID(), { x: 60, y: 60 })
    get().updateBoard(id, { elements: [...b.elements, cl] } as never)

    const after = get().boards.find((x) => x.id === id)!
    const kinds = after.type === 'planning' ? after.elements.map((e) => e.kind) : []
    expect(kinds).toContain('checklist')
    expect(() => fromObject(get().toObject())).not.toThrow()
  })
})
```

> Add the two imports at the top of `canvasStore.test.ts` only if not already present. Confirm `get()` is the file's existing store-accessor helper (it is — used throughout the tidy/tile suites).

- [ ] **Step 3: Run the store tests**

Run: `pnpm exec vitest run src/renderer/src/store/canvasStore.test.ts`
Expected: PASS — existing tests + 2 new.

- [ ] **Step 4: Delete the two probe files + deregister**

Delete `src/main/e2e/probes/layout.ts` and `src/main/e2e/probes/planning.ts`.
In `src/main/e2e/index.ts`: remove `import { tidy, tile } from './probes/layout'` and `import { planning } from './probes/planning'`, and remove `tidy`, `tile`, `planning` from `PLAYLIST`.

> **Order-coupling check:** `planning` seeds `ctx.ids.planId`, which the SLIVER whiteboard probes (`whiteboardFullviewAdd`, `whiteboardPasteImage`, `whiteboardExport`) read. Deleting the `planning` probe removes that seed. Before deleting, move the `planId` seed into the kept whiteboard slivers OR add a minimal `seedBoard('planning')` at the top of the first surviving whiteboard sliver so `ctx.ids.planId` is still set. Confirm `ctx.ids.planId` has a producer after the deletion — grep `ctx.ids.planId` across `src/main/e2e/probes/` and ensure something still assigns it.

- [ ] **Step 5: Verify**

Run: `pnpm typecheck` → clean (proves `ctx.ids.planId` + imports are consistent).
Run: `pnpm test` → PASS (record total = Task-3 total + 2).
Run: `pnpm lint` → 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/canvasStore.test.ts src/main/e2e/probes/layout.ts src/main/e2e/probes/planning.ts src/main/e2e/index.ts
git commit -m "test(store): migrate tidy span + planning checklist/round-trip; delete layout+planning e2e probes (T3)"
```

---

## Task 5: PreviewLink migration + harness-trim doc + final gate + push

**Disposition:** `duplicateKeepsLink` ALREADY-COVERED (`canvasStore.test.ts:583-593`). `previewEdgeStale` MIGRATE (the `previewEdges` data flag is covered at `previewEdges.test.ts:27-36`; the missing piece is `PreviewEdge` rendering `strokeDasharray`/reduced opacity when `data.stale`). `previewConnectGesture` SLIVER-KEEP (real IPC + long-press timer + order-coupled width restore).

**Files:**
- Modify (rename to `.tsx`): `src/renderer/src/canvas/edges/PreviewEdge.test.ts` → `PreviewEdge.test.tsx`
- Modify: `src/main/e2e/probes/previewLink.ts`
- Modify: `src/main/e2e/index.ts`
- Modify: `docs/testing/TESTING.md`

- [ ] **Step 1: Add the stale-styling render test**

`PreviewEdge` renders SVG via React Flow's `BaseEdge`. Read `PreviewEdge.tsx:~95-96` (the `stale` style branch) to confirm the exact `strokeDasharray` (`'5 5'`) and opacity values, and what props/context `PreviewEdge` needs to render (it likely needs `<ReactFlowProvider>` and `EdgeProps`). Rename the file to `PreviewEdge.test.tsx` (it now renders → must be jsdom; the `*.test.tsx` glob routes it to jsdom and keeps it in the `unit` project — or name it `PreviewEdge.integration.test.tsx` if it renders a tree and you want it in the integration project; prefer integration since it renders). Append a render test:

```tsx
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { PreviewEdge } from './PreviewEdge'

function renderEdge(stale: boolean): SVGPathElement | null {
  const props = {
    id: 'preview-b1',
    source: 's',
    target: 't',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 0,
    data: { stale }
  } as never
  render(
    <ReactFlowProvider>
      <svg>
        <PreviewEdge {...props} />
      </svg>
    </ReactFlowProvider>
  )
  return document.querySelector('.react-flow__edge-path') as SVGPathElement | null
}

describe('PreviewEdge stale styling (migrated from previewEdgeStale)', () => {
  it('a live edge renders solid (no dash)', () => {
    const path = renderEdge(false)
    const dash = path?.getAttribute('stroke-dasharray')
    expect(dash === null || dash === 'none' || dash === '').toBe(true)
  })

  it('a stale edge renders dashed', () => {
    const path = renderEdge(true)
    expect(path?.getAttribute('stroke-dasharray') ?? '').toContain('5')
  })
})
```

> The exact rendered element/selector and the dash value depend on how `PreviewEdge` wires `BaseEdge` + `style`. Confirm against `PreviewEdge.tsx` before running; if `BaseEdge` doesn't emit `.react-flow__edge-path` in jsdom, assert on the `style` prop via a different query (e.g. the rendered `<path>` `style.strokeDasharray`). If the existing `edgePositions` unit tests in the file don't render, they stay as-is in the renamed file.

- [ ] **Step 2: Run the edge tests**

Run: `pnpm exec vitest run src/renderer/src/canvas/edges/PreviewEdge.test.tsx`
Expected: PASS — the existing `edgePositions` tests + 2 new stale-styling tests.

- [ ] **Step 3: Delete `previewEdgeStale` + `duplicateKeepsLink`; keep `previewConnectGesture`**

In `src/main/e2e/probes/previewLink.ts`, delete the `previewEdgeStale` and `duplicateKeepsLink` exports. Keep `previewConnectGesture` (sliver — and it holds the `w:360` terminal-widen that restores `menuChrome`'s `w:150` narrowing).

In `src/main/e2e/index.ts`: from the `./probes/previewLink` import remove `previewEdgeStale, duplicateKeepsLink`; keep `previewConnectGesture`. Remove the two from PLAYLIST.

- [ ] **Step 4: Update `docs/testing/TESTING.md`**

Append after the "MAIN IPC integration — the harness" section:

```markdown
## E2E push-down (T3) — what migrated, what stayed

T3 moved redundant `CANVAS_SMOKE=e2e` probe coverage down to Vitest and deleted the migrated
probes. The homegrown harness now holds only the irreducible native/real-instance **slivers**
(deferred to the T4 Playwright keep-set):

- **Migrated to Vitest:** whiteboard interactions (erase/shortcut/marquee/multidrag/shift-add/snap/
  alt-dup/lock/group/align/group-align → `PlanningBoard.interaction.test.tsx`); board-menu contracts
  (→ `BoardMenu.integration.test.tsx`); tidy span + planning checklist/round-trip (→
  `canvasStore.test.ts`); preview-edge stale styling (→ `PreviewEdge.test.tsx`). The paste/export
  asset parts were already covered by `projectStore.test.ts` + `whiteboardExport.test.ts`.
- **Kept as slivers (T4):** `whiteboardFullviewAdd`, `whiteboardPasteImage`, `whiteboardExport` (png
  raster), `menuChrome` (real title-bar layout / viewport clamp), `menuPreviewDetach` (native
  `WebContentsView` detach), `previewConnectGesture` (live port-detect IPC + long-press). These need
  real OS input through the live camera transform, a native view, or the renderer's raster pipeline —
  jsdom cannot reproduce them.
```

- [ ] **Step 5: Final gate**

Run: `pnpm test` → PASS. Record the final total (= Task-4 total + 2). Confirm `unit` + `integration` project tags show.
Run: `pnpm typecheck` → clean.
Run: `pnpm lint` → 0 errors (the one `PlanningBoard.tsx` `no-console` warning is fine).
Run: `pnpm format:check` → "All matched files use Prettier code style!" (run `pnpm exec prettier --write` on any new/renamed test file that fails, then re-commit).

- [ ] **Step 6: Best-effort e2e smoke (NOT a gate)**

Run: `pnpm build`
Then: `$env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: the harness loads, runs the shrunk PLAYLIST, prints `E2E_*` lines + `E2E_DONE`, and the final `seed` probe still reports the board count returned to 4. Known env flakes (`e2e-browser-trio-flake`) are acceptable — confirm only that it does not crash on a missing import / undefined `ctx.ids.planId` and the seed-count assertion passes. If it crashes structurally, fix the registry/seed wiring; if it merely flakes on a live-view probe, proceed.

- [ ] **Step 7: Commit + push**

```bash
git add src/renderer/src/canvas/edges/PreviewEdge.test.tsx src/main/e2e/probes/previewLink.ts src/main/e2e/index.ts docs/testing/TESTING.md
git rm src/renderer/src/canvas/edges/PreviewEdge.test.ts 2>$null
git commit -m "test(edges): migrate preview-edge stale styling; trim previewLink e2e to the connect-gesture sliver; document T3 push-down"
git push
```

(Updates PR #37 — the whole testing initiative on the one branch.)

---

## Self-Review

**Spec coverage (§T3 of the design + the 2026-06-03 disposition audit):**
- Migrate `whiteboard` probe coverage to Vitest integration → Tasks 1–2 (`PlanningBoard.interaction.test.tsx`, 11 tests). ✅
- Migrate `menu` → Task 3 (`BoardMenu.integration.test.tsx`). ✅
- Migrate `layout` (`tidy`/`tile`) → Task 4 (`tile` already covered; `tidy` span test added). ✅
- Migrate `planning` → Task 4 (checklist + round-trip store test). ✅
- Migrate `previewLink` → Task 5 (`PreviewEdge` stale styling; `duplicateKeepsLink` already covered). ✅
- Delete migrated probe code → each task deletes its probes; `layout.ts`/`planning.ts` removed entirely. ✅
- Retain irreducible slivers, fold into T4 keep-set → SLIVER-KEEP list preserved verbatim + documented in TESTING.md. ✅
- Harness shrinks to the keep-set; no new dep → no `pnpm add`; only deletions + Vitest tests. ✅
- Single branch / PR #37, one commit per phase → all commits on `testing-strategy`. ✅

**Order-coupling / seed-count safety:** the coupled pair (`menuChrome` w:150 → `previewConnectGesture` w:360) are both SLIVER-KEEP, so the narrow→widen contract and the final `seed` count==4 assertion are preserved; Task 4 Step 4 explicitly re-homes the `ctx.ids.planId` seed that the deleted `planning` probe produced, and every task re-runs `pnpm typecheck` (catches dangling imports) + the best-effort e2e run (Task 5 Step 6) confirms structural integrity.

**Placeholder scan:** the whiteboard lock/group/align tests + the menu/edge tests carry explicit "confirm the exact selector/value against the probe before running" notes — these are *faithful-migration verification steps*, not unfilled placeholders: each test ships with concrete, runnable code and a named source (`whiteboard.ts`/`menu.ts`/`PreviewEdge.tsx`) to reconcile selectors against. The recipe in Task 2 is the mechanical DOM-block→jsdom translation, not a TODO.

**Count arithmetic:** baseline 662 → +2 (Task 1) = 664 → +9 (Task 2) = 673 → +N menu (Task 3) → +2 (Task 4) → +2 (Task 5). The exact menu/edge counts are recorded empirically in each task's verify step (the precise number of new menu assertions depends on which `setMenuOpen`/clamp checks prove jsdom-viable vs sliver). The invariant the executor enforces: the total only ever **grows**; a drop means a lost test → STOP.

**Type consistency:** `Harness`/`seedPlanning`/`els`/`note`/`well`/`press`/`tap`/`drag`/`grip`/`ev`/`noteX`/`seedTwo` names are defined once in Task 1/2 and reused consistently; the store accessor `get()` matches `canvasStore.test.ts`'s existing helper; `makeChecklist`/`fromObject` import paths match `e2eHooks.ts`. The whiteboard tests assert off the store (`useCanvasStore.getState()`), never component state, matching the probes' "selection/tool are ephemeral" rule.
```
