# Browser preview camera-sync — ROOT CAUSE (confirmed by code + live measurement)

**Status:** Root cause identified and reproduced in the built app. **Next session must independently
re-verify** (re-run the diagnostic, prove the fix hypothesis with a minimal change) before implementing.
**Branch:** `fix/preview-camera-sync` (worktree `Z:\canvas-ade-preview-camera-sync`).
**Date:** 2026-06-06.

> Companion doc on this branch: `2026-06-06-browser-preview-layer-alignment.md` — the earlier
> multi-agent workflow research. It was **inconclusive** (chased full-view edge cases off the
> screenshot) and is superseded by THIS doc. Keep it for the trail; trust this one.

---

## Symptom (user-reported, reproduced)

On a Browser board, the native `WebContentsView` (the live localhost page) **does not follow the
camera**. Pan/scroll the canvas (or zoom) and the white page detaches from its HTML device frame —
the native rect stays frozen where it was while the rounded HTML frame travels with the camera. The
page reads as "white out of bounds, content at the bottom." Happens on **every** pan/zoom. The user's
exact words: *"everything loses whenever I drag, I moved, I resized the browser… the camera of the
canvas moved to the right, and the browser bugs."*

---

## Root cause

**React Flow's `useOnViewportChange` writes to a SINGLE store slot. It is not additive. The app calls
it twice, and the second registration clobbers the first.**

React Flow 12.10.2 implementation (`node_modules/@xyflow/react/dist/esm/index.js:3988`):

```js
function useOnViewportChange({ onStart, onChange, onEnd }) {
  const store = useStoreApi();
  useEffect(() => { store.setState({ onViewportChangeStart: onStart }); }, [onStart]);
  useEffect(() => { store.setState({ onViewportChange: onChange }); }, [onChange]);
  useEffect(() => { store.setState({ onViewportChangeEnd: onEnd }); }, [onEnd]);
}
```

Each call overwrites the store's single `onViewportChangeStart/onViewportChange/onViewportChangeEnd`
fields. The d3-zoom handlers call exactly those fields on a camera gesture (`index.js:1311/1321`).

The app registers **two** consumers:

1. **`src/renderer/src/canvas/Canvas.tsx:674`** — autosave viewport persistence:
   ```js
   useOnViewportChange({ onChange: (vp) => setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }) })
   ```
2. **`src/renderer/src/canvas/boards/usePreviewManager.ts:671`** — the camera→native sync:
   ```js
   useOnViewportChange({ onStart: beginMotion, onChange: startPump, onEnd: endMotion })
   ```

**React runs descendant effects before ancestor effects.** `usePreviewManager` is a descendant
(mounted inside `<ReactFlow>`, which is inside `Canvas`). So the preview manager registers first;
then `Canvas` registers second and **overwrites all three slots**:

- `onViewportChange` → Canvas's autosave (clobbers `startPump`)
- `onViewportChangeStart` → **`undefined`** (Canvas passes no `onStart` → clobbers `beginMotion`)
- `onViewportChangeEnd` → **`undefined`** (clobbers `endMotion`)

Net effect: **on a camera pan/zoom, none of the preview manager's camera callbacks fire.** The native
view is never detached (no `beginMotion`) and never repositioned (no `startPump` → no rAF pump → no
`setBounds`). It stays pinned at whatever bounds the last *store-subscription* path
(reconcile on board-mutation / node-gesture / focus / full-view) set. The HTML frame, positioned by
the React Flow camera transform, moves; the native view does not. They split.

### Why it shipped unnoticed

- The autosave `useOnViewportChange` was added later (its comment literally says *"no new pump"* — the
  author assumed `onChange` was additive). It silently disabled the preview's camera sync.
- The e2e suite only exercises the **node-gesture** detach/reattach path (`setGesture(true/false)` →
  store subscription, still works) and a single-board `fitView`. **No test ever asserted "pan the
  camera, is the native view still aligned with its frame?"** — that is the coverage gap.

---

## Evidence (live measurement, built app)

A diagnostic spec (`e2e/preview-align.e2e.ts`, on this branch) measures the native view's bounds
(`viewBounds` main getter, added to `preview.ts` + `e2eMain.ts`) vs the HTML `.bb-frame`
`getBoundingClientRect`, after each motion. Temporary counters in `usePreviewManager.ts`
(`previewDebug`, exposed on `window.__previewDebug`) count pump activity.

