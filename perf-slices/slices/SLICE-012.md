# SLICE-012 — Terminal: cap xterm scrollback memory

- **Dimension:** memory / scalability · **Severity:** low · **Effort:** S
- **Finding:** `ft-xterm-scrollback-5000-per-terminal`
- **Where:** `src/renderer/src/canvas/boards/terminal/useTerminalSpawn.ts:378-388` (`new Terminal({
  scrollback: 5000 })`); mount-at-LOD design at `TerminalBoard.tsx:486-490`.

## Baseline (measured, reproduced)

- Each terminal is `new Terminal({ scrollback: 5000 })` and is **kept mounted at LOD by design**
  (LOD only `display:none` + detaches WebGL — `useTerminalWebgl.ts:135-140`; **no buffer trim**).
- xterm 5.5 cell cost = `Uint32Array(3*cols)` = 12 B/cell. Micro-bench (`node --expose-gc`,
  `arrayBuffers`): a fully-scrolled terminal @120 cols = **6.87 MB** (matches analytic
  5000×3×120×4); **20 fully-scrolled terminals = 137.3 MB arrayBuffers + 18.3 MB heap, RSS +181 MB**.
  Buffers are lazy (materialize as output is written) but never **release** on LOD/off-screen → memory
  grows linearly with terminal count and never bounds down.

## Target

Bound resident scrollback for off-screen / below-LOD terminals. Lowest-risk: lower the default
scrollback (e.g. 2000) and/or trim the xterm buffer when a board stays below LOD for a while — **note
PTY data already past the buffer can't be recovered, so trimming must only drop already-scrolled-out
history, never live/visible rows.** Keep the PTY alive (the mount-at-LOD invariant). **Target: <55 MB
arrayBuffers at 20 terminals** (from ~137 MB).

## Validation

1. `node --expose-gc` style measurement or an in-app `process.memoryUsage().arrayBuffers` probe with
   20 scrolled terminals before/after → <55 MB.
2. Active/visible terminals show full expected scrollback; live output never truncated.

## Invariant (must stay identical)

Visible/active terminal scrollback behavior unchanged; no loss of live PTY output; PTY survives
zoom-out (mount-at-LOD invariant preserved).

## Files touched

- `src/renderer/src/canvas/boards/terminal/useTerminalSpawn.ts` (Terminal opts + optional LOD trim
  hook).

## Collisions

- None (isolated). Parallel-safe in Wave 1.
