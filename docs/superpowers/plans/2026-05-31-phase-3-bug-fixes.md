# Phase 3 Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 12 user-confirmed bugs on `phase-3-slice-c`, grouped into 4 root themes, each landing as its own commit series (and ideally its own branch/PR).

**Architecture:** The bugs cluster into 4 roots: (A) full view was built only for the Browser board's native-view rect-rebind — Terminal (PTY remount) and Planning (coord space, preview re-attach) were never made full-view-aware; (B) a live Browser `WebContentsView` ghosts on any camera-move/store-mutation because the motion-driven detach is async/deferred while an *ungated* reconcile re-push + `attach()` re-show fight it (Electron #43961); (C) the board ⋯ menu has two independent defects — it's clipped by the frame's `overflow:hidden`, and its items are dead because the outside-close listens on `pointerdown` while items only stop `mousedown`; (D) the preview-link edge is purely derived from durable `previewSourceId` with no liveness signal.

**Tech Stack:** Electron 33 · React 18 · `@xyflow/react` v12 · Zustand · Vitest + jsdom + @testing-library/react · TypeScript strict.

**Verification reality:** Some fixes (native-view ghosts, portal relocation, pointer-capture drags) are not fully reproducible in jsdom. Each task states whether it gets a **unit test** (TDD) or a **manual/runtime verification** with exact repro steps. Where a unit test is feasible, the failing test comes first. Never claim a runtime symptom is fixed without running `pnpm dev` and observing.

**Branch strategy:** Branch off `phase-3-slice-c`. Recommended order — Theme C → Theme A → Theme B → Theme D (C is highest-confidence and self-contained; B shares a root so its tasks land together; A's Task 5 is the riskiest). Run `pnpm test` + `pnpm typecheck` after every task.

---

## Theme C — Board ⋯ menu (bugs 8/9, 11/12)

Highest confidence, self-contained, no native-view complexity. Do first.

### Task 1: Menu items fire (bugs 11 & 12 — Delete/Duplicate dead)

**Root:** `BoardMenu` registers `document.addEventListener('pointerdown', close)` while open, but the menu container/items only `stopPropagation` on `mousedown`. `pointerdown` is a distinct native event → it bubbles to `document` → `close()` → `setOpen(false)` → the item `<button>` unmounts before its `click` fires → the action never runs. (Store actions `duplicateBoard`/`removeBoard` are verified correct — the menu is the only defect.)

**Files:**
- Modify: `src/renderer/src/canvas/BoardFrame.tsx` (`BoardMenu`, ~line 130-141)
- Test: `src/renderer/src/canvas/BoardMenu.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/BoardMenu.test.tsx`. (`BoardMenu` is not exported — export it from `BoardFrame.tsx` in Step 3; write the test importing it now so it fails to compile/import first.)

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BoardMenu } from './BoardFrame'