**Clean panOnScroll-only run** (the app uses `panOnScroll` with `zoomActivationKeyCode=['Meta','Control']`,
so plain wheel/trackpad = PAN — the user's exact gesture):

```
baseline:  native={x:25,y:79}  frame={x:307,y:220}   pumps:0 beginMotions:0 endMotions:0 lastVp:(0,0,1)
pan step0: native={x:25,y:79}  frame={x:307,y:175}   pumps:0 beginMotions:0 endMotions:0 lastVp:(0,0,1)
pan step1: native={x:25,y:79}  frame={x:307,y:130}   pumps:0 beginMotions:0 endMotions:0 lastVp:(0,0,1)
pan step2: native={x:25,y:79}  frame={x:307,y: 85}   pumps:0 beginMotions:0 endMotions:0 lastVp:(0,0,1)
pan step3: native={x:25,y:79}  frame={x:307,y: 40}   pumps:0 beginMotions:0 endMotions:0 lastVp:(0,0,1)
```

The frame moves every step; the native is frozen; **`pumps:0` and `beginMotions:0` every step** — the
camera pump never ran and the detach never fired. That is the smoking gun.

Corroborating facts established along the way (all ruled-in/out with evidence):
- `devicePixelRatio = 1` → **DPI is NOT involved** (the workflow's DPI angle is moot here).
- The rest-state geometry math IS congruent — `worldRectToScreen` is the exact RF transform and both
  layers derive from `deviceStageRect`/`deviceFrameRect`. The bug is NOT in the formula; it is that the
  formula is never re-applied on a camera move.
- Store-subscription paths (board resize, node-gesture wrap) DO reposition correctly (~1px) — confirming
  the geometry + IPC are fine; only the `useOnViewportChange`-driven path is dead.
- Programmatic `rf.setViewport` (the e2e `panBy`/`setZoom`/`fitView` helpers) does **not** fire
  `useOnViewportChange` at all (`pumps:0` unchanged) — so those helpers can't be used to test the camera
  path; only **real OS input** (`sendInput` wheel/drag) exercises it. (This also means the app's own
  `rf.fitView` for focus/tidy/fit-frame leaves the native un-pumped too — but those are followed by a
  store-path reconcile in practice; confirm during the fix.)

---

## Scaffolding present on this branch (re-verify with these)

| File | Change | Purpose |
|---|---|---|
| `src/main/preview.ts` | `debugViewBounds(id)` — returns `{attached, bounds:getBounds()}` | read the native rect from main |
| `src/main/e2eMain.ts` | registers it as `viewBounds` on `__canvasE2EMain` | reach it from the probe |
| `src/renderer/src/canvas/boards/usePreviewManager.ts` | **TEMP** `previewDebug` counters on `window.__previewDebug` | count pump/detach activity |
| `e2e/preview-align.e2e.ts` | diagnostic spec (2 tests: chaotic sweep + CLEAN panOnScroll) | the reproduction + measurement |

> ⚠️ The `previewDebug` instrumentation in `usePreviewManager.ts` is **temporary** and MUST be removed
> before the fix PR. The `viewBounds` getter + the diagnostic spec should STAY (the spec becomes the
> regression guard once it asserts congruence).

Run it:
```
pnpm build
pnpm exec playwright test e2e/preview-align.e2e.ts            # both tests
pnpm exec playwright test e2e/preview-align.e2e.ts -g "CLEAN" # the clean panOnScroll proof
```

---

## Proposed fix (direction — the next session designs the final form)

There must be exactly **one** `useOnViewportChange` owner (single store slot). The preview manager's
three callbacks must survive. Options, lowest-risk first:

1. **Move Canvas's autosave off `useOnViewportChange`.** It only needs the current viewport persisted
   to `canvasStore` for save. Replace the `useOnViewportChange({ onChange })` at `Canvas.tsx:674` with a
   collision-free mechanism — e.g. subscribe to the React Flow store `transform` via `useStoreApi().subscribe`
   (additive; multiple subscribers are fine), or capture the viewport lazily at autosave time. This leaves
   `usePreviewManager`'s `useOnViewportChange` as the sole owner → camera sync restored. **Recommended.**
2. **Single fan-out owner.** Lift one `useOnViewportChange` to `Canvas` whose callbacks call BOTH the
   autosave persist AND the preview manager's begin/pump/end (passed up via refs/props). More plumbing.
3. **Drive the preview pump from a store subscription instead of `useOnViewportChange` entirely.** Most
   robust (also fixes the programmatic-camera-doesn't-pump gap for `rf.fitView`/focus/tidy), but a larger
   change to the motion start/end (detach) detection. Consider as a follow-up hardening, not the first fix.

**Verification the fix works:** after the change, the CLEAN panOnScroll diagnostic must show
`pumps > 0`, `beginMotions > 0`, and the native rect tracking `.bb-frame` to within ≤2px after each pan.
Then convert the diagnostic into a hard-asserting regression test.

---

## Open questions for the next session to confirm

1. **Is the effect-order clobber deterministic?** Confirm Canvas always wins (descendant-before-ancestor).
   Prove the mechanism by a minimal change: temporarily remove/relocate `Canvas.tsx:674` and re-run the
   CLEAN diagnostic — expect `pumps>0` + native tracking. (Decisive: if removing Canvas's call fixes it,
   the collision is proven the cause.)
2. **Are there other `useOnViewportChange` callers?** `grep` confirms only Canvas + usePreviewManager in
   production (FlowSmoke.tsx is the dead Phase-1 spike). Re-confirm none were added.
3. **Does the chosen fix keep autosave-viewport persistence correct?** Pan, wait for autosave, reopen the
   project, assert the viewport restored.
4. **Programmatic-camera path:** does `rf.fitView` (focus/tidy/fit-frame) also leave the native un-pumped
   in real use, or is it always followed by a store-path reconcile that fixes it? Decide whether the fix
   should also cover this (option 3) or whether a follow-up suffices.
5. **Regression-test shape:** the spec should assert native-vs-`.bb-frame` ≤2px after a REAL panOnScroll
   (use `sendInput`, not programmatic `panBy` which doesn't fire the path). Mind the
   `e2e-browser-trio-flake` (assert on deterministic `viewBounds`, not `capturePage`).
