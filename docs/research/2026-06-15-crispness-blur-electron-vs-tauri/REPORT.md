# Canvas crispness / blur — root causes, per-surface fixes, and Electron vs Tauri

*Research synthesis — 2026-06-15. Lead synthesis of a codebase audit, web research, and a 3-lens Electron-vs-Tauri decision panel. Companion to `docs/reviews/2026-06-14-electron-to-flutter-assessment/` (Flutter NO-GO) and ADR 0002 (preview/occlusion).*

---

## 1. Executive summary

- **Headline verdict: STAY ON ELECTRON. Fix blur per-surface, in app. Do NOT migrate to Tauri (or Flutter).** All three decision lenses — migration-cost-and-risk, rendering-quality, terminal-and-preview — return `stay-electron-fix-blur` with `blurFixableInElectron: true`. The verdict is unanimous.
- **The blur is a compositor-universal property, not an Electron defect.** A fixed-DPR `<canvas>`/`<img>` bitmap is bilinear-resampled by `transform: scale(z)` at any z != 1, and *no* compositor (Chromium, WebView2, WKWebView, WebKitGTK) can re-rasterize a canvas's pixels on scale change. Switching engines re-implements the same fix on three engines for zero net gain. ([Chrome — re-rastering composited layers](https://developer.chrome.com/blog/re-rastering-composite))
- **The terminal blur class (#122/#125/#138) is already comprehensively solved** by the shipped FREEZE counter-scale (`useTerminalReraster.ts`): the xterm host lays out at `content x cs` with `transform: scale(1/cs)`, so the GL backing store maps 1:1 to device pixels at *every settled zoom*. There is nothing left to harvest here.
- **DOM/SVG/whiteboard chrome is crisp by construction** because Chromium re-rasters DOM/SVG at the transformed resolution at rest. Crucially, **WebKit does NOT** (bug 27684, open since 2009), so a Tauri move would *regress* this free behavior on macOS and Linux — a rendering-quality loss, the opposite of the migration premise. ([WebKit bug 27684](https://bugs.webkit.org/show_bug.cgi?id=27684))
- **The residual blur is small and in-app fixable on Chromium:** device-pixel-snap the React Flow viewport translate (xyflow #3282 / drei #2380), transient `will-change` during gesture only, supersample snapshots, and the already-shipped [0.95, 1.06]->1 snap band. This is a few-hundred-line change reusing existing `onMove`/`onMoveEnd` plumbing — not a 12-24 engineer-month rewrite.
- **The only hard rendering problem (browser-preview occlusion) is fixable in Electron today** via offscreen-render -> HTML `<canvas>` (OSR `paint` / CDP `Page.startScreencast`, pre-authorized by ADR 0002), already proven flag-gated in #151. Tauri makes that fix **impossible** (no offscreen/render-to-texture path in wry/WebView2) — it removes the ability to fix occlusion rather than delivering it.

---

## 2. Where blur comes from today — per surface

### 2.1 Canvas / React Flow camera transform

React Flow paints all canvas content under one CSS transform on `.react-flow__viewport`: `transform: translate(vp.x, vp.y) scale(vp.zoom)` with origin `0 0` (documented in `src/renderer/src/lib/cameraBounds.ts:1-20`, applied internally by React Flow, never overridden in app CSS).

- At any settled zoom z != 1, the Chromium compositor bilinear-resamples each board's painted layer. For **DOM/SVG** this is transient — Chromium re-rasters at rest, so settled chrome is usually sharp. For **`<canvas>`** it is structural and permanent.
- The app has essentially one app-wide crispness lever: `useZoomSettle` + `snapZoom` snap a settled zoom inside [0.95, 1.06] to exactly 1 (`src/renderer/src/lib/canvasView.ts:58-68`, `src/renderer/src/canvas/hooks/useZoomSettle.ts`).
- **Gaps:** no device-pixel snapping of the camera *translate* (vp.x/vp.y land board edges on sub-pixel screen boundaries on fractional-DPR displays), no `will-change`/`contain`/`image-rendering` tuning on `.react-flow__viewport` or board nodes, no per-node counter-scale fallback. React Flow's un-rounded viewport transform is a known library blur source on dPR=1 displays ([xyflow #3282](https://github.com/wbkd/react-flow/issues/3282)).
- The `.reflowing .react-flow__node` transform transition (`index.css:2365`) leaves absorbed/reflowed boards mid-tween (compositor-scaled, soft) for ~340ms during the group-absorb animation.

### 2.2 Terminal (xterm.js + node-pty)

The terminal renders xterm into a div inside the camera transform, so a naive setup is bitmap-resampled and blurs at every z != 1. **This is solved.** The live mechanism is the FREEZE counter-scale (#125, which superseded #122's WebGL-only-at-100% renderer-swap policy):

- `useTerminalReraster.ts:124-139` lays the host out at `boardContent x cs` with `transform: scale(1/cs)` (net visual scale exactly 1 at rest). The GL/DOM backing store maps 1:1 to device pixels at every settled zoom.
- Single font seam: `effectiveTerminalFont = pin x cs` (`terminalFont.ts:55-58`), fractional, written only to `term.options.fontSize`, never routed through the store/undo (the `fromObject` clamp would destroy it). cols/rows are FROZEN — zoom never triggers a ConPTY reflow.
- WebGL held at every settled zoom (suspend = LOD only, `useTerminalSpawn.ts:244-255`); over-budget boards fall back to the DOM renderer (also crisp at net scale 1); `WEBGL_BUDGET=8` cap + orphan-canvas sweep (`useTerminalWebgl.ts:85-110`).
- Hinted OS mono font (`--term-mono`: Cascadia Mono/Consolas) resolved from the CSS var before handing to xterm, because `var()` doesn't resolve on xterm's grayscale-AA canvas atlas (`useTerminalSpawn.ts:374-388`).

**Residual blur (all intentional):** (1) mid-gesture softness during the ~250ms `SETTLE_MS` window (no motion snapshot, by design); (2) sub-pixel font at overview zooms (~2px/char) is unwinnable — the Overview button was *removed* (#138) rather than chase it; (3) the no-clip rAF correction can leave a same-bg gutter (0-14%) at quantization-hostile zooms — a fit artifact, not a glyph-sharpness one. Root cause confirmed in xterm source: `CoreBrowserService.dpr` returns `window.devicePixelRatio` alone; `WebglRenderer` sizes the backing store from dpr alone, with no transform awareness ([xterm WebglRenderer](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-webgl/src/WebglRenderer.ts), [issue #2662](https://github.com/xtermjs/xterm.js/issues/2662)).

### 2.3 Browser / preview

The **live native `WebContentsView` is crisp by construction:** `setBounds(round(rect))` positions it and `setZoomFactor` *reflows* the page at the chosen scale (Chromium re-lays-out, doesn't resample). Blur on the shipping path comes only from fallbacks:

- **Snapshot fallback (primary):** `preview.ts:640` `capturePage()` captures at the view's current native size, returned as a dataURL and shown as `<img class="bb-snapshot">` with `object-fit: cover` (`index.css:969-976`) under the camera `scale(z)` transform. Any pan/zoom off the capture moment bilinear-resamples a fixed bitmap — the pre-#122 terminal class returning. This is the visible state during motion, below `LOD_ZOOM` (0.4), over `MAX_LIVE=4`, and on every occlusion demote.
- **OSR spike (structural, always-on blur):** `previewOsr.ts` renders every page into a fixed `1280x800` logical bitmap (`OSR_WIDTH/HEIGHT`), streamed BGRA into a `<canvas class="bb-live">` (`useOffscreenPreview.ts`); resampled by both the device-frame fit and the camera scale at every zoom. The spike spec marks this gap **M1** (broken — `setContentSize(W*S) + setZoomFactor(S)` supersample is the recorded fix lever).
- **Minor:** integer `roundRect` bounds rounding (`cameraBounds.ts:55-63`) is a sub-pixel alignment seam, not a perceptible blur; the `[0.25, 5]` `zoomFactor` floor degrades *correctness* (wrong breakpoint) at heavy zoom-out, not sharpness, in the working band.

### 2.4 Whiteboard / Planning

The architectural **opposite** of the terminal problem — essentially already crisp. All live content is SVG or plain DOM, with **no live `<canvas>`** in the render path:

- Arrows/strokes/marquee/guides/endpoint handles are SVG (`WhiteboardSvg.tsx`); notes/free-text/checklist/image cards are absolutely-positioned DOM. Perfect-freehand is an SVG *fill outline* path (`svgPaths.ts`), not a raster.
- Because the camera scale is a CSS transform on an ancestor, Chromium re-rasters DOM text + SVG geometry at the final transformed resolution on every settled zoom (the assessment README:104-109 notes: "Chromium's at-rest re-rasterization rescues DOM/SVG but can never re-raster a `<canvas>`").
- Planning full view is a deliberate **camera fit** (`useFullView.ts:24-26`, `maxZoom: Z_MAX`), NOT the portal+second-transform path — chosen precisely because vectors re-raster crisp at any zoom.
- The only `<canvas>` in the subtree is `exportBoard.ts` (offscreen PNG rasterizer, not live display). Residual softness is the universal during-gesture transient plus normal raster-image upscaling for pasted `ImageCard` bitmaps.

### 2.5 Fonts / DPR (global)

- All UI text is HTML laid out by Chromium and re-rastered per zoom — crisp by construction. There is **no global `image-rendering`, `translateZ`/`will-change` GPU-layer hack, or `imageSmoothingEnabled` override** anywhere in the renderer that would pin chrome to a fixed bitmap. This absence is a load-bearing invariant.
- Self-hosted Geist variable woff2 (`font-display: swap`) for UI; a separate hinted `--term-mono` stack only for the xterm grid. `-webkit-font-smoothing: antialiased` on body is intentional for the dark theme.
- DPR handled where it matters: terminal re-fits on a `matchMedia` resolution change (`TerminalBoard.tsx:237-249`); backdrop canvas scenes clamp the backing store to `min(devicePixelRatio, 1.5)` (`DPR_CLAMP`, duplicated across ~10 scene files).
- **Minor drift:** the design reference uses `text-rendering: optimizeLegibility`; the app body sets only `-webkit-font-smoothing: antialiased`. Likely deliberate (ligature/kerning layout cost) but unreconciled.
- **Scope-out:** backdrop scene `<canvas>` layers and native `WebContentsView` previews are screen-fixed / integer-positioned and do *not* ride the RF viewport scale — not camera-scale blur sources.

---

## 3. Root-cause analysis — inherent vs fixable

The single governing rule, confirmed by primary Chromium/web.dev/Blink sources and the repo's own #122 forensics ([Chrome re-raster](https://developer.chrome.com/blog/re-rastering-composite), [web.dev antialiasing-101](https://web.dev/articles/antialiasing-101)):

> Chromium rasterizes content into GPU tiles at a chosen raster scale, then the compositor draws them with the layer's transform. **DOM/SVG/text without `will-change`** are re-rasterized at the new effective scale once a transform settles -> crisp at rest at any zoom. **A `<canvas>`/`<img>`** is an immutable bitmap with no display list -> the compositor can only bilinear-resample it -> structurally blurry at any z != 1. The compositor can *never* re-raster a canvas's pixels.

| Blur source | Inherent to CSS scale(z)? | Verdict |
|---|---|---|
| xterm WebGL/canvas bitmap resampled by camera | Yes (any compositor) | **FIXED** in Electron via counter-scale FREEZE (#125). |
| capturePage snapshot `<img>` resampled during motion/LOD | Yes (fixed bitmap) | Fixable: capture at settled device scale + supersample; minimize the snapshot window. |
| OSR fixed `1280x800` bitmap (spike) | Yes (fixed bitmap) | Fixable: `setContentSize(W*S) + setZoomFactor(S)` (M1). |
| Fractional viewport *translate* on `.react-flow__viewport` | No — a snapping defect | Fixable: round translate to device pixels on settle. |
| Mid-gesture soft DOM/terminal (compositor scales cached tiles pre-re-raster) | Partly inherent (re-raster is at-rest) | Mitigable: transient `will-change`; accepted ~250ms today. |
| Settled DOM/SVG chrome at fractional zoom | No — Chromium re-rasters at rest | Largely a non-issue; verify empirically. |
| Pasted image upscaled past native pixels | No — normal raster behavior | Expected, not a regression. |

**Counter-intuitive trap (must avoid):** `will-change: transform` / `translateZ(0)` *locks* a layer's raster scale at first rasterization — subsequent zoom upscales the cached tiles, so the layer **stays blurry**. The same "GPU acceleration" hack people cargo-cult is what *defeats* at-rest crispness in a zoomable canvas ([Chrome re-raster sample](https://googlechrome.github.io/samples/css-will-change-transform-rasterization/), [framer-motion #355](https://github.com/framer/motion/issues/355)). Use it transiently during gesture only, then remove on settle.

---

## 4. Ranked crispness fixes for Electron

Highest-leverage first. Effort S = hours/small, M = days, L = weeks+.

| # | Technique | What it fixes | Effort | Risk |
|---|---|---|---|---|
| 1 | **Device-pixel-snap the viewport translate** — intercept the RF viewport transform, apply `Math.round(v * z * dpr) / (z * dpr)` to translate x,y only (never scale); read dpr live via `matchMedia`, re-snap on resolution change ([xyflow #3282](https://github.com/wbkd/react-flow/issues/3282), [drei #2380](https://github.com/pmndrs/drei/issues/2380)). | Fractional-translate AA on **all** HTML boards at once; 1px border/divider softness on fractional-DPR displays. | S | Low — reuses `onMoveEnd`; snap translate only. |
| 2 | **Transient `will-change` (promote on motion, remove on settle)** — add `will-change: transform` to the viewport on move-start, remove ~150ms after settle so Chromium re-rasters at native res ([xyflow #4617](https://github.com/xyflow/xyflow/discussions/4617)). | Smooth GPU pans without permanent raster-resolution lock; sharper settled state. | S-M | Low — mirrors existing detach/reattach timing. **Never leave it on permanently.** |
| 3 | **Capture snapshots at settled device scale + supersample** — `capturePage` at `dpr x targetZoom` (or re-capture once on settle before live reattach); capture above display size and let the browser downscale (downscale aliases far less than upscale). | Browser-preview snapshot blur during/after zoom-in past capture resolution; host-DPR-dependent snapshot inconsistency. | M | Low-Med — extra readback; gate to settle. |
| 4 | **OSR M1 supersample** (only if OSR is productionized) — `setContentSize(presetW x S) + setZoomFactor(S)` and size the `<canvas>` backing store to `css-box x dpr x camZoom`, NOT `setDeviceScaleFactor`. | The OSR fixed-`1280x800` always-on blur (the terminal class returning). | M | Med — structural showstopper; per spike kill-order, do before any other OSR work. |
| 5 | **`devicePixelContentBox` ResizeObserver for self-canvases** — size xterm/export backing stores from exact integer physical pixels under fractional DPR ([web.dev](https://web.dev/device-pixel-content-box/)); feature-detect, fall back to `Math.round(rect x dpr)` (no Safari). | Moire/blur from the 1-physical-pixel guess at Windows 125/150% scaling and browser zoom. | M | Low — refinement over current dpr math. |
| 6 | **Snapshot `image-rendering` + exact-aspect** — match captured aspect to `.bb-frame` (avoid `object-fit: cover` scale surprises); pick the resampling aesthetic for the transient motion state ([MDN image-rendering](https://developer.mozilla.org/en-US/docs/Web/CSS/image-rendering)). | Cosmetic during-motion mushiness + geometric mismatch on `.bb-snapshot`. | S | Low — cannot recover detail; pair with #3. |
| 7 | **Seed `settledZoomStore` from restored viewport** (not hard-coded 1) — removes the <=250ms wrong-counter-scale flash on opening a project saved at non-1 zoom. | Brief terminal blur/reflow flash on project open. | S | Low. |
| 8 | **Audit & forbid permanent `will-change`/`translateZ`/`backface-visibility`** on board nodes and chrome — lint/convention guard so a future perf change can't freeze a layer and re-introduce resample blur on vector text. | Latent regression class (the exact mechanism that bites `<canvas>`). | S | Low — preserves a load-bearing invariant. |
| 9 | **Expose `--scale: calc(1/var(--zoom))`** for constant-size sub-elements (selection handles, resize grips, group outlines, arrow stroke widths) — tldraw's `--tl-scale` pattern ([tldraw rendering](https://deepwiki.com/tldraw/tldraw/3.1-canvas-rendering)). | Pixel-stable chrome under zoom without re-layout. | S | Low. |
| 10 | **Crisp-on-settle for `.reflowing` nodes** — re-raster nudge when the group-absorb transition ends. | ~340ms soft window during group-absorb. | S | Low. |

Note: the terminal counter-scale FREEZE (the analogue of #4 for xterm) is **already shipped** — listed in section 2.2, not re-counted here.

---

## 5. Terminal library decision

**Keep xterm.js + WebGL + the shipped counter-scale fix. Do not switch terminal libraries.**

Rationale, confirmed against xterm source and the maintainer's own guidance:

- There is **no public xterm API to override dpr / force a backing-store multiplier** — dpr is sourced internally from `window.devicePixelRatio` ([CoreBrowserService](https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/services/CoreBrowserService.ts)). The maintainer (Tyriar) on [issue #2662](https://github.com/xtermjs/xterm.js/issues/2662) explicitly proposed disabling dpr-based scaling and applying a manual multiplier — citing VS Code's minimap, which keeps a static canvas and renders content at a programmatic scale. **This is exactly what the shipped FREEZE counter-scale does.** The current path *is* the recommended one.
- **No canvas/WebGL web terminal is crisp at arbitrary CSS scale** — xterm canvas, [Rio/Sugarloaf](https://medium.com/@raphamorim/rio-terminal-a-native-and-web-terminal-application-powered-by-rust-webgpu-and-webassembly-76d03a8c99ed) (renders to canvas via WebGPU/WebGL, web build early-stage), and native GPU terminals (WezTerm/Alacritty/Ghostty) all reproduce the identical fixed-bitmap resample (or aren't web-embeddable at all). Crispness under arbitrary CSS scale comes from exactly two routes: render real DOM text, or recompute the canvas backing store at the target on-screen scale. The app already does the latter.
- **DOM-text terminals** (xterm's own DOM renderer, hterm, wterm) are intrinsically scale-crisp because Chromium re-rasters real text — but markedly slower. xterm already offers its DOM renderer as the over-budget fallback (also crisp at net scale 1). A full frontend swap to hterm/wterm would lose the node-pty MessagePort bridge, addons, and the entire `terminalCrisp.e2e.ts` harness for a problem already solved at rest.

**If — and only if — during-gesture softness ever becomes a hard requirement,** evaluate two bounded in-Electron options in priority order: (1) a **hybrid renderer** (WebGL at settled 1:1, DOM renderer during motion/off-crisp zoom — DOM re-rasters crisp at arbitrary scale, and WebGL is already suspended off-crisp); (2) per-frame counter-scale recompute during the gesture — perf-risky, since each scale change forces a full glyph-atlas rebuild ([#955](https://github.com/xtermjs/xterm.js/issues/955)/[#1118](https://github.com/xtermjs/xterm.js/issues/1118)) and likely needs an offscreen-canvas/worker. Also consider vendoring the unmerged `getComputedStyle` `CharSizeService` patch ([#2488](https://github.com/xtermjs/xterm.js/issues/2488)) as cheap transform-measurement insurance.

**Do not** reintroduce the #122 WebGL-only-at-100% renderer-swap policy — it was tried and superseded; swapping renderers alone never fixed the defeated-hinting blur.

---

## 6. Live-preview crispness options

The three approaches, and the recommended composition:

| Approach | Crisp-at-scale | Occlusion-free (clip/round/z-order/transform) | Live | Cost |
|---|---|---|---|---|
| **Native `WebContentsView` overlay** (shipping) | Yes — `setZoomFactor` *reflows* the page at camera-scaled device resolution (165fps / ~6.1ms measured) | **No** — separate native compositor surface painting above all HTML; Electron 33+ `setBorderRadius` adds rounding but still can't z-order under HTML or transform | Yes | Low — proven baseline |
| **Offscreen -> HTML `<canvas>`** (OSR `paint` / CDP screencast) | Yes **only if** the frame is produced at `device-px x camZoom` (else the terminal-blur class returns) | **Yes** — an ordinary DOM `<canvas>` inheriting `scale(z)` | Yes | OSR `paint`: large; CDP screencast: medium but throughput-limited |
| **capturePage snapshot** (shipping, `bb-snapshot`) | Crisp **still**, blurs when scaled past capture DPR | Yes (`<img>`/dataURL) | No (frozen) | Low — the 1-fps degenerate case of offscreen |

**Recommended composition:**

1. **Keep the native `WebContentsView` as the proven live baseline** behind a flag to A/B against OSR. It is the sharpest-at-rest and fastest path; its only ceiling is occlusion.
2. **Default offscreen transport = OSR `paint` (CPU `NativeImage` bitmap), not CDP screencast.** Screencast delivers base64-encoded JPEG/PNG per frame with a per-frame ack, is CPU-heavy, and is often <24fps — the maintainers' own issue calls it not-scalable ([devtools-protocol #63](https://github.com/ChromeDevTools/devtools-protocol/issues/63), [chromium 781117](https://bugs.chromium.org/p/chromium/issues/detail?id=781117)). Use it only as a portable fallback / low-fps single-board case. CDP is pre-authorized by ADR 0002.
3. **Crispness is the #1 OSR correctness risk, not perf:** drive the offscreen content size to `(CSS width x camZoom)` via `setContentSize(W*S) + setZoomFactor(S)` so the page *re-renders* at zoomed device resolution; size the `<canvas>` backing store to `css-box x dpr x camZoom`. Validate this (spike M1) before anything else.
4. **For multi-board throughput,** pursue GPU shared-texture OSR (`webPreferences.offscreen.useSharedTexture: true`, ~3ms -> <100us, no GPU->CPU readback to starve node-pty) — Windows-first via a small native node module importing the DXGI/D3D11 handle into WebGL; CPU-bitmap `paint` fallback on macOS (implemented-but-untested per [electron #45428](https://github.com/electron/electron/issues/45428)) and Linux. Gate per-board: `stopPainting`/`setFrameRate` for idle/off-screen boards, honor `dirtyRect`, cap `MAX_LIVE`.
5. **Keep capturePage snapshots as the LOD/idle/over-cap layer** under the live canvas regardless of which live path wins.
6. **Budget for the fidelity-gap class** (IME/CJK composition, native `<select>`/date/color popups — which shared-texture mode explicitly cannot composite — clipboard chords, AltGr, dialogs that freeze the preview, focus ring) via CDP shims (`Emulation.setFocusEmulationEnabled`, `Input.imeSetComposition`). These — not sharpness — are where the offscreen path is genuinely incomplete today.

This is the spike direction already shipped flag-gated in #151 (`VITE_PREVIEW_OSR=1`, off by default), tracked for productionization as feature-proposal OS-3.

---

## 7. Electron vs Tauri — DECISION

**Majority verdict: `stay-electron-fix-blur` — unanimous across all three lenses (migration-cost-and-risk, rendering-quality, terminal-and-preview).** `blurFixableInElectron: true` is the consensus on every lens.

### 7.1 Reasoning

The motivating problem — canvas-zoom blur — is the **weakest possible justification for a stack switch**, because the blur is compositor-universal. Tauri's webviews (WebView2/WKWebView/WebKitGTK) bilinear-resample a fixed-DPR `<canvas>` under `scale(z)` exactly as Chromium does, so a migration re-implements the identical fix on three engines for **zero net rendering gain** ([Tauri architecture](https://v2.tauri.app/concept/architecture/)).

Worse, the migration *regresses* rendering on 2 of 3 platforms. **WebKit (WKWebView on macOS, WebKitGTK on Linux) does NOT re-rasterize composited `transform: scale` content crisply** — [bug 27684 is open since 2009](https://bugs.webkit.org/show_bug.cgi?id=27684); WebKit keeps the smaller backing store and interpolates up. The free at-rest DOM/SVG board-chrome sharpness this CSS-scale canvas relies on (Planning arrows, freehand strokes, all HTML chrome) would become blurry during and after every camera zoom on macOS and Linux. Linux/WebKitGTK adds documented fractional-scale/Wayland blur ([Tauri #6224](https://github.com/tauri-apps/tauri/issues/6224)/[#5600](https://github.com/tauri-apps/tauri/issues/5600), [wry #1727](https://github.com/tauri-apps/wry/issues/1727)) with no good GPU+crisp+fractional combination short of disabling the compositor (~1-2fps). macOS adds a custom-scheme `devicePixelRatio=1` half-res canvas trap ([Wails #5111](https://github.com/wailsapp/wails/issues/5111)) and a 60fps WKWebView rAF cap ([WebKit 173434](https://bugs.webkit.org/show_bug.cgi?id=173434)).

**Decisive inversion: Tauri is strictly worse than the already-rejected Flutter path for the one hard rendering problem — occlusion.** Browser-preview occlusion is fixable in Electron *today* via offscreen-render -> HTML `<canvas>` (ADR 0002 pre-authorized; #151 spike proved it works). Tauri makes that fix **impossible**: wry/tao offscreen-render is open and unimplemented since 2021 ([wry #391](https://github.com/tauri-apps/wry/issues/391), [tao #289](https://github.com/tauri-apps/tao/issues/289), [tauri #13740](https://github.com/tauri-apps/tauri/issues/13740)), and WebView2 has no public OSR API ([WebView2Feedback #547](https://github.com/MicrosoftEdge/WebView2Feedback/issues/547)/[#968](https://github.com/MicrosoftEdge/WebView2Feedback/issues/968)). Migration would not just fail to fix occlusion — it removes the ability to fix it. On top, **multiwebview — the load-bearing "multiple live previews" feature — is UNSTABLE/feature-gated in Tauri v2 stable** (`cargo --features unstable`).

### 7.2 Concrete migration cost / blockers if switching

The frontend is the bright spot — React 18 / React Flow v12 / xterm.js / perfect-freehand / Zustand port into the system webview essentially as-is (Tauri's one genuine advantage over the Flutter NO-GO). But "frontend is cheap" is a trap: the entire cost is the Rust backend rewrite plus *losing* the occlusion fix.

Blockers, ranked:

1. **No offscreen/texture path in Tauri/wry/WebView2** -> the occlusion fix is unbuildable (open unimplemented since 2021).
2. **multiwebview is unstable/incomplete** — the canvas's load-bearing live-preview feature depends on an experimental API.
3. **node-pty -> portable-pty is a full rewrite** of the hardest non-rendering subsystem (~3,189 LOC): park/adopt/reap lifecycle, Windows `taskkill /PID <pid> /T /F` tree-kill, *nix neg-pgid, `launchCommand`-first-line. The MessagePort data plane has **no Tauri analog** — v2 Channel rides webview IPC, reported ~200ms/10MB "weirdly slow" on Windows, the worst case for high-throughput PTY byte and preview-frame streaming.
4. **preview.ts (~3,588 LOC) rebuilt with missing primitives** — no `capturePage`, no per-board `partition` zoom isolation, no `setZoomFactor` responsive reflow (390/834/1280), no detach+snapshot LOD, no no-destroy lifecycle.
5. **~22k-LOC Node MCP/LLM/context backend + ~12k LOC tests don't port to Rust** -> ship as a Node sidecar = two runtimes per platform, doubling packaging/signing/update surface (pkg/Node-SEA is a documented dead end for node-pty).
6. **e2e gate materially regresses** — the Playwright `_electron` harness (MAIN `evaluate()`, `capturePage` native-view PNG asserts, real-OS `sendInputEvent`) that *caught and verified-fixed the PR #82 occlusion/camera-sync bugs* has no Tauri equivalent; `tauri-driver` is Windows+Linux only (macOS unsupported — Apple ships no WKWebView WebDriver, [tauri #7068](https://github.com/tauri-apps/tauri/issues/7068)).
7. **3-engine rendering fragmentation** re-opens the already-fixed #122 work and the CSS-scale compositing on WebKit/WebKitGTK.

The clean-mapping items — `electron-updater -> tauri-plugin-updater` (Ed25519-signed Win/mac/Linux incl. AppImage), `simple-git -> git2` — are real but a small slice, and the packaging/signing work is owed regardless of stack. Realistic migration range: **~12-24 engineer-months delivering none of the rendering goal and several regressions.** Tauri's genuine wins (bundle ~8MB vs ~244MB, RAM 30-50MB vs 150-300MB) are not stated goals and don't survive the node-pty/`WebContentsView`/Node-backend coupling.

### 7.3 Reconciliation with the prior Flutter NO-GO

This decision is **consistent with and reinforces** the 2026-06-14 Flutter assessment (`docs/reviews/2026-06-14-electron-to-flutter-assessment/`). That assessment concluded NO-GO on Flutter and explicitly stated *"Do NOT use Tauri for this — its OS-native webview reproduces the same overlay/occlusion constraint and adds no fix."* This synthesis confirms that line and sharpens it with new evidence: Tauri is not merely "no fix" for occlusion — it is *worse than Flutter*, because Flutter could in principle texture-composite a webview (via the immature `webview_cef`), whereas Tauri/wry/WebView2 have no offscreen path at all. Both assessments converge on the same prescription: **fix occlusion IN Electron (offscreen/CDP spike — done in #151), ship nothing for terminal blur (already fixed), reinvest the saved engineer-months in Phase 5 packaging/signing — the genuine release blocker.**

---

## 8. Recommended action plan

**Phase A — Cheap, broad, low-risk wins (days). Reuses existing `onMove`/`onMoveEnd` plumbing.**
1. Device-pixel-snap the RF viewport translate (fix #1). Read dpr live via `matchMedia`, re-snap on resolution change.
2. Transient `will-change: transform` on the viewport during gesture only, removed ~150ms after settle (fix #2).
3. Seed `settledZoomStore` from the restored project viewport (fix #7).
4. Add the lint/convention guard forbidding permanent `will-change`/`translateZ`/`backface-visibility` on board nodes and chrome (fix #8). Add the matching guard for the Planning path (no live `<canvas>`, no layer-freezing hint).
5. Build a Playwright `_electron` zoom x dpr screenshot sweep (z in {0.5, 0.7, 1, 1.4, 2}; dpr in {1.0, 1.25, 1.5, 2.0}) over a seeded Planning board (text + freehand stroke) and a terminal — blur is invisible on Retina and green typecheck/unit cannot catch it.

**Phase B — Snapshot crispness (days-week).**
6. Capture snapshots at settled device scale + supersample-and-downscale (fix #3); fix `.bb-snapshot` aspect/`image-rendering` (fix #6); verify the live native view truly reflows (no resample) at z = 0.5/1/2 against a settled board, so effort is confirmed to belong to the snapshot path.

**Phase C — OSR productionization (weeks; only if pursuing occlusion fix, OS-3).** On a new worktree off main, behind `VITE_PREVIEW_OSR`.
7. Implement M1 supersample (`setContentSize(W*S) + setZoomFactor(S)`, canvas backing store `css-box x dpr x camZoom`) — the structural showstopper, before any other OSR work.
8. M2 throughput (per-board `stopPainting`/`setFrameRate` visibility-gating, honor `dirtyRect`, `createImageBitmap`, `MAX_LIVE`); evaluate GPU shared-texture OSR Windows-first.
9. M4 responsive presets + the P1 fidelity-gap CDP shims. Decide whether to flip OSR to the default preview.
   Never weaken the locked security invariants on any preview path (contextIsolation/sandbox/nodeIntegration:false, per-board `partition`, deny-all permission handlers, `isForeignSender` frame guard, `setWindowOpenHandler` deny + token-bucket).

**Phase D — Reinvest.** Direct the engineer-months *not* spent on a migration toward **Phase 5 packaging/signing** — the actual release blocker and the only e2e-uncovered surface (auto-update).

**Do NOT:** migrate to Tauri or Flutter; reintroduce the #122 WebGL-only-at-100% policy; add permanent `will-change`/`translateZ` to any text-bearing element; feed raw camera z to the terminal selection shim (double-corrects); use global GPU/HiDPI command-line switches (`--disable-gpu-rasterization`, `--force-device-scale-factor`) as a crispness fix — they are diagnostic/Linux-HiDPI-only and cannot make a CSS-scaled bitmap sharp.

---

## 9. Open questions / validate empirically

1. **Is settled DOM chrome actually soft at non-snapped fractional zooms?** The audit's strongest caveat: Chromium's at-rest re-raster usually rescues DOM/SVG, so the real residual may be only the during-gesture + 250ms settle window. Run `CANVAS_SHOT` at several fractional zooms (0.7, 1.4, 2.1) *before* investing in per-node counter-scale for DOM — the cheapest probe may show no settled-state defect to fix.
2. **Does device-pixel translate-snapping (fix #1) measurably sharpen the working band on dPR=1 vs fractional-DPR displays?** Confirm with the Phase A zoom x dpr sweep; gate Layer-2 (`devicePixelContentBox`) work on whether `Math.round(rect x dpr)` is insufficient.
3. **Is the ~250ms mid-gesture terminal/DOM softness perceived as a defect with a real terminal?** Confirm before tuning `SETTLE_MS` or building a DOM-during-motion hybrid — it is a deliberate per-frame-resample-avoidance tradeoff today.
4. **OSR M2 throughput on this app's 4-board load:** does the CPU-bitmap `paint` path's GPU->CPU readback starve node-pty I/O in shared MAIN? Quantify before committing to the native shared-texture module.
5. **GPU shared-texture OSR cross-platform reach:** Windows is implemented+tested; macOS implemented-but-untested ([electron #45428](https://github.com/electron/electron/issues/45428)); Linux effectively absent. Confirm the CPU-bitmap fallback is acceptable on mac/Linux before scoping OS-3.
6. **Exact Electron-42/current-Chromium defaults** for subpixel-vs-grayscale AT-rest text and the precise `setZoomFactor` floor (0.25) are version-sensitive — spot-verify in the running app.
7. **Backdrop `DPR_CLAMP=1.5`** — is 1.5 still the right cap on common 2x displays where the backdrop visibly softens? Hoist into one shared constant first.
8. **Recover the deleted research docs** (`2026-06-11-terminal-font-blur.md`, `2026-06-12-terminal-native-reraster-audit.md`) from git history if any future terminal-blur work is undertaken — band boundaries, dpr matrices, and oscillation checks survive only there + the e2e spec.

---

*Sources cross-validate: primary Chromium/Chrome-dev/web.dev/Blink threads, the CSSWG and W3C drafts, the xterm.js / React Flow / Tauri / wry / WebView2 / Electron issue trackers, and the repo's own shipped #122/#125/#138 fixes + ADR 0002. The canvas-vs-DOM re-raster distinction and the `will-change` raster-scale lock are documented Chromium behavior, not inference. Version-sensitive edges (exact at-rest AA mode, `setZoomFactor` floor, some Tauri Linux DPI bug statuses) are flagged in section 9 for empirical confirmation.*