describe('BoardMenu', () => {
  it('fires Duplicate even though the outside-close listens on pointerdown', () => {
    const onDuplicate = vi.fn()
    render(<BoardMenu onDuplicate={onDuplicate} onDelete={() => {}} onFull={() => {}} />)
    // Open the menu.
    fireEvent.click(screen.getByTitle('More'))
    const dup = screen.getByText('Duplicate')
    // Real interaction order: pointerdown (would close via the document listener)
    // THEN click. With the bug the menu unmounts on pointerdown and the click is lost.
    fireEvent.pointerDown(dup)
    fireEvent.click(dup)
    expect(onDuplicate).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/BoardMenu.test.tsx`
Expected: FAIL — either `BoardMenu` is not exported, or `onDuplicate` called 0 times (item unmounted on pointerdown before click).

- [ ] **Step 3: Implement the minimal fix**

In `BoardFrame.tsx`, export `BoardMenu` (change `function BoardMenu(` → `export function BoardMenu(`) and stop `pointerdown` on the popover container so an inside press never reaches the document close listener. Edit the `.board-menu` container element (currently `onMouseDown`/`onClick` only):

```tsx
        <div
          className="board-menu"
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
```

(The `onPointerDown` guard is the fix; keep the existing `onMouseDown`/`onClick` guards. The document listener now only fires for genuinely-outside presses.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/BoardMenu.test.tsx`
Expected: PASS.

- [ ] **Step 5: Manual sanity** — `pnpm dev`, open a board ⋯ menu, click Duplicate (board clones) and Delete (board removes). Confirm Full view from the menu also works now.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/BoardFrame.tsx src/renderer/src/canvas/BoardMenu.test.tsx
git commit -m "fix(menu): stop pointerdown on board menu so item clicks fire (bugs 11/12)"
```

---

### Task 2: Menu escapes the frame clip (bugs 8/9 — truncated menu)

**Root:** `.board-menu` is an inline descendant of `BoardFrame`'s outer div which has `overflow:hidden` (BoardFrame.tsx:257). The `position:absolute` popover is clipped to the board bounds; items past the bottom edge (Delete) vanish. `z-index` can't escape an `overflow:hidden` ancestor. (The "hidden trigger button" half was a misread of the clipped dropdown — the trigger isn't clipped.)

**Fix approach:** Portal the popover to `document.body`, positioned from the trigger's `getBoundingClientRect()`. Mirrors the existing full-view portal pattern. Keep the outside-pointerdown/Escape close behavior and the Task 1 `stopPropagation` guards.

**Files:**
- Modify: `src/renderer/src/canvas/BoardFrame.tsx` (`BoardMenu`)
- Modify: `src/renderer/src/index.css` (`.board-menu` — drop `position/top/right`, keep visual styling; positioning now inline)

- [ ] **Step 1: Write the failing test** (extends Task 1's file)

```tsx
  it('renders the open menu outside the BoardFrame overflow:hidden frame (portaled to body)', () => {
    const { container } = render(
      <div className="bb-frame" style={{ overflow: 'hidden', position: 'absolute', inset: 0 }}>
        <BoardMenu onDuplicate={() => {}} onDelete={() => {}} onFull={() => {}} />
      </div>
    )
    fireEvent.click(screen.getByTitle('More'))
    const menu = document.querySelector('.board-menu') as HTMLElement
    expect(menu).toBeTruthy()
    // The popover must NOT be a descendant of the clipping frame.
    expect(container.querySelector('.board-menu')).toBeNull()
    expect(document.body.contains(menu)).toBe(true)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/BoardMenu.test.tsx`
Expected: FAIL — the menu is currently inside `container` (not portaled).

- [ ] **Step 3: Implement — portal the popover with computed coords**

Replace `BoardMenu`'s body. Capture the trigger element, compute popover coords on open, and `createPortal` to `document.body`:

```tsx
import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
// ...
export function BoardMenu({ onFull, onDuplicate, onDelete }: {
  onFull?: (e: MouseEvent) => void
  onDuplicate?: () => void
  onDelete?: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 0, right: 0 })
  const triggerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    // Reposition on scroll/resize while open (the canvas can pan under it).
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [open])

  const openMenu = (e: MouseEvent): void => {
    e.stopPropagation()
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    setOpen((v) => !v)
  }

  const item = (label: string, danger: boolean, fn?: (e: MouseEvent) => void): ReactElement => (
    <button
      className="board-menu-item"
      data-danger={danger || undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        setOpen(false)
        fn?.(e)
      }}
    >
      {label}
    </button>
  )

  return (
    <div ref={triggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <IconBtn name="more" title="More" active={open} onClick={openMenu} />
      {open &&
        createPortal(
          <div
            className="board-menu"
            role="menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {onFull && item('Full view', false, onFull)}
            {onDuplicate && item('Duplicate', false, () => onDuplicate())}
            {onDelete && item('Delete', true, () => onDelete())}
          </div>,
          document.body
        )}
    </div>
  )
}
```

- [ ] **Step 4: Update CSS** — in `src/renderer/src/index.css`, change `.board-menu` to drop the now-inline positioning (the rule still owns the visual style):

```css
.board-menu {
  min-width: 132px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  box-shadow: var(--shadow-pop);
  padding: 4px;
  display: flex;
  flex-direction: column;
  z-index: 250; /* above the fullview-scrim (200) so the menu works in full view too */
}
```

(Remove the old `position: absolute; top: calc(100% + 4px); right: 0;` lines — `position:fixed` + `top`/`right` are now set inline.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/canvas/BoardMenu.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 6: Manual sanity** — `pnpm dev`, open a board's ⋯ menu near the bottom edge of the board and near the viewport edge; all three items (Full view / Duplicate / Delete) are fully visible and clickable.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/BoardFrame.tsx src/renderer/src/index.css src/renderer/src/canvas/BoardMenu.test.tsx
git commit -m "fix(menu): portal board menu to body so it isn't clipped by the frame (bugs 8/9)"
```

---

## Theme A — Full view not terminal/planning-aware (bugs 1, 4, 5, 6)

### Task 3: Checklist is draggable (bug 5)

**Root:** `ChecklistCard` header gates `onDragStart` behind `e.target === e.currentTarget` (ChecklistCard.tsx:170). The title `<input flex:1>` fills the header, so the bare-header target practically never occurs → no grab area. NoteCard/FreeText use a dedicated grip with no such guard. (`.pl-check-head:active{cursor:grabbing}` in index.css:561 proves the header was the intended grip.) The title input already `stopPropagation`s its own press in select mode, so dropping the guard is safe — pressing the input won't start a drag.

**Files:**
- Modify: `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx` (~line 169-174)
- Test: `src/renderer/src/canvas/boards/planning/ChecklistCard.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ChecklistCard } from './ChecklistCard'

const el = {
  id: 'c1', kind: 'checklist' as const, x: 10, y: 10, w: 220,
  title: 'List', items: [{ id: 'i1', label: 'a', done: false }]
}

it('starts a drag when the header (e.g. the count badge) is pressed', () => {
  const onDragStart = vi.fn()
  render(
    <ChecklistCard
      element={el} interactive onDragStart={onDragStart}
      onToggle={() => {}} onChangeTitle={() => {}} onChangeItem={() => {}}
      onAddItem={() => {}} onRemoveItem={() => {}} onDelete={() => {}}
    />
  )
  // The done/total count span is part of the header but is NOT currentTarget —
  // the old `e.target === e.currentTarget` guard wrongly excluded it.
  fireEvent.pointerDown(screen.getByText('0/1'))
  expect(onDragStart).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/ChecklistCard.test.tsx`
Expected: FAIL — `onDragStart` called 0 times (guard excludes the span target).

- [ ] **Step 3: Implement — drop the `currentTarget` guard**

In `ChecklistCard.tsx`, change the header's `onPointerDown` (the `.pl-check-head` div):

```tsx
        onPointerDown={(e) => {
          if (!interactive) return
          e.stopPropagation()
          onDragStart(e, element.id)
        }}
```

(The title `<input>` keeps its own `onPointerDown` `stopPropagation` in select mode, so pressing the input still edits instead of dragging; the count span and bare header now grab.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/planning/ChecklistCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Manual sanity** — `pnpm dev`, add a Checklist to a Planning board, drag it by the title bar/badge; it moves. Editing the title input still works (no drag).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/planning/ChecklistCard.tsx src/renderer/src/canvas/boards/planning/ChecklistCard.test.tsx
git commit -m "fix(planning): make the checklist card draggable from its header (bug 5)"
```

---

### Task 4: Planning coords correct in full view (bug 6)

**Root:** `PlanningBoard.toBoard` maps screen→board-local using the camera zoom `useStore(s => s.transform[2])` (PlanningBoard.tsx:88,120). In full view the well is portaled into the untransformed modal (no `scale()`), so the real screen↔board scale is the well's measured ratio, not camera zoom — a note dropped center-modal gets a board-local x far outside the board, clipped by the well's `overflow:hidden` in normal mode. Fix: derive the scale by measuring the well — `getBoundingClientRect().width / offsetWidth` — which equals camera zoom on-canvas and `1` in the modal, correct in both.

**Files:**
- Modify: `src/renderer/src/lib/pen.ts` (add a pure `screenScale` helper)
- Modify: `src/renderer/src/canvas/boards/planning/PlanningBoard.tsx` (`toBoard`, ~line 120-129; remove the camera-zoom read)
- Test: `src/renderer/src/lib/pen.test.ts` (extend)

- [ ] **Step 1: Write the failing test** (append to `pen.test.ts`)

```ts
import { screenScale } from './pen'

describe('screenScale', () => {
  it('returns the rendered/layout ratio (= camera zoom on-canvas, 1 in the modal)', () => {
    expect(screenScale(180, 360)).toBe(0.5) // scaled to half → zoom 0.5
    expect(screenScale(360, 360)).toBe(1)   // untransformed modal
  })
  it('falls back to the provided zoom when not laid out (offsetWidth 0)', () => {
    expect(screenScale(0, 0, 0.8)).toBe(0.8)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/pen.test.ts`
Expected: FAIL — `screenScale` is not exported.

- [ ] **Step 3: Implement the helper** in `src/renderer/src/lib/pen.ts`

```ts
/**
 * Screen↔board scale measured from the well itself: rendered width (getBoundingClientRect,
 * which includes any CSS transform) ÷ layout width (offsetWidth, pre-transform). On the
 * camera-transformed canvas this equals the camera zoom; inside the untransformed full-view
 * modal it is ~1 — so board-local mapping is correct in both modes without a fullView flag.
 * Falls back to `fallbackZoom` when the well isn't laid out yet (offsetWidth 0).
 */
export function screenScale(renderedWidth: number, layoutWidth: number, fallbackZoom = 1): number {
  if (layoutWidth > 0 && renderedWidth > 0) return renderedWidth / layoutWidth
  return fallbackZoom
}
```

- [ ] **Step 4: Wire it into `PlanningBoard.toBoard`**

In `PlanningBoard.tsx`, keep the `zoom` subscription only as a fallback, and measure the well:

```tsx
import { screenToBoard, pushBoardPoint, screenScale } from '../../lib/pen'
// ...
  const toBoard = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const wellEl = wellRef.current
      const r = wellEl?.getBoundingClientRect()
      const scale = screenScale(r?.width ?? 0, wellEl?.offsetWidth ?? 0, zoom)
      return screenToBoard(
        { x: e.clientX, y: e.clientY },
        { originX: r?.left ?? 0, originY: r?.top ?? 0, zoom: scale }
      )
    },
    [zoom]
  )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/lib/pen.test.ts`
Expected: PASS.

- [ ] **Step 6: Manual sanity** — `pnpm dev`, open a Planning board in full view at a camera zoom ≠ 100%, drop a note + checkbox, drag an element; toggle back to normal — the elements sit where placed, visible (not clipped). Repeat at 100% zoom (was the only working case before) to confirm no regression.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/lib/pen.ts src/renderer/src/lib/pen.test.ts src/renderer/src/canvas/boards/planning/PlanningBoard.tsx
git commit -m "fix(planning): measure well scale so element placement is correct in full view (bug 6)"
```

---

### Task 5: Full view relocates the terminal without remounting (bug 1) — HIGHEST RISK

**Root:** `BoardNode` renders `fullView && fullViewHost ? createPortal(subtree, fullViewHost) : subtree` (BoardNode.tsx:193). Toggling full view flips that slot between a plain element and a portal — different fiber tags at the same position → React unmounts + remounts the subtree → `TerminalBoard`'s spawn-effect cleanup runs `killTerminal` and the fresh mount `spawnTerminal`s. Changing a portal's *container* also remounts. The only remount-free relocation is a **stable portal container** (one element, created once) that is *always* the portal target and is *moved in the DOM* between the in-node anchor and the modal host.

**Files:**
- Modify: `src/renderer/src/canvas/BoardNode.tsx` (the full-chrome return, ~line 151-195)
- Test: manual + runtime (jsdom can't run the PTY bridge / ResizeObserver layout reliably)

- [ ] **Step 1: Implement the stable-container relocation**

In `BoardNode.tsx`, add `useLayoutEffect` to the imports. Keep the LOD early-return for non-terminal non-fullview boards exactly as-is (it intentionally unmounts heavy content at LOD). Replace the full-chrome return:

```tsx
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
// ...
  // Stable per-board content host: created ONCE and always the createPortal target, so
  // toggling full view never changes the fiber structure (which would remount the subtree
  // and kill a live PTY — bug 1). We RELOCATE this element in the DOM between the in-node
  // anchor and the modal host; React keeps rendering into the same node, so no remount.
  const contentHostRef = useRef<HTMLDivElement | null>(null)
  if (!contentHostRef.current) {
    const d = document.createElement('div')
    d.style.position = 'absolute'
    d.style.inset = '0'
    contentHostRef.current = d
  }
  const anchorRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const host = contentHostRef.current
    if (!host) return
    const target = fullView && fullViewHost ? fullViewHost : anchorRef.current
    if (target && host.parentNode !== target) target.appendChild(host)
  }, [fullView, fullViewHost])

  const common = { selected, hovered, dimmed }
  const subtree = (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'absolute', inset: 0 }}
    >
      {board.type === 'terminal' && <TerminalBoard board={board} lod={lod} {...common} {...actions} />}
      {board.type === 'browser' && <BrowserBoard board={board} {...common} {...actions} fullView={fullView} />}
      {board.type === 'planning' && <PlanningBoard board={board} {...common} {...actions} />}
    </div>
  )

  return (
    <>
      <EdgeAnchors />
      {!lod && (
        <NodeResizer
          minWidth={MIN_BOARD_SIZE.w}
          minHeight={MIN_BOARD_SIZE.h}
          isVisible={selected || hovered}
          onResizeStart={() => useCanvasStore.getState().beginChange()}
          onResize={() => usePreviewStore.getState().setNodeGesture(true)}
          onResizeEnd={() => usePreviewStore.getState().setNodeGesture(false)}
        />
      )}
      {/* In-node mount point; the stable content host is appended here when not full-view. */}
      <div ref={anchorRef} style={{ position: 'absolute', inset: 0 }} />
      {createPortal(subtree, contentHostRef.current)}
    </>
  )
```

(Delete the old `{fullView && fullViewHost ? createPortal(subtree, fullViewHost) : subtree}` line and the inline `subtree` const that fed it.)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no unused `fullViewHost`/`createPortal`; both are now used).

- [ ] **Step 3: Run the full suite — guard against regressions**

Run: `pnpm test`
Expected: PASS (296+). If a BoardNode/full-view test exists it must still pass.

- [ ] **Step 4: Manual verification — the core gate (bug 1)**

`pnpm build` then `$env:CANVAS_SMOKE='e2e'; pnpm start` to confirm boards still seed; then `pnpm dev`:
1. Create a Terminal board, let the shell spawn, type something so scrollback is visible.
2. Open Full view (⤢). **Expected:** the SAME terminal appears in the modal — no flash, scrollback intact, no `[process exited]`, no fresh PowerShell banner. (Before the fix it killed + respawned.)
3. Exit full view (⤢/Esc). Terminal still the same live session.
4. Repeat for a Browser board (must still rect-rebind its native view full-bleed) and a Planning board (elements intact).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/BoardNode.tsx
git commit -m "fix(fullview): relocate board subtree via a stable portal host so the PTY survives (bug 1)"
```

---

### Task 6: Full view stops re-attaching other Browser views (bug 4)

**Root:** In full view `applyLiveness` `closeBoard`s every non-full-view Browser (BrowserPreviewLayer.tsx:484-496). But a note drag (or any store mutation) fires the store subscription → `reconcile()` runs unconditionally; for the now-closed Browser it takes the new-board branch (`:629-632`) gated only on `liveEligible && !occludesProtected` — **neither consults `fullViewIdRef`** — so it `attachBoard`s the Browser at its canvas rect, painting over the modal scrim. Fix: when a board is in full view, reconcile must not bring any non-full-view Browser live, and a store mutation should re-run the full-view-aware `applyLiveness`.

**Files:**
- Modify: `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` (`reconcile` new-board branch ~line 629; the store subscription ~line 712-720)
- Test: manual/runtime (the layer is a monolithic native-view driver; assert by repro)

- [ ] **Step 1: Guard reconcile's new-board attach against full view**

In `reconcile`, the new-board branch (`if (!r.exists && !r.attached) {`): only attach when NOT in full view, or when this IS the full-view board:

```tsx
        if (!r.exists && !r.attached) {
          const fvId = fullViewIdRef.current
          const blockedByFullView = fvId !== null && fvId !== g.id
          if (!blockedByFullView && liveEligible(g) && !occludesProtected(g)) void attachBoard(g)
          else if ((usePreviewStore.getState().byId[g.id]?.status ?? 'idle') === 'idle')
            patchRuntime(g.id, { status: 'connecting' })
        } else if (r.exists) {
```

- [ ] **Step 2: Re-run full-view-aware liveness on any mutation while full view is active**

In the store subscription (the `useCanvasStore.subscribe((s) => {...})` block ~line 712-720), also reconcile liveness when a board is in full view (covers note drags and every other mutation, not just selection changes):

```tsx
    const unsub = useCanvasStore.subscribe((s) => {
      const selChanged = syncSelection(s)
      reconcile(toGeom(s.boards))
      if ((selChanged || fullViewIdRef.current !== null) && !gestureRef.current) applyLiveness()
    })
```

- [ ] **Step 3: Typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Manual verification (bug 4)**

`pnpm dev`: have a live Browser board on-canvas; open a *different* Planning board in full view; drag a note inside it. **Expected:** no Browser page appears over the modal scrim. Exit full view → the Browser re-attaches normally on-canvas.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx
git commit -m "fix(preview): keep non-fullview browser views closed during full view (bug 4)"
```

---

## Theme B — Live Browser native view ghosts on camera-move/mutation (bugs 2, 7, 10)

Shared deeper root: the motion-driven detach is async/deferred, while an **ungated** `reconcile` bounds re-push (`:651-657`) + `attach()` `setVisible(true)` re-show the view the motion is trying to remove; per-frame `flushBatch` setBounds-then-detach then hits Electron #43961. These are runtime-confirmed by repro, not jsdom.

### Task 7: Gate the reconcile re-push on the gesture (bug 10, and hardens 2/7)

**Root (bug 10):** detach at drag-start is a deferred React effect, but `reconcile`'s `r.attached` branch re-pushes bounds via `attachPreview` on **every** drag tick with no `gestureRef` guard (BrowserPreviewLayer.tsx:651-657), re-showing the view mid-drag. `selectNodesOnDrag` (RF v12 default true) adds a synchronous select→`applyLiveness` on the click-then-drag case, tightening the attach/detach toggle into the #43961 window.

**Files:**
- Modify: `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` (`reconcile` r.attached branch ~line 651; `onNodeDragStart` path)
- Modify: `src/renderer/src/canvas/Canvas.tsx` (detach synchronously at drag start)
- Test: manual/runtime

- [ ] **Step 1: Skip the reconcile bounds re-push while a gesture is active**

In `reconcile`, the `if (r.attached) {` bounds re-push branch — bail when a node/camera gesture is in flight (the motion paths own bounds during a gesture):

```tsx
          if (r.attached && !gestureRef.current) {
            const bounds = boundsFor(g)
            const zoomFactor = zoomFor(g)
            if (r.lastSent && rectsEqual(r.lastSent, bounds) && r.lastZoom === zoomFactor) continue
            r.lastSent = bounds
            r.lastZoom = zoomFactor
            void window.api.attachPreview({ id: g.id, bounds, zoomFactor })
          }
```

- [ ] **Step 2: Detach synchronously at node-drag start**

The async `capturePage`-then-detach in `beginMotion` leaves the view attached for the capture round-trip. For a node drag we want it gone *before* React Flow moves the node. Add a synchronous detach of all live views in `Canvas.onNodeDragStart` (the snapshot is captured by `beginMotion`; this just removes the native layer immediately):

In `Canvas.tsx`, extend `onNodeDragStart`:

```tsx
  const onNodeDragStart = useCallback(() => {
    beginChange()
    setNodeGesture(true)
    // Pull every live native view out IMMEDIATELY (before RF starts moving the node) so a
    // dragged board can't be occluded by — or strand — an always-above native layer (#43961).
    // beginMotion still captures the snapshot; this is the synchronous safety detach.
    void window.api.detachAllPreviews?.()
  }, [beginChange, setNodeGesture])
```

Add the `detachAllPreviews` bridge: in `src/main/preview.ts` add a handler and in the preload expose it.

```ts
// preview.ts — inside registerPreviewHandlers
  ipcMain.handle('preview:detachAll', (ev) => {
    if (isForeignSender(ev, getWin)) return true
    for (const e of views.values()) detach(e)
    return true
  })
```

Preload (`src/preload/index.ts`): add `detachAllPreviews: () => ipcRenderer.invoke('preview:detachAll')` to the `api` object and its type in `src/preload/index.d.ts`. The renderer rec/`attached` flags are reconciled by the following `endMotion`/`applyLiveness`; mark them detached optimistically isn't required because `endMotion` re-derives liveness — but to keep `recs` honest, also clear `r.attached` for all in a tiny renderer helper is optional. Keep minimal: rely on `endMotion`→`applyLiveness` to reattach the eligible ones at rest.

> NOTE: if `endMotion`/`applyLiveness` double-counts because `recs` still says `attached`, prefer instead to drive the synchronous detach through the existing `beginMotion` by making its capture optional. Implementer's choice — verify the live-count in the DiagOverlay returns to the correct number after a drag.

- [ ] **Step 3: Typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 4: Manual verification (bug 10)**

`pnpm dev`: click empty canvas (deselect), then immediately drag a Browser board by its title bar. **Expected:** no stranded copy of the page at the old position; the snapshot follows the board; on drop the live view reattaches once. Check the DiagOverlay live-view count returns to its prior value (no leak).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx src/renderer/src/canvas/Canvas.tsx src/main/preview.ts src/preload/index.ts src/preload/index.d.ts
git commit -m "fix(preview): gate reconcile re-push + sync-detach on drag start to kill browser ghost (bug 10)"
```

---

### Task 8: Wheel over the terminal config doesn't pan (bug 7, part 1)

**Root:** `panOnScroll` is on; the `TerminalConfig` popover lacks React Flow's `nowheel` class, so a wheel over it reaches `panOnScroll` and pans the canvas, moving live Browser views (→ ghost). The xterm well has `nowheel` but the config popover (in the `shell` container) does not.

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalConfig.tsx` (the root `pop` div)

- [ ] **Step 1: Add `nowheel` (+ stop wheel) to the config popover**

In `TerminalConfig.tsx`, on the root popover `<div style={pop} …>` add the React Flow opt-out class and stop the wheel so neither the canvas pans nor it bubbles:

```tsx
    <div
      style={pop}
      className="nowheel"
      tabIndex={-1}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Manual verification (bug 7, entry condition)**

`pnpm dev`: live Browser board present; open a Terminal's Configure popover; scroll the wheel over the popover. **Expected:** the canvas does NOT pan (so no ghost is triggered from the config). Combined with Task 9's general hardening, the pan-ghost is closed.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalConfig.tsx
git commit -m "fix(terminal): nowheel on the config popover so scrolling it doesn't pan (bug 7)"
```

---

### Task 9: Detach live views before/without trailing them during camera moves (bugs 2 & 7, part 2)

**Root:** During an animated `fitView` (focus, bug 2) or a wheel `panOnScroll` (bug 7), `startPump`'s `flushBatch` pushes `setBounds` to the still-attached live view **every frame** until the async `demoteToSnapshot`/`beginMotion` detach lands — the per-frame-setBounds-then-detach is the #43961 trigger. Fix: stop `flushBatch` from repositioning a board that is about to be (or is being) demoted, so the view is detached promptly rather than trailed.

**Files:**
- Modify: `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` (`beginMotion` — detach synchronously via the new bridge before the capture; or exclude in-gesture boards from `flushBatch`)
- Test: manual/runtime

- [ ] **Step 1: Capture first, then detach within the same gesture tick (surgical — keep the existing guards)**

Do NOT rewrite `beginMotion`. The current order is correct for snapshot freshness (capture while attached → then `detachPreview` per board, with the `attachSeq`/#15/#48 guards that must stay). The ghost comes from the *camera* path's per-frame `flushBatch` repositioning the still-attached view during the ~tens-of-ms capture window. So the surgical fix is in `flushBatch`: skip any board that `beginMotion` is currently demoting, so the pump stops issuing `setBounds` on a view about to be detached.

Add a demoting set ref near the other refs:

```tsx
  const demoting = useRef<Set<string>>(new Set())
```

In `beginMotion`, mark boards demoting before the capture await and unmark after the detach completes — without touching the existing `attachSeq`/rec guards:

```tsx
    gestureRef.current = true
    live.forEach((g) => demoting.current.add(g.id)) // pump skips these until detached
    void (async () => {
      // ... existing capture + detach body unchanged ...
      // at the very end of the async IIFE, after the detach state-writes:
      live.forEach((g) => demoting.current.delete(g.id))
    })()
```

In `flushBatch`, skip a demoting board so it is never repositioned during the capture window:

```tsx
    for (const g of geomRef.current.values()) {
      const r = recs.current.get(g.id)
      if (!r || !r.attached) continue
      if (demoting.current.has(g.id)) continue // about to detach — don't trail it (#43961)
      // ... rest unchanged ...
```

> Rationale: this removes the per-frame-setBounds-then-detach pattern (the #43961 trigger) without losing any of the existing concurrency guards or snapshot freshness. The synchronous `detachAllPreviews` from Task 7 still covers the node-drag start; this covers the camera (focus/pan) start.

- [ ] **Step 2: Typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. Adjust `preview.test.ts` only if a detach-order assertion exists.

- [ ] **Step 3: Manual verification (bugs 2 & 7)**

`pnpm dev`, live Browser board present:
- Double-click a Terminal (focus animation) — no stranded browser frame after the camera settles (bug 2).
- Wheel-pan the canvas — no stranded/trailing browser frame during or after the pan (bug 7).
- Confirm normal node-drag (the previously-working path) still has no ghost (no regression).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx
git commit -m "fix(preview): detach live views up-front on motion start to kill camera-move ghost (bugs 2/7)"
```

---

## Theme D — Preview-link semantics (bug 3)

### Task 10: Render the preview edge as stale when the source terminal isn't running (bug 3)

**Decision (from user):** keep the link, but render the edge dimmed/dashed when the source terminal is not running. Needs a terminal-running signal feeding the edge.

**Files:**
- Create: `src/renderer/src/store/terminalRuntimeStore.ts` (ephemeral running-by-id, like `previewStore`)
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx` (publish running state)
- Modify: `src/renderer/src/lib/previewEdges.ts` (mark `stale` from a running-id set) + `previewEdges.test.ts`
- Modify: `src/renderer/src/canvas/Canvas.tsx` (pass running set; thread `stale` to edge data)
- Modify: `src/renderer/src/canvas/edges/PreviewEdge.tsx` (dashed/dimmed when `stale`)

- [ ] **Step 1: Write the failing test** (extend `previewEdges.test.ts`)

```ts
it('marks an edge stale when its source terminal is not running', () => {
  const boards = [
    { id: 't1', type: 'terminal' },
    { id: 'b1', type: 'browser', previewSourceId: 't1' }
  ] as never
  const live = previewEdges(boards, new Set(['t1']))
  expect(live[0].data?.stale).toBe(false)
  const down = previewEdges(boards, new Set())
  expect(down[0].data?.stale).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/previewEdges.test.ts`
Expected: FAIL — `previewEdges` takes one arg and has no `data.stale`.

- [ ] **Step 3: Implement — `previewEdges(boards, runningIds?)`**

In `previewEdges.ts`:

```ts
export interface PreviewEdgeDesc {
  id: string
  source: string
  target: string
  type: 'preview'
  data: { stale: boolean }
}

export function previewEdges(boards: Board[], runningIds: Set<string> = new Set()): PreviewEdgeDesc[] {
  const ids = new Set(boards.map((b) => b.id))
  const edges: PreviewEdgeDesc[] = []
  for (const b of boards) {
    if (b.type !== 'browser') continue
    const src = b.previewSourceId
    if (src && ids.has(src)) {
      edges.push({ id: `preview-${b.id}`, source: src, target: b.id, type: 'preview', data: { stale: !runningIds.has(src) } })
    }
  }
  return edges
}
```

- [ ] **Step 4: Terminal runtime store + publish**

Create `src/renderer/src/store/terminalRuntimeStore.ts`:

```ts
import { create } from 'zustand'
import type { TerminalState } from '../canvas/boards/terminalState'
import { isRunning } from '../canvas/boards/terminalState'

interface TerminalRuntimeState {
  running: Record<string, boolean>
  setRunning: (id: string, state: TerminalState) => void
  clear: (id: string) => void
}

export const useTerminalRuntimeStore = create<TerminalRuntimeState>((set) => ({
  running: {},
  setRunning: (id, state) =>
    set((s) => {
      const next = isRunning(state)
      return s.running[id] === next ? s : { running: { ...s.running, [id]: next } }
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.running)) return s
      const r = { ...s.running }
      delete r[id]
      return { running: r }
    })
}))

export const selectRunningIds = (s: TerminalRuntimeState): Set<string> =>
  new Set(Object.keys(s.running).filter((id) => s.running[id]))
```

In `TerminalBoard.tsx`, publish on every `state` change and clear on unmount:

```tsx
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'
// ...inside the component, after `const [state, setState] = useState(...)`:
  useEffect(() => {
    useTerminalRuntimeStore.getState().setRunning(board.id, state)
  }, [board.id, state])
  useEffect(() => () => useTerminalRuntimeStore.getState().clear(board.id), [board.id])
```

- [ ] **Step 5: Thread into Canvas + edge**

In `Canvas.tsx`, subscribe to the running set and pass it to `previewEdges`, forwarding `data` to React Flow edges:

```tsx
import { useTerminalRuntimeStore, selectRunningIds } from '../store/terminalRuntimeStore'
// ...
  const runningIds = useTerminalRuntimeStore(selectRunningIds)
  const edges = useMemo(
    () =>
      previewEdges(boards, runningIds).map((e) => ({
        ...e,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#4f8cff', width: 16, height: 16 }
      })),
    [boards, runningIds]
  )
```

In `PreviewEdge.tsx`, read `data.stale` and render dashed + dimmed (e.g. `strokeDasharray: '5 5'`, `opacity: 0.4`, and a muted marker). Use the existing edge path; only the stroke style is conditional:

```tsx
  const stale = (data as { stale?: boolean } | undefined)?.stale ?? false
  // ...on the path style:
  style={{ stroke: '#4f8cff', strokeWidth: 1.5, opacity: stale ? 0.4 : 1, strokeDasharray: stale ? '5 5' : undefined }}
```

(Match the exact prop names `PreviewEdge` already uses; only add the `stale` branch.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/lib/previewEdges.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Manual verification (bug 3)**

`pnpm dev`: link a Browser to a Terminal via Preview; while the terminal runs, the arrow is solid. Restart the terminal / reopen the project (terminal idle) → the arrow renders dashed + dimmed. Re-run the dev server → solid again.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/store/terminalRuntimeStore.ts src/renderer/src/canvas/boards/TerminalBoard.tsx src/renderer/src/lib/previewEdges.ts src/renderer/src/lib/previewEdges.test.ts src/renderer/src/canvas/Canvas.tsx src/renderer/src/canvas/edges/PreviewEdge.tsx
git commit -m "feat(preview): render the preview link stale when the source terminal is down (bug 3)"
```

---

## Final verification

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm test` — all green (new tests: BoardMenu ×2, ChecklistCard, screenScale ×2, previewEdges stale).
- [ ] `pnpm build` then `$env:CANVAS_SMOKE='e2e'; pnpm start` — `E2E_DONE`, exit 0.
- [ ] Manual pass through every bug's repro (bugs 1, 2, 4, 7, 10 are the runtime-gated ones — observe in `pnpm dev`, don't infer).
- [ ] Update `CLAUDE.md` Status + `docs/handoffs` with the fixed bugs and the two new patterns: stable-portal-host relocation, gesture-gated native-view detach.

## Notes on test coverage gaps (be honest in the PR)

- Bugs **1, 2, 4, 7, 10** have no automated regression test — they depend on Electron native-view compositing / React-Flow camera animation / pointer-capture that jsdom can't exercise. They are verified manually. Consider a follow-up Playwright `_electron` e2e (already a deferred Phase-2 item) that drives full view + a camera move with a live Browser board and asserts via the MAIN-side `debugCaptureView`/live-count that no extra native view remains — that is the real automated guard and is out of scope here.
