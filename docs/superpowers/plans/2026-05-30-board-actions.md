# Phase 3 Slice B — Board Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Full view (fullscreen modal, live, no camera move) + Duplicate (clone offset 36px) + the ⋯ overflow menu (Full view · Duplicate · Delete) to all three board types.

**Architecture:** Duplicate = a pure store action + viewport-cycle helper. Full view = ephemeral Canvas-local `fullViewId` + an HTML modal + a single `createPortal` swap in `BoardNode` (relocates the live board subtree — no remount, so the PTY/xterm/native view survive). Browser boards get their native `WebContentsView` re-bounded to the portaled device-frame's live DOM rect while in full view; all other native views detach. Board action handlers reach the per-type board files via a `BoardActionsContext`; the ⋯ menu lives once in the shared `BoardFrame`.

**Tech Stack:** React 18 (`createPortal`, context), `@xyflow/react` v12, Zustand, Vitest. Spec: `docs/superpowers/specs/2026-05-30-board-actions-design.md`. Branch `phase-3-board-actions` (already created off `phase-3-persistence`).

**Conventions:** TS strict, no unused locals/params. `pnpm test` (Vitest), `pnpm typecheck`, `pnpm lint`, `pnpm format` before commits. Match the design tokens already in `index.css`. Commit per task.

**Cross-task contract (referenced by later tasks):**
```ts
// store/canvasStore.ts
duplicateBoard: (id: string) => string | null   // returns new board id, or null if id missing

// lib/viewportCycle.ts
export function nextViewport(v: BrowserViewport): BrowserViewport

// canvas/boardActions.ts (new)
export interface BoardActions {
  requestFullView: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
}
export const BoardActionsContext: React.Context<BoardActions | null>

// canvas/fullViewContext.ts (new)
export const FullViewContext: React.Context<HTMLElement | null>  // the modal portal host, or null

// BoardViewProps (canvas/BoardNode.tsx) gains:
onFull?: () => void
onDuplicate?: () => void
onDelete?: () => void

// BoardFrame props: REPLACE `onMore?` WITH:
onFull?: (e: MouseEvent) => void       // kept
onDuplicate?: () => void               // new
onDelete?: () => void                  // new
```

---

### Task 1: `lib/viewportCycle.ts` — next-preset helper

**Files:**
- Create: `src/renderer/src/lib/viewportCycle.ts`
- Test: `src/renderer/src/lib/viewportCycle.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/renderer/src/lib/viewportCycle.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { nextViewport } from './viewportCycle'

describe('nextViewport', () => {
  it('cycles mobile → tablet → desktop → mobile', () => {
    expect(nextViewport('mobile')).toBe('tablet')
    expect(nextViewport('tablet')).toBe('desktop')
    expect(nextViewport('desktop')).toBe('mobile')
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- viewportCycle`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/renderer/src/lib/viewportCycle.ts`:
```ts
/** Browser viewport preset cycling (Duplicate → next preset for side-by-side compare). */
import type { BrowserViewport } from './boardSchema'

const ORDER: readonly BrowserViewport[] = ['mobile', 'tablet', 'desktop']

