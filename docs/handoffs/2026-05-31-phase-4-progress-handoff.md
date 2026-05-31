# Phase 4 — Design Pass & Polish — Progress Handoff (6/7 shipped)

> Written 2026-05-31. Entry point for the next session. **6 of 7 Phase 4 slices are
> committed on branch `phase-4-design-pass`** (off `main`, not yet pushed/merged). Only
> **Slice 5 (full-view enter/exit motion)** remains. Read this top-to-bottom before touching code.

## TL;DR

- Branch `phase-4-design-pass` (8 commits, base = `main` `65a0160`). **Not pushed, no PR yet.**
- Shipped: Slices **1 (motion) · 2 (token/chrome) · 3 (fonts) · 6 (CSP) · 7 (code-split) · 4 (states)**.
- Remaining: **Slice 5 — full-view enter/exit motion + the §6.1 top band** (deferred here: it is the
  most delicate work — the native `WebContentsView` can't be CSS-animated — and deserves full context).
- Baseline each slice: **311 unit · typecheck · lint** green; full e2e gated each slice.
- Plan + per-slice detail: `docs/superpowers/plans/2026-05-31-phase-4-design-pass.md`.

## Branch commits (oldest → newest)

```
3587198 docs(phase-4): plan — design pass & polish (7 slices, per-slice workflow verify)
5e2dbed feat(phase-4): motion pass — §9 camera ease + reduced-motion gate (Slice 1)
83beb17 fix(phase-4):  token/chrome parity — §4 two-shadow + §6 ring-only + §7.3 grid (Slice 2)
e541a54 feat(phase-4): bundle self-hosted Geist fonts (Slice 3)
ceb53cb feat(phase-4): harden packaged-build CSP — drop script-src 'unsafe-inline' (Slice 6)
5874f2d perf(phase-4): code-split boards — lazy xterm/pen behind board type (Slice 7)
76e76fe feat(phase-4): states pass — welcome tokens + terminal braille spinner (Slice 4)
0cfc753 docs(phase-4): progress (6/7 shipped) + Slice 5 handoff + e2e env-flake note
```

## What shipped (per slice)

### Slice 1 — Motion (§9) · `5e2dbed`
- New `src/renderer/src/lib/motion.ts`: `cubicBezier()` solver + `EASE_STANDARD` =
  cubic-bezier(.2,.7,.2,1), `prefersReducedMotion()`, and `cameraAnim(opts)` → wraps React Flow
  viewport-op options with `{ duration: 200, ease }`, collapsing to `duration: 0` under
  reduced-motion (read at call time). 8 unit tests (`motion.test.tsx`, jsdom).
- `Canvas.tsx` + `AppChrome.tsx`: every USER-triggered camera op (fit `1` / reset `0` / focus
  double-click / fit·reset·overview buttons) routes through `cameraAnim`. **On-load fit + RF
  initial-mount `fitViewOptions` stay instant by design** (no `cameraAnim`).
- `index.css`: progress sliver 1.25→1.2s, caret blink 1.05→1s; **board select ring now animates**
  (box-shadow added to `BoardFrame` transition, 120ms ease-out); **resize handles fade in 100ms**
  (`ca-handle-in` keyframe) — both added to the `prefers-reduced-motion` `animation: none` list.

### Slice 2 — Token / chrome parity (§A) · `83beb17`
- 5-agent parity audit (workflow) vs DESIGN.md §2–§7. **§2 tokens = exact match.**
- Fixes: §4 two-shadow rule — `NoteCard`/`ChecklistCard`/`DiagOverlay` custom shadows →
  `var(--shadow-pop)`; `.bb-frame` dropped its heavy 3rd drop-shadow (kept the §7.2 "subtle inset").
  §6 selected state = accent **ring (box-shadow) only**; the 1px border stays neutral (was also
  recoloured accent). §7.3 planning grid 13→12px.
- **Deliberate divergences confirmed with the owner and KEPT (do not "fix" these):**
  - The title-bar **type tag** (`TERMINAL`/`BROWSER`/`PLANNING`) stays **dropped** — the glyph +
    title carry the type (calm-density §1.1). DESIGN §6 lists it; we intentionally diverge.
  - Terminal title-bar actions keep the shipped **globe** (Slice C′ port-detect→preview) and
    **gear** (config) — they predate the design's pause/run·interrupt list (brief-wins-on-stack).
  - `FadingDots` `#202022` + arrow marker `#4f8cff` are hardcoded because React Flow SVG fills
    can't read CSS vars; values mirror the tokens.

### Slice 3 — Geist fonts (§D) · `e541a54`
- `geist` devDep; `Geist-Variable.woff2` + `GeistMono-Variable.woff2` vendored into
  `src/renderer/src/assets/fonts/` (one variable file/family spans wght 100–900). `@font-face`
  (font-display: swap) in `index.css`; Vite fingerprints + emits the woff2; CSP `font-src 'self'`.
- `useRendererSmoke` logs a `RENDERER_FONTS` probe (`document.fonts.load`) — a load guard for
  VISIBLE/dev runs only (headless smoke windows throttle font I/O, so it's silent there).

### Slice 4 — States (§B) · `76e76fe`
- Welcome/project-picker (`index.css`): hardcoded colours → tokens + type scale + `--ui`; primary
  (Create) is accent-as-functional (accent text/border on `--accent-wash`), not a filled button.
- Terminal **braille spinner** (§9/§7.1, was unwired): running status label is prefixed with
  `brailleFrame()` advancing 80ms/frame (`terminalState` comment corrected 90→80ms);
  reduced-motion holds a static glyph (no interval).
- Audit outcome: `EmptyState.tsx` (§8 empty-canvas) + Browser `DeviceContent`
  connecting/load-failed/snapshot states were **already spec-compliant** (Phase 2) — unchanged.
  NOTE: `WelcomeScreen.tsx` is the no-project PICKER; the §8 "Empty project" is `EmptyState.tsx`
  (the handoff that started Phase 4 conflated them).

### Slice 6 — CSP hardening (§E) · `ceb53cb`
- New `canvas-ade-csp-meta` Vite plugin (`electron.vite.config.ts`) rewrites the index.html CSP
  `<meta>` at build: **PROD = `script-src 'self'`** (no `unsafe-inline`; the built HTML's only
  script is the external hashed module bundle); **DEV keeps `'unsafe-inline'`** for Vite's HMR
  preamble. CSP shipped as `<meta>` because `loadFile`/`file://` makes `onHeadersReceived` unreliable.
- **`style-src` keeps `'unsafe-inline'` in BOTH** — the app uses React inline `style={{}}`
  attributes pervasively (+ xterm runtime element styles), and CSP nonces cannot authorize inline
  style ATTRIBUTES (only `<style>`/`<link>` elements). Documented in the plugin. Verified prod boots
  via `loadFile` with **0 CSP console violations**.

### Slice 7 — Renderer code-split (§F) · `5874f2d`
- `BoardNode` dispatches the three boards via **`React.lazy` + `Suspense`** → each type is its own
  chunk loaded on first mount of that type. `useRendererSmoke` xterm import made **dynamic** (it's
  always mounted via `App`, so a static import re-pins xterm into the entry chunk).
- **Entry chunk 1,286 → 672 kB.** xterm (402 kB) + addon-webgl (139 kB) + per-board chunks now load
  on demand; a no-terminal project never fetches xterm. The `createPortal` relocation that keeps the
  live PTY/native view alive is unaffected (verified — `terminal-fullview` same-pid survives).

## Verify the baseline (next session, before any change)

```
pnpm install
pnpm lint ; pnpm typecheck ; pnpm test          # expect clean + 311 passing
pnpm build                                       # entry chunk ~672 kB; 2 woff2 emitted
Get-Process electron -EA SilentlyContinue | Stop-Process -Force ; Start-Sleep -Seconds 2
$env:CANVAS_SMOKE='e2e'; pnpm start              # expect E2E_DONE {ok:true}, 19 parts
```

### ⚠ Known e2e env-flake (NOT a regression — memory `e2e-browser-trio-flake`)
`browser` (`empty=true`) / `browser-gesture` / `focus-detach` (`not live`) flap on this machine —
the live-`WebContentsView` `capturePage` first-paint timing flake. **Proven environmental**: a
negative-control run on stashed main-equivalent code failed the identical trio. When only these
three fail, the bar is "16/16 non-trio parts green"; rerun on a fresh `electron` process for a clean
19/19 (Slices 2 & 3 hit it green this session). Always kill stray electron first (it locks `userData`).

## ▶ Remaining — Slice 5: Full-view enter/exit motion (§C) + §6.1 top band

Process: this is feature-shaped — **brainstorm → spec → implement → e2e-verify → commit**.

1. **Write the spec** `docs/superpowers/specs/2026-05-31-fullview-motion.md` first.
2. `FullViewModal.tsx` opens/closes **instantly** today. Add **scrim fade-in + frame scale/opacity
   from the board's on-canvas rect** (reverse on close), `200ms cubic-bezier(.2,.7,.2,1)` — reuse
   `EASE_STANDARD` / the timing story from `lib/motion.ts`. Reduced-motion → instant (gate it).
3. **Native-view constraint (the hard part):** a Browser board's `WebContentsView` is an OS layer —
   it CANNOT be CSS-animated, clipped, or rounded. Animate the HTML scrim/frame only; the native
   view snaps to its final bounds (or carries the transition via its `capturePage` snapshot). The
   full-view machinery is in `BrowserPreviewLayer.tsx` (`fullViewBoundsFor`, the full-view rAF pump)
   and `Canvas.tsx`/`fullViewContext.ts` (the live-subtree portal relocation — DON'T remount).
4. **Fold in the §6.1 top band** the Slice 2 audit flagged missing: a `FULL VIEW` label + `✕ Esc`
   exit band atop the full-view frame (`FullViewModal.tsx`). This changes the frame layout →
   **`fullViewBoundsFor` geometry shifts → re-verify `fullview-emulator` + `fullview-preview` e2e**
   (both currently green) after.
5. e2e gate: `terminal-fullview` (same-pid survival), `fullview-preview`, `fullview-emulator` must
   stay green. Esc/✕/backdrop-close paths still work.

## After Slice 5 — closing Phase 4
- Optional final gate: `pnpm pack:dir` → launch `release/win-unpacked` and confirm the packaged
  renderer boots with the strict CSP + Geist (the loadFile e2e is a faithful proxy; a real pack
  re-check is the belt-and-suspenders).
- Then `finishing-a-development-branch`: squash/merge decision, push, PR, update CLAUDE.md Status to
  "Phase 4 shipped", point to Phase 5.

## Decisions log (this session)
- Geist via npm `geist` pkg (variable woff2). · One branch, slice-per-commit. · Per-slice workflow
  verify (parity audit) + full e2e + negative-control. · Browser-touching slices (4,5) reordered last
  due to the env-flake. · Type tag dropped · terminal globe/gear kept · selected edge ring-only (all
  owner-confirmed). · CSP: harden script-src only; style-src `unsafe-inline` is unavoidable (inline
  style attributes). · Code-split via React.lazy boards + dynamic smoke xterm.
