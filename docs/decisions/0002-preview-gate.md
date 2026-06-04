# ADR 0002 — Native `WebContentsView` preview is feasible (Phase 1 gate PASSED)

- **Status:** Accepted (2026-05-29)
- **Context:** Phase 1 was a hard gate (ADR 0001 flagged native-overlay sync as the biggest cost,
  "lags worse on Windows"). Steps 1-A…1-E each isolated one risk variable on Windows. This ADR
  records the verdict and the load-bearing implementation decisions discovered while passing it.

## Decision

**The native `WebContentsView` browser-preview approach is feasible. Proceed to Phase 2.** The salvaged
sync code (camera→bounds math, keyed `PreviewManager`, single rAF batch, detach+snapshot, responsive
`fitZoomFactor`) graduates into the Phase 2.0 canvas foundation.

## What was proven on Windows

- **Alignment** — a view positioned by `worldRectToScreen(nodeWorldRect, viewport, paneOffset)` sits
  pixel-aligned over its node at static zooms (1-B).
- **Live tracking** — a single rAF pump off `useOnViewportChange` (one coalesced `setBounds` IPC/frame,
  `rectsEqual` diff-skip, self-stopping) held **165 fps / ~6.1 ms** with the live view through hard
  pan/zoom — smoother than ADR 0001 feared (1-C).
- **Motion / LOD** — `capturePage` (while attached) → snapshot `<img>` inside the node → detach carries
  motion with no trailing native layer; reattach exact bounds on `onMoveEnd`; snapshot below 40% zoom (1-D).
- **Multi-view + leak-free** — keyed `Map<id, WebContentsView>`; two views synced from one IPC batch/frame;
  open/close cycling held `electron.exe` at **6 → 4 → 6** (preview renderers freed on `close()`, no climb),
  full close → 0 processes (1-E).

## Load-bearing implementation decisions

1. **Per-board session isolates zoom.** Chromium stores page zoom **per-host in the session's zoom map**.
   Multiple views of the same origin on a shared session share zoom — `setZoomFactor` on one rewrites it
   for all (presets synced across boards). Fix: a unique `partition: \`preview-<id>\`` per view.
2. **Browser board scales WITH the camera** (snapshot scales as a unit), not 1:1. Locked in 1-D.
3. **Responsive reflow** holds the page at a fixed CSS width W∈{390,834,1280} via
   `setZoomFactor = (nodeWorldW / W) * camZoom` (so `bounds.width / zoomFactor === W`, media queries fire
   at the breakpoint), then scales as a unit. Pure, tested (`fitZoomFactor`).
4. **Snapshot stays as a fallback layer under the live view** (never cleared on attach) so a reattach can
   never flash the bare cutout.
5. **No `destroy()`** → every removed board calls `webContents.close()`; `disposeAll` on shutdown.

## Known constraints (inherent to native overlays — carried to Phase 2)

- **A `WebContentsView` paints above ALL HTML** → it occludes other (HTML) boards and any in-canvas
  chrome it overlaps. Mitigations: LOD/motion snapshots (HTML, clippable) cover most cases; **put chrome
  in a bar OUTSIDE the canvas pane** (views are bounded to the pane); Full view DETACHes the native view
  during the modal tween and re-ATTACHes on exit (snapshot is an intermediate fallback only, not a
  permanent stand-in) so HTML chrome is never punched through. Boards rarely overlap in normal use.
- **Zoom-factor floor (0.25)** → the 1280 desktop preset can't reach a true 1280 CSS px at heavy camera
  zoom-out (it clamps to a narrower breakpoint); correct in the working-zoom band, and a snapshot below
  40% anyway. Phase 2 picks board world-sizes that keep presets unclamped across the normal zoom band.

## Consequences

- Phase 2.0 promoted the sync code into the shared `BoardFrame` + `BrowserPreviewLayer`; `FlowSmoke.tsx`
  is a dead spike file (kept as reference, not wired into the app).
- The liveness policy was refined through Phase 2.2 and finalised in PR #14: **LOD/occluded boards
  DETACH** (webContents is kept alive for fast reattach); **over-cap boards are closed**
  (`webContents.close()`) only when a snapshot fallback already exists; **full-view exit always DETACHes**
  (never closes) so the page's navigation state is preserved across modal transitions.
