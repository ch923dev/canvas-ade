# Planning Full-View = Camera-Fit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Planning board's "Full view" zoom the React Flow **camera** to fit the board (reusing the proven Focus path) instead of portaling it into a modal + applying a second CSS transform — eliminating the nested-transform that breaks click-to-place and drag.

**Architecture:** The bug's root cause (see `docs/research/2026-06-02-infinite-canvas-coordinate-model.md`): full-view stacks a **second** coordinate transform on the planning well; `toBoard` only inverts ONE. Fix = don't add a second transform. Planning full-view becomes a camera-fit (`rf.fitView({ nodes:[board] })`) with the board staying **in the canvas** under the single parent camera — so `toBoard`, add-note, drag, and snapping work identically to the normal canvas. A new `cameraFullViewId` (separate from the portal `fullViewId`) drives a dim + exit + viewport-restore. Browser/Terminal keep the existing portal modal (they need it to keep live native content — WebContentsView/PTY — alive). The earlier portal/CSS-transform experiments in `PlanningBoard` are reverted; the independent ChecklistCard drag fix is kept.

**Tech Stack:** React 18 + TypeScript, `@xyflow/react` (React Flow v12) camera (`rf.fitView`/`rf.getViewport`/`rf.setViewport`), Zustand store, the `CANVAS_SMOKE=e2e` real-input harness (`win.webContents.sendInputEvent`).

---

## File Structure

- `src/renderer/src/canvas/boards/PlanningBoard.tsx` — **revert** the full-view stage/`fvFit`/transform experiment back to the plain `inset:0` well; remove the `BoardFullViewContext`/`fitToContent`/`useEffect` measurement code added during the experiments. (Keep nothing fit-related.)
- `src/renderer/src/canvas/boards/planning/fullViewFit.ts` + `fullViewFit.test.ts` — **delete** (no longer used).
- `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx` — **unchanged from the drag fix** (whole-body drag surface stays).
- `src/renderer/src/canvas/Canvas.tsx` — **the core change**: add `cameraFullViewId` state + `priorViewportRef` + `FULLVIEW_OPTIONS` + `enterCameraFullView`/`exitCameraFullView`; branch `requestFullView` by board type; fold `cameraFullViewId` into the node `dimmed`/`fullView` data, the Esc handler, the board-removed cleanup effect, and pane-click.
- `src/renderer/src/canvas/BoardNode.tsx` — **no change expected** (a planning board with `data.fullView=true` and no modal host already stays in-node via `anchorRef`, and still provides `BoardFullViewContext` for the title-bar "exit" affordance). Confirm during Task 3.
- `src/main/e2e/probes/whiteboard.ts` — **add** a real-input (`sendInputEvent`) probe `whiteboard-fullview-add` that enters camera-full-view on a planning board, clicks to add a note, and asserts it lands in-bounds under the cursor; register it in `src/main/e2e/index.ts`.

---

### Task 1: Revert the PlanningBoard full-view experiments (keep ChecklistCard fix)

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx`
- Delete: `src/renderer/src/canvas/boards/planning/fullViewFit.ts`, `src/renderer/src/canvas/boards/planning/fullViewFit.test.ts`

- [ ] **Step 1: Delete the now-unused fit helper + its test**

```bash
git rm src/renderer/src/canvas/boards/planning/fullViewFit.ts \
       src/renderer/src/canvas/boards/planning/fullViewFit.test.ts
```

- [ ] **Step 2: Remove the experiment imports from PlanningBoard.tsx**

Remove these lines (added during the experiments):
- `useContext`, `useEffect`, `type CSSProperties` from the `react` import (restore to `useCallback, useRef, useState, type MouseEvent, type PointerEvent, type ReactElement`).
- `import { BoardFullViewContext } from '../fullViewContext'`
- `import { fitToContent, type FitTransform } from './planning/fullViewFit'`
- Keep `elementBBox, unionBBox` in the `./planning/elements` import only if still used elsewhere; if they were imported solely for the fit, drop them (verify with a grep — they are also used by the snap pass in `onWellPointerMove`, so they STAY).

- [ ] **Step 3: Remove the `fullView` hook + the stage/fit effects + `wellStyle`**

Delete: the `const fullView = useContext(BoardFullViewContext)` line; the entire `// ── Full-view fit-to-content` block (the `stageRef`/`stageSize`/`fvFit`/`elementsRef` state, the two `useEffect`s, and the `wellStyle` const).

