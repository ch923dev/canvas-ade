# Terminal-crisp umbrella — ready-to-paste session prompts

Umbrella branch: **`feat/terminal-crisp-umbrella`** · worktree `.worktrees/terminal-crisp` · seed `07a700bf`.
Spec: `docs/research/2026-06-25-terminal-dom-renderer/REPORT.md` (on the umbrella branch).

**Status (2026-06-25):** P1 ✅ (DOM renderer) · P2 ✅ (DOM-only, hybrid ruled out) · umbrella REBASED
onto `origin/main afe3c89` (#254), tip `69283cc3` · **Lane A = DISPATCHED** (worktree
`.worktrees/terminal-dom-liveness`) · **Lane C = SUPERSEDED by #254** · Lane B open.

**Dispatch order:** lanes branch off the **umbrella tip** and PR **into the umbrella** (not main). A & B
both touch `useTerminalSpawn.ts` → develop concurrently, merge sequentially with a rebase between.
Each session: read `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`, work in ITS OWN worktree,
inline-reply every bot comment, `gh auth switch --user ch923dev` before pushing.

---

## P1 — DOM-renderer default (do this FIRST; built on the umbrella worktree itself)

```
You are working on the terminal-crisp umbrella (feat/terminal-crisp-umbrella, worktree
.worktrees/terminal-crisp). Read docs/research/2026-06-25-terminal-dom-renderer/REPORT.md §2,§4,§5(P1).

Implement P1 — switch the live terminal to xterm's DOM renderer (the permanent crisp-under-zoom fix):
- Stop loading the WebGL addon; remove the lod/suspend WebGL pooling (delete useTerminalWebgl usage).
- In useTerminalSpawn: collapse the in-canvas counterScale to 1 but KEEP
  `counterScale = isFullView ? fullViewScale(board.w,board.h,innerW,innerH) : 1` — the Pure A1
  full-view scale-up (#235) MUST be preserved. Selection shim getZoom → raw camera transform[2]
  (1 in full view).
- KEEP settledZoomStore + useZoomSettle intact (the OSR preview's useOffscreenSizing depends on
  settledZoom; the snap-to-100% detent stays). Only remove the TERMINAL's consumption of settledZoom.
- Preserve find-in-terminal (#232) + configurable scrollback (#237). Keep the no-clip rAF safety for
  full view; at cs=1 in-canvas it no-ops.
- Guardrail: assert NO `will-change: transform` on the terminal host or any ancestor.
- Rewrite e2e/terminalCrisp.e2e.ts to DOM invariants (rows present = DOM painting; crisp during a
  fractional-zoom drag-select; cols/rows frozen across zoom; full-view scrollback intact). Update the
  __canvasE2E probes + terminalFont unit tests.
- Gate (typecheck/lint/format/unit) + title-stamped manual dev check (CANVAS_DEV_TITLE='P1 terminal
  DOM renderer') on a LIVE claude session: crisp at rest, during pan/zoom, busy vs fresh terminal.
- Commit to the umbrella branch directly. Then run the P2 load test (REPORT §5 P2) and report numbers
  BEFORE deciding on the WebGL@1 hybrid.
```

## Lane A — DOM perf liveness gating (PRIMARY perf work; worktree READY)

> Worktree already created: `.worktrees/terminal-dom-liveness` (branch `feat/terminal-dom-liveness`,
> off umbrella tip `69283cc3`). Just open a Claude session there and paste the prompt.

