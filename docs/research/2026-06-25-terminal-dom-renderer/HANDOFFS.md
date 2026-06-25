# Terminal-crisp umbrella — ready-to-paste session prompts

Umbrella branch: **`feat/terminal-crisp-umbrella`** · worktree `.worktrees/terminal-crisp` · seed `07a700bf`.
Spec: `docs/research/2026-06-25-terminal-dom-renderer/REPORT.md` (on the umbrella branch).

**Dispatch order:** P1 first (foundation). Lanes A/B/C only **after P1 is committed to the umbrella**
(they all touch `useTerminalSpawn.ts` → develop concurrently, merge sequentially with a rebase between).
Each session: read `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`, work in ITS OWN worktree,
branch off the **umbrella tip**, PR **into the umbrella** (not main), inline-reply every bot comment,
`gh auth switch --user ch923dev` before pushing.

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

## Lane A — DOM perf liveness gating (after P1)

```
You are on the terminal-crisp umbrella. P1 (DOM renderer) is committed to feat/terminal-crisp-umbrella.
Read docs/research/2026-06-25-terminal-dom-renderer/REPORT.md §5 (Lane A) + §6.
Branch off the umbrella tip into your own worktree (new-worktree.ps1 -Base feat/terminal-crisp-umbrella).

Implement Lane A — pause/throttle DOM-renderer terminals that are off-screen or below the zoom LOD,
and coalesce PTY writes (xterm #880: the renderer draws all incoming data regardless of visibility).
Reuse the OSR liveness pattern (paint-gate below-LOD, freeze last frame). The PTY session must NOT
tear down. Gate + scoped e2e + dev check. PR into the umbrella; coordinate the useTerminalSpawn touch
on ACTIVE-WORK with lanes B/C (sequential merge, rebase between).
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

## Lane C — Correctness pack (after P1)

```
You are on the terminal-crisp umbrella. P1 (DOM renderer) is committed. Read REPORT.md §5 (Lane C) + §6.
A feat/terminal-correctness-pack worktree already exists — rebase it onto the umbrella tip (or branch
fresh off the umbrella tip).

Implement Lane C — add @xterm/addon-web-links + @xterm/addon-unicode11 (load in useTerminalSpawn
alongside fit/search). Deps change on MAIN then merge per the worktree-deps rule, OR add to the
umbrella and reconcile. Gate + scoped e2e + dev check. PR into the umbrella; coordinate the
useTerminalSpawn touch with lanes A/B.
```