export function nextViewport(v: BrowserViewport): BrowserViewport {
  return ORDER[(ORDER.indexOf(v) + 1) % ORDER.length]
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- viewportCycle`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/viewportCycle.ts src/renderer/src/lib/viewportCycle.test.ts
git commit -m "feat(lib): nextViewport preset-cycle helper"
```

---

### Task 2: Store — `duplicateBoard(id)`

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/renderer/src/store/canvasStore.test.ts`:
```ts
describe('canvasStore — duplicateBoard', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], viewport: null, selectedId: null, past: [], future: [] })
  })

  it('offsets +36, assigns a new id, selects the copy, one undo step', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 100, y: 100 })
    const pastLen = useCanvasStore.getState().past.length
    const copyId = useCanvasStore.getState().duplicateBoard(src)
    const s = useCanvasStore.getState()
    expect(copyId).not.toBeNull()
    expect(copyId).not.toBe(src)
    const copy = s.boards.find((b) => b.id === copyId)!
    const orig = s.boards.find((b) => b.id === src)!
    expect(copy.x).toBe(orig.x + 36)
    expect(copy.y).toBe(orig.y + 36)
    expect(s.selectedId).toBe(copyId)
    expect(s.past.length).toBe(pastLen + 1)
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().boards.some((b) => b.id === copyId)).toBe(false)
  })

  it('browser copy advances to the next viewport preset', () => {
    const id = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 }) // default 'desktop'
    const copyId = useCanvasStore.getState().duplicateBoard(id)
    const copy = useCanvasStore.getState().boards.find((b) => b.id === copyId)!
    expect(copy.type === 'browser' && copy.viewport).toBe('mobile') // desktop → mobile
  })

  it('planning copy deep-clones elements with fresh ids', () => {
    const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    useCanvasStore.getState().updateBoard(id, {
      elements: [{ id: 'e1', kind: 'text', x: 1, y: 1, text: 'hi' }]
    } as never)
    const copyId = useCanvasStore.getState().duplicateBoard(id)
    const s = useCanvasStore.getState()
    const orig = s.boards.find((b) => b.id === id)! as { elements: { id: string }[] }
    const copy = s.boards.find((b) => b.id === copyId)! as { elements: { id: string }[] }
    expect(copy.elements).toHaveLength(1)
    expect(copy.elements[0].id).not.toBe('e1')
    expect(copy.elements).not.toBe(orig.elements)
  })

  it('returns null for an unknown id and does not mutate', () => {
    const before = useCanvasStore.getState().boards
    expect(useCanvasStore.getState().duplicateBoard('nope')).toBeNull()
    expect(useCanvasStore.getState().boards).toBe(before)
  })
})
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm test -- canvasStore`
Expected: FAIL — `duplicateBoard` is not a function.

- [ ] **Step 3: Implement**

In `src/renderer/src/store/canvasStore.ts`:

Add the import (extend the boardSchema import block — already imports `createBoard`, add nothing new there; add the viewport-cycle import near the top imports):
```ts
import { nextViewport } from '../lib/viewportCycle'
```

Add to the `CanvasState` interface (after `removeBoard`):
```ts
  /** Clone a board (geometry + state) offset 36px, select the copy; one undo step. Returns the new id (null if the source is gone). */
  duplicateBoard: (id: string) => string | null
```

Add the implementation (after the `removeBoard` impl, before `updateBoard`):
```ts
  duplicateBoard: (id) => {
    const src = get().boards.find((b) => b.id === id)
    if (!src) return null
    const cloneId = newId()
    const clone = structuredClone(src)
    clone.id = cloneId
    clone.x = src.x + 36
    clone.y = src.y + 36
    delete clone.z // re-stacks on top via array order, like a freshly added board
    if (clone.type === 'browser') clone.viewport = nextViewport(clone.viewport)
    if (clone.type === 'planning') {
      clone.elements = clone.elements.map((e) => ({ ...structuredClone(e), id: newId() }))
    }
    set((s) => ({
      past: recordPast(s.past, s.boards),
      future: [],
      boards: [...s.boards, clone],
      selectedId: cloneId
    }))
    return cloneId
  },
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm test -- canvasStore`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.
```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "feat(store): duplicateBoard — clone offset 36px, browser next-preset, planning element id regen"
```

---

### Task 3: `BoardFrame` — ⋯ overflow menu (shared, DRY)

**Files:**
- Modify: `src/renderer/src/canvas/BoardFrame.tsx`

> Replace the `onMore` prop with `onDuplicate` + `onDelete` (keep `onFull`). The ⋯ button toggles a small popover with **Full view · Duplicate · Delete**. Menu logic lives once here so all three board types get an identical menu.

- [ ] **Step 1: Update the props interface**

In `src/renderer/src/canvas/BoardFrame.tsx`, in `BoardFrameProps` (around lines 91–94), replace:
```ts
  /** Provided only when the board is focusable → renders the maximize button. */
  onFull?: (e: MouseEvent) => void
  onMore?: (e: MouseEvent) => void
```
with:
```ts
  /** Provided only when the board is focusable → renders the maximize button. */
  onFull?: (e: MouseEvent) => void
  /** ⋯ menu → Duplicate. When provided alongside onFull/onDelete, the ⋯ button shows. */
  onDuplicate?: () => void
  /** ⋯ menu → Delete (danger). */
  onDelete?: () => void
