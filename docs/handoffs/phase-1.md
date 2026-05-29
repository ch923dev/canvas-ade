# Handoff — Phase 1 GATE, steps 1-B…1-E (preview feasibility spike)

> For a fresh session. Self-contained. Read this, then execute the next open step. This is the
> rest of the Phase 1 GATE ladder; **1-A is DONE** (commit `8a96d2d`). Steps run in order
> 1-B → 1-C → 1-D → 1-E, each ending **runnable + committed**. See `docs/roadmap.md` → Phase 1.

## Why this gate exists

Prove the hardest thing before building on it: a native `WebContentsView` browser preview that stays
**visually correct** as the React Flow camera pans/zooms — on Windows, with multiple views. A
`WebContentsView` is a NATIVE OS layer: it paints ABOVE all HTML, cannot be clipped/rounded/rotated,
has no z-index vs HTML, and has **no `destroy()`**. If we can't make it track the camera smoothly and
leak-free, the whole Browser-board concept needs rethinking — hence the gate. **If janky and unfixable
at the end of 1-E: STOP, write up options, decide with the user before Phase 2.**

## First 10 minutes (orientation)

1. Read `CLAUDE.md` — esp. **Architecture → Browser preview (the Phase 1 gate)** (the detach+snapshot
   / responsive-scale / cap-4 decisions) and the security model (never weaken).
2. Read `docs/roadmap.md` → **Phase 1** (the 1-A…1-E ladder + GATE verdict) and `docs/decisions/0001-stack.md`.
3. Skim `design-reference/project/DESIGN.md` **§7.2 Browser board** (device frames, viewport presets) and
   **§5 Canvas**.
4. Look at what already exists (the spike builds directly on this):
   - `src/main/preview.ts` — **single** `WebContentsView` + IPC `preview:open {url?,bounds}` /
     `preview:setBounds bounds` / `preview:close`. `round()` helper, `disposePreview()` does
     `webContents.close()`. Secure `webPreferences`. **Single-view today — 1-E makes it multi.**
   - `src/preload/index.ts` — `window.api.openPreview / setPreviewBounds / closePreview`.
   - `src/renderer/src/smoke/PreviewSmoke.tsx` — proves load + bounds-sync via `getBoundingClientRect()`
     on a cutout div (window-relative DIP rect → `setPreviewBounds`). **1-B replaces `getBoundingClientRect`
     with the camera math** so bounds come from the React Flow node + viewport, not the DOM.
   - `src/renderer/src/smoke/FlowSmoke.tsx` — the React Flow canvas (3 smoke nodes, `minZoom 0.1`/`maxZoom
     2.5`, `hideAttribution`). The `<DiagOverlay liveViews={n}/>` is already wired here (dev-default-on,
     toggle **Ctrl/⌘+Shift+D**).
   - `src/main/index.ts` — single `BrowserWindow`; native views attach via `win.contentView.addChildView(view)`.
   - `src/main/localServer.ts` — a loopback server; its `url` is the default preview target (good test page).

State: **Phase 1-A DONE & green** (commit `8a96d2d`). App runs `pnpm dev`. Headless smoke:
`$env:CANVAS_SMOKE='exit'; pnpm start` → prints `RENDERER_SMOKE …` + `SELFTEST_DONE …`.

## The load-bearing tools you already have (built in 1-A)

- **`src/renderer/src/lib/cameraBounds.ts`** — the camera→bounds math. USE THIS, don't reinvent:
  - `worldRectToScreen(node, vp, paneOffset)` → screen rect. `node` = world-space `{x,y,width,height}`,
    `vp` = `{x,y,zoom}` (React Flow viewport), `paneOffset` = the pane's top-left in window CSS px.
  - `roundRect(r)` → integer fields (`WebContentsView.setBounds` wants ints).
  - `rectsEqual(a,b)` → diff-skip for the rAF loop (skip the IPC when nothing moved).
  - 19 unit tests in `cameraBounds.test.ts`; extend them as the math grows (responsive scale in 1-E).
- **`src/renderer/src/spike/DiagOverlay.tsx`** — frame-time / FPS / `liveViews` count / JS heap. Feed it
  the live-view count (`liveViews={previewCount}`) to MEASURE 1-C smoothness and 1-E leak behavior.
- **Tooling gates** (all wired, run before every commit): `pnpm typecheck · lint · format:check · test ·
  build`. CI `check` runs lint+test+typecheck+build. Markdown is Prettier-ignored.