- [ ] **Step 4: Restore the well to the plain inset:0 render (remove the stage wrapper)**

The render returns to: `<BoardFrame ...><div ref={wellRef} className="pl-well" ... style={{ position:'absolute', inset:0, overflow:'hidden', cursor: <the tool ternary>, backgroundImage:'radial-gradient(var(--grid-dot) 1px, transparent 1px)', backgroundSize:'12px 12px', backgroundPosition:'6px 6px', touchAction:'none' }}>{…children…}</div></BoardFrame>` — i.e. no `pl-fv-stage` wrapper, inline style as it was before the experiments. (Reference: the pre-experiment version is the parent commit of this branch's working changes.)

- [ ] **Step 5: Verify gate on the revert**

Run: `pnpm -C "Z:/canvas-ade-wb-sync" typecheck:web && pnpm -C "Z:/canvas-ade-wb-sync" exec eslint src/renderer/src/canvas/boards/PlanningBoard.tsx src/renderer/src/canvas/boards/planning/ChecklistCard.tsx && pnpm -C "Z:/canvas-ade-wb-sync" exec vitest run src/renderer/src/canvas/boards/planning/`
Expected: typecheck clean; lint 0 errors; planning tests pass (the 8 fullViewFit tests are gone with the file; ChecklistCard test still green).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -F - <<'EOF'
revert(planning): drop the full-view portal/CSS-transform fit experiment

Option A (camera-fit, see docs/research/2026-06-02-infinite-canvas-coordinate-model.md)
moves full-view zoom to the React Flow camera, so the planning well needs no second
transform. Removes fullViewFit.ts + the stage/measure/transform code in PlanningBoard;
the well returns to the plain inset:0 render. The independent ChecklistCard whole-body
drag fix stays.
EOF
```

---

### Task 2: Add the camera-full-view state + enter/exit helpers in Canvas.tsx

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Import the `Viewport` type**

Add `Viewport` to the existing `@xyflow/react` type imports (it already imports React Flow types near the top).

- [ ] **Step 2: Add the fit options constant (beside `FOCUS_OPTIONS`, ~line 74)**

```ts
// Planning full view fits TIGHTER than focus (fills more of the viewport). Vector
// content (notes/pen) re-rasterises crisp at any zoom, so Z_MAX is fine.
const FULLVIEW_OPTIONS = { padding: 0.1, maxZoom: Z_MAX } as const
```

- [ ] **Step 3: Add state + refs (beside `fullViewId`, ~line 135)**

```ts
// Planning "full view" is a CAMERA fit (Option A), NOT the portal modal — it keeps the
// board in the canvas under the single parent camera so toBoard/add/drag stay correct.
// Separate id so it never collides with the portal `fullViewId` (browser/terminal).
const [cameraFullViewId, setCameraFullViewId] = useState<string | null>(null)
const cameraFullViewIdRef = useRef<string | null>(null)
useEffect(() => {
  cameraFullViewIdRef.current = cameraFullViewId
}, [cameraFullViewId])
// Viewport captured on enter so exit returns the user where they were.
const priorViewportRef = useRef<Viewport | null>(null)
```

- [ ] **Step 4: Add enter/exit helpers (near `openFullView`/`closeFullView`, ~line 168)**

```ts
const enterCameraFullView = useCallback(
  (id: string) => {
    // Portal full-view and camera full-view are mutually exclusive.
    hardCloseFullView()
    priorViewportRef.current = rf.getViewport()
    setCameraFullViewId(id)
    selectBoard(id)
    void rf.fitView(cameraAnim({ ...FULLVIEW_OPTIONS, nodes: [{ id }] }))
  },
  [rf, selectBoard, hardCloseFullView]
)
const exitCameraFullView = useCallback(() => {
  if (!cameraFullViewIdRef.current) return
  setCameraFullViewId(null)
  const vp = priorViewportRef.current
  priorViewportRef.current = null
  if (vp) void rf.setViewport(vp, cameraAnim({}))
}, [rf])
```

- [ ] **Step 5: Typecheck (no behaviour wired yet)**

Run: `pnpm -C "Z:/canvas-ade-wb-sync" typecheck:web`
Expected: clean (helpers defined, `cameraFullViewId` unused-for-now is fine — it's read in Task 3; if lint flags unused, proceed straight to Task 3 in the same commit).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx && git commit -m "feat(canvas): camera-full-view state + enter/exit helpers (Planning Option A)"
```

---

### Task 3: Wire camera-full-view into requestFullView, dim, affordance, Esc, cleanup

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`
- Verify: `src/renderer/src/canvas/BoardNode.tsx` (expect no change)

- [ ] **Step 1: Branch `requestFullView` by board type (~line 531)**

```ts
requestFullView: (id) => {
  const type = useCanvasStore.getState().boards.find((b) => b.id === id)?.type
  if (type === 'planning') {
    cameraFullViewIdRef.current === id ? exitCameraFullView() : enterCameraFullView(id)
  } else {
    fullViewIdRef.current === id ? closeFullView() : openFullView(id)
  }
},
```
Add `enterCameraFullView`, `exitCameraFullView` to the surrounding `useMemo`/`useCallback` deps.

- [ ] **Step 2: Fold `cameraFullViewId` into the node data (`nodes` memo, ~line 196)**

```ts
dimmed:
  (focusedId !== null && focusedId !== b.id) ||
  (cameraFullViewId !== null && cameraFullViewId !== b.id),
fullView: fullViewId === b.id || cameraFullViewId === b.id
```
Add `cameraFullViewId` to the `nodes` memo dependency array.

- [ ] **Step 3: Handle Esc + pane-click exit**

In the Esc keydown handler (~line 652): `if (e.key === 'Escape' && (fullViewId || cameraFullViewId)) { … if (cameraFullViewId) exitCameraFullView(); else closeFullView() }` (add `cameraFullViewId`, `exitCameraFullView` to that effect's deps). In `onPaneClick` (the empty-canvas click handler — find the existing one that clears selection/focus): add `exitCameraFullView()`.

- [ ] **Step 4: Clear on board removal (the boards-changed cleanup effect, ~line 584)**

Beside the existing `focusedId`/`fullViewId` cleanup, add: if `cameraFullViewId` is set and no board matches it, clear it (no viewport restore needed — the board is gone): `setCameraFullViewId((c) => (c !== null && !boards.some((b) => b.id === c) ? null : c))`.

- [ ] **Step 5: Clear on delete/duplicate/push of the full-viewed board**

In the boardActions `remove`/`duplicate`/`pushPreviewTo` handlers that already call `hardCloseFullView()` when `fullViewIdRef.current === id`, also handle the camera case: `if (cameraFullViewIdRef.current === id) exitCameraFullView()`.

- [ ] **Step 6: Verify BoardNode does NOT portal planning**

Read `BoardNode.tsx` lines ~168-171 and ~206-227. Confirm: with `data.fullView=true` but `fullViewHost` null (no modal rendered for planning), `target = fullView && fullViewHost ? fullViewHost : anchorRef.current` resolves to `anchorRef.current` → the board stays in the node (no portal), and `BoardFullViewContext.Provider value={fullView}` is still `true` → the title-bar shows "exit full view". If any assumption is false, note the minimal fix; otherwise no change.

- [ ] **Step 7: Gate + live manual check via HMR**

Run: `pnpm -C "Z:/canvas-ade-wb-sync" typecheck && pnpm -C "Z:/canvas-ade-wb-sync" lint && pnpm -C "Z:/canvas-ade-wb-sync" exec prettier --check src/renderer/src/canvas/Canvas.tsx`
Then in the running dev app (hard-reload): ⋯ → Full view on a planning board → camera fits it, others dim, title-bar shows exit; **note tool → click lands under the cursor, in-bounds; checklist drags; Esc restores the prior viewport.**
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(canvas): Planning Full view = camera fit (dim + exit + viewport restore)"
```

---

### Task 4: Real-input e2e regression probe

**Files:**
- Modify: `src/main/e2e/probes/whiteboard.ts`, `src/main/e2e/index.ts`
- Check: `src/main/e2e/context.ts` (the `ctx` already exposes `win`; `sendInputEvent` is `ctx.win.webContents.sendInputEvent`)

- [ ] **Step 1: Add a real-input probe that drives the camera-full-view add-note**

Add `whiteboardFullviewAdd` to `whiteboard.ts`. It must: (a) seed/locate the planning board (`ctx.ids.planId`); (b) trigger camera-full-view via a harness hook (extend `window.__canvasE2E` with `enterCameraFullView(id)`/`exitCameraFullView()` mapped to the new Canvas helpers, mirroring how `openFullViewAnimated` is exposed at `Canvas.tsx:682`); (c) select the note tool + compute the well's on-screen point via `getBoundingClientRect`; (d) `ctx.win.webContents.sendInputEvent({type:'mouseDown'|'mouseUp', x, y, button:'left', clickCount:1})` at that point (REAL OS input — synthetic `dispatchEvent` false-greens, memory `e2e-sendinputevent-vs-dispatchevent`); (e) assert the new note's board-local `x` is within `[0, board.w]` and within a few px of the expected `toBoard(click)` — not merely "a note exists".

- [ ] **Step 2: Register it in the playlist**

In `src/main/e2e/index.ts` add `whiteboardFullviewAdd` to the imports and to `PLAYLIST` after `whiteboardSelection`, before `seed`.

- [ ] **Step 3: Build + run the harness (kill stray electron first)**

Run: `Get-Process electron | Stop-Process -Force` (PowerShell) then `pnpm -C "Z:/canvas-ade-wb-sync" build` and `CANVAS_SMOKE=e2e` run.
Expected: `E2E_WHITEBOARD-FULLVIEW-ADD {"ok":true,...}` and `E2E_DONE {"ok":true}`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(e2e): real-input probe for Planning camera-full-view add-note"
```

---

### Task 5: Full gate + user verification + cleanup

- [ ] **Step 1: Full gate**

Run: `pnpm -C "Z:/canvas-ade-wb-sync" typecheck && pnpm -C "Z:/canvas-ade-wb-sync" lint && pnpm -C "Z:/canvas-ade-wb-sync" run format:check && pnpm -C "Z:/canvas-ade-wb-sync" test`
Expected: all green.

- [ ] **Step 2: e2e harness (full playlist)**

Build + `CANVAS_SMOKE=e2e` run. Expected: `E2E_DONE {"ok":true}` (browser-trio may flake — rerun; memory `e2e-browser-trio-flake`).

- [ ] **Step 3: User live verification (real mouse)**

User confirms in the dev app: Planning full view fits + dims; add-note lands under cursor and survives exit; checklist drags; Esc/exit restores the viewport. (This is the authoritative check — synthetic tests lie here.)

- [ ] **Step 4: Update the research/handoff status + the coordination row; commit**

Note in `docs/research/2026-06-02-infinite-canvas-coordinate-model.md` that Option A shipped; mark the prior `docs/superpowers/handoffs/2026-06-02-planning-fullview-and-drag-bugs.md` bug-1 resolved.

---

## Notes / decisions locked

- **Camera moves on Planning full view** (focus already did; the portal-era "full view doesn't move the camera" rule applies only to the Browser/Terminal portal path). Viewport is saved on enter and restored on exit.
- **Dim** reuses the existing focus-dim opacity via the `dimmed` node flag (now also driven by `cameraFullViewId`); no separate scrim layer for the MVP. A deeper scrim can be added later if the dim reads too soft.
- **Mutually exclusive** with the portal full-view (`enterCameraFullView` calls `hardCloseFullView` first).
- **Bounded-box clipping is NOT solved here** (Option C territory) — but with the camera at the board's fit, "natural" clicks land inside the box, so the practical bug is gone. If users still place off-box content, schedule Option C (unbounded world coords).
- **No new schema / no migration.**
