# Design — Phase 3 Slice B: Board actions (Full view · Duplicate · ⋯ menu)

**Date:** 2026-05-30
**Phase/slice:** Phase 3 · Slice B. **Focus is already implemented** (`Canvas.tsx` `focusedId` +
dim + double-click). This slice = **Full view + Duplicate + the ⋯ overflow menu**. Project
persistence (Slice A) and git worktrees + per-board ports (Slice C) are out of scope.
**Branch:** `phase-3-board-actions` off `phase-3-persistence` (stacks — overlaps `canvasStore.ts`,
`Canvas.tsx`, `BoardFrame.tsx`, `BoardNode.tsx`, `BrowserPreviewLayer.tsx`).

## Goal

Add the two board-level actions from DESIGN.md §6.1 plus their menu:
- **Full view** — lift one board into a fullscreen modal (does NOT move the camera; distinct from
  Focus). Live + interactive (the single live instance is relocated, never re-mounted).
- **Duplicate** — clone a board (geometry + state) offset 36px and select the copy.
- **⋯ overflow menu** — Full view · Duplicate · Delete, identical across all three board types.

## Decisions (locked this session)

- **Full-view rendering:** live relocation. HTML content (Terminal xterm host, Planning) is
  React-portaled into the modal (same component instance → no remount → live PTY/xterm/elements
  survive). The Browser native `WebContentsView` is re-bounded to the modal rect (it's already a
  free OS layer synced by bounds); all other native views detach.
- **Browser band placement:** the `FULL VIEW` band is an HTML strip ABOVE the content rect — a
  native view paints above all HTML, so the band cannot overlay it. Layout: band strip on top,
  content rect (native view) below. Same layout for HTML types (visual consistency).
- **Duplicate / Terminal:** copy clones config (`shell`/`launchCommand`/`cwd`/`port`); the copy
  mounts like any new Terminal → spawns its own shell + runs `launchCommand`. Independent PTY.
- **Duplicate / Browser:** `viewport = nextViewport(src.viewport)` (mobile→tablet→desktop→mobile),
  for side-by-side preset comparison.
- **Duplicate / Planning:** deep-clone `elements`, regenerate every element id.
- **Duplicate is one undo step.**
- **⋯ menu** = Full view · Duplicate · Delete (DESIGN §6.1). Delete routes through the existing
  `removeBoard` (+ terminal park-on-delete) and closes full view if open.

## Architecture

Two orthogonal pieces:

1. **Duplicate** — a pure store action + a viewport-cycle helper. No UI risk.
2. **Full view** — ephemeral Canvas-local state (`fullViewId`) + an HTML modal + a single
   `createPortal` swap in `BoardNode` (the no-remount mechanism) + a native-view re-bound in the
   preview layer for Browser boards.

Board action handlers reach the per-type board components through a `BoardActionsContext` that
`Canvas` provides and `BoardNode` consumes (building per-id callbacks), passed down via
`BoardViewProps`. The ⋯ menu itself lives in the shared `BoardFrame` (defined once, identical for
all types).

## Components

### 1. `lib/viewportCycle.ts` (new, pure)

```ts
import type { BrowserViewport } from './boardSchema'
const ORDER: readonly BrowserViewport[] = ['mobile', 'tablet', 'desktop']
export function nextViewport(v: BrowserViewport): BrowserViewport {
  return ORDER[(ORDER.indexOf(v) + 1) % ORDER.length]
}
```

### 2. `store/canvasStore.ts` — `duplicateBoard(id): string | null`

- Find source; if absent return `null`.
- `set`: `past: recordPast(s.past, s.boards)`, `future: []`, append the clone, `selectedId: cloneId`.
- Clone: `structuredClone(src)`, new `id`, `x: src.x + 36`, `y: src.y + 36`, drop `z` (re-stacks on
  top naturally by array order, matching add).
- Per type: Browser `viewport = nextViewport(src.viewport)`; Planning
  `elements = src.elements.map((e) => ({ ...structuredClone(e), id: newId() }))`.
- Returns the new id. Added to `CanvasState` interface + initial impl.

### 3. Full-view state — `Canvas.tsx` local

- `const [fullViewId, setFullViewId] = useState<string | null>(null)`.
- Cleared when the board is removed (extend the existing focus-heal effect to also drop a stale
  `fullViewId`).
- Node data: `fullView: fullViewId === b.id` added to each node's `data` (alongside `dimmed`).
- Keydown: if `fullViewId` is set, Esc closes full view and `return`s (does not also clear
  selection/focus). Otherwise existing Esc behavior.

### 4. `canvas/FullViewModal.tsx` (new) + `canvas/fullViewContext.ts` (new)

- `FullViewContext = createContext<{ hostEl: HTMLElement | null } | null>(null)` — the portal target.
- `FullViewModal({ board, onClose })`:
  - Overlay `position:fixed; inset:0; z-index:200`.
  - Scrim `rgba(0,0,0,0.66)`; click on the scrim (not the frame) → `onClose`.
  - Centered frame: inset ~`5vh/5vw`, `border-radius: var(--r-board)`, `box-shadow: 0 0 0 1.5px
    var(--accent), var(--shadow-board)`, `overflow:hidden`, flex column.
  - **Band** (~40px, `flex:none`, `--surface-raised`): mono `FULL VIEW` label (left) + a `✕` button
    with an `Esc` hint (right).
  - **Host** (`flex:1`, `position:relative`): a `ref`'d div = the portal target. Its element is
    published via `FullViewContext.Provider` so the matching `BoardNode` portals into it.
- Rendered by `Canvas` when `fullViewId` resolves to a board.

### 5. `canvas/BoardNode.tsx` — portal relocation

