# OS-3 Phase 1 — OSR preview sizing & sharpness (M1 + M4)

> Slice spec for `feat/osr-sizing`. First phase of OS-3 (OSR Browser-preview productionization,
> `docs/feature-proposals.md` › OS-3). Per the doc-lifecycle this file is **deleted on merge** (the
> build-history line is the residue). Authoritative gap register: the spike spec
> `docs/reviews/2026-06-14-electron-to-flutter-assessment/preview-offscreen-spike-spec.md` › §8c.

## Decisions locked (this session, 2026-06-15)

- **Rollout:** OSR becomes the **default** Browser-preview engine; the native `WebContentsView` path
  is retired at the end of OS-3 (the §7 payoff cleanup). Phase 1 still ships **flag-gated**
  (`VITE_PREVIEW_OSR`); the flip happens in Phase 5.
- **Start phase:** Phase 1 = M1 (sharpness) + M4 (responsive presets) — they share one `setContentSize`
  seam, and per the spike's cheapest-first kill order M1 is the structural showstopper.

## Problem (grounded in the code)

Today the offscreen producer renders at a **hardcoded `1280×800`** with no DPR or preset sizing:

- `src/main/previewOsr.ts` — `OSR_WIDTH = 1280`, `OSR_HEIGHT = 800`; the hidden `BrowserWindow` is
  created once at that size, `setFrameRate(30)`, never `setContentSize`/`setZoomFactor`.
- `src/renderer/.../useOffscreenInput.ts` — the screen→page coordinate transform hardcodes the same
  `OSR_PAGE_W = 1280`, `OSR_PAGE_H = 800` as the page's logical space.
- `src/renderer/.../useOffscreenPreview.ts` — draws each frame at `f.width × f.height` into the
  `<canvas>` (it already adapts to **any** frame size; the canvas CSS size comes from `.bb-frame`).

Two consequences:

- **M1 (blur):** a 1280-wide bitmap drawn into a stage that is, on screen, e.g. 520 physical px wide
  (zoomed out) or 2000 px wide (zoomed in + HiDPI) is resampled at every zoom ≠ its native ratio →
  soft text. This is the terminal-blur class (`docs/research/2026-06-11-terminal-font-blur.md`)
  returning for the preview.
- **M4 (no reflow):** every board lays out at 1280 logical px regardless of the Mobile/Tablet/Desktop
  preset, so a responsive site never hits its mobile breakpoint — the device frame shrinks but the
  page does **not** reflow. The native path gets this right via the `setZoomFactor` responsive trick
  (`previewGeom.ts` › `zoomFor` / `boundsAndZoom`); OSR has no equivalent yet.

## Design

### The one number: supersample factor `S`

The OSR `<canvas>` is displayed at the **device-stage** size — `deviceStageRect(boardW,boardH,vp).width`
world px (`browserLayout.ts`) — then scaled by the camera and the window's device-pixel ratio. The
on-screen **physical** width of one logical page pixel is therefore:

```
S = deviceFitScale(boardW, boardH, vp) × settledZoom × window.devicePixelRatio
```

(`deviceStageRect.width = presetW × deviceFitScale`, so `presetW` cancels — `S` is preset-independent.)
Rendering the page at `S×` resolution and drawing the larger buffer into the same on-screen stage gives
crisp text — exactly the supersample the gap register prescribes (`setContentSize(W·S)+setZoomFactor(S)`,
**no** `setDeviceScaleFactor`).

- **MAIN applies:** `osrWin.setContentSize(round(presetW·S), round(presetH·S))` then
  `wc.setZoomFactor(S)` then `wc.invalidate()`. The page lays out at `presetW` logical
  (`contentSize/zoomFactor = presetW`) and paints at `S×` → `paint` emits a `presetW·S`-wide frame →
  the renderer draws it into the stage-sized canvas → crisp.
- **Clamp:** `S ∈ [1.0, 2.0]` for Phase 1 (a 1280 desktop at S=2 ⇒ 2560×1600 BGRA ≈ 16 MB/frame; ×4
  boards is already heavy — the live-count/frame-rate cost gating is **Phase 2 / M2**, called out in
  Risks). `S < 1` (zoomed far out) is clamped to 1 and carried by Phase-2 LOD instead of a sub-native
  buffer. Quantize `S` to 0.25 steps so micro-zoom-settles don't churn `setContentSize`.

### The seam: settle-gated, low-frequency `preview:osrResize`

The OSR path's headline win is **zero per-frame camera IPC** — the canvas moves with the DOM. Phase 1
must not reintroduce a pump. `S` only changes on three low-frequency events:

