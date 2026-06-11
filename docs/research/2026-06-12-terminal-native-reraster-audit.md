# Terminal native re-raster (FREEZE) — audit + design (2026-06-12)

The pre-implementation audit and final design for the settled-zoom native re-raster that keeps
terminal text crisp at EVERY settled zoom. Supersedes the renderer-swap policy of
`2026-06-11-terminal-font-blur.md` (#122) — the snap band from that fix is kept, the
WebGL-only-at-crisp-zoom valve is replaced by the counter-scale below.

## 1. Root-cause taxonomy — three distinct blur mechanisms

| # | Mechanism | Status |
|---|---|---|
| 1 | **Bitmap resample** — the xterm WebGL canvas is a fixed-dpr bitmap; the camera's `scale(z≠1)` bilinear-resamples it. | Fixed by #122; verified across dpr 1/1.25/1.5, maximized, full view, a real project with a resumed agent session. |
| 2 | **Defeated hinting at fractional paint scale** — DOM-renderer text *lays out* at fontSize 12.5 and is *painted* at z × that; glyph stems land between device pixels, grayscale AA smears them. Chromium's at-rest re-raster cannot beat this. | **Fixed by THIS feature.** Reproduced at Overview (settled z=0.82) on a real project; before/after captures rode the PR review. |
| 3 | **Physically small text** — at z=0.46, 12.5px ⇒ ~5.8 physical px. No renderer fixes this. | Out of scope (product levers: focus, full view, LOD digest, per-board font). |

## 2. The design — FREEZE counter-scale + single font seam + no-clip correction

At every **settled** camera zoom z (`settledZoomStore`, 250ms debounce — never per gesture
frame), per terminal board:

- **Counter-scale wrapper** (`useTerminalReraster`): the xterm host lays out at
  `boardContent × z` with `transform: scale(1/z)` origin 0 0 → net visual scale is **exactly 1**
  at rest (camera z === wrapper cs), so the renderer's backing store maps 1:1 to device pixels.
  Padding scales with cs (visual parity + z-invariant fits). Identity in full view (the portal
  already renders at scale 1) and at cs = 1.
- **Single font seam** — the ONLY writer of `term.options.fontSize` after construction:
  `effective = clampPinned(board.fontSize ?? bornFont) × cs`, fractional, NEVER routed through
  `updateBoard`/undo (the `fromObject` clamp would destroy a persisted effective value). A PIN
  change reflows the grid (`fitWhole` → PTY resize, as before); a ZOOM change never does.
- **FREEZE** — cols/rows are frozen across zoom. The spawn effect's ResizeObserver gates on the
  z-INVARIANT screenWrap size (board content px), so a zoom-driven wrapper resize never refits;
  mount, real board resize, LOD exit and the full-view portal still do.
- **No-clip correction** — xterm quantizes cell dims to WHOLE px (§4), so the frozen grid at
  eff = pin×cs can land one integer cell-step wider/taller than the wrapper. A bounded rAF loop
  steps the render font down (×0.97, ≤4 steps, token-superseded per settle) until the grid fits.
  Residual UNDERFILL is a same-background right/bottom gutter (reads as padding); content never
  clips.
- **WebGL held at every settled zoom** (`suspend = lod` only). Over-`WEBGL_BUDGET` boards fall
  back to the DOM renderer — ALSO crisp at net scale 1, so budget pressure is perf-only.
- **Selection shim** sees the NET element scale (`camera z / cs` — exactly 1 at rest, the live
  ratio mid-gesture; 1 in full view), NOT the raw camera z. Feeding the camera z double-corrects
  (proven: an 11-cell drag selected 14 cells under the prototype).
- **Snap band kept** ([0.95, 1.06] → exactly 1): no longer the crispness mechanism, still the
  nicest state (eff = pin exactly, zero quantization slack).

During gestures nothing changes: the live camera scales the settled raster (soft while moving,
Figma-like); the wrapper geometry is gesture-proof (rendered size = W×z′ for any live z′).

## 3. Why FREEZE (and not refit, and not the rejected alternatives)

- **Refit-on-settle** (cols track the wrapper): perfect fill, but integer cell quantization makes
  cols JUMP between adjacent zooms (measured 92–138 around a 120 baseline with rounded fonts;
  1015px/cellW 5 = 203 vs /6 = 169 with fractional) — a ConPTY reflow of the live TUI on nearly
  every settle. Rejected; could return later as an opt-in "readable mode" with a font floor.
- **DPR monkey-patch** (`_coreBrowserService.dpr`): proven possible (OpenCove) and proven
  painful — they reverted the zoom multiplication after three follow-up PRs of WebGL geometry
  churn vs xterm's `devicePixelContentBoxSize` sizing path. No public API exists; the xterm
  maintainers' position is "scale via the font size setting" (xterm.js #3242).
- **Chromium zoom / WebContentsView per terminal**: true dpr-based crispness (the VS Code/Hyper
  mechanism) but window-global, or imports the entire native-view occlusion problem class.
- **CSS `zoom`**: affects layout, not canvas backing stores; xterm explicitly unsupports it.

## 4. Measured constraints (the data the design rests on)

Probes: `_electron` harness, dpr 1, Cascadia Mono, lineHeight 1.2 (throwaway scripts in the
untracked `blurprobe/` dir of the main checkout; method = seed terminal → drive camera →
measure `terminalCounterScale`/rects → native-res screenshots).

- **Cell dims quantize to whole px**: cellW = 7 (font ≥12.1), 6 (10.25–11.9), 5 (10.0) — exact
  integer grid widths (175 cols → 875/1050/1225). `letterSpacing` quantizes (+0.5/+0.74/+1.37
  all ⇒ +1px; −0.26 ⇒ 0). `lineHeight` row contribution quantizes the same way. Exact
  grid-fills-wrapper is therefore IMPOSSIBLE; the residual must be absorbed as gutter (chosen)
  or clip (rejected: full-width TUI content loss — measured −44.7px ≈ 7 columns at settled 0.82
  pre-correction).
- **Post-correction slack** (1240×1060 board, pin 12.5): z=1 ⇒ +8/+4 px; 0.82 ⇒ +135/+102
  (the quantization-hostile case: eff stepped 10.25→9.94, cellW 6→5); 0.7 ⇒ +162/+36;
  0.6 ⇒ +40/+47; 1.3 ⇒ +28/+84; 2 ⇒ +16/+120. Gutter is zoom-dependent (0–14%), same
  background, never clips. cols/rows stayed 174×56 through the whole ladder; netScale = 1 ± 1e-7.
- **Full-view round trips re-quantize the grid** (e.g. 174×56 → 200×63 after an exit at
  settled 0.82): the portal resize is a legit refit executed in counter-scaled space, and cell
  quantization differs per cs. Full view always reflowed the PTY (in/out); the grid it returns
  to is valid and fits (slack +5px measured). Accepted.
- **Glyph cost of the correction is tiny**: one cell-step ≈ 0.25px of font (10.25→10.0).

## 5. Audit findings carried into the implementation

(Full pre-implementation audit: two static-analysis passes + an empirical matrix — zoom sweep
0.41–2.5 with exact band boundaries, dpr 1/1.5, 10-cycle oscillation leak check, LOD crossing,
full-view cycling, font/resize at fractional zoom, real-mouse selection at 0.82/1/1.3, a
10-terminal GL-budget stress — all green on current main before the change.)

- Selection shim double-correct under counter-scale: **proven**, fixed via `getZoom` returning
  the net scale (see §2). e2e: `terminalCrisp` drag-select at settled 0.82.
- "Two masters" on `term.options.fontSize`: merged into the single seam (`useTerminalReraster`).
  The pinned value stays the ONLY persisted/undo-visible font; toolbar ± bounds stay pinned-space.
- ResizeObserver refit gate: keyed on screenWrap size (z-invariant), preserving mount / resize /
  LOD-exit / full-view refits while blocking zoom-driven ones.
- Recap back-face, port picker, idle overlay are SIBLINGS of the counter-scaled host — only the
  `screenRef` div is wrapped.
- Atlas-rebuild guard: the seam early-outs when the effective font is unchanged; settles are
  250ms-debounced and the store identity-skips repeated zooms.
- e2e updates: `terminalCrisp` rewritten for the new policy (hold + geometry + freeze + no-clip +
  selection + snap band + sweep); `terminalFont`/`terminalClip`/`terminalIO` unaffected (run at
  z=1 or settle-invariant geometry) — verified green.

## 6. Residual gaps (explicit non-goals)

- Mechanism 3 (§1): below ~65% zoom text is crisp but physically small. Levers: focus/full view/
  LOD digest/per-board font; a future opt-in "readable mode" = refit + font floor behind a toggle.
- During-gesture softness: by design (settle-then-re-raster, like Figma).
- The zoom-dependent gutter (§4): the price of integer cell quantization. The snap band keeps the
  everyday near-1 zooms gutter-free; a future refinement could try integer-aware wrapper sizing.
- dpr > 1 shrinks quantization steps (device-px integer ⇒ finer CSS-px steps), so gutters are
  SMALLER on scaled displays; dpr 1 is the worst case and the one all numbers above are from.