```

Update the destructure in the `BoardFrame` function signature (around lines 108–110): replace `onMore,` with `onDuplicate,` and `onDelete,`.

- [ ] **Step 2: Add the menu component**

Add this component above `BoardFrame` (after `IconBtn`, before `BoardFrameProps`):
```tsx
/** ⋯ overflow popover: Full view · Duplicate · Delete (DESIGN §6.1). */
function BoardMenu({
  onFull,
  onDuplicate,
  onDelete
}: {
  onFull?: (e: MouseEvent) => void
  onDuplicate?: () => void
  onDelete?: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (): void => setOpen(false)
    // Close on any outside pointerdown or Escape.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = (label: string, danger: boolean, fn?: (e: MouseEvent) => void): ReactElement => (
    <button
      className="board-menu-item"
      data-danger={danger || undefined}
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
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <IconBtn
        name="more"
        title="More"
        active={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      />
      {open && (
        <div
          className="board-menu"
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {onFull && item('Full view', false, onFull)}
          {onDuplicate && item('Duplicate', false, () => onDuplicate())}
          {onDelete && item('Delete', true, () => onDelete())}
        </div>
      )}
    </div>
  )
}
```

Add `useEffect` to the React import at the top of the file (currently `import { useState } from 'react'`):
```ts
import { useEffect, useState } from 'react'
```

- [ ] **Step 3: Render the menu in the title bar**

Replace the action-cluster block (around lines 271–275):
```tsx
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
          {actions}
          {onFull && <IconBtn name="maximize" title="Full view" size={14} onClick={onFull} />}
          {onMore && <IconBtn name="more" title="More" onClick={onMore} />}
        </div>
```
with:
```tsx
        <div style={{ display: 'flex', alignItems: 'center', gap: 1, flex: 'none' }}>
          {actions}
          {onFull && <IconBtn name="maximize" title="Full view" size={14} onClick={onFull} />}
          {(onFull || onDuplicate || onDelete) && (
            <BoardMenu onFull={onFull} onDuplicate={onDuplicate} onDelete={onDelete} />
          )}
        </div>
```

- [ ] **Step 4: Add menu styles**

Append to `src/renderer/src/index.css`:
```css
.board-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 132px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  box-shadow: var(--shadow-pop);
  padding: 4px;
  display: flex;
  flex-direction: column;
  z-index: 10;
}
.board-menu-item {
  text-align: left;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  border-radius: calc(var(--r-ctl) - 2px);
  cursor: pointer;
  font-size: 12px;
}
.board-menu-item:hover {
  background: var(--surface-raised);
  color: var(--text);
}
.board-menu-item[data-danger]:hover {
  color: var(--err);
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL — the three board components still pass nothing for these (no error) but any caller of the removed `onMore` errors. Search: `grep -rn "onMore" src/renderer/src`. If only `BoardFrame.tsx` referenced it, typecheck is clean. (Boards don't pass `onMore` today, so expect PASS.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/BoardFrame.tsx src/renderer/src/index.css
git commit -m "feat(chrome): shared ⋯ board menu (Full view · Duplicate · Delete) in BoardFrame"
```

---

### Task 4: `BoardActionsContext` + thread actions into all 3 boards (Duplicate + Delete live)

**Files:**
- Create: `src/renderer/src/canvas/boardActions.ts`
- Modify: `src/renderer/src/canvas/BoardNode.tsx`
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`
- Modify: `src/renderer/src/canvas/boards/BrowserBoard.tsx`
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`
- Modify: `src/renderer/src/canvas/Canvas.tsx`

> After this task, Duplicate + Delete work from every board's ⋯ menu. Full view's `onFull` is wired to `requestFullView` but the modal arrives in Tasks 5–6 (so clicking it just sets state, harmless).

- [ ] **Step 1: Create the context**

Create `src/renderer/src/canvas/boardActions.ts`:
```ts
/** Board-level actions, provided by Canvas and consumed by BoardNode to build
 *  per-id callbacks for the shared BoardFrame menu / maximize button. */
import { createContext } from 'react'

export interface BoardActions {
  requestFullView: (id: string) => void
  duplicate: (id: string) => void
  remove: (id: string) => void
}

export const BoardActionsContext = createContext<BoardActions | null>(null)
```

- [ ] **Step 2: Extend `BoardViewProps` + build per-id callbacks in `BoardNode`**

In `src/renderer/src/canvas/BoardNode.tsx`:

Add to imports:
```ts
import { useContext } from 'react'
import { BoardActionsContext } from './boardActions'
```
(merge `useContext` into the existing `react` import that already has `useEffect, useState`.)

Extend `BoardViewProps` (after `lod?: boolean`):
```ts
  /** Title-bar maximize → request full view for this board. */
  onFull?: () => void
  /** ⋯ menu → duplicate this board. */
  onDuplicate?: () => void
  /** ⋯ menu → delete this board (terminal park-on-delete handled by the store/Canvas). */
  onDelete?: () => void
```

Inside `BoardNode`, after `const dimmed = data.dimmed ?? false`, build the callbacks:
```ts
  const acts = useContext(BoardActionsContext)
  const onFull = acts ? (): void => acts.requestFullView(board.id) : undefined
  const onDuplicate = acts ? (): void => acts.duplicate(board.id) : undefined
  const onDelete = acts ? (): void => acts.remove(board.id) : undefined
  const actions = { onFull, onDuplicate, onDelete }
```

Pass `actions` into each board component in the dispatch (around lines 120–122):
```tsx
        {board.type === 'terminal' && (
          <TerminalBoard board={board} lod={lod} {...common} {...actions} />
        )}
        {board.type === 'browser' && <BrowserBoard board={board} {...common} {...actions} />}
        {board.type === 'planning' && <PlanningBoard board={board} {...common} {...actions} />}
```

- [ ] **Step 3: Forward the props in each board component**

In **`BrowserBoard.tsx`** — change the component signature to accept the new props and forward to `BoardFrame`. The component currently destructures `BoardViewProps`; add `onFull, onDuplicate, onDelete` to the destructure and add to the `<BoardFrame …>` opening tag (around line 160):
```tsx
    <BoardFrame
      type="browser"
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      status={status}
      contentBg="var(--surface)"
      actions={<ViewportControl value={board.viewport} onChange={setViewport} />}
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
    >
```
> Note: `BoardFrame`'s `onFull` is typed `(e: MouseEvent) => void`; passing the prop-typed `() => void` is assignment-compatible (a handler may ignore its arg). If strict mode objects, wrap: `onFull={onFull ? () => onFull() : undefined}`.

In **`PlanningBoard.tsx`** — add `onFull, onDuplicate, onDelete` to the destructured props and to its `<BoardFrame …>` opening tag (around line 380), same three lines.

In **`TerminalBoard.tsx`** — it renders `BoardFrame` in two places (around lines 479 and 511: the full-chrome and the LOD-but-mounted render). Add `onFull, onDuplicate, onDelete` to the destructured props and to BOTH `<BoardFrame …>` opening tags.

- [ ] **Step 4: Provide the context in `Canvas`**

In `src/renderer/src/canvas/Canvas.tsx`:

Add imports:
```ts
import { useMemo } from 'react' // already imported — ensure present
import { BoardActionsContext, type BoardActions } from './boardActions'
```
(merge into existing imports; `useMemo` is already imported.)

Add `duplicateBoard` to the store reads (near the other `useCanvasStore` reads):
```ts
const duplicateBoard = useCanvasStore((s) => s.duplicateBoard)
```

Build the actions value (after `focusBoard` / near the other callbacks). For now `requestFullView` is a placeholder `setFullViewId` that Task 5 adds — define a temporary local until Task 5; to avoid churn, add the `fullViewId` state now:
```ts
const [fullViewId, setFullViewId] = useState<string | null>(null)

const boardActions = useMemo<BoardActions>(
  () => ({
    requestFullView: (id) => setFullViewId(id),
    duplicate: (id) => {
      setFullViewId(null)
      duplicateBoard(id)
    },
    remove: (id) => {
      const removed = useCanvasStore.getState().boards.find((x) => x.id === id)
      if (removed?.type === 'terminal') void window.api.parkTerminal(id)
      setFullViewId((f) => (f === id ? null : f))
      removeBoard(id)
      setFocusedId((f) => (f === id ? null : f))
    }
  }),
  [duplicateBoard, removeBoard]
)
```

Wrap the returned JSX tree in the provider — change the outer `<div ref={paneRef} style={paneStyle}>` return so its children are inside `<BoardActionsContext.Provider value={boardActions}>`:
```tsx
  return (
    <BoardActionsContext.Provider value={boardActions}>
      <div ref={paneRef} style={paneStyle}>
        {/* …existing children unchanged… */}
      </div>
    </BoardActionsContext.Provider>
  )
```

- [ ] **Step 5: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS. (`fullViewId` is set-but-unused until Task 5 — referenced by `boardActions`, so no unused-var error; if lint flags it, Task 5 immediately consumes it.)

- [ ] **Step 6: Manual verify**

Run: `pnpm dev`
Add a Planning board → ⋯ → Duplicate → a copy appears offset 36px, selected. ⋯ → Delete → removed. Add a Browser board → ⋯ → Duplicate → copy is the next viewport preset.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/boardActions.ts src/renderer/src/canvas/BoardNode.tsx src/renderer/src/canvas/boards/TerminalBoard.tsx src/renderer/src/canvas/boards/BrowserBoard.tsx src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(canvas): wire Duplicate + Delete through BoardActionsContext → ⋯ menu on all boards"
```

---

### Task 5: Canvas full-view state — node data, Esc priority, heal effect

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`
- Modify: `src/renderer/src/canvas/BoardNode.tsx`

> `fullViewId` was added in Task 4. This task feeds it into node data, makes Esc close full view first, and drops a stale `fullViewId` when its board is removed. The modal itself lands in Task 6 (so full view has no visible effect yet — `fullViewId` just tracks).

- [ ] **Step 1: Add `fullView` to node data**

In `BoardNode.tsx`, extend `BoardNodeData`:
```ts
export interface BoardNodeData extends Record<string, unknown> {
  board: Board
  /** Dim to 55% when another board is focused (dimOnFocus, fixed-on). */
  dimmed?: boolean
  /** This board is the one shown in the full-view modal (Task 6 portals it). */
  fullView?: boolean
}
```

In `Canvas.tsx`, add `fullView` to the node mapping (`nodes` useMemo, in the `data` object):
```ts
        data: { board: b, dimmed: focusedId !== null && focusedId !== b.id, fullView: fullViewId === b.id },
```
Add `fullViewId` to that `useMemo`'s dependency array: `[boards, selectedId, focusedId, fullViewId]`.

- [ ] **Step 2: Esc-priority + heal effect**

In the keydown handler (the `if (e.key === 'Escape' && !typing)` branch), make full view take priority:
```ts
      if (e.key === 'Escape' && !typing) {
        if (fullViewId) {
          setFullViewId(null)
          return
        }
        clearSelection()
      } else if (/* …unchanged… */) {
```
Add `fullViewId` to that effect's dependency array.

Extend the existing focus-heal effect (the one keyed on `[boards]` that drops a stale `focusedId`) to also drop a stale `fullViewId`:
```ts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFullViewId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
  }, [boards])
```

- [ ] **Step 3: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx src/renderer/src/canvas/BoardNode.tsx
git commit -m "feat(canvas): full-view state — node data flag, Esc priority, heal on remove"
```

---

### Task 6: `FullViewModal` + portal relocation (Terminal / Planning / Browser-HTML live)

**Files:**
- Create: `src/renderer/src/canvas/fullViewContext.ts`
- Create: `src/renderer/src/canvas/FullViewModal.tsx`
- Modify: `src/renderer/src/canvas/BoardNode.tsx`
- Modify: `src/renderer/src/canvas/Canvas.tsx`
- Modify: `src/renderer/src/index.css`

> The modal renders a scrim + band + a portal host. The full-view `BoardNode` portals its board subtree into that host (same React element → no remount → live session survives). Browser's native view re-bound is Task 7.

- [ ] **Step 1: Create the portal context**

Create `src/renderer/src/canvas/fullViewContext.ts`:
```ts
/** The full-view modal's portal host element (null when no modal is open). The
 *  matching BoardNode portals its live subtree into this element so the board is
 *  relocated, not re-mounted (PTY / xterm / native view survive). */
import { createContext } from 'react'

export const FullViewContext = createContext<HTMLElement | null>(null)
```

- [ ] **Step 2: Create `FullViewModal`**

Create `src/renderer/src/canvas/FullViewModal.tsx`:
```tsx
/**
 * Full-view modal (DESIGN §6.1): a fullscreen overlay over a 66%-black scrim with an
 * accent-ringed frame, a `FULL VIEW` band + ✕/Esc exit, and a portal host that the
 * matching board relocates its live content into. Does NOT move the camera. Closes on
 * Esc, ✕, or scrim click. Renders the host immediately and publishes it on mount so the
 * BoardNode can portal into it the same frame.
 */
import { useEffect, useState, type ReactElement } from 'react'

export function FullViewModal({
  onClose,
  onHost
}: {
  onClose: () => void
  onHost: (el: HTMLElement | null) => void
}): ReactElement {
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null)

  useEffect(() => {
    onHost(hostEl)
    return () => onHost(null)
  }, [hostEl, onHost])

  return (
    <div
      className="fullview-scrim"
      onMouseDown={(e) => {
        // Only a click on the scrim itself (not the frame) closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="fullview-frame" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fullview-band">
          <span className="fullview-label">FULL VIEW</span>
          <button className="fullview-close" onClick={onClose} title="Close (Esc)">
            ✕ Esc
          </button>
        </div>
        <div className="fullview-host" ref={setHostEl} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Portal the board subtree in `BoardNode`**

In `BoardNode.tsx`:

Add imports:
```ts
import { createPortal } from 'react-dom'
import { FullViewContext } from './fullViewContext'
```

Read the context + flag inside `BoardNode` (near the `acts` line):
```ts
  const fullViewHost = useContext(FullViewContext)
  const fullView = data.fullView ?? false
```

The board subtree currently is:
```tsx
      <div
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{ position: 'absolute', inset: 0 }}
      >
        {board.type === 'terminal' && (<TerminalBoard … />)}
        {board.type === 'browser' && <BrowserBoard … />}
        {board.type === 'planning' && <PlanningBoard … />}
      </div>