1. **settled zoom** changes (`settledZoomStore`, published once per camera settle by `useZoomSettle` —
   #122 infra, already mounted in `Canvas`);
2. **preset** changes (user toggles Mobile/Tablet/Desktop → `board.viewport`);
3. **board resize** settles (NodeResizer changes `deviceFitScale`) — debounced, not per drag-frame.

A new renderer hook `useOffscreenSizing(boardId, geom, enabled)` computes `{ logicalW, logicalH, S }`
from those inputs and fires **one** IPC — `window.api.resizeOsr(boardId, { logicalW, logicalH, supersample })`
— only when the quantized payload changes (identity-skip, same discipline as `settledZoomStore`). No rAF,
no per-frame send.

MAIN handler `preview:osrResize` (frame-guarded, in `registerPreviewOsrHandlers`):
- store `logicalW/H/S` on the `OsrEntry`;
- `osrWin.setContentSize(round(logicalW·S), round(logicalH·S))`; `wc.setZoomFactor(S)`; `wc.invalidate()`;
- guard against a no-op (same content size + zoom) so a redundant send doesn't force a relayout.

### M4: dynamic logical size (real reflow)

- `OSR_WIDTH/HEIGHT` in `previewOsr.ts` become the **default/initial** size; the live logical size is
  `logicalW/H` from `preview:osrResize` (= `VIEWPORT_PRESETS[vp].{w,h}`). Changing it re-lays-out the
  page at the preset width → genuine breakpoint reflow.
- The input transform must follow: `useOffscreenInput.toPage` replaces the module-const `OSR_PAGE_W/H`
  with the **live preset** logical size (read from the board's `viewport` via the same geom the sizing
  hook uses). `S` does **not** enter the input math — coordinates map to *logical* page space, which is
  DPR/supersample-independent (the existing comment already anticipates this).

### Renderer wiring

- `BrowserBoard.tsx` already gates the OSR hooks behind `osrEnabled` (VITE_PREVIEW_OSR + not full view).
  Add `useOffscreenSizing(boardId, geom, osrEnabled)` next to `useOffscreenPreview`/`useOffscreenInput`,
  and thread the live preset size into `useOffscreenInput` (new arg or shared small store) so its
  `toPage` uses it.
- `geom` (board w/h + viewport) is already available to the board node; `deviceFitScale` is a pure
  import from `browserLayout.ts`. `settledZoom` from `useSettledZoomStore`. `devicePixelRatio` read at
  send time (and re-sent on a `window` DPR-change, mirroring BUG-016's lesson — a monitor move must
  re-supersample).

## Files

| File | Change |
|---|---|
| `src/main/previewOsr.ts` | `OsrEntry` gains `logicalW/H/superSample`; `OSR_WIDTH/HEIGHT` → initial only; new `applyOsrSize(e)` (setContentSize+setZoomFactor+invalidate, no-op-guarded); `preview:osrResize` handler |
| `src/preload/index.ts` (+ `index.d.ts`) | expose `resizeOsr(id, {logicalW,logicalH,supersample})` |
| `src/renderer/.../useOffscreenSizing.ts` (new) | compute `{logicalW,logicalH,S}`, identity-skip send |
| `src/renderer/.../useOffscreenInput.ts` | `toPage` reads live preset logical size, not the const |
| `src/renderer/.../BrowserBoard.tsx` | mount `useOffscreenSizing`; pass live size to input hook |
| `src/renderer/src/lib/osrSizing.ts` (new, pure) | `computeOsrSize(geom, settledZoom, dpr) → {logicalW,logicalH,supersample}` — unit-tested |

Keeping the `S`/logical-size math in a **pure** `osrSizing.ts` (no DOM, like `previewGeom.ts`) makes M1
the unit-test target and keeps the hook thin.

## Tests

- **`osrSizing.test.ts` (pure):** `presetW` cancels (S preset-independent); clamp `[1,2]` + 0.25
  quantization; DPR and settledZoom both scale S; mobile/tablet/desktop produce the right `logicalW/H`.
- **`previewOsr` (main):** `preview:osrResize` calls `setContentSize(logicalW·S, logicalH·S)` +
  `setZoomFactor(S)` + `invalidate`; no-op guard skips an identical resize; frame-guard rejects a
  foreign sender.
- **input transform:** `toPage` maps to the **live** preset space (a mobile board maps to 0..390, not
  0..1280).
- **e2e (`@preview`, flag ON):** switch a board to Mobile → the forwarded logical width is 390 (reflow
  path exercised); zoom in, settle → exactly one `osrResize` fires per settle (no per-frame pump). Tag
  per `docs/testing/TESTING.md` › E2E tags.

## Acceptance (Phase 1)

- **M1:** at settled zoom 0.5 / 1 / 2 the preview text is no softer than a native board side-by-side
  (supersample buffer tracks on-screen px). Verified by the manual dev check + a screenshot pair.
- **M4:** Mobile/Tablet/Desktop reflow at the true breakpoint (a responsive localhost site shows its
  hamburger at Mobile), matching native `setZoomFactor` behaviour.
- No per-frame IPC: exactly one `osrResize` per settle / preset / resize-settle (asserted in e2e).
- Full gate green; FULL e2e matrix at the pre-merge gate (cluster touches `src/main` → Linux leg
  required).

## Risks / handoffs

- **Cost (→ Phase 2 / M2):** supersampling multiplies buffer bytes (S=2 ⇒ 4× pixels) and the renderer
  still does a per-pixel BGRA→RGBA swap (`useOffscreenPreview`). Phase 1 clamps `S ≤ 2` and quantizes;
  the real fix (visibility frame-gating, `MAX_LIVE`, `createImageBitmap`/`dirtyRect`) is **Phase 2** and
  must not be pre-empted here — only bounded.
- **`setZoomFactor` ⊗ offscreen:** the gap register prescribes this exact pair; verify in the dev check
  that the offscreen surface honours `setContentSize` + `setZoomFactor` (no `setDeviceScaleFactor`).
- **Resize churn:** `setContentSize` re-layouts the page. Quantizing `S` + the no-op guard keep this to
  genuine settles. A board-resize drag must debounce (settle), not send per NodeResizer frame.
- **DPR change:** a window moved to a different-DPR monitor must re-send (BUG-016 class — re-check, not
  one-shot).

## Out of scope (later OS-3 phases)

M2 throughput/CPU gating · IME/clipboard/AltGr/wheel (Phase 3) · native `<select>`/dialogs/downloads/mute
(Phase 4, design-artifact-gated) · P2 polish + the default-flip + native-path deletion (Phase 5).