## `paneOffset` — get it right (this is the #1 alignment trap)

`WebContentsView.setBounds` takes coordinates relative to the **window content area** (DIP). React Flow's
node coords are world-space, transformed by the viewport `translate(x,y) scale(zoom)` on
`.react-flow__viewport`, and the pane itself is offset inside the window (the 44px topbar + tabs sit above
`.panel`). So: `screenRect = worldRectToScreen(nodeWorldRect, viewport, paneOffset)` where
`paneOffset = paneEl.getBoundingClientRect()` top-left (the React Flow pane, e.g. `.react-flow` or its
container). **Compute `paneOffset` once per layout** (ResizeObserver on the pane + on window resize), never
per frame. PreviewSmoke's `getBoundingClientRect` worked because the cutout already lives in window space;
the camera-driven version must add `paneOffset` explicitly.

React Flow v12 APIs you'll use: `useViewport()` (reactive `{x,y,zoom}`, fine when camera is still),
`useReactFlow().getViewport()` (imperative read in the rAF loop), `useStore(s => s.transform)`,
`useOnViewportChange({ onStart, onChange, onEnd })`, the `<ReactFlow onMove onMoveStart onMoveEnd>` props,
and node sizing via `node.measured?.{width,height}` (or fixed board dims for the spike).

---

## 1-B · Static overlay ⛓ 1-A — *START HERE*

One `WebContentsView` pinned to ONE React Flow node's bounds, **camera still**.

Checklist:
- [ ] Pick/mark one smoke node as the "preview node" (give it known world `{x,y,width,height}`; React Flow
      position = world x/y, set an explicit board size e.g. 360×240).
- [ ] On mount/open: read `viewport = getViewport()`, compute `paneOffset` once, then
      `bounds = roundRect(worldRectToScreen(nodeWorldRect, viewport, paneOffset))` → `window.api.openPreview({ bounds })`
      (defaults to the localServer URL — a good test page).
- [ ] Re-sync `setPreviewBounds` on pane resize / window resize (ResizeObserver, like PreviewSmoke) — but
      bounds now come from the math, not `getBoundingClientRect`.
- [ ] Render a placeholder "cutout" in the node so you can SEE alignment (the native view should sit
      exactly over it).
- ✅📏 view sits **pixel-aligned** over the node cutout at a few static zoom levels (set zoom via Controls,
      reopen). Transform unit tests still green (`pnpm test`). Commit.

Done-signal: open the preview, eyeball that the native view edges match the node's cutout edges at zoom 1,
~0.6, ~1.8. Tiny ≤1px rounding drift is fine; systematic offset means `paneOffset`/formula is wrong.

## 1-C · Live pan/zoom ⛓ 1-B — *the core risk*

View follows the camera **live**.

Checklist:
- [ ] Drive a **single rAF loop** off `useOnViewportChange`/`onMove` (NOT React re-renders). Each frame:
      compute `roundRect(worldRectToScreen(...))`, `rectsEqual`-skip if unchanged, else one coalesced
      `setPreviewBounds` IPC. One batch per frame — never N IPCs/frame.
- [ ] Watch the **per-frame IPC fan-out to MAIN** (shared channel with node-pty). Coalesce + diff-skip.
- [ ] Read trailing/lag off `DiagOverlay` (frame time, FPS) while panning/zooming hard on Windows.
- ✅📏 record perceived smoothness + frames-behind on Windows. 🚦 **If unacceptable even coalesced**, that's
      the signal detach+snapshot (1-D) must carry the motion — note it and move on, don't over-polish 1-C.
      Commit with the measurement written down (in the commit body or a short note).

## 1-D · Detach + snapshot ⛓ 1-C

Hide the native view during motion behind a captured image so there's no trailing live view.

Checklist:
- [ ] Add IPC `preview:capture` → `view.webContents.capturePage()` → `NativeImage.toDataURL()`. **Capture
      WHILE on-screen** (capture → await → detach), or the snapshot is blank.
- [ ] On `onMoveStart` (and below ~40% zoom — LOD): capture, then detach (`contentView.removeChildView` /
      hide), show the dataURL as an `<img>` card scaled to the node. On `onMoveEnd`: reattach
      (`addChildView`) + `setBounds` to exact current bounds.
