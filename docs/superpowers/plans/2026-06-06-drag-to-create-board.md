# Drag-to-create Board Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dock's instant click-spawn with a placement gesture — clicking a dock button arms a board type; a click on the canvas spawns a default-size board at the cursor, a drag spawns a board sized to the dragged rectangle. The dock also moves to top-center.

**Architecture:** A clicked dock button sets the existing `tool` store field to the board type (armed). While armed, `Canvas.tsx` renders a transparent **capture overlay** over the pane that owns the pointer gesture (so boards are non-interactive and React Flow never pans). `useBoardPlacement` drives press→drag→release: a screen-space ghost `<div>` follows the pointer; on release the corners convert to world coords via `rf.screenToFlowPosition` and `addBoard` is called with an optional size. Pure geometry lives in `lib/placement.ts`.

**Tech Stack:** React 18, Zustand, `@xyflow/react` v12, Vitest (unit + jsdom integration), Playwright `_electron` (e2e).

**Spec:** `docs/superpowers/specs/2026-06-06-drag-to-create-board-design.md`.

### Refinements from the approved spec (same UX, internal mechanism only)

- **Reuse `tool: Tool = 'select' | BoardType`** (`canvasStore.ts:31-32`, comment: "the neutral select tool or a pending add-board type") instead of adding a new `placement` field. Armed ≡ `tool !== 'select'`. `tool` is already ephemeral (not in `toObject`'s serialized slice).
- **Capture overlay** instead of toggling React Flow's `panOnDrag`. A pane-covering `<div pointerEvents:auto>` while armed intercepts the gesture — boards become non-interactive and RF never sees the drag (no pan), with no "stuck unpannable canvas" failure mode. Trade-off: wheel-zoom is paused while armed (a brief, one-shot state); zoom before arming. Accepted.
- `lib/placement.ts` is self-contained (its own `normalizeBox`) rather than importing `rectFromPoints` from `canvas/boards/planning/marquee.ts` (avoids a `lib → canvas` layering inversion).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/renderer/src/lib/placement.ts` (NEW) | Pure geometry: `normalizeBox`, `isClickGesture`, `placementRect` (+ `Box` type). No React/DOM. |
| `src/renderer/src/lib/placement.test.ts` (NEW) | Unit tests for the above. |
| `src/renderer/src/store/canvasStore.ts` (MODIFY) | `addBoard` gains `opts.size` + `opts.exact`; interface + impl. |
| `src/renderer/src/store/canvasStore.test.ts` (MODIFY) | Tests for the new `addBoard` opts. |
| `src/renderer/src/canvas/AppChrome.tsx` (MODIFY) | Dock → top-center; buttons arm via `setTool`; `DockBtn` active state; export `Dock`; drop the now-unused `onAdd` prop on Dock + AppChrome. |
| `src/renderer/src/canvas/AppChrome.dock.integration.test.tsx` (NEW) | jsdom: clicking a dock button arms `tool`, adds no board; select clears. |
| `src/renderer/src/canvas/hooks/useBoardPlacement.ts` (NEW) | The gesture hook: armed flag, ghost state, capture-overlay pointerdown, window move/up, Esc cancel, commit. |
| `src/renderer/src/canvas/hooks/useBoardPlacement.test.tsx` (NEW) | jsdom integration: armed reflects `tool`; click vs drag branch calls `addBoard` correctly (mocked `rf`); Esc disarms. |
| `src/renderer/src/canvas/Canvas.tsx` (MODIFY) | Use the hook; render capture overlay + ghost; drop `onAdd` on the `<AppChrome>` call. |
| `src/renderer/src/index.css` (MODIFY) | `.placement-capture` + `.placement-ghost` classes. |
| `src/renderer/src/smoke/e2eHooks.ts` (MODIFY) | Add `setTool` + `getTool` to the `__canvasE2E` registry. |
| `e2e/placement.e2e.ts` (NEW) | Real-OS-input drag/click/Esc through the live camera transform. |
| `docs/testing/TESTING.md` (MODIFY) | Note the placement e2e sliver in the Browser/canvas row. |

---

## Task 1: Pure placement geometry (`lib/placement.ts`)

**Files:**
- Create: `src/renderer/src/lib/placement.ts`
- Test: `src/renderer/src/lib/placement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/lib/placement.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeBox, isClickGesture, placementRect } from './placement'
import { MIN_BOARD_SIZE } from './boardSchema'