```
Extract it into a `const subtree = ( …that div… )`, then render conditionally:
```tsx
  const subtree = (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'absolute', inset: 0 }}
    >
      {board.type === 'terminal' && (
        <TerminalBoard board={board} lod={lod} {...common} {...actions} />
      )}
      {board.type === 'browser' && <BrowserBoard board={board} {...common} {...actions} />}
      {board.type === 'planning' && <PlanningBoard board={board} {...common} {...actions} />}
    </div>
  )

  return (
    <>
      {!lod && (<NodeResizer … />)}
      {fullView && fullViewHost ? createPortal(subtree, fullViewHost) : subtree}
    </>
  )
```
> Keep the existing `NodeResizer` block unchanged. When portaled, the node leaves the resizer (an empty handle frame) on-canvas behind the scrim — harmless. `createPortal` preserves the `subtree` instance, so the terminal's xterm/PTY and the planning elements are NOT remounted.

- [ ] **Step 4: Render the modal + provide the host in `Canvas`**

In `Canvas.tsx`:

Add imports:
```ts
import { FullViewModal } from './FullViewModal'
import { FullViewContext } from './fullViewContext'
```

Add host state:
```ts
const [fullViewHost, setFullViewHost] = useState<HTMLElement | null>(null)
```

Wrap the tree in the `FullViewContext.Provider` (inside the `BoardActionsContext.Provider`), and render the modal when `fullViewId` matches an existing board:
```tsx
  const fullViewBoard = fullViewId ? boards.find((b) => b.id === fullViewId) : undefined

  return (
    <BoardActionsContext.Provider value={boardActions}>
      <FullViewContext.Provider value={fullViewHost}>
        <div ref={paneRef} style={paneStyle}>
          {/* …existing children… */}
        </div>
        {fullViewBoard && (
          <FullViewModal onClose={() => setFullViewId(null)} onHost={setFullViewHost} />
        )}
      </FullViewContext.Provider>
    </BoardActionsContext.Provider>
  )