- Read `fullView` from node data (`data.fullView`).
- Read `FullViewContext`. When `fullView && ctx?.hostEl`, wrap the board's rendered subtree (the
  `<div onMouseEnter…>{board dispatch}</div>` block) in `createPortal(subtree, ctx.hostEl)`.
  Same JSX element → React keeps the component instance mounted (no PTY/xterm/native remount).
- When portaled, the in-canvas node renders an empty placeholder (it sits behind the scrim anyway).
- Build per-id action callbacks from `BoardActionsContext` and pass `onFull`/`onDuplicate`/`onDelete`
  into the board component via `BoardViewProps`.

### 6. `canvas/BoardFrame.tsx` — ⋯ menu (DRY, shared)

- Replace the `onMore?` prop with `onDuplicate?: () => void` and `onDelete?: () => void` (keep
  `onFull?`).
- The ⋯ `IconBtn` toggles an internal popover (local `useState`), anchored below the button:
  - **⬢ Full view** → `onFull` (only if provided)
  - **⧉ Duplicate** → `onDuplicate`
  - **✕ Delete** → `onDelete` (danger styling)
- Popover closes on item click, Esc, or outside-click (a `pointerdown` listener on `document` while
  open). `onMouseDown` stops drag propagation (matches `IconBtn`).

### 7. `BoardNode` → board components → `BoardFrame` wiring

- Extend `BoardViewProps` with optional `onFull?`, `onDuplicate?`, `onDelete?: () => void`.
- Each of `TerminalBoard` / `BrowserBoard` / `PlanningBoard` forwards these straight into its
  `BoardFrame` (they already render `BoardFrame`).
- `BoardActionsContext = createContext<{ requestFullView(id): void; duplicate(id): void;
  remove(id): void } | null>(null)`, provided by `Canvas` (wraps `setFullViewId`,
  `duplicateBoard`, `removeBoard`). `BoardNode` consumes it and constructs the per-id callbacks.

### 8. `canvas/boards/BrowserPreviewLayer.tsx` — native view in full view

- Accept a new `fullViewId: string | null` prop (sibling to `focusedId`).
- When `fullViewId` is set and that board is a Browser board: target its native view bounds to the
  modal **content host** rect (read the portal host element's `getBoundingClientRect()`), zoomFactor
  per its viewport preset; **detach every other live view** for the duration. On exit, resume the
  normal camera-synced reconcile.
- The portal host element is the same one the band sits above, so the view fills the content area
  cleanly and the band is never punched through.

### 9. `Canvas.tsx` — assembly

- Provide `BoardActionsContext`; pass `fullView` into node data; render `<FullViewModal>` when
  `fullViewId` resolves; pass `fullViewId` to `<BrowserPreviewLayer>`; Esc-priority handling.

## Data flow

- **Duplicate:** ⋯→Duplicate (or future shortcut) → `BoardActionsContext.duplicate(id)` →
  `duplicateBoard` → clone appended + selected → React Flow renders the new node 36px offset.
- **Open full view:** maximize btn / ⋯→Full view → `setFullViewId(id)` → node data `fullView=true`
  → `BoardNode` portals the board subtree into `FullViewModal`'s host → (Browser) preview layer
  re-bounds the native view to the host rect, others detach.
- **Close full view:** Esc / ✕ / scrim-click → `setFullViewId(null)` → portal returns subtree to the
  canvas node → (Browser) preview layer resumes camera sync.

## Error handling / edge cases

- Duplicate of a missing id → `null`, no-op.
- Full view of a board that gets deleted (menu Delete while open, or undo) → the focus-heal effect
  drops the stale `fullViewId`; `FullViewModal` unmounts; portal naturally returns/destroys.
- Esc while both full view and a selection exist → full view closes first (priority), selection
  intact.
- xterm in full view: the DOM reparent triggers its existing `ResizeObserver`→FitAddon refit + PTY
  resize; reverts on close. No new resize plumbing.
- Browser scrim-click exit is only reachable on the scrim margin (the native view absorbs clicks on
  the page); Esc and ✕ are always available — documented, acceptable.
- Only one board in full view at a time (`fullViewId` is a single id).

## Testing

- `lib/viewportCycle.test.ts` — cycle mobile→tablet→desktop→mobile.
- `lib/fullViewLayout.test.ts` — pure helper computing the content-host rect (and band height) from
  a pane rect; the Browser-bounds math.
- `store/canvasStore.test.ts` (extend):
  - duplicate offsets +36, assigns a new id, selects the copy, grows `past` by exactly 1, and a
    single undo restores the pre-duplicate boards.
  - Browser duplicate sets the next viewport preset.
  - Planning duplicate deep-clones elements with fresh ids (no shared element id, not the same array
    ref).
  - duplicate of an unknown id returns null and mutates nothing.
- Portal relocation + native re-bound: manual verify (Playwright e2e later) — `pnpm dev`: open full
  view on each type (Terminal keeps live session + scrolls; Planning interactive; Browser fills the
  modal live, band above it); Esc/✕/scrim close; Duplicate a Browser → next preset, side-by-side.

## Out of scope

- Focus (already shipped).
- git worktrees + per-board ports (Slice C).
- Inline title editing (DESIGN mentions double-click title edit — separate concern, not this slice).
- Persistence of `fullViewId`/`focusedId` (ephemeral UI, never persisted).

## Risks

- **Portal-into-modal (#5)** is the riskiest piece — React Flow owns the node DOM, and reparenting
  the xterm host must not drop the WebGL context or the MessagePort. Mitigation: a single
  `createPortal` swap of the existing subtree (no manual DOM moves, no remount); verify the live
  terminal survives empirically.
- **Native-view bounds in full view (#8)** must read the live host rect AFTER layout — compute on
  the rAF tick the preview layer already runs, not during React render.