- [ ] **Decide the open question (assumption: scales with camera):** does a Browser board shrink with zoom
      (snapshot scales as a unit) or stay 1:1? Lock it, write it in `CLAUDE.md`/an ADR if it deviates.
- ✅📏 perceived motion smooth (no trailing live view), snapshot never blank, scale model locked. Commit.

## 1-E · N views + responsive + lifecycle ⛓ 1-D

Make `preview.ts` **multi-view** and prove it scales + doesn't leak.

Checklist:
- [ ] Refactor `preview.ts` from the single `view`/`owner` to a **PreviewManager**: `Map<boardId, WebContentsView>`.
      All IPC (`open/setBounds/close/capture`) takes a `boardId`. `disposePreview(id)` + `disposeAll`.
- [ ] 2+ simultaneous views, each synced from its own node via the same rAF batch (one IPC batch/frame for
      ALL views, not per-view).
- [ ] **Responsive reflow** at true breakpoint width W∈{390,834,1280}: hold the page at fixed CSS width W,
      `fitScale = nodePx / W`, `view.webContents.setZoomFactor(fitScale * camZoom)` +
      `setBounds(width: W * fitScale * camZoom, …)` → real reflow at the breakpoint, scaled as a unit.
- [ ] **Cap ~4 live views**: close far/off-screen/over-cap views (`webContents.close()`), recreate on demand;
      below ~40% zoom show snapshots not live views.
- [ ] **Leak check**: open/close many times; watch `DiagOverlay` heap + `liveViews` count + Task Manager
      renderer-process count. Every removed board MUST `webContents.close()` (no `destroy()` exists).
- ✅📏 multi-view stays aligned; reflow correct at all 3 presets through camera changes; memory stable across
      open/close (no leaked renderers). Commit.

## 🚦 GATE verdict (end of 1-E)

Smooth + leak-free + aligned on Windows → **proceed to Phase 2** (the working sync code graduates into
Phase 2.0's production canvas; the rest of the spike can be thrown away). **If janky and unfixable**: STOP,
write up fallback options (snapshot-only previews, fewer live views, alternate transport than per-frame IPC)
and decide with the user before building Phase 2.

## Gotchas / carry-forward (don't relearn these)

- **`preview.ts` is single-view today.** 1-B–1-D can stay single-view; **1-E must refactor to a keyed
  multi-view PreviewManager.** Don't bolt a 2nd global `view` on — do the Map refactor.
- **`setBounds` wants window-content DIP coords**, not pane-local. Always add `paneOffset` (= pane
  `getBoundingClientRect()` top-left), computed once per layout — never `getBoundingClientRect` per frame in
  the rAF loop (layout thrash). Use `worldRectToScreen` (pure, cheap).
- **No `destroy()`** on `WebContentsView` → `webContents.close()` per removed board or you leak a renderer.
- **Capture before detach**: `capturePage()` of an off-screen/detached view is blank. capture → await → detach.
- **Per-frame IPC shares the channel with node-pty.** Coalesce to one batch/frame, `rectsEqual` diff-skip.
- **Native view paints above ALL HTML** — can't be clipped/rounded/rotated/z-indexed vs HTML. The snapshot
  card (HTML) is what lets you do rounded corners / LOD / motion.
- **Security (never weaken):** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, thin preload.
  New preview views keep the same secure `webPreferences` as `preview.ts` already sets. External nav →
  `setWindowOpenHandler` deny + `shell.openExternal`. Browser-board content must NEVER reach the PTY write channel.
- **node-pty stays `1.2.0-beta.13`** (winpty-free; repo path has a space). Don't touch.
- **React Flow:** `proOptions={{ hideAttribution:true }}`, `minZoom={0.1}`, `maxZoom={2.5}` already set.
- **Build is CDP-ready, don't implement CDP** (deferred). Build views as real `WebContentsView` (already are).
- **Every step ends green + committed:** `pnpm typecheck · lint · format:check · test · build`, then commit.
  Add tests for any new pure math (e.g. responsive `fitScale`) in `cameraBounds.test.ts`.

## What Phase 2.0 picks up (after the gate passes)

The salvaged sync code (camera math + PreviewManager + rAF batch + detach/snapshot) graduates into the real
canvas foundation: shared `BoardFrame`, persisted node-data schema + `schemaVersion`, app chrome shell, LOD
card. See `docs/roadmap.md` → Phase 2.0.
