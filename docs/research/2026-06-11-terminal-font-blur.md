# Terminal font blur — root cause + fix plan (2026-06-11)

> Status: fixes A1 (WebGL-only-at-crisp-zoom renderer policy) + A2 (settled-zoom snap band) are
> IMPLEMENTED on `fix/terminal-font-blur` (this PR): `useZoomSettle` + `settledZoomStore` +
> `snapZoom`/`isCrispZoom` in canvasView + the `suspend` generalization of `useTerminalWebgl`.
> Plan B (counter-scale re-raster) stays the documented fallback if DOM-renderer streaming perf
> ever disappoints. Evidence: `blurprobe/*.png` (untracked, repo root on the dev box) — same dense
> text captured from a WebGL-renderer terminal and a DOM-renderer terminal at camera zooms
> 0.8 / 1 / 1.3 / 2 on this machine (dpr = 1). Probe method: scratch Playwright spec (deleted;
> seed 9 terminals so the 9th lands past `WEBGL_BUDGET=8` on the DOM renderer,
> `resetTerminalWrite` identical text, clip-screenshot the node rect per zoom).

## TL;DR

The terminal is the ONLY board whose content is a **fixed-resolution bitmap under the camera
transform**. xterm's WebGL renderer sizes its canvas backing store from `window.devicePixelRatio`
alone (`CoreBrowserService.dpr` → `WebglRenderer` `device.* = css * dpr`); it has no idea React
Flow's `translate(x,y) scale(z)` exists. At any camera zoom z ≠ 1 the compositor bilinear-resamples
that bitmap by z → structural blur. Chromium's at-rest re-rasterization (Chrome ≥53) rescues **DOM
text** (planning boards, chrome, xterm's DOM renderer) at any zoom, but can **never** re-raster a
canvas. Verified empirically: at z=2 the WebGL terminal is mush while the DOM-renderer terminal is
razor-sharp; at z=0.8 WebGL is visibly smudged; at exactly z=1 both are fine.

Since fit/focus/free-zoom park the camera at arbitrary fractional z (FIT_FRAME maxZoom 2; focus
caps raster boards at 1 but routinely lands BELOW 1), users live at z ≠ 1 most of the time → the
terminal reads permanently blurry. Other boards are unaffected (see audit below).

## Root-cause stack (ranked)

1. **Camera zoom ≠ 1 × canvas raster** — dominant, structural. `@xterm/addon-webgl` 0.18 /
   xterm 5.5: backing store = `cols·cellW·dpr × rows·cellH·dpr`, CSS-sized back via
   `Math.round(device/dpr)`. No API to render at a custom scale (xterm #2662 — closed without an
   API; `CoreBrowserService.dpr` is a hardwired getter). Geometry (cell measurement) IS
   transform-agnostic since 5.4 (`TextMetricsMeasureStrategy`, PR #4929) — only raster resolution
   is wrong.
2. **Grayscale-AA atlas vs ClearType** — minor at z=1/dpr=1: the shared transparent glyph atlas
   cannot do subpixel AA (xterm #973), so WebGL text reads slightly softer than DOM text even when
   pixel-exact. VS Code's escape hatch is `terminal.integrated.gpuAcceleration: "off"` = DOM
   renderer (vscode #134622, #84194).
3. **Fractional default fontSize 12.5 (ADR 0005)** — small: atlas glyphs are drawn at integer
   device px regardless, but fractional sizes maximize floor/ceil drift between atlas cell and CSS
   cell (xterm #1844/#967 lineage), and at dpr 1.25/1.5 fractional CSS cells composite at
   fractional device offsets.
4. **Fractional React Flow translate** — sub-pixel compositing softness for everything (xyflow
   #3282); cosmetic next to 1–3.

## Other boards (audited — not affected the same way)

- **Planning** (notes/text/checklist = DOM, pen = SVG): crisp at rest at any zoom — Chromium
  re-rasters composited layers on scale change unless `will-change: transform` pins them
  (https://developer.chrome.com/blog/re-rastering-composite). Verified `@xyflow/react` dist CSS
  ships NO `will-change`, and the repo adds none (the flip 3D transform is animation-only,
  flat-at-rest by design). Transient blur DURING a zoom gesture is normal compositor behavior.
- **Browser**: native `WebContentsView` re-flows via `setZoomFactor` → crisp; the snapshot `<img>`
  is motion/LOD/over-cap only (transient by design).
- **LOD cards / BoardFrame chrome**: DOM → crisp at rest.

## Fix plan (for the worktree that implements this)

**A. Quick wins (ship regardless):**
1. **Renderer policy: WebGL only at z=1, DOM renderer otherwise (at rest).** The probe proves the
   DOM renderer is crisp at EVERY zoom at rest. `useTerminalWebgl` already owns attach/detach on
   the `lod` flag — extend the policy to `lod || settledZoom !== 1` (read settled zoom on
   onMoveEnd, the same source the LOD flag uses; epsilon-band z≈1). Detaching the addon reverts
   xterm to the DOM renderer (proven in-repo by the over-budget fallback). Bonus: fewer live GL
   contexts. Risk to measure: DOM-renderer paint cost under heavy agent streaming with several
   terminals at z≠1 — if it janks, keep WebGL while `state === 'running'` and streaming, or fall
   back to plan B.
2. **Zoom detent at 100%**: snap settled zoom in [~0.95, 1.06] to exactly 1 on gesture end so the
   common working band gets the pixel-exact WebGL path for free.
3. Optional polish: integer default font (13 vs 12.5; touches ADR 0005 + reset constant), and
   integer-rounded RF translate (xyflow #3282) for chrome/DOM crispness.

**B. The "true fix" fallback (if DOM-renderer perf disappoints): re-raster at effective scale.**
On onMoveEnd, per detail terminal: inner wrapper `width/height × z` + `transform: scale(1/z)`
(origin 0 0) and `term.options.fontSize = base × z` — backing store then equals on-screen device
pixels at any z. Keep cols/rows FIXED (do NOT refit) so the PTY/TUI never reflows on zoom; accept
sub-pixel slack at the well edge. Must also teach `terminalSelection`'s shim + `terminalCellPoint`
the extra inner scale. This is the xterm-maintainer-suggested approach (#2662) and what VS Code
does conceptually (zoom = fontSize change). Medium effort/medium risk (resize-storm and #4886-class
edges) — hence A first.

**Do NOT**: hack `window.devicePixelRatio` (global, breaks previews/captures; xterm's dpr observer
is matchMedia-based and won't even fire), or use Electron `setZoomFactor` (window-global).

## Key references

- xterm WebGL dpr-only sizing: `node_modules/@xterm/addon-webgl/src/WebglRenderer.ts` (`_devicePixelRatio`, `_updateDimensions`), `@xterm/xterm/src/browser/services/CoreBrowserService.ts` (`get dpr`).
- xterm issues: #2662 (blur at zoom, manual-scale remedy), #2488/#4929 (transform-agnostic measurement since 5.4), #973 (no subpixel AA in atlas), #1844/#967 (fractional metrics), #4886 (fontSize-zoom edges).
- VS Code: `terminal.integrated.gpuAcceleration: off` = DOM renderer fixes blur reports (#134622, #84194, #85154).
- Chromium at-rest re-raster (DOM only, never canvas; `will-change` opts out): https://developer.chrome.com/blog/re-rastering-composite
- React Flow fractional-transform blur: xyflow/xyflow #3282.
- In-repo: `Canvas.tsx` focusBoard already caps raster boards at maxZoom 1 (the team knew); `FIT_FRAME` maxZoom 2 still upscales terminals; `useTerminalWebgl.ts` is the attach/detach seam for fix A1.