```
You are implementing Lane A of the terminal-crisp umbrella, in the worktree
.worktrees/terminal-dom-liveness (branch feat/terminal-dom-liveness, already created off the umbrella
tip). Read docs/research/2026-06-25-terminal-dom-renderer/REPORT.md §2-3 (root cause + perf), §5 Lane A,
§6 coordination, AND the "P2 RESULT" block (the load-test that motivates this lane).

CONTEXT: P1 shipped the DOM renderer (crisp under zoom). P2 load-tested it and proved camera motion is
NEVER the bottleneck (zoom >= static), so the WebGL@1 hybrid was RULED OUT. The residual cost at heavy
load (P2: N=8 streamers all visible ~40fps) lives in the WRITE / DOM-mutation path — and xterm's DOM
renderer draws ALL incoming PTY data regardless of whether the board is visible (xterm #880). Lane A is
the DURABLE fix and the reason DOM-only is safe. Lane C is SUPERSEDED (web-links+unicode11 already
merged via #254 — do not re-add). Lane B (theming) is the only other live lane.

IMPLEMENT:
- Gate the live xterm RENDER work for terminals that are OFF-SCREEN or BELOW-LOD (camera < LOD_ZOOM
  0.4). The PTY session and the buffer MUST stay alive — only the rendering/DOM mutation is paused.
- Coalesce PTY writes: batch the per-chunk term.write() calls (the port.onmessage 'data' path in
  useTerminalSpawn) into a buffered flush (rAF- or microtask-batched), so a burst of small chunks
  becomes few writes; widen the flush window (or hold the buffer) while hidden/below-LOD and flush
  losslessly on becoming visible. Respect scrollback caps so a hidden firehose can't grow unbounded.
- REUSE the OSR liveness architecture as the template: src/renderer/.../boards/useOffscreenLiveness.ts
  (isOsrVisible / on-screen ∧ ≥LOD gating, MAX_LIVE eviction with a frozen last frame). LOD_ZOOM /
  isLod live in src/renderer/src/lib/canvasView.ts. The terminal analogue of a "frozen last frame" is
  simply: leave the DOM as-is and stop applying writes while hidden.

DO NOT REGRESS (verify each): DOM renderer stays (no WebGL); Pure A1 full-view scrollback (#235); find
(#232); configurable scrollback (#237); the scale-correct selection shim + Shift+Enter LF; the #254
web-links + unicode11 addons; settledZoomStore/useZoomSettle (OSR preview depends on settledZoom). NO
`will-change: transform` on the terminal host or any ancestor (re-introduces blur).

VERIFY: gate (typecheck/lint/format/unit) + scoped @terminal e2e + a NEW e2e proving a hidden/below-LOD
terminal stops rendering writes while its PTY stays alive and catches up losslessly when revealed.
Quantify the win: extend e2e/terminalLoad.bench.ts (run via playwright.bench.config.ts) with an
"N streamers, only K visible" scenario and show the visible terminals' fps stays high regardless of how
many off-screen streamers run (vs the current all-visible baseline). Title-stamped manual dev check
(CANVAS_DEV_TITLE='Lane A terminal liveness') on a LIVE multi-terminal layout.

PROCESS: PR INTO feat/terminal-crisp-umbrella (NOT main). On ACTIVE-WORK, you SHARE useTerminalSpawn.ts
with Lane B — coordinate (sequential merge, rebase between). gh auth switch --user ch923dev before
pushing; inline-reply every bot review comment.
```

## Lane B — Terminal theming / color (after P1; ✎ design artifact first)

```
You are on the terminal-crisp umbrella. P1 (DOM renderer) is committed. Read REPORT.md §5 (Lane B) + §6.
Branch off the umbrella tip into your own worktree.

Implement Lane B — terminal theme/color now that the DOM renderer gives real subpixel AA + native
color. Produce a DESIGN ARTIFACT (token-true HTML/JSX mock or wireframe) for sign-off BEFORE code.
Then: additive board `themeId?`/`fontFamilyId?` (closed-registry ids; ADR 0007 writer-only schema
bump, board-level — do NOT move MIN_READER_VERSION; fromObject degrades unknown id → default); move
the inline THEME (useTerminalSpawn) into a TERMINAL_THEMES registry; Configure-panel swatch control;
live apply via `term.options.theme = {…fresh}` (xterm ref-compares — mutate = no-op). Mirror the
fontSize?/terminalFont.ts sticky precedent. Gate + dev check. PR into the umbrella; coordinate the
useTerminalSpawn touch with lanes A/C.
```

## Lane C — Correctness pack — ✅ SUPERSEDED (do not run)

web-links + unicode11 shipped on `main` as **#254** (Phase 4) and merged into the umbrella when it was
rebased onto `afe3c89`. The addons load in `useTerminalSpawn` alongside fit/search; `terminalLinks.e2e`
(6 tests) is green on the DOM renderer. Nothing left for Lane C.
