# Terminal crispness — DOM-renderer default (umbrella spec + research appendix)

**Date:** 2026-06-25 · **Umbrella:** `feat/terminal-crisp-umbrella` (seed `07a700bf`) ·
**Supersedes the FREEZE counter-scale (#122/#125) for the live terminal.**
Follows `docs/research/2026-06-14-terminal-blur-during-motion-fix.md` (Option A, prototyped on the
stale `fix/terminal-dom-renderer`) and `docs/research/2026-06-15-crispness-blur-electron-vs-tauri/`.

---

## 1. The bug (user report, 2026-06-25)

Terminal text is blurry — and **busy/long-running agent sessions blur worse than fresh idle ones at
the same zoom** (side-by-side, image 3). A comparable Tauri+xterm app never blurs because its terminal
is **not under a zoom transform**.

## 2. Root cause (grounded in the code)

Each terminal board lives inside React Flow's `transform: scale(z)` camera. xterm's **WebGL renderer
is a fixed-DPR `<canvas>` bitmap** — Chromium's compositor can only *bilinear-resample* it at any
zoom ≠ 1 (it is the layer's source pixels; there is no higher-res source to re-raster from). The
whiteboard stays crisp because it is real DOM/SVG, which Chromium **re-rasters at the new "ideal
scale"** on any script-driven transform change — exactly React Flow's camera path.

The shipped FREEZE counter-scale (#125) lays the host out at `content × z` / `scale(1/z)`, font =
`pinned × z`, recomputed **250 ms after settle** → crisp **only at rest**.

**Why busy > fresh at the same settled zoom:**
1. The **no-clip rAF step-down loop** in `useTerminalReraster.ts` shrinks the font by ×0.97 (a
   *fractional* value) only on a board whose frozen grid overflows its wrapper — far likelier once an
   agent TUI has triggered a PTY resize. On WebGL a fractional cell size makes the backing store no
   longer 1:1 with device px → permanently soft. A fresh terminal that fit cleanly keeps a crisp font.
2. The during-motion resample is **exposed** by dense streaming agent text and **hidden** by a sparse
   fresh prompt.

The DOM renderer deletes **both** mechanisms.

## 3. Research synthesis (deep-research workflow, 2026-06-25; 19 primary sources, adversarial verify)

- **xterm.js v6 (Dec 2025) removed the canvas addon entirely; the DOM renderer is the default and
  WebGL is an opt-in fast path.** Switching to DOM-default *aligns with* upstream direction. [xterm
  #3271, #4175]
- The canvas-vs-DOM compositor rule is confirmed by primary Chromium sources: a fixed-DPR canvas is
  texture-mapped (resampled) under `scale(z)`; DOM is display-list-backed and re-rastered crisp at the
  ideal scale on script-driven scale changes. [developer.chrome.com/blog/re-rastering-composite;
  chromium GPU-compositing + impl-side-painting design docs; web.dev/speed-layers] Same root cause as
  xterm **#2662**.
- **GUARDRAIL: do NOT set `will-change: transform`** on the terminal host or any promoting ancestor —
  it pins a fixed bitmap and *re-introduces* the blur. (We don't today; React Flow doesn't — keep it
  that way.) [css-will-change-transform-rasterization sample]
- **Perf risk is real but UNQUANTIFIED.** The maintainer calls DOM "much slower," but the famous VS
  Code "DOM <10 FPS" figure was **refuted** (unsupported by the cited blog), and the one concrete DOM
  cost (WidthCache layout thrashing) is being fixed upstream via OffscreenCanvas (v7). → **must
  profile locally before committing.** [xterm #5548, #880; vscode blog REFUTED]
- VS Code switches renderers by **capability + measured frame time** (`gpuAcceleration: auto` → WebGL→
  canvas→DOM), **not by zoom scale** — its terminal isn't under a transform. So "WebGL at scale 1 then
  DOM" is not a VS Code behavior, but a **hybrid keyed on zoom==1 is viable** and is mechanically what
  this repo's own #122 did; xterm supports runtime addon load/unload (`WebglAddon.dispose()`). [vscode
  #106202; xterm addon-webgl README, #1360]
- Closest real-world comparable: `0-AI-UG/cate` — an infinite zoomable coding canvas with native
  xterm.js + node-pty (same Electron+pty+spatial shape).

**Verdict: DOM-renderer-default is the correct permanent fix.** Guardrails to ship: scrollback caps
(have, #237), write coalescing, and paint-gating off-screen/below-LOD boards (reuse the OSR liveness
pattern + the `lod` flag). Keep a WebGL-at-zoom-1 hybrid as a *conditional* escape hatch only if
profiling shows DOM-default can't sustain the heaviest multi-session load.

## 4. The change is surgical (NOT the stale branch as-is)

The 2026-06-14 prototype (`fix/terminal-dom-renderer`, commit `e877cf43`) is right in spirit but on a
stale base (~#141). Merging it as-is would **regress** three things that landed since:
- **Pure A1 full-view scrollback fix (#235)** — full view reuses `counterScale = fullViewScale` to
  scale the frozen grid by **font alone** (no col refit → no scrollback reflow). This is a
  *correctness* mechanism, independent of WebGL-vs-DOM. **MUST PRESERVE.**
- **find-in-terminal (#232)** + **configurable scrollback (#237)**.
- It also wrongly deleted `settledZoomStore`, which the **OSR browser preview now depends on**
  (`useOffscreenSizing` → `computeOsrSize(…, settledZoom, …)` supersampling). **MUST KEEP.**

## 5. Phases & lanes (umbrella)

> Everything PRs **into `feat/terminal-crisp-umbrella`**; the umbrella merges to `main` once, full
> e2e matrix both legs at that single pre-merge gate. Worker→umbrella PRs pay the cheaper scoped gate.

### P1 — DOM-renderer default (foundation; built on the umbrella branch directly)
- Switch the live terminal to xterm's **DOM renderer**: stop loading the WebGL addon; remove the
  `lod`/suspend WebGL pooling (`useTerminalWebgl`).
- Collapse the in-canvas counter-scale to **identity** but keep `counterScale = isFullView ?
  fullViewScale(board.w, board.h, innerW, innerH) : 1` so **#235 full-view scale-up is preserved**.
  The host wrapper is then always identity in-canvas; full view scales the grid by **font** alone.
- Selection shim `getZoom` → **raw camera zoom** (`transform[2]`), `1` in full view.
- **KEEP** `settledZoomStore` + `useZoomSettle` intact (OSR preview dependency + the snap-to-100%
  comfort detent). Only remove the *terminal's* consumption of `settledZoom`.
- Preserve find (#232) + scrollback (#237). Keep the no-clip rAF safety only where it still matters
  (full view); at cs=1 in-canvas it no-ops.
- Guardrail assert: no `will-change: transform` on the terminal host/ancestors.
- Rewrite `e2e/terminalCrisp.e2e.ts` to **DOM-renderer invariants** (rows present = DOM painting;
  crisp during a fractional-zoom gesture; cols/rows frozen across zoom; full-view scrollback intact;
  selection cell-accurate at fractional zoom). Update `terminalFont` unit tests (drop
  `effectiveTerminalFont` if removed) + the `__canvasE2E` probes (`terminalCounterScale`).
- Gate (typecheck · lint · format · unit) + **title-stamped manual dev check on a live `claude`
  session** (crisp at rest, during pan/zoom, on a busy terminal vs a fresh one).

### P2 — Perf validation + conditional WebGL@1 hybrid (decision gate)
- Load-test 4–10 agent sessions streaming heavy colored output while panning/zooming; capture
  FPS/CPU. **This is "the required optimization."**
- **Smooth → ship DOM-only.** **Janks at zoom 1 → enable WebGL-at-zoom-1**: re-arm the existing
  `attachWebgl`/`detachWebgl` on `settledZoom === 1 && liveZoom === 1`; drop to DOM on any zoom ≠ 1
  (panning at zoom 1 doesn't resample a canvas, so WebGL stays crisp while panning). Small increment.

### Lane A — DOM perf liveness gating (after P1 in umbrella)
xterm #880: the renderer draws all incoming data regardless of visibility. Pause/throttle term
rendering + coalesce PTY writes for off-screen / below-LOD boards (reuse the OSR liveness pattern).
The durable perf guardrail — likely makes P2's hybrid unnecessary.

### Lane B — Terminal theming / color (after P1 in umbrella; ✎ design artifact first)
DOM unlocks real subpixel AA + native color/weight with no atlas rebuild. Additive `themeId?` /
`fontFamilyId?` (closed-registry ids, ADR 0007 writer-only bump, board-level — do NOT move
`MIN_READER_VERSION`); move the inline `THEME` into a `TERMINAL_THEMES` registry; Configure-panel UI
(swatch segmented control); live apply via `term.options.theme = {…fresh}` (xterm ref-compares).
Mirror the `fontSize?`/`terminalFont.ts` sticky precedent (ADR 0005).

### Lane C — Correctness pack (after P1 in umbrella)
`@xterm/addon-web-links` + `@xterm/addon-unicode11` (scrollback capability sequence Phase 4). A
`feat/terminal-correctness-pack` worktree already exists — rebase it onto the umbrella tip.

## 6. Coordination contract (for listening sessions)

- **Shared-file owner while P1 is in flight = P1.** No other lane touches `useTerminalSpawn.ts` /
  `TerminalBoard.tsx` / `terminalBoardStyles.ts` until P1 is committed to the umbrella.
- A/B/C all re-touch `useTerminalSpawn` → **develop concurrently, merge sequentially** into the
  umbrella with a `git rebase <umbrella-tip>` between merges.
- Branch off the **umbrella tip**, not `main`. PR target = the umbrella branch. Inline-reply every bot
  comment. Full e2e matrix is owed **once**, at umbrella→main.
- Push note: `gh auth switch --user ch923dev` before pushing (the `ch-dev401` account lacks push).

## 7. Open questions (carry into P2)

1. Measured DOM-renderer FPS/CPU under 4–10 heavy streaming agent sessions on this Electron 42 /
   Windows box (no verified benchmark exists — measure locally).
2. Confirm React Flow applies `scale(z)` via script style mutation (crisp path), not a CSS
   transition / Web Animation on the zoomed wrapper (would keep DOM soft). The `cameraAnim` tween is a
   transient (acceptable, like a gesture) but verify it doesn't promote a permanent layer.
3. Does DOM-default alone meet the bar, or is the WebGL@1 hybrid actually needed? Decide from (1).