```

- [ ] **Step 5: Modal styles**

Append to `src/renderer/src/index.css`:
```css
.fullview-scrim {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.66);
  display: flex;
  padding: 5vh 5vw;
}
.fullview-frame {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-radius: var(--r-board);
  overflow: hidden;
  background: var(--surface);
  box-shadow: 0 0 0 1.5px var(--accent), var(--shadow-board);
}
.fullview-band {
  flex: none;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border-subtle);
}
.fullview-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  color: var(--text-3);
}
.fullview-close {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  padding: 3px 8px;
  cursor: pointer;
}
.fullview-close:hover {
  color: var(--text);
  border-color: var(--border);
}
.fullview-host {
  flex: 1;
  position: relative;
  min-height: 0;
}
```

- [ ] **Step 6: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 7: Manual verify (the critical no-remount check)**

Run: `pnpm dev`. Open a project.
- **Terminal:** add a Terminal, let it spawn, type `echo hello`. ⋯ → Full view (or maximize). The SAME live shell fills the modal (history intact, still interactive — type another command). Esc → returns to canvas, session still alive.
- **Planning:** add notes, full view → interactive at size; Esc → returns.
- **Browser** in full view will show its HTML frame but the native page won't be positioned yet (Task 7). Confirm the modal opens; scrim-click + ✕ + Esc all close.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/canvas/fullViewContext.ts src/renderer/src/canvas/FullViewModal.tsx src/renderer/src/canvas/BoardNode.tsx src/renderer/src/canvas/Canvas.tsx src/renderer/src/index.css
git commit -m "feat(canvas): full-view modal + portal relocation (live Terminal/Planning, no remount)"
```

