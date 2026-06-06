# Browser preview camera-sync — ROOT CAUSE (confirmed by code + live measurement)

**Status:** Root cause identified and reproduced in the built app. **Next session must independently
re-verify** (re-run the diagnostic, prove the fix hypothesis with a minimal change) before implementing.
**Branch:** `fix/preview-camera-sync` (worktree `Z:\canvas-ade-preview-camera-sync`).
**Date:** 2026-06-06.

> **⚠️ A SECOND, DISTINCT BUG was found during manual verification (2026-06-06)** — see
> §"Bug 2: out-of-bounds over the Project-context panel" near the end. The camera-sync clobber (this
> doc's main subject) is one cause of "the browser bugs when I move"; the digest-panel occlusion gap is
> another. Both are fixed on this branch. A THIRD report ("Something went wrong" canvas crash) was a
> **symptom of Bug 2, not a separate defect** — once Bug 2 landed, the user re-tested on a fresh build
> and the crash card is **gone (confirmed 2026-06-06)**. See §Bug 3.

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

---

## ✅ INDEPENDENT RE-VERIFICATION (2026-06-06, session 2) — ROOT CAUSE CONFIRMED

A second session re-derived this from scratch (static read + live decisive test). **Verdict: the
suspected root cause is correct — the single-slot `useOnViewportChange` collision is THE cause.** No
correction needed. Details below.

### Static confirmation (code re-read, not trusted from above)

- **RF source verbatim** (installed `@xyflow/react@12.10.2`, `node_modules/.../dist/esm/index.js:3988`):
  three separate `useEffect`s each `store.setState({ onViewportChange* : … })` — a **single slot per
  field, last-writer-wins, NOT additive.** Quote in the root-cause section above matches the shipped file.
- **Both call sites present and exactly as described:** `Canvas.tsx:674` (`onChange` only → autosave
  `setViewport`) and `usePreviewManager.ts:671` (`onStart:beginMotion, onChange:startPump,
  onEnd:endMotion`).
- **Tree / effect order is structural, not coincidental:** `Canvas` (owns the autosave hook) renders
  `<ReactFlow>` → `<BrowserPreviewLayer>` (`Canvas.tsx:737`) → `usePreviewManager` (the camera-sync hook),
  all under ONE `ReactFlowProvider` (`Canvas.tsx:832`) ⇒ one shared store. React **commits child effects
  before parent effects**, so the preview manager registers its three callbacks first and `Canvas`
  overwrites all three last (`onStart`/`onEnd` → `undefined`, `onChange` → autosave). Deterministic.
- **Only two production callers** (re-grepped): Canvas + usePreviewManager. `FlowSmoke.tsx:357` also calls
  it but `FlowSmoke` is **never imported/mounted anywhere** (dead Phase-1 spike) — confirmed by grep.

### Decisive live test (built app, real `sendInput` panOnScroll)

`pnpm build` → `pnpm exec playwright test e2e/preview-align.e2e.ts -g "CLEAN"`, run twice:

| Metric (per panOnScroll step) | **BUG** (as shipped) | **FIX-PROBE** (autosave `useOnViewportChange` removed) |
|---|---|---|
| baseline `maxAbs` (native vs frame) | **282.59px** (frozen) | **0.59px** (tracks) |
| `pumps` | `0` every step | `8 → 12 → 16 → 20 → 24` |
| `beginMotions` | `0` every step | `2 → 3 → 3 → 4 → 4` |
| `endMotions` | `0` every step | `2 → 2 → 3 → 3 → 4` |
| native rect | frozen `{x:25,y:79}` while frame.y 220→175→130→85→40 | moves `220→130`, tracks frame at settled rest |

Removing **only** `Canvas.tsx:674` flips the bug → the preview manager's begin/pump/end fire again and the
native rect tracks the `.bb-frame` to **0.59px** at settled rest. **The collision is proven to be the
cause.** (Temp edit was reverted immediately; tree is clean.)

> ⚠️ **Measurement nuance for the regression test:** during/right-after a pan the diagnostic sometimes
> caught the view **`attached=false`** (steps 0/2/3, `maxAbs` 44/89px). That is **expected** — `beginMotion`
> detaches the live view to an HTML snapshot for the motion (the CLAUDE.md detach+snapshot LOD strategy);
> the snapshot moves with the camera and the native **re-attaches at rest** (step 1 showed `attached=true`
> @ 0.59px). The regression test must therefore assert congruence **only at settled rest** (poll until
> `attached===true` after the pan), not mid-motion.

### Open questions — answered

1. **Effect-order deterministic?** ✅ Yes. Structural (parent commits after child), and the decisive test
   confirms the direction (removing Canvas's call restores the preview callbacks).
2. **Other callers?** ✅ Only Canvas + usePreviewManager in production; `FlowSmoke` is dead/unmounted.
3. **Fix keeps autosave correct?** ✅ Achievable. `setViewport` is the canvasStore action (unit-tested
   directly: untracked/no-undo + the Bug-L2 equal-value identity guard). Rewriting the *writer* (RF-store
   `transform` subscription instead of `useOnViewportChange.onChange`) writes the same values at the same
   rAF cadence ⇒ persistence + restore unchanged; existing `setViewport`/persistence tests call the store
   action directly and are unaffected. Plan adds an explicit pan→autosave→reopen→restore check.
4. **Programmatic-camera path (`rf.fitView`/focus/tidy)?** ✅ Resolved. **Animated** fits — focus, tidy
   (animate), keybinding `1`, AppChrome fit button — wrap `FIT_FRAME` in `cameraAnim` (a duration tween)
   ⇒ d3 transition fires `onViewportChangeStart/Change/End` ⇒ once the preview owns the slot (post-fix)
   they **pump correctly**. **Instant** sets (`duration:0`: viewport restore `Canvas.tsx:687`, fit-on-load
   `Canvas.tsx:688`, `useTidyTile.ts:83`) don't fire `onChange`, BUT each is followed by a **store-path
   reconcile** (board-mutation subscription `usePreviewManager.ts:908`, or live-attach/focus reconcile)
   that repositions the native at the current camera. Residual edge: an instant programmatic camera move
   with NO following store mutation/focus would stay un-pumped until the next real gesture (rare). **Option
   3** (drive the pump from a store-`transform` subscription) closes even that — recommended as a
   **follow-up hardening**, not the first fix.
5. **Regression-test shape:** ✅ Decided — see the plan. Real `sendInput` panOnScroll (programmatic
   `panBy`/`setZoom` use `duration:0` and do **not** fire the camera path), assert on deterministic
   `viewBounds` (main getter) vs `.bb-frame` (≤2px) **at settled rest**, never `capturePage`
   (`e2e-browser-trio-flake`).

### Recommendation (unchanged from "Proposed fix" above)

**Option 1** — move Canvas's autosave OFF `useOnViewportChange` (subscribe to the RF store `transform`
additively via `useStoreApi().subscribe`), leaving `usePreviewManager` the sole `useOnViewportChange`
owner. Lowest-risk, surgical, restores camera sync. Full step-by-step in
`docs/superpowers/plans/2026-06-06-preview-camera-sync-fix.md`.

---

## Bug 2: out-of-bounds over the Project-context (digest) panel — FIXED 2026-06-06

**Symptom (user screenshot):** With the "Project context" panel open (a fixed 300px LEFT overlay,
`.digest-panel`, `z-index:70`), panning a Browser board LEFT so it travels under the panel makes the live
native page **paint over the panel** — the white page bleeds out of bounds across the panel area. Distinct
from the camera-sync clobber (which is about the native not *tracking* the frame); here the native tracks
fine but is never *demoted* where it overlaps left-edge chrome.

**Root cause:** `chromeExclusionZones` (`src/renderer/src/lib/previewPlan.ts:128`) returned only
`[dock, topRight]`. A native `WebContentsView` paints above ALL HTML (ADR 0002), so the occlusion mitigation
demotes a live view to its (clippable, z-ordered) HTML snapshot when it overlaps protected chrome — but the
**digest panel was never a protected zone**, so an overlapping live view stayed live and covered it.

**Reproduced (probe):** digest open, real `sendInput` panOnScroll left → board native stays `attached=true`
with `native.x` going `307→187→67→-53→-173→-293`, overlapping the panel's `x:0..300` the whole way.

**Fix:** thread `digestOpen` into `usePreviewManager` (new `LayerProps.digestOpen`, passed from
`Canvas.tsx`). In `occludesProtected`, when the panel is open, push its live DOM rect
(`[data-test=digest-panel]` `getBoundingClientRect`, skipped when off-screen) onto the chrome zones so
`shouldDemoteForOcclusion` demotes any overlapping live view. The focus effect syncs `digestOpenRef` and
re-runs `applyLiveness` on a digest toggle (so opening the panel over an already-live board demotes it; closing
re-attaches). **Post-fix probe:** the board now reports `attached=false` at every overlapping step; a board
clear of the panel stays live. Regression test: `e2e/preview-align.e2e.ts` › "Browser native demotes to
snapshot when panned under the open digest panel" (real panOnScroll; asserts demote while overlapping +
re-attach on close).

## Bug 3 (RESOLVED — was Bug 2): "Something went wrong" canvas crash

The screenshot also showed the canvas ErrorBoundary card ("The canvas hit an unexpected error. Your last save
is on disk. Reload"). It was **never reproduced** by panning (20+ real-input steps across two directions,
digest open: `errorBoundary:false`, renderer alive throughout; no error in the dev main-process log). The
working hypothesis held: it was **not a separate defect** but the orphaned out-of-bounds native `WebContentsView`
(Bug 2) painting over the canvas / its error card. **After Bug 2's fix (`70cff5a`) the user re-tested on a
fresh build and the crash card is gone (confirmed 2026-06-06).** No standalone crash to hunt; closed.
