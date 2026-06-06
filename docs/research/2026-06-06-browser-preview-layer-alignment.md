<!--
Source: dynamic-workflow "browser-preview-alignment-research" (run wf_62a7cec7-104), 2026-06-06.
18 agents (Map ×5 ‖ Research ×4 → Diagnose → Verify ×7 → Synthesize). 7 candidates, 0 statically
confirmed, 6 refuted WITH code evidence; surviving = binding/timing hypotheses (RC1–RC4).
Status: RESEARCH / PREP. No code changed. Per CLAUDE.md this should move to a fix/* worktree when the
fix starts.
-->

# Browser preview layer-alignment — fix research

**Symptom.** On a Browser board, the native `WebContentsView` (the live localhost page) detaches from its HTML device frame: a large white rectangle escapes the bezel and floats near the canvas/window center, the real web content renders only at the *bottom* of that white area, and the HTML chrome (title bar, URL bar, "1280 × 800" device label) sits separately near the window top with a dark gap above the white box. It has been "buggy ever since," is intermittent ("some go off, some go nuts"), and is state-dependent.

**Verdict on what's really happening.** Every *specific* hypothesis we verified against the code came back **refuted** as the root cause — and importantly, each was refuted *with code evidence*, not hand-waved. The white-below-content behavior is real but *in-spec* (a short page on a tall device viewport shows white below the fold, contained inside the frame); the camera-skew, paneOffset, zoom-floor-clamp, and navigation-zoom-reset theories were each shown to be *unable* to move the native rect relative to its HTML frame. That leaves one structural conclusion: **the native rect and the HTML `.bb-frame` are congruent by construction at rest, so the reported misalignment is a *binding/timing* defect — the native view being driven from a rect computed against a state the HTML frame is not currently in (a stale full-view modal rect carried across a full-view exit, a portal-relocation race on full-view enter, or a board-resize/store-write that pushes `setBounds` a frame before React re-lays-out the HTML).** The single most likely production trigger is the **full-view enter/exit path** (stale modal rect + self-terminating pump), with the **board-resize store-write race** a close second. This report ranks those, gives the targeted fixes, and — because no candidate is *confirmed* — front-loads the **instrumentation that turns this from a guess into a measurement** (the bounds-vs-DOM divergence probe), so whoever fixes it can localize it in one repro instead of re-deriving the geometry.

---

## Layer model (recap)

A Browser board is a single React Flow node occupying a world rect `(x, y, w, h)`. Because a `WebContentsView` is a native OS compositor layer that **paints above all HTML and cannot be clipped, rounded, or z-ordered** (ADR 0002), the rounded device frame, notch, URL bar, and title bar are all **HTML chrome drawn around an unrounded native rect**. Two coordinate systems must stay congruent:

**On canvas (math path).** The native rect is computed purely, never from the DOM:

```
deviceStageRect(w,h,vp)            // board-local: device frame inset 1px  (browserLayout.ts:107-116)
  → toWorldRect(+x,+y)             // board-local → world                  (browserLayout.ts:122-129)
  → worldRectToScreen(_, getViewport(), paneOffset)  // world → screen DIP (cameraBounds.ts:46-53)
  → roundRect → setBounds          // integer native rect                   (cameraBounds.ts:56-63)
```

The HTML `.bb-frame` is laid out by `BrowserBoard.tsx` from the **same** `deviceFrameRect(board.w, board.h, viewport)` and lives under `.react-flow__viewport`'s `translate()scale(camZoom)` transform, so it is scaled by the identical camera. The two are reconciled by `frameTopInStage = frame.y − TITLEBAR_H − URLBAR_H` (`BrowserBoard.tsx:161`) plus `.bb-stage { top: URLBAR_H }` plus the 34px title bar, summing to board-local top `== frame.y`.

**In full view (DOM path).** The board's `.bb-frame` is portaled out of the camera-scaled canvas into an untransformed modal host; the native rect switches to `fullViewBoundsFor(id)`, which reads the **live `.bb-frame` `getBoundingClientRect()`** (inset 1px), guarded by `host.contains(el)` (`usePreviewManager.ts:234-255`).

### Invariants the system must keep

| # | Invariant | Where enforced | Failure mode |
|---|---|---|---|
| **I1** | `bounds.width / zoomFactor === presetW` (390 / 834 / 1280) | `fitZoomFactorForBounds(roundedBoundsWidth, presetW)` derives zoom from the **same rounded width** fed to `setBounds` — `cameraBounds.ts:100-102`, `usePreviewManager.ts:218` | Page reflows at the wrong CSS width → content mis-scales *inside* the rect |
| **I2** | Native stage rect (incl. the 34+30 chrome offset and 1px bezel inset) == HTML `.bb-frame` inner rect at the same camera | Both derive from `deviceFrameRect`; CSS token `--titlebar-h:34px` (`index.css:119`) == JS `TITLEBAR_H=34`; `box-sizing:border-box` global (`index.css:234`) | Native white floats off its bezel — **the reported bug** |
| **I3** | `zoomFactor` ∈ Chromium's `[0.25, 5]` | both `fitZoomFactor` and `fitZoomFactorForBounds` clamp | At the 0.25 floor I1 breaks (page lays out narrower than `presetW`) |

The constants are **duplicated, not derived**: `browserLayout.ts` hard-codes `TITLEBAR_H=34 / URLBAR_H=30 / STAGE_PAD=14 / MAX_FIT_SCALE=1.1`, and the math trusts that the rendered DOM matches. No test asserts CSS-token == JS-constant, and no test asserts I2 against the live DOM rect.

---

## Confirmed root causes — ranked

> **Honest status:** every *named* candidate in the verification pass was **refuted with code evidence** (see next section). None reproduced the symptom in isolation under static analysis. The items below are therefore the **ranked surviving hypotheses** — the binding/timing paths that the refutations explicitly pointed at as the only ones that *can* move the native rect relative to its HTML frame. Each is concrete and independently testable; the test plan (and the instrumentation in §6a) is what will promote one of these from "ranked suspect" to "confirmed." Ship the instrumentation **first**.

### RC1 — Full-view exit re-attaches the native view at the *stale full-view modal rect* (HIGH)

**Mechanism.** Full view binds the native view to the relocated portal's `.bb-frame` rect — a large, near-window-sized rect (`fullViewBoundsFor`, `usePreviewManager.ts:234-255`). On full-view **exit**, the system DETACHes the view (never `close()`, per the `fullview-reset` decision) and re-attaches it on canvas. But on detach, **nothing clears `r.lastSent` / the view's last bounds** — `detach()` only hides + removes the child view (`preview.ts:373-383`), and `closeBoard` is not called on a full-view exit. The renderer's `r.lastSent` still holds the modal rect.

**Why it yields out-of-bounds + content-at-bottom.** If a `flushBatch` or `attachBoard` for that board fires **before the renderer recomputes the in-canvas stage rect** (camera + paneOffset), `attachBoard`'s diff-skip (`usePreviewManager.ts:397-406`) sees `lastSent === bounds` against the *stale modal rect* and either re-shows the view at it or skips the correction. Main faithfully applies the last rect (`preview.ts:455-464`, no clamp). Result: a large white native rectangle floating where the modal was (canvas/window center), while the on-canvas HTML chrome renders correctly elsewhere — and because the held `zoomFactor` is the modal's `fv.width`-derived value, the page lays out at a CSS width that mismatches the canvas rect, packing content to the bottom. Exactly the screenshot.

**Evidence.**
- `usePreviewManager.ts:378-439` — `attachBoard` HOLD/diff-skip: on full-view exit `isFullView` is now false, so `fv = null` and `bounds = boundsFor(g)`; **but** if the camera/paneOffset recompute hasn't run, `boundsFor` returns the correct canvas rect *only if* `getViewport()`/`paneOffset` are current — and the diff-skip compares against the modal `lastSent`.
- `preview.ts:373-383` — `detach()` leaves `e.zoom` + last bounds intact on the hidden view; no rect reset.
- `usePreviewManager.ts:442-453` — `closeBoard` *does* reset `lastSent=null`, but it is **not** on the full-view-exit path (exit detaches, it does not close).

**Fix.** *Files:* `usePreviewManager.ts`, `preview.ts`.
*Approach:* On any full-view **enter and exit** transition for a board, reset that board's `r.lastSent = null` and `r.lastZoom = -1` so the next `attachBoard`/`flushBatch` **cannot diff-skip** and is forced to push a freshly-computed rect. Mirror the existing `detach` discipline in the renderer model: when the manager observes `fullViewId` change (the effect at `usePreviewManager.ts:680-683`), clear `lastSent` for the entering/leaving board before `applyLiveness()`. Belt-and-suspenders: in `detach()` (`preview.ts:373-383`), null the view's cached bounds notion so a re-attach with no fresh bounds is a visible no-op rather than a stale-rect repaint.
*Risk:* low. It only forces an extra (correct) `setBounds` on a transition that already re-attaches.

**Verification assertion.** Extend `e2e/fullview.e2e.ts`: `openFullViewAnimated` → settle → **exit** full view → poll main's view bounds (`debugViewWebContentsId` / a `viewBounds` getter) **and** `document.querySelector('[data-bb-frame=ID]').getBoundingClientRect()`; assert `|native.{x,y,width,height} − frame.inset1px| ≤ 2px` within N frames of exit. Without the fix this diverges by the full modal-vs-canvas delta; with it, it converges.

---

### RC2 — Board-resize / store-write pushes `setBounds` one frame before React re-lays-out the HTML frame (HIGH)

**Mechanism.** When `NodeResizer` fires `onResize`, `canvasStore` is updated synchronously; the manager's store subscription runs `reconcile` → recomputes `boundsFor` with the **new** `g.w/g.h` and emits `setPreviewBoundsBatch` immediately (`usePreviewManager.ts:741+`, `flushBatch:456-478`). Main calls `setBounds` (`preview.ts:455-464`) **before React Flow has re-rendered the board node and the HTML `.bb-frame` at the new size**.

**Why it yields out-of-bounds.** For the 1–2 frames between the store write and the React commit, the native view occupies the *new* computed rect while the HTML device frame is still at the *old* size. If the board grew, the native white surface extends past the old bezel (white outside the frame); the page, still at the prior `zoomFactor` for that frame, renders content low. This is the most plausible "intermittent, appears right after a resize gesture" trigger and matches "buggy ever since" (it has always raced).

**Evidence.**
- `usePreviewManager.ts:456-478` (`flushBatch`) recomputes `bounds = boundsFor(g)` from `geomRef.current` (updated synchronously by the store subscription) — there is no "HTML committed at this size" gate.
- React Flow re-renders the node on the next render cycle, not synchronously with the store write (architecture, not a single line).
- `preview.ts:455-464` applies the rect verbatim, no clamp, no DPI/HTML cross-check.

**Fix.** *Files:* `usePreviewManager.ts`.
*Approach:* When a board's `w`/`h` changed since `lastSent` (a resize, distinct from a camera pan), defer that board's bounds push by **one rAF tick** (set a per-board `pendingResize` flag; push on the next frame after React has committed the new layout). The gesture path already detaches the live view to a snapshot during the drag (`beginMotion`), so the deferral is invisible mid-gesture; the only exposed frame is the first after `endMotion`, which the deferral fixes rather than worsens.
*Risk:* low–medium. Adds a one-frame latency to resize-driven bounds, imperceptible in practice.

**Verification assertion.** e2e: seed a Browser board live; programmatically resize the node (`updateBoard(id,{w,h})`); on the very next frame assert the native rect still matches the **old** `.bb-frame` rect (proving no premature push), then after a settle assert it matches the **new** `.bb-frame` rect — both within ±2px.

---

### RC3 — Full-view *enter* portal-relocation race + the self-terminating pump (MEDIUM)

**Mechanism.** On full-view enter, `applyLiveness` attaches with `fv = null` (HOLD, `usePreviewManager.ts:388`), then a dedicated rAF pump (`692-736`) re-attaches once the portal relocates `.bb-frame` into the modal host. That pump **self-terminates after 4 idle frames** (`722`) and only re-arms on `window 'resize'` (`731`). If the portal commit (React `createPortal` + layout) takes longer than the pump survives — or a missed tick lets `idle` reach 4 before `fullViewBoundsFor` returns non-null — the view is **never re-attached at the modal rect** and stays at its prior (canvas) bounds for the rest of the full-view session: a small/large white rect at the canvas position while the modal chrome is at the top.

**Why it's ranked below RC1.** The refutation pass showed the production *animated* enter keeps `fullViewMotion=true` for the whole ~200ms tween, holding the pump armed (`706-720`), and the focus effect re-runs `applyLiveness` on the `fullViewHost` dep (`671-683`) as an independent corrector — so the race window is narrow. But it is a *real* window in the raw-setter e2e path and on a slow portal commit, and it precisely matches the "native at canvas center, chrome at top" picture.

**Evidence.** `usePreviewManager.ts:692-736` (pump + `idle < 4` + resize-only re-arm), `378-389` (HOLD), `680-683` (host-dep corrector).

**Fix.** *Files:* `usePreviewManager.ts`.
*Approach (pick one):* (a) gate the pump's idle counter on having *seen* a non-null `fullViewBoundsFor` at least once — don't start counting idle until the relocated rect was read; or (b) replace the `idle < 4` self-stop on enter with a **`MutationObserver`** on `fullViewHost` that fires `attachBoard` the moment `[data-bb-frame=id]` lands inside it, then disconnects; or (c) the minimal change — raise the enter-phase idle threshold from 4 to ~12 frames. (a) or (b) are precise; (c) is a one-line hedge.
*Risk:* low.

**Verification assertion.** e2e (`fullview.e2e.ts`): `openFullViewAnimated` → poll until the native rect equals the modal `.bb-frame` rect (±2px) **and** I1 (`bounds.width/zoomFactor===presetW`) holds, asserting it converges within the 200ms enter. Negative control: force the pump to idle out (wait > 4 frames) and confirm the rect stays correct.

---

### RC4 — Stale `lastSent` diff-skip strands a corrected rect (MEDIUM, an amplifier of RC1/RC3)

**Mechanism.** `flushBatch` and `attachBoard` both **diff-skip** when `rectsEqual(lastSent, bounds) && lastZoom === zoomFactor` (`470`, `401-403`). The self-stopping pump (`startPump`, `480-489`) ends 4 idle frames after motion settles. If the last frame before idle-out recorded a *wrong* `lastSent` (a transition rect, a stale modal rect, a pre-commit resize rect), **no later event recomputes it** — the diff-skip prevents correction and the pump is no longer running. This is why the bug *persists* at rest rather than self-healing, and why it is intermittent.

**Evidence.** `usePreviewManager.ts:470` (flushBatch diff-skip), `397-406` (attachBoard diff-skip), `480-489` (4-idle self-stop).

**Fix.** *Files:* `usePreviewManager.ts`. Already largely covered by RC1/RC2/RC3's "clear `lastSent` on transition" — make that the *general rule*: **any** state change that can move the HTML frame without a viewport event (full-view enter/exit, resize commit, paneOffset re-measure) must `lastSent = null` for affected boards and re-arm the pump. The `paneOffset` measure effect (`903-920`) already calls `flushBatch()` but is itself diff-skipped — add a `lastSent` clear there too so a paneOffset change can't be swallowed.
*Risk:* low.

**Verification assertion.** Unit: after simulating a transition that should move the frame, assert the next `flushBatch` emits a batch item for the board (not diff-skipped). e2e: cover by the RC1/RC2/RC3 convergence assertions.

---

### Note on the genuinely in-spec (non-bug) white

`deviceStageRect.height` is the device-frame's geometric aspect height (`preset.h * fitScale`), **never** the page's rendered content height (`browserLayout.ts:88-116`). `setZoomFactor` reflows the page to a fixed CSS *width* and does not resize the native box. So a short dev page legitimately shows white below its content — **inside** the correctly-positioned, `overflow:hidden` frame. This is *not* the reported bug and needs no fix. Optional cosmetic polish only: set each preview view's document background to the bezel color so a genuinely short page reads as bezel rather than white (`preview.ts`). Do **not** "fix" this by binding the on-canvas rect to the live DOM — see §6.

---

## Refuted / ruled-out

Each was traced to code; do **not** re-chase these:

- **`height-decoupled-from-content`** — *Refuted.* The premise (native height = aspect height, not page height) is true, but the resulting white lands **inside** the congruent frame (`overflow:hidden`, dark theme so the only white surface is the page itself). Cannot move or oversize the rect relative to the HTML frame. Explains "white below the fold" (expected), not "white out of bounds."
- **`live-camera-vs-react-state-skew`** — *Refuted.* `getViewport()` and the `.bb-frame` CSS transform read the **same** `@xyflow/react` store `transform` (one `onTransformChange` callback sets store state and fires `onViewportChange` in one synchronous call). No two-source skew exists; a 1-frame offset would be a few-px uniform translate, not the gross structural mismatch reported.
- **`stale-zero-paneoffset`** — *Refuted.* The pane is `position:absolute inset:0` (`Canvas.tsx:838-842`) inside `App.tsx`'s `position:fixed inset:0` root (`App.tsx:62`), so its window origin is rigidly `(0,0)` and a stale/zero read is the *correct* value. `worldRectToScreen` adds paneOffset to **x/y only** — it can't enlarge the box or push content to the bottom. (The `cameraBounds.ts:15-19,42-43` "44px topbar + tabs" header comment is **stale doc text** — the only `.topbar` renderer is the legacy `smoke/FlowSmoke.tsx` spike; fix the comment, it misled diagnosis.)
- **`navigation-zoom-reset-bounds-race`** — *Refuted as root cause.* A page load resets Chromium zoom to 1 and `did-finish-load` re-applies `e.zoom` (`preview.ts:194-197, 297-303`), so there is a real sub-second content-scale flash — but it touches **`setZoomFactor` only, never `setBounds`** (`applyZoom:350-358`). It cannot move/oversize the rect or detach the chrome. At most a transient mis-scale *inside* a correctly-placed rect.
- **`fullview-stale-portal-rect`** (the specific "pump idles out during the animated enter" chain) — *Refuted.* `fullViewMotion` holds the pump armed for the whole 200ms tween (`706-720`), the portal relocates in 1–2 frames via a `useLayoutEffect`, and the `fullViewHost`-dep focus effect (`671-683`) re-attaches independently. (RC3 keeps the *non-animated / slow-commit* variant as a live, narrower hypothesis.)
- **`zoomfactor-floor-clamp-breaks-width-invariant`** — *Refuted.* The 0.25 clamp changes only the value passed to `setZoomFactor`, never bounds. Boards below ~40% zoom detach to a snapshot anyway (`LOD_ZOOM=0.4`), so the floor rarely bites while live. A clamp breaks I1 (content mis-scale *inside* the rect) but cannot move the rect off the frame.

---

## External best practices that apply

- **DIP vs CSS px / `setBounds`.** `WebContentsView.setBounds` and `getBoundingClientRect` are both in **CSS px / DIP**, identical at 100% Windows scaling. At 125%/150%, set/get round-trips and integer rounding can drift 1 physical px per axis, and if Electron's DPI-awareness mode mismatches the monitor, the two spaces diverge by the scale factor (electron/electron#10659, #8533, #27651). *Relevance:* confirm the dev machine's display scale; a mixed-DPI multi-monitor move is the one environmental path that could produce a *uniform* offset our math can't see. Compensate **main-side** via `screen.getDisplayNearestPoint().scaleFactor` if it reproduces only at non-100%.
- **`getBoundingClientRect` inside a CSS-transformed ancestor returns post-transform (visual) coords** (MDN). *Relevance:* the on-canvas `.bb-frame` is under `translate()scale()`, so reading it per-frame would return the camera-scaled rect — which is exactly why the on-canvas path is **pure math** and only `fullViewBoundsFor` reads the DOM (and only after the portal moves it into the *untransformed* host). Do not "simplify" the on-canvas path to a DOM read.
- **`setZoomFactor` is a layout zoom, not visual** (bennadel, electron#16018). It shrinks `window.innerWidth`, so the responsive trick is correct *only* while I1 holds; a held/stale zoom across a load paints one frame at zoom 1 (page over-wide, content low). *Relevance:* validates the in-spec flash but not the persistent misalignment.
- **Independent integer rounding** (`roundRect` rounds x,y,w,h separately) can put `round(x)+round(w)` 1px past `round(x+w)`. *Relevance:* the existing 1px bezel inset (`deviceStageRect` and `fullViewBoundsFor`) absorbs it. Optional hardening: floor-origin / ceil-size so `round(x)+round(w)===round(x+w)`.
- **Ghost-frame bug class** (electron#43961/#44652): `removeChildView` can leave a stale composited frame; the workaround `setVisible(false)` **before** `removeChildView` is already applied (`preview.ts:380-381`). Keep it; audit that no path removes a view without first hiding it.
- **`Page.startScreencast` / OSR / iframe alternatives** (tldraw, Figma use iframes). *Relevance:* see §6b.
- **`Emulation.setDeviceMetricsOverride`** (Chrome DevTools Protocol) sets width/height/dpr/mobile atomically, decoupling responsive layout from view sizing — eliminates I1/I3 coupling entirely. *Relevance:* the architectural option in §6b; CDP attach is explicitly **deferred** in CLAUDE.md.

---

## Recommended fix strategy

### (a) Minimal targeted fixes to ship now — ordered

1. **Instrument first (zero-risk, do before any fix).** Add a dev-only divergence probe: each frame a board is live, compare the pushed native rect to its `.bb-frame` `getBoundingClientRect` (inset 1px) and `console.warn` + record when `|Δ| > 2px` on any field, logging `devicePixelRatio`, `paneOffset`, `getViewport()`, `fullViewId`, and whether a resize/transition just occurred. Also assert I1 (`|bounds.width/zoomFactor − presetW| > 0.5`). This **localizes** the bug in one repro instead of guessing between RC1–RC4. (External "instrument the bounds pipeline" technique.)
2. **RC1 — clear `lastSent` on every full-view enter/exit transition** (force a fresh push; kill the stale-modal-rect re-attach). Highest-probability production cause, lowest risk.
3. **RC2 — defer the resize-driven bounds push by one rAF** (gate on `w/h` changed; let React commit the new HTML layout first).
4. **RC4 — generalize "clear `lastSent` + re-arm pump" to all non-viewport frame-moving events** (paneOffset re-measure, transitions). Makes the diff-skip safe.
5. **RC3 — make the full-view enter pump robust** (gate idle on first non-null `fullViewBoundsFor`, or a `MutationObserver` on the host; or raise the enter idle threshold to ~12).
6. **Hygiene:** fix the stale `cameraBounds.ts` "44px topbar" comment; optional floor-origin/ceil-size rounding.

These are surgical, preserve the responsive-reflow invariant, the LOD/snapshot motion path, and per-board session isolation, and add no new IPC.

### (b) Larger architectural option

Two candidates, with trade-offs:

| Option | Fixes | Loses / costs |
|---|---|---|
| **Bind on-canvas rect to `.bb-frame` `getBoundingClientRect` per frame** (mirror `fullViewBoundsFor` everywhere) | I2 binding/timing drift entirely — native view tracks the real DOM element | Forces a layout read per live board per frame (O(MAX_LIVE=4)); reintroduces **CSS-transform pollution** (the rect is camera-scaled) that the pure-math path was built to avoid; breaks the "pure, testable, DOM-free" discipline. **Not recommended.** |
| **CDP `Emulation.setDeviceMetricsOverride` per board** | I1 + I3 coupling permanently (width/height/dpr/mobile declared atomically; view bounds become a free scaling unit, the 0.25 floor stops mattering) | Requires `webContents.debugger.attach()` per view — **CDP is explicitly deferred** in CLAUDE.md; override must be re-applied on `did-navigate`; does **not** fix the positional binding (RC1–RC4). |

**Recommendation.** Ship the §6a targeted fixes — they address the *binding/timing* defect that actually produces the symptom, at low risk, without architectural churn. **Do not** move the on-canvas path to a DOM read. Revisit `setDeviceMetricsOverride` later, scoped to the deferred CDP phase, *only* as an I1/I3 robustness upgrade — it is orthogonal to this bug. Keep the always-above `WebContentsView` (it is the only approach that gives true per-board responsive-breakpoint reflow); the occlusion is already mitigated by LOD/snapshots and out-of-canvas chrome.

---

## Test plan to lock it

**Unit (pure, deterministic — prove the geometry, no flake):**

1. **I2 congruence.** For a board `(x,y,w,h)` and viewport `vp`, assert `roundRect(worldRectToScreen(toWorldRect(deviceStageRect(w,h,vp),x,y), vp, paneOffset))` equals the screen rect the HTML `.bb-frame` occupies (`deviceFrameRect` mapped through the same `translate(vp.x,vp.y)scale(vp.zoom)+paneOffset`, inset 1px) within ±1px on every field — across **mobile/tablet/desktop** presets and several `camZoom` values. This is the assertion that has been missing.
2. **CSS-token == JS-constant.** Assert `--titlebar-h` (34) and `--urlbar`/`.bb-stage top` (30) match `TITLEBAR_H`/`URLBAR_H`. A regression on either silently desyncs I2.
3. **I1 invariant + clamp boundary.** Assert `roundedBoundsWidth / fitZoomFactorForBounds(roundedBoundsWidth, presetW) === presetW` in the unclamped band, and that the clamp at 0.25 is the *only* break.
4. **paneOffset is translation-only.** A nonzero paneOffset shifts x/y by exactly that amount and leaves width/height unchanged (already covered by `cameraBounds.test.ts:38-47`).
5. **Diff-skip safety (RC4).** After a simulated frame-moving transition, the next `flushBatch` is **not** diff-skipped for the affected board.

**e2e (Playwright `_electron` — measure native rect vs DOM, the regression guard):**

A shared helper reads (a) the native view bounds from main (`debugViewWebContentsId` → a `viewBounds` getter; add one to `preview.ts` exposing the last `setBounds` rect per id) and (b) `document.querySelector('[data-bb-frame=ID]').getBoundingClientRect()` in the renderer, asserting `|native − frame.inset1px| ≤ 2px` per field. Scenarios:

- **On-canvas, all presets, at rest** — after the board goes live and the pump settles.
- **After pan/zoom settle** — repeat across several settles (catches RC4 stranding).
- **After node resize** — assert old-frame match the frame before commit, new-frame match after (RC2).
- **Full-view enter** — converges to the modal rect (±2px) and I1 holds, within the 200ms tween; negative control: idle the pump out, rect stays correct (RC3).
- **Full-view exit** — converges back to the canvas rect (±2px) within N frames; **the RC1 regression guard.**
- **Short-page control** — load a deliberately short white-body localhost route; assert the native rect still equals the inset `.bb-frame` (white-below-content is *inside* the frame, not out of bounds) — proves the in-spec white is not the bug.

**Flake caveat.** The `browser` / `browser-gesture` / `focus-detach` e2e trio is a known live-`WebContentsView` env `capturePage` flake (memory `e2e-browser-trio-flake`), proven by neg-control — **rerun for a clean pass, do not treat a single red as a regression.** Keep `retries:2`, `workers:1` per the pre-commit matrix policy. Where possible, assert on `viewBounds` (deterministic) rather than `capturePage` pixels (flaky).

---

## Open questions / things to confirm live in the app

1. **Which transition actually fires it?** Run the §6a instrumentation and reproduce: does the `|Δ|>2px` warn fire on full-view **exit** (RC1), immediately after a **resize** (RC2), on full-view **enter** (RC3), or at rest after pan (RC4)? This single measurement picks the primary fix.
2. **Display scaling.** What is this machine's Windows display scale and monitor config? If the symptom only reproduces at 125%/150% or after dragging the window between mixed-DPI monitors, the DPI path (external best practices) is in play and the fix is main-side scale compensation, not the binding fixes.
3. **Is `r.lastSent` actually the modal rect on exit?** Log `r.lastSent` for a board across a full-view enter→exit cycle to confirm RC1's premise directly.
4. **Portal commit timing.** On full-view enter, how many frames until `fullViewBoundsFor` first returns non-null? If it ever exceeds 4 in production (slow page, GPU contention), RC3 is live and needs the MutationObserver/idle-gate fix, not just the threshold bump.
5. **Does `did-finish-load` re-apply a *stale* `e.zoom` after a navigation in a board whose last batch was full-view?** Confirm `e.zoom` is refreshed by the next on-canvas batch promptly; if not, the in-spec flash could be longer-lived and worth the earlier-zoom-apply polish.
6. **Multi-board z-order.** With several overlapping live Browser boards, does detach→reattach order ever leave one painting above another (additive `addChildView` stacking)? Not the reported bug, but the "some go nuts" plural phrasing warrants a check.