---

### Task 7: Browser native view in full view (re-bound to the portaled frame)

**Files:**
- Modify: `src/renderer/src/canvas/boards/BrowserBoard.tsx`
- Modify: `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
- Modify: `src/renderer/src/canvas/Canvas.tsx`

> In full view the Browser board's HTML frame is portaled into the modal, but the native view's bounds are camera-derived (`boundsFor`) — pointing at the on-canvas location, not the modal. Override: while a Browser board is in full view, bound its native view to the portaled `.bb-frame`'s live DOM rect and detach all other views. **Fallback (if this proves janky): demote the full-view Browser to its snapshot (`demoteToSnapshot`) — the portaled HTML frame then shows the snapshot image; document and ship that instead.**

- [ ] **Step 1: Tag the device frame for DOM-rect lookup**

In `BrowserBoard.tsx`, add a stable attribute to the `.bb-frame` div (around line 221):
```tsx
        <div
          className="bb-frame"
          data-bb-frame={board.id}
          style={{ … unchanged … }}
        >
```

- [ ] **Step 2: Accept `fullViewId` in the preview layer + override bounds**

In `BrowserPreviewLayer.tsx`:

Add to `LayerProps` (after `focusedId: string | null`):
```ts
  /** The board currently in full view (its native view binds to the modal frame). */
  fullViewId: string | null
