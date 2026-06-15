# OS-3 Phase 2 — OSR preview throughput / CPU gating (M2)

> Slice spec for `feat/osr-throughput`. Second phase of OS-3 (OSR Browser-preview
> productionization). Per the doc-lifecycle this file is **deleted on the FINAL OS-3 PR** (the
> build-history line is the residue, #150 backdrop precedent). Authoritative gap register: the
> spike spec `docs/reviews/2026-06-14-electron-to-flutter-assessment/preview-offscreen-spike-spec.md`
> › §8c (the **M2** + **MAX_LIVE** rows). Builds on Phase 1 (#155 — M1 supersample + M4 reflow).

## Decisions locked

- **Rollout (unchanged):** OSR is still **flag-gated** (`VITE_PREVIEW_OSR`); the default-flip + native
  path deletion is Phase 5. This phase only changes behaviour behind the flag.
- **Phase 2 = the M2 row in full:** per-board `setFrameRate`/`stopPainting` visibility-gating, the
  `MAX_LIVE` existence cap, and the per-frame pipeline cost (`dirtyRect` + the BGRA→RGBA swizzle).

## Problem (grounded in the code)

The Phase-1 producer is correct but **ungated** — every offscreen board paints forever at full rate
and every Browser board holds a full hidden renderer process, regardless of whether the user can see it:

- `src/main/previewOsr.ts` — `ensureOsr` creates ONE hidden offscreen `BrowserWindow` per board,
  `wc.setFrameRate(30)`, `wc.startPainting()` on first ready, and then **never stops**. A board panned
  off-screen, zoomed below LOD, or simply idle keeps emitting ~30 BGRA frames/s. The `paint` handler
  ignores its `dirty` argument and emits the **whole** frame every time.
- `src/renderer/.../useOffscreenPreview.ts` — opens its window on mount and closes on unmount; nothing
  caps the number of concurrent windows. Each frame runs a **per-pixel** JS loop (`for i … rgba[i]=…`)
  to swap BGRA→RGBA, then a full-frame `putImageData`. With S=2 (Phase-1 supersample) a 1280-desktop
  board is a 2560×1600 BGRA buffer ≈ 16 MB/frame; the swizzle touches every one of ~4M pixels.

Three consequences (the §8c rows this phase closes):

- **M2 — CPU/battery:** 4 boards panned off-screen keep MAIN's GPU readback + the renderer's swizzle
  pegged. The spike's own quick-probe — *"4 boards panned off-screen, walk away → CPU stays pegged?"* —
  is a known **yes** today. Co-risk: the readback shares MAIN with node-pty, so runaway frames can
  starve PTY I/O (the M2 pass-threshold explicitly co-tests typing in a Terminal board).
- **MAX_LIVE — RAM:** N Browser boards = N hidden renderer processes (~50–100 MB each). The native path
  caps concurrent live views at 4 (`usePreviewManager` `MAX_LIVE`); OSR has no equivalent.
- **Per-frame cost:** the full-frame swizzle + full `putImageData` runs on the renderer main thread for
  every paint of every live board, even when one character blinked.

## Design

The OSR path's defining win is **zero per-frame camera IPC** (the `<canvas>` moves with the DOM). M2
must preserve that: all gating is **settle-driven**, never a per-frame pump. And because a `<canvas>`
clips/z-orders like any DOM node, the OSR liveness decision is **far simpler than the native one** —
there is **no occlusion, no focus-isolation, no chrome-exclusion zones** (the §7 payoff). The whole
`shouldDemoteForOcclusion` / `chromeExclusionZones` / focus-isolation apparatus from `previewPlan.ts`
is **not ported**. OSR liveness is only: *is this board on-screen, big enough, and within the cap.*

### 2A — Visibility paint-gating (the CPU win)

A board's offscreen window should paint only while the board is **visible** — on-screen and zoomed in
enough to be worth the frames. Otherwise `stopPainting()` it: CPU for that window drops to ~0 and the
**last painted frame stays on the `<canvas>`** as a free static snapshot (no extra snapshot machinery —
the bitmap is already there). On return to visible, `startPainting()` + `wc.invalidate()` (force one
fresh repaint so a stale frame never lingers — the §8c "stale frame on resume" row).

**Pure decision (`src/renderer/src/lib/osrLiveness.ts`, no DOM — sibling of `osrSizing.ts`):**

```
isOsrVisible({ screen: Box, pane: Box, zoom, lod }): boolean
  = zoom >= lod                 // below LOD → freeze (the native snapshot-at-LOD analogue)
  && rectsOverlap(screen, pane) // intersects the visible pane (ANY overlap — unlike native,
                                //   a partially-above-pane board is fine: the canvas clips)
```

Note the difference from native `isLiveEligible`: native requires `screenY >= paneTop` (a native view
can't be clipped above the pane); OSR only needs **intersection** (the canvas clips), so a board half
above the pane top stays live. `rectsOverlap` is the existing pure predicate (reused, not re-imported
from the occlusion layer — copied/shared into `osrLiveness.ts` to keep the module self-contained).

**The manager (`src/renderer/.../useOffscreenLiveness.ts`):** mounted ONCE in `BrowserPreviewLayer`,
**above** the `OSR_PREVIEW` early-return (next to `useBrowserAutoConnect`, the same engine-agnostic
slot). It has RF context (`useReactFlow().getViewport`) and the `paneRef`. It reconciles on the
**low-frequency** signals only:

1. **camera settle** — `useOnViewportChange({ onEnd })` (fires once when a pan/zoom gesture ends, pan
   included — the piece `settledZoomStore` alone misses);
2. **board geometry settle** — the `nodeGesture` falling edge (drag/resize end), same signal the native
   manager detaches on;
3. **board set change** — a Browser board added/removed/url-changed (canvasStore subscription).

Per reconcile it computes each Browser board's screen rect (`deviceStageRect` + `worldRectToScreen`,
the same geom helpers the native manager + Phase-1 sizing use), runs `isOsrVisible`, and **diffs** the
desired paint-state against the last sent. Only **changed** boards fire IPC — `window.api.setOsrPaint(id,
painting)` — so a settle that changes nothing sends nothing.

**MAIN handler `preview:osrSetPaint` (frame-guarded, `registerPreviewOsrHandlers`):**
- track `painting` on the `OsrEntry`;
- `painting:false` → `wc.stopPainting()` (idempotent-guarded on the tracked flag);
- `painting:true` → `wc.startPainting()` then `wc.invalidate()` (clear the stale frame, repaint now).
- A board still `connecting`/`load-failed`/`crashed` is never force-painted on (mirror the crash-ready
  gate: `startPainting` stays latch-gated; setPaint only toggles a board that has begun painting).

### 2B — MAX_LIVE existence cap (the RAM win)

Even frozen (`stopPainting`), a hidden window still holds a renderer process. Cap the number that
**exist** at once. Reuse the native `pickLive` (distance-to-viewport-centre rank, stable ties) +
`MAX_LIVE = 4` from `previewPlan.ts`:

- The manager ranks **all** Browser boards (visible first, then nearest the pane centre) and marks the
  top `MAX_LIVE` `alive:true`, the rest `alive:false`.
- It writes a tiny `osrLivenessStore` (`{ byId: { [id]: { paint, alive } } }`). `useOffscreenPreview`
  **reads `alive` for its board** and gates its open/close on it (the open/close lifecycle stays in the
  per-board hook — the manager only decides; it does NOT own the IPC open). An evicted board:
  `closeOsrPreview` (frees the renderer) but **does NOT clear the canvas** → the last frame stays as a
  frozen snapshot, and a "paused" badge shows (mirrors the native evicted state in `BrowserBoard`).
- **Recreate on demand:** when an evicted board climbs back into the top `MAX_LIVE` (user pans to it),
  `alive` flips true → `useOffscreenPreview` re-opens → reconnect → fresh frames. previewStore briefly
  shows `connecting`; the frozen frame covers it until the first new paint.

This is the only invasive piece (it changes when a window exists). It is built **after** 2A+2C are
green; if its recreate-lifecycle proves hairy it splits to its own PR (Phase 2b) and 2A+2C ship as the
Phase-2 PR — 2A already delivers the headline CPU win.

### 2C — Frame-pipeline efficiency (per-frame cost)

Independent of liveness; cuts the cost of each frame that DOES paint.

- **Honor `dirtyRect`.** Electron's `paint` event gives `(event, dirty, image)` where `dirty` is the
  changed rect. MAIN crops to it — `image.crop(dirty)` → a smaller `NativeImage` → `toBitmap()` of just
  the changed region — and ships `{ id, full:{w,h}, dirty:{x,y,w,h}, buffer }`. Smaller IPC payload AND
  a smaller swizzle. The renderer keeps the canvas at the FULL frame size and `putImageData(patch,
  dirty.x, dirty.y)` — a partial blit. A resize/first-paint sends a full-frame `dirty` (whole image), so
  the existing full-frame path is just the `dirty == full` case.
- **Fast swizzle.** Replace the per-byte loop with a 32-bit-word swizzle over a `Uint32Array` view:
  one read + one write per pixel (`out = (px & 0xFF00FF00) | ((px & 0xFF) << 16) | ((px >> 16) & 0xFF)`,
  endianness-checked) instead of four byte ops — ~4× fewer array accesses. Kept in a pure, unit-tested
  `bgraToRgba(src, dst?)` helper. (A worker / `OffscreenCanvas` / WebGL upload is a bigger rewrite —
  noted as P2, not done here; dirty-rect + the word swizzle make the main-thread cost negligible for
  typical mostly-static pages.)

## Files

| File | Change |
|---|---|
| `src/renderer/src/lib/osrLiveness.ts` (new, pure) | `Box`, `rectsOverlap`, `isOsrVisible`, `pickLiveOsr` (or reuse `previewPlan.pickLive`); unit-tested |
| `src/renderer/src/lib/bgraToRgba.ts` (new, pure) | 32-bit-word BGRA→RGBA swizzle; unit-tested |
| `src/renderer/src/store/osrLivenessStore.ts` (new) | tiny Zustand store `{ byId: { paint, alive } }` (2B) |
| `src/renderer/.../useOffscreenLiveness.ts` (new) | the settle-gated manager; computes paint+alive, diffs, fires `setOsrPaint`, writes the store |
| `src/renderer/.../BrowserPreviewLayer.tsx` | mount `useOffscreenLiveness(props)` above the OSR early-return |
| `src/renderer/.../useOffscreenPreview.ts` | gate open/close on `alive` (2B); partial `putImageData` at the dirty offset + `bgraToRgba` (2C); keep last frame on evict |
| `src/main/previewOsr.ts` | `OsrEntry.painting`; `applyOsrPaint(win,state,on)` (start/stop+invalidate, idempotent); crop to `dirty` in the paint handler; `preview:osrSetPaint` handler |
| `src/preload/index.ts` (+ `index.d.ts`) | expose `setOsrPaint(id, painting)`; `OsrFramePayload` gains `dirty` |
| `src/renderer/.../BrowserBoard.tsx` | read `alive`/evicted from the store → "paused" badge in OSR mode (2B) |

## Tests

- **`osrLiveness.test.ts` (pure):** below LOD → not visible; off-pane (no overlap) → not visible;
  partially-above-pane → visible (the OSR-vs-native difference); `pickLiveOsr` caps to MAX_LIVE and
  distance-ranks toward the pane centre with stable ties.
- **`bgraToRgba.test.ts` (pure):** R/B swapped, G/A preserved; round-trips; handles a cropped
  (dirty-rect) buffer length; no-op on empty.
- **`previewOsr` (main):** `preview:osrSetPaint(false)` calls `stopPainting`; `(true)` calls
  `startPainting`+`invalidate`; idempotent (a second identical set is a no-op); frame-guard rejects a
  foreign sender. `paint` with a sub-rect `dirty` crops + emits `dirty` in the payload.
- **e2e (`@preview`, flag ON):** pan a board fully off-screen, settle → exactly one `setOsrPaint(false)`
  fires (no per-frame pump); pan it back → one `setOsrPaint(true)`. With >MAX_LIVE boards, only
  MAX_LIVE windows exist (assert via a debug count). Tag per `docs/testing/TESTING.md` › E2E tags.

## Acceptance (Phase 2)

- **M2 (CPU):** 4 boards panned fully off-screen → their offscreen windows stop painting (MAIN CPU for
  the preview path drops to ~idle); typing in a concurrent Terminal board has no perceptible lag.
  Verified by the manual dev check (Task Manager / `wc.isPainting()` probe) + a before/after note.
- **MAX_LIVE (RAM):** with >4 Browser boards only 4 hidden renderers exist at once; panning to a 5th
  evicts the farthest and recreates the target (its frozen frame covers the reconnect).
- **2C:** a mostly-static page paints sub-rect patches (dirty-rect honored); the swizzle is the word
  path. No visual regression vs Phase 1 at z = 0.5 / 1 / 2.
- No per-frame IPC anywhere: paint-state + sizing both fire only on settle. Full gate green; FULL e2e
  matrix at the pre-merge gate (touches `src/main` → Linux leg required).

## Risks / handoffs

- **Resume staleness:** a frozen board that resumes must `invalidate()` or it shows the pre-freeze frame
  for up to one paint interval — explicitly handled in `applyOsrPaint(on:true)`.
- **Evict/recreate churn (2B):** rapid pan across many boards could thrash open/close. Mitigate with the
  settle gate (only on move-END) + the stable-tie ranking (a board on the boundary doesn't flip every
  settle). If still thrashy, add a small hysteresis margin to the cap — noted, not pre-built.
- **dirty-rect + supersample:** Phase-1 `setZoomFactor(S)` means the `dirty` rect is in the
  **supersampled** surface space (matches `image` and the canvas, which is also S-sized) — no extra
  scaling. Verify the crop offset lands correctly at S=2 in the dev check.
- **PTY co-test (locked M2 threshold):** the dev check MUST type in a Terminal board while a Browser
  board animates — the readback shares MAIN with node-pty; "no perceptible PTY input lag" is a release
  gate, not a nicety.
- **Stop-painting + lifecycle events:** a `stopPainting`'d window still receives nav/crash events; the
  paint flag is orthogonal to the load-latch/crash-ready gate — do not entangle them.

## Out of scope (later OS-3 phases)

IME/clipboard/AltGr/wheel (Phase 3) · native `<select>`/dialogs/downloads/mute (Phase 4,
design-artifact-gated) · the default-flip + native-path deletion + P2 polish, incl. a worker/
`OffscreenCanvas`/WebGL frame path and the 60fps focused-board cap (Phase 5).