describe('normalizeBox', () => {
  it('orders corners into a positive-size box (any drag direction)', () => {
    expect(normalizeBox(100, 80, 40, 20)).toEqual({ x: 40, y: 20, w: 60, h: 60 })
    expect(normalizeBox(40, 20, 100, 80)).toEqual({ x: 40, y: 20, w: 60, h: 60 })
  })
})

describe('isClickGesture', () => {
  it('is a click below the 5px threshold on both axes', () => {
    expect(isClickGesture(0, 0)).toBe(true)
    expect(isClickGesture(4, -4)).toBe(true)
  })
  it('is a drag once either axis reaches the threshold', () => {
    expect(isClickGesture(5, 0)).toBe(false)
    expect(isClickGesture(0, -6)).toBe(false)
  })
})

describe('placementRect', () => {
  it('normalizes two world corners into a board rect', () => {
    expect(placementRect({ x: 300, y: 400 }, { x: 50, y: 100 })).toEqual({
      x: 50,
      y: 100,
      w: 250,
      h: 300
    })
  })
  it('clamps a sub-minimum drag up to MIN_BOARD_SIZE, anchored at the top-left', () => {
    const r = placementRect({ x: 10, y: 10 }, { x: 30, y: 25 })
    expect(r).toEqual({ x: 10, y: 10, w: MIN_BOARD_SIZE.w, h: MIN_BOARD_SIZE.h })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/lib/placement.test.ts`
Expected: FAIL — `Failed to resolve import "./placement"` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/src/lib/placement.ts`:

```ts
/**
 * Pure geometry for drag-to-create board placement (no React/DOM). Used by
 * useBoardPlacement to turn a press→drag→release into a board rect, and to draw the
 * screen-space ghost. Unit-tested like tidyLayout.ts / marquee.ts.
 */
import { MIN_BOARD_SIZE } from './boardSchema'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Normalize two corner points (any order) to a positive-size box. */
export function normalizeBox(ax: number, ay: number, bx: number, by: number): Box {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) }
}

/** Below `threshold` px of displacement on BOTH axes counts as a click, not a drag. */
export function isClickGesture(dx: number, dy: number, threshold = 5): boolean {
  return Math.abs(dx) < threshold && Math.abs(dy) < threshold
}

/**
 * Two WORLD corners → a normalized board rect, clamped up to the minimum board size
 * (grown from the top-left so a sub-min drag never inverts the rect).
 */
export function placementRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  min: { w: number; h: number } = MIN_BOARD_SIZE
): Box {
  const box = normalizeBox(a.x, a.y, b.x, b.y)
  return { x: box.x, y: box.y, w: Math.max(min.w, box.w), h: Math.max(min.h, box.h) }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/lib/placement.test.ts`
Expected: PASS (3 describe blocks, 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/placement.ts src/renderer/src/lib/placement.test.ts
git commit -m "feat(canvas): pure placement geometry for drag-to-create"
```

---

## Task 2: `addBoard` accepts an optional size + exact placement (`canvasStore.ts`)

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts:98` (interface) and `:337-347` (impl)
- Test: `src/renderer/src/store/canvasStore.test.ts`

Context: `createBoard` already accepts `opts.w`/`opts.h` (`boardSchema.ts:218-219`). `freeSlot(boards, at, size)` nudges off overlaps (`canvasStore.ts:284`). `DEFAULT_BOARD_SIZE` is already imported in `canvasStore.ts`.

- [ ] **Step 1: Write the failing test**

Add to `src/renderer/src/store/canvasStore.test.ts` inside the existing `describe('addBoard', …)` block:

```ts
it('uses an explicit size when provided', () => {
  const id = get().addBoard('terminal', { x: 0, y: 0 }, { size: { w: 333, h: 222 } })
  const b = get().boards.find((x) => x.id === id)!
  expect(b).toMatchObject({ w: 333, h: 222 })
})

it('places exactly (skips freeSlot) when exact:true, even over an existing board', () => {
  get().addBoard('terminal', { x: 100, y: 100 }) // occupies the slot
  const id = get().addBoard('browser', { x: 100, y: 100 }, { size: { w: 240, h: 160 }, exact: true })
  const b = get().boards.find((x) => x.id === id)!
  expect(b).toMatchObject({ x: 100, y: 100 }) // verbatim, NOT nudged off the overlap
})

it('still nudges off an overlap when exact is falsy (default click-spawn)', () => {
  get().addBoard('terminal', { x: 100, y: 100 })
  const id = get().addBoard('terminal', { x: 100, y: 100 })
  const b = get().boards.find((x) => x.id === id)!
  expect(b.x === 100 && b.y === 100).toBe(false) // freeSlot moved it
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/store/canvasStore.test.ts -t addBoard`
Expected: FAIL — the `size`/`exact` opts are ignored (board gets default size / is nudged), so the size + exact-position assertions fail. (TypeScript will also flag the unknown opts — that is the failing state.)

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/store/canvasStore.ts`, change the interface signature (`:98`):

```ts
  addBoard: (
    type: BoardType,
    at: { x: number; y: number },
    opts?: { id?: string; size?: { w: number; h: number }; exact?: boolean }
  ) => string
```

Replace the impl (`:337-347`):

```ts
  addBoard: (type, at, opts) => {
    const id = opts?.id ?? newId()
    const size = opts?.size ?? DEFAULT_BOARD_SIZE[type]
    // exact:true honours a deliberately-drawn rectangle (drag-create) verbatim; otherwise
    // nudge off any overlap (click-spawn / the MCP spawn path).
    const pos = opts?.exact ? at : freeSlot(get().boards, at, size)
    const board = createBoard(type, { id, x: pos.x, y: pos.y, w: size.w, h: size.h })
    // A fresh, this-session add is NOT idle-on-mount, so a Terminal board auto-spawns
    // on mount. Only restored/duplicated boards are flagged idle (M-1).
    set((s) =>
      trackedChange(s, { boards: [...s.boards, board] }, { selectedId: id, reflectPresent: false })
    )
    return id
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/renderer/src/store/canvasStore.test.ts`
Expected: PASS — all existing `addBoard` tests plus the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "feat(store): addBoard accepts optional size + exact placement"
```

---

## Task 3: Dock moves to top-center and arms a board type (`AppChrome.tsx`)

**Files:**
- Modify: `src/renderer/src/canvas/AppChrome.tsx` (`Dock` `:352-372`, `DockBtn` `:417-449`, `AppChrome` `:38-48`, `styles.dock` `:462-468`)
- Modify: `src/renderer/src/canvas/Canvas.tsx:777` (drop `onAdd` on the `<AppChrome>` call)
- Test: `src/renderer/src/canvas/AppChrome.dock.integration.test.tsx` (NEW)

Context: `Dock` already reads nothing from the store; we add `tool`/`setTool` reads (the store hooks are already imported in this file via `useCanvasStore`). The `select` `ToolBtn` already calls `setTool('select')`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/AppChrome.dock.integration.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Dock } from './AppChrome'
import { useCanvasStore } from '../store/canvasStore'

beforeEach(() => {
  useCanvasStore.setState({ boards: [], connectors: [], selectedId: null, tool: 'select', past: [], future: [] })
})
afterEach(() => cleanup())

describe('Dock arms a board type (drag-to-create)', () => {
  it('clicking +Terminal sets tool to terminal and adds NO board', () => {
    render(<Dock />)
    fireEvent.click(screen.getByText('Terminal'))
    expect(useCanvasStore.getState().tool).toBe('terminal')
    expect(useCanvasStore.getState().boards).toHaveLength(0)
  })

  it('clicking Select clears the armed tool back to select', () => {
    useCanvasStore.setState({ tool: 'browser' })
    render(<Dock />)
    fireEvent.click(screen.getByTitle('Select'))
    expect(useCanvasStore.getState().tool).toBe('select')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/AppChrome.dock.integration.test.tsx`
Expected: FAIL — `Dock` is not exported (import error), and once exported its current `onClick` calls `onAdd` (adds a board) rather than `setTool`.

- [ ] **Step 3: Write minimal implementation**

In `src/renderer/src/canvas/AppChrome.tsx`:

(a) `AppChrome` (`:38-48`) — drop the unused `onAdd` and render `<Dock />` with no props:

```tsx
export interface AppChromeProps {
  /** Apply a layout preset, then fit — the camera-cluster Tidy picker (Smart / tiling
   *  templates) and the `t` key (Smart). */
  onTidy: (preset: LayoutPreset) => void
}

export function AppChrome({ onTidy }: AppChromeProps): ReactElement {
  const [showSettings, setShowSettings] = useState(false)
  return (
    <>
      <ProjectSwitcher />
      <CameraCluster onTidy={onTidy} onSettings={() => setShowSettings(true)} />
      <Dock />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
```

(b) Replace `Dock` (`:352-372`) — export it, arm via `setTool`, drop `onAdd`:

```tsx
// ── Top-center: board dock ────────────────────────────────────────────────────
// Clicking a board button ARMS that type (sets the store `tool`); the canvas then
// turns a click into a default-size board and a drag into a sized one
// (useBoardPlacement). Select disarms. Exported for the dock arming integration test.
export function Dock(): ReactElement {
  const tool = useCanvasStore((s) => s.tool)
  const setTool = useCanvasStore((s) => s.setTool)
  return (
    <div style={styles.dock}>
      <div style={{ ...styles.pill, padding: 4, gap: 3 }}>
        <ToolBtn
          name="select"
          title="Select"
          big
          active={tool === 'select'}
          onClick={() => setTool('select')}
        />
        <span style={styles.divider} />
        {(['terminal', 'browser', 'planning'] as const).map((type) => (
          <DockBtn key={type} type={type} active={tool === type} onClick={() => setTool(type)} />
        ))}
      </div>
    </div>
  )
}
```

(c) `DockBtn` (`:417-449`) — add an `active` prop and reflect it in the styles:

```tsx
function DockBtn({
  type,
  active = false,
  onClick
}: {
  type: BoardType
  active?: boolean
  onClick: () => void
}): ReactElement {
  const [hover, setHover] = useState(false)
  const label = type[0].toUpperCase() + type.slice(1)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 32,
        padding: '0 11px 0 9px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        background: active ? 'var(--accent-wash)' : hover ? 'var(--surface-overlay)' : 'transparent',
        color: active ? 'var(--accent)' : hover ? 'var(--text)' : 'var(--text-2)',
        fontSize: 12.5,
        fontWeight: 500,
        fontFamily: 'var(--ui)',
        transition: 'color .1s, background .1s'
      }}
    >
      <span
        style={{
          color: active || hover ? 'var(--accent)' : 'var(--text-3)',
          display: 'inline-flex'
        }}
      >
        <TypeGlyph type={type} />
      </span>
      <span style={{ color: 'var(--text-faint)', fontFamily: 'var(--mono)' }}>+</span>
      {label}
    </button>
  )
}
```

(d) `styles.dock` (`:462-468`) — move bottom → top:

```tsx
  dock: {
    position: 'absolute',
    top: 14,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 50
  },
```

(e) In `src/renderer/src/canvas/Canvas.tsx:777`, drop the now-removed prop:

```tsx
          <AppChrome onTidy={tidyAndFit} />
```

- [ ] **Step 4: Run tests + typecheck to verify pass**

Run: `pnpm vitest run src/renderer/src/canvas/AppChrome.dock.integration.test.tsx`
Expected: PASS (2 tests).
Run: `pnpm typecheck:web`
Expected: PASS — no unused `onAdd`, the `<AppChrome>` caller compiles. (`EmptyState` still gets its own `onAdd={addCentered}` at `Canvas.tsx:776` — unchanged.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/AppChrome.tsx src/renderer/src/canvas/Canvas.tsx src/renderer/src/canvas/AppChrome.dock.integration.test.tsx
git commit -m "feat(canvas): move dock to top-center and arm a board type on click"
```

---

## Task 4: The placement gesture hook (`useBoardPlacement.ts`)

**Files:**
- Create: `src/renderer/src/canvas/hooks/useBoardPlacement.ts`
- Test: `src/renderer/src/canvas/hooks/useBoardPlacement.test.tsx`

The hook reads `tool` (armed ≡ `tool !== 'select'`), tracks a screen-space `ghost`, and exposes `startPlacement` (the capture overlay's `onPointerDown`). On release it commits via `addBoard` and disarms. Esc cancels.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/hooks/useBoardPlacement.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import { useBoardPlacement } from './useBoardPlacement'
import { useCanvasStore } from '../../store/canvasStore'

// Mock rf.screenToFlowPosition as identity (world == screen). Transform correctness is the
// e2e's job; here we test the hook's wiring + click/drag branching.
const rf = { screenToFlowPosition: (p: { x: number; y: number }) => p } as never

function Harness(): ReactElement {
  const { armed, ghost, startPlacement } = useBoardPlacement(rf)
  return (
    <div
      data-testid="cap"
      data-armed={armed}
      data-ghost={ghost ? `${ghost.w}x${ghost.h}` : 'none'}
      onPointerDown={startPlacement}
    />
  )
}

beforeEach(() => {
  useCanvasStore.setState({ boards: [], connectors: [], selectedId: null, tool: 'terminal', past: [], future: [] })
})
afterEach(() => cleanup())

const down = (el: Element, x: number, y: number): void =>
  fireEvent.pointerDown(el, { clientX: x, clientY: y })
const move = (x: number, y: number): void =>
  act(() => void window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y })))
const up = (x: number, y: number): void =>
  act(() => void window.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: y })))

describe('useBoardPlacement', () => {
  it('armed reflects a non-select tool', () => {
    const { getByTestId } = render(<Harness />)
    expect(getByTestId('cap').getAttribute('data-armed')).toBe('true')
  })

  it('a drag creates a board sized to the rect, then disarms (tool → select)', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 100, 100)
    move(400, 300)
    up(400, 300)
    const boards = useCanvasStore.getState().boards
    expect(boards).toHaveLength(1)
    expect(boards[0]).toMatchObject({ type: 'terminal', x: 100, y: 100, w: 300, h: 200 })
    expect(useCanvasStore.getState().tool).toBe('select')
  })

  it('a sub-threshold click creates a DEFAULT-size board centered on the cursor', () => {
    const { getByTestId } = render(<Harness />)
    down(getByTestId('cap'), 500, 500)
    up(502, 501)
    const b = useCanvasStore.getState().boards[0]
    // terminal default 420x340, centered on (~502,501) → top-left ≈ (292, 331)
    expect(b).toMatchObject({ type: 'terminal', w: 420, h: 340 })
    expect(Math.round(b.x)).toBe(292)
    expect(Math.round(b.y)).toBe(331)
  })

  it('Escape while armed disarms without creating a board', () => {
    render(<Harness />)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(useCanvasStore.getState().boards).toHaveLength(0)
    expect(useCanvasStore.getState().tool).toBe('select')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/hooks/useBoardPlacement.test.tsx`
Expected: FAIL — `Failed to resolve import "./useBoardPlacement"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/renderer/src/canvas/hooks/useBoardPlacement.ts`:

```ts
/**
 * Drag-to-create board placement (redesign 2026-06-06). Armed ≡ the store `tool` is a
 * board type (the dock sets it; see AppChrome.Dock). While armed, Canvas renders a
 * transparent capture overlay whose `onPointerDown` is `startPlacement`:
 *   - drag ≥5px  → a board sized to the dragged rect (world coords, min-clamped), placed exact
 *   - click <5px → a default-size board centered on the cursor (freeSlot-nudged)
 * Either way the tool reverts to 'select'. Esc cancels. The ghost is a screen-space rect
 * (client coords) the overlay draws; world conversion happens only on release.
 *
 * Pointer model mirrors Canvas.tsx's connector rubber-band: pointerdown arms a window
 * pointermove/pointerup pair, removed on release (no per-frame store writes).
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { DEFAULT_BOARD_SIZE, type BoardType } from '../../lib/boardSchema'
import { isClickGesture, normalizeBox, placementRect, type Box } from '../../lib/placement'

export interface BoardPlacementApi {
  /** True while a board type is armed (capture overlay should mount). */
  armed: boolean
  /** Screen-space ghost rect (client coords) while dragging, else null. */
  ghost: Box | null
  /** Capture overlay's `onPointerDown`. */
  startPlacement: (e: ReactPointerEvent) => void
}

export function useBoardPlacement(rf: ReactFlowInstance): BoardPlacementApi {
  const tool = useCanvasStore((s) => s.tool)
  const setTool = useCanvasStore((s) => s.setTool)
  const armed = tool !== 'select'
  const [ghost, setGhost] = useState<Box | null>(null)

  // Esc cancels while armed.
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setGhost(null)
        setTool('select')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armed, setTool])

  const startPlacement = useCallback(
    (e: ReactPointerEvent) => {
      if (tool === 'select') return
      const type = tool as BoardType
      const sx = e.clientX
      const sy = e.clientY
      setGhost({ x: sx, y: sy, w: 0, h: 0 })

      const onMove = (ev: PointerEvent): void => {
        setGhost(normalizeBox(sx, sy, ev.clientX, ev.clientY))
      }
      const onUp = (ev: PointerEvent): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setGhost(null)
        const add = useCanvasStore.getState().addBoard
        if (isClickGesture(ev.clientX - sx, ev.clientY - sy)) {
          const pt = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
          const size = DEFAULT_BOARD_SIZE[type]
          add(type, { x: pt.x - size.w / 2, y: pt.y - size.h / 2 }, { exact: false })
        } else {
          const a = rf.screenToFlowPosition({ x: Math.min(sx, ev.clientX), y: Math.min(sy, ev.clientY) })
          const b = rf.screenToFlowPosition({ x: Math.max(sx, ev.clientX), y: Math.max(sy, ev.clientY) })
          const r = placementRect(a, b)
          add(type, { x: r.x, y: r.y }, { size: { w: r.w, h: r.h }, exact: true })
        }
        setTool('select')
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [tool, rf, setTool]
  )

  return { armed, ghost, startPlacement }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/hooks/useBoardPlacement.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/hooks/useBoardPlacement.ts src/renderer/src/canvas/hooks/useBoardPlacement.test.tsx
git commit -m "feat(canvas): useBoardPlacement gesture hook"
```

---

## Task 5: Wire the overlay + ghost into Canvas (`Canvas.tsx` + `index.css`)

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx` (imports `:13-79`; the inner component body; the overlay JSX inside the `paneRef` div near `:739`)
- Modify: `src/renderer/src/index.css` (append the two classes)

This task has no unit test (JSX wiring through the native camera transform is the e2e's job, Task 6). Verify by typecheck + build; behavior is proven in Task 6.

- [ ] **Step 1: Add the hook import**

In `src/renderer/src/canvas/Canvas.tsx`, with the other `./hooks/*` imports (after `:79`):

```tsx
import { useBoardPlacement } from './hooks/useBoardPlacement'
```

- [ ] **Step 2: Call the hook in the component body**

Near the other hook calls (e.g. just after the `useTidyTile` call at `:428`), add:

```tsx
  const { armed, ghost, startPlacement } = useBoardPlacement(rf)
```

- [ ] **Step 3: Render the capture overlay + ghost**

Inside the `paneRef` div, immediately AFTER `<AlignmentGuides guides={guides} overlaps={overlaps} />` (`:739`), add:

```tsx
          {/* Drag-to-create (redesign 2026-06-06): while a dock button is armed, a transparent
              overlay owns the pointer — boards go non-interactive and React Flow can't pan, so a
              press→drag draws a new board. The ghost is a screen-space rect; world conversion +
              addBoard happen on release (useBoardPlacement). Chrome (z-50) stays above this (z-40),
              so the Select button / other dock buttons remain clickable to re-arm or cancel. */}
          {armed && (
            <div className="placement-capture" onPointerDown={startPlacement}>
              {ghost && (
                <div
                  className="placement-ghost"
                  style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}
                >
                  <span className="placement-ghost-chip">
                    <TypeGlyph type={tool as BoardType} /> {tool}
                  </span>
                </div>
              )}
            </div>
          )}
```

`tool` is read from the store — confirm a `const tool = useCanvasStore((s) => s.tool)` selector exists in the component; if not, add it near the other store selectors. `TypeGlyph` import: add `import { TypeGlyph } from './TypeGlyph'` with the other `./` imports if not already present.

- [ ] **Step 4: Add the CSS**

Append to `src/renderer/src/index.css`:

```css
/* Drag-to-create capture overlay (redesign 2026-06-06). Sits above the React Flow pane
   (boards) but below the floating app chrome (z-50), so the dock stays clickable while armed. */
.placement-capture {
  position: absolute;
  inset: 0;
  z-index: 40;
  cursor: crosshair;
}
.placement-ghost {
  position: absolute;
  border: 1px solid var(--accent);
  background: var(--accent-wash);
  border-radius: var(--r-board);
  pointer-events: none;
}
.placement-ghost-chip {
  position: absolute;
  top: 6px;
  left: 6px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-family: var(--ui);
  font-size: 11px;
  font-weight: 500;
  text-transform: capitalize;
}
```

(If `--r-board` is not a defined token, use `var(--r-ctl)`. Confirm in `index.css` — search `--r-board`; the project's board radius token. Use whichever board-radius token exists.)

- [ ] **Step 5: Verify typecheck + build**

Run: `pnpm typecheck:web && pnpm build`
Expected: PASS — no type errors; the renderer bundles.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx src/renderer/src/index.css
git commit -m "feat(canvas): render placement capture overlay + drag ghost"
```

---

## Task 6: E2E — real drag/click/Esc through the live camera (`placement.e2e.ts`)

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts` (add `setTool` + `getTool` to `CanvasE2E`)
- Create: `e2e/placement.e2e.ts`
- Modify: `docs/testing/TESTING.md` (note the sliver)

Arming is plain state (set via `__canvasE2E.setTool`); the part that ONLY reproduces in the real app — a drag through the live camera transform hitting the capture overlay — is driven with real OS input (`sendInput`). Synthetic `dispatchEvent` would false-green the transform hit-test (memory `e2e-sendinputevent-vs-dispatchevent`).

- [ ] **Step 1: Add the e2e hooks**

In `src/renderer/src/smoke/e2eHooks.ts`, add to the `CanvasE2E` interface (near `setZoom`):

```ts
  setTool: (tool: Tool) => void
  getTool: () => Tool
```

Add `Tool` to the existing `canvasStore` type import (the file already imports from `../store/canvasStore`), and add the two methods to the registry object alongside the others:

```ts
    setTool: (tool) => useCanvasStore.getState().setTool(tool),
    getTool: () => useCanvasStore.getState().tool,
```

- [ ] **Step 2: Write the e2e spec**

Create `e2e/placement.e2e.ts`:

```ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval } from './helpers'

test.describe('drag-to-create board placement (real OS input through the camera)', () => {
  test('a drag creates a board sized to the rectangle', async ({ page, electronApp }) => {
    await evalIn(page, `window.__canvasE2E.setZoom(1)`) // world size == screen drag size
    await evalIn(page, `window.__canvasE2E.setTool('terminal')`)
    expect(await evalIn<number>(page, `window.__canvasE2E.getBoards().length`)).toBe(0)

    const drag = async (x1: number, y1: number, x2: number, y2: number): Promise<void> => {
      await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 })
      await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: x2, y: y2, button: 'left' })
      await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
    }
    await drag(420, 360, 720, 580) // 300 x 220, in the lower-middle (clear of the top chrome)

    expect(await pollEval(page, `window.__canvasE2E.getBoards().length === 1`, 4000)).toBe(true)
    const b = await evalIn<{ type: string; w: number; h: number }>(
      page,
      `(() => { const b = window.__canvasE2E.getBoards()[0]; return { type: b.type, w: b.w, h: b.h }; })()`
    )
    expect(b.type).toBe('terminal')
    expect(Math.abs(b.w - 300)).toBeLessThanOrEqual(10)
    expect(Math.abs(b.h - 220)).toBeLessThanOrEqual(10)
    // armed tool reverted to select after the create
    expect(await evalIn<string>(page, `window.__canvasE2E.getTool()`)).toBe('select')
  })

  test('a click spawns a default-size board', async ({ page, electronApp }) => {
    await evalIn(page, `window.__canvasE2E.setTool('browser')`)
    await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x: 500, y: 500, button: 'left', clickCount: 1 })
    await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x: 501, y: 500, button: 'left', clickCount: 1 })
    expect(await pollEval(page, `window.__canvasE2E.getBoards().length === 1`, 4000)).toBe(true)
    const b = await evalIn<{ type: string; w: number; h: number }>(
      page,
      `(() => { const b = window.__canvasE2E.getBoards()[0]; return { type: b.type, w: b.w, h: b.h }; })()`
    )
    expect(b).toEqual({ type: 'browser', w: 700, h: 500 }) // DEFAULT_BOARD_SIZE.browser
  })

  test('Escape while armed cancels — no board, tool back to select', async ({ page }) => {
    await evalIn(page, `window.__canvasE2E.setTool('planning')`)
    await page.keyboard.press('Escape')
    expect(await evalIn<number>(page, `window.__canvasE2E.getBoards().length`)).toBe(0)
    expect(await evalIn<string>(page, `window.__canvasE2E.getTool()`)).toBe('select')
  })
})
```

- [ ] **Step 3: Run the e2e (Windows leg)**

Run: `pnpm test:e2e -- placement`
Expected: PASS (3 tests). If the drag board lands off-size, the camera wasn't at zoom 1 — confirm `setZoom(1)` ran before arming. (`reset()` runs per-test via the fixture, so each test starts from a clean canvas.)

- [ ] **Step 4: Note the sliver in TESTING.md**

In `docs/testing/TESTING.md`, in the **Browser board / preview** (or a canvas) row's e2e-sliver list, add: `drag-to-create board (real drag through the camera) · click-spawn default · Esc cancel (e2e/placement.e2e.ts)`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/smoke/e2eHooks.ts e2e/placement.e2e.ts docs/testing/TESTING.md
git commit -m "test(e2e): drag-to-create placement (drag/click/Esc through the camera)"
```

---

## Final verification

- [ ] **Full gate (local):**

```bash
pnpm typecheck:web && pnpm lint && pnpm format:check && pnpm test
```

Expected: typecheck clean; lint 0 errors; format clean (run `pnpm format` on touched files first if needed — memory `gate-must-run-format-check`); all unit + integration green (existing baseline + the new placement/store/dock/hook tests).

- [ ] **E2E (the new surface):** `pnpm test:e2e -- placement` green on Windows. (Full `pnpm test:e2e:matrix` runs on commit via the pre-commit hook — the junctioned worktree needs the token'd `node_modules` + Docker for the Linux leg; if unavailable, commit the e2e task with `--no-verify` and note it, per memory `mcp-publish-gating`.)

- [ ] **Manual smoke (`pnpm dev`):** dock is top-center; clicking +Terminal shows the button active + crosshair cursor; click spawns a default terminal at the cursor; drag spawns a sized board; Esc mid-arm cancels; Select disarms; the tool reverts to select after each create.

---

## Self-review notes (addressed)

- **Spec coverage:** state model (Task 3, via `tool`), `addBoard` size/exact (Task 2), gesture state machine + click/drag/Esc (Task 4), dock move (Task 3), ghost visual (Task 5), pure helper (Task 1), all tests incl. the e2e sliver (Tasks 1–6). The spec's `panOnDrag` mechanism is intentionally superseded by the capture overlay (documented above) — same UX.
- **Browser preset** independence: no code touches the preset on create — `createBoard('browser', …)` keeps `viewport: 'desktop'` (`boardSchema.ts:228`); the drag only sets `w/h`. Requirement met by omission.
- **No schema bump:** size persists via the existing `boards[].w/h`; `tool` is ephemeral.
- **Type consistency:** `Box`, `normalizeBox`, `isClickGesture`, `placementRect`, `BoardPlacementApi`, the `addBoard` opts `{id?,size?,exact?}`, and the `__canvasE2E` `setTool/getTool` names are used identically across tasks.