```
Destructure it: `export function BrowserPreviewLayer({ paneRef, focusedId, fullViewId }: LayerProps)`.

Add a ref tracking it (next to `focusedIdRef`):
```ts
  const fullViewIdRef = useRef<string | null>(fullViewId)
```
Keep it fresh — extend the existing focus effect (the one at ~line 502 that sets `focusedIdRef.current = focusedId` and calls `applyLiveness`) to also set it, and add `fullViewId` to its deps:
```ts
    focusedIdRef.current = focusedId
    fullViewIdRef.current = fullViewId
    // …existing applyLiveness call…
  }, [focusedId, fullViewId, applyLiveness])
```

Add a full-view bounds helper near `boundsFor`:
```ts
  /** In full view, the native view binds to the portaled device frame's live DOM rect
   *  (the board's HTML frame is relocated into the modal; camera math no longer applies). */
  const fullViewBoundsFor = useCallback((id: string): Rect | null => {
    const el = document.querySelector<HTMLElement>(`[data-bb-frame="${id}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return null
    return roundRect({ x: r.left, y: r.top, width: r.width, height: r.height })
  }, [])
```

In `attachBoard`, override the bounds/zoom when this board is the full-view board (right after `const r = rec(g.id)`):
```ts
      const fv = fullViewIdRef.current === g.id ? fullViewBoundsFor(g.id) : null
      const bounds = fv ?? boundsFor(g)
      const zoomFactor = fv ? fitZoomFactorForBounds(fv.width, preset(g.viewport).w) : zoomFor(g)
```
(replace the existing `const bounds = boundsFor(g)` / `const zoomFactor = zoomFor(g)` lines).

In `applyLiveness` (the central liveness picker), force the full-view board to be the sole live view: at the top of the function, if `fullViewIdRef.current` is set, the live set is exactly that board (when it's a Browser board) and every other board demotes. Add near the start of `applyLiveness`:
```ts
    const fvId = fullViewIdRef.current
    if (fvId) {
      // Full view: only the full-view Browser board may be live; detach all others.
      for (const g of geomRef.current.values()) {
        if (g.id === fvId) void attachBoard(g)
        else if (rec(g.id).attached) void demoteToSnapshot(g)
      }
      return
    }
```
> Place this BEFORE the normal candidate/cap logic and after the gesture/early-exit guards already at the top. If `applyLiveness` isn't structured to early-return cleanly, wrap the existing body in an `else`.

- [ ] **Step 3: Keep the native bounds following the modal frame**

The rAF flush (`flushBatch`) re-pushes bounds each frame from `boundsFor`. Ensure the full-view override is also applied there: locate where the flush computes each attached board's `bounds`/`zoomFactor` (it calls `boundsFor(g)` / `zoomFor(g)`), and apply the same `fv` override:
```ts
      const fv = fullViewIdRef.current === g.id ? fullViewBoundsFor(g.id) : null
      const bounds = fv ?? boundsFor(g)
      const zoomFactor = fv ? fitZoomFactorForBounds(fv.width, preset(g.viewport).w) : zoomFor(g)
```
> This makes the native view track the modal frame across window resizes. If the flush loop already derives bounds via a shared local, factor the override into that single spot.

- [ ] **Step 4: Pass `fullViewId` from `Canvas`**

In `Canvas.tsx`, update the layer usage:
```tsx
        <BrowserPreviewLayer paneRef={paneRef} focusedId={focusedId} fullViewId={fullViewId} />
```

- [ ] **Step 5: Typecheck + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS.

- [ ] **Step 6: Manual verify**

Run: `pnpm dev`. Add a Browser board → point it at `http://localhost:5173` (the dev app) or any localhost. ⋯ → Full view:
- The live page fills the modal device frame (interactive — click/scroll the page).
- The URL bar + viewport toggle (board chrome) show above it.
- Esc / ✕ close; back on canvas the native view returns to its on-canvas position.
- Other Browser boards (add a 2nd) detach to snapshot while one is full-view.
If the native view trails / mis-positions badly, apply the documented fallback (demote-to-snapshot for the full-view Browser) and note it.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/boards/BrowserBoard.tsx src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(browser): live native view in full view — bind to portaled frame rect, detach others"
```

---

### Task 8: Final verification + docs

**Files:**
- Modify: `CLAUDE.md`, `docs/roadmap.md`

- [ ] **Step 1: Full gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`
Expected: ALL PASS. (Run `pnpm format` if `format:check` flags new files, then re-run.)

- [ ] **Step 2: e2e harness still green**

Run: `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start`
Expected: `E2E_DONE`, exit 0. (Full view / menu don't run in the seed harness, but confirm nothing regressed.)

- [ ] **Step 3: Manual smoke of the whole slice**

`pnpm dev`: each board type → ⋯ menu shows Full view · Duplicate · Delete; Duplicate offsets + selects (Browser → next preset); Full view is live + interactive for all three; Esc/✕/scrim close; Delete from menu removes (terminal session killed).

- [ ] **Step 4: Docs**

In `CLAUDE.md` Status, append to the Phase 3 line: Slice B (board actions) — Full view (live, portal-relocation; Browser native re-bound to the modal frame) · Duplicate (offset 36px, Browser→next preset, planning element-id regen) · shared ⋯ menu — on branch `phase-3-board-actions`.

In `docs/roadmap.md`, mark the Phase 3 Focus/Full view + Duplicate bullets DONE (Focus was already shipped; Full view + Duplicate land here), citing `docs/superpowers/{specs,plans}/2026-05-30-board-actions*.md`.

- [ ] **Step 5: Commit + PR**

```bash
git add CLAUDE.md docs/roadmap.md
git commit -m "docs(phase-3): mark Full view + Duplicate + ⋯ menu landed (Slice B)"
git push -u origin phase-3-board-actions
gh pr create --base main --head phase-3-board-actions --title "Phase 3 Slice B — Board actions (Full view · Duplicate · ⋯ menu)" --body "Full view (live portal-relocation; Browser native view re-bound to the modal frame), Duplicate (offset 36px, Browser→next preset, planning element-id regen), and the shared ⋯ menu. Stacks on phase-3-persistence. Spec/plan in docs/superpowers."
```
> Note: this branch stacks on `phase-3-persistence`. If that PR (#5) is not yet merged, either base this PR on `phase-3-persistence` or merge #5 first so the diff is clean.

---

## Self-review notes (addressed)

- **Spec coverage:** viewportCycle (T1) · duplicateBoard incl. all three type rules + one-undo (T2) · ⋯ menu in BoardFrame (T3) · BoardActionsContext + Duplicate/Delete wiring (T4) · full-view state/Esc/heal (T5) · modal + portal no-remount (T6) · Browser native re-bound + fallback (T7) · gate + docs (T8). All spec sections mapped.
- **Deviation from spec:** the spec listed a `lib/fullViewLayout.ts` pure helper for Browser-bounds math; the plan instead reads the portaled `.bb-frame` live DOM rect (`fullViewBoundsFor`), so no math helper is needed — simpler and avoids duplicating layout in two places. Documented here.
- **Type consistency:** `BoardActions` ({requestFullView,duplicate,remove}), `FullViewContext` (HTMLElement|null), `duplicateBoard(id)→string|null`, BoardFrame `onFull`/`onDuplicate`/`onDelete`, BoardViewProps `onFull`/`onDuplicate`/`onDelete`, node data `fullView` — used identically across tasks.
- **Risk callouts:** T6 portal (no-remount — verify live terminal empirically) and T7 native re-bound (documented snapshot fallback) are the two risky tasks; both have explicit manual-verify steps.
```
