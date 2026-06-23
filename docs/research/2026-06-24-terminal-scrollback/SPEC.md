# Phase 3 — Configurable + persisted terminal scrollback

> Part of the terminal-capabilities sequence (see `docs/research/2026-06-23-terminal-scrollback-reflow/REPORT.md`).
> Phase 1 (full-view freeze) + Phase 2 (find-in-terminal) shipped to `main` via umbrella #235.
> This phase = **single PR** (`feat/terminal-scrollback`), no umbrella.

## Problem

Scrollback is a hard-coded **2000** lines (`useTerminalSpawn.ts` xterm constructor — a perf cap
from SLICE-012: xterm retains ~12 B/cell of buffer that never releases while a board stays mounted).
Log-heavy agent runs scroll off the top; now that full view is corruption-free (Phase 1) and the
buffer is searchable (Phase 2), depth is the missing lever. Make it **per-board configurable** and
**persisted**, with a **sticky last-used default** for new terminals.

## Design (signed off 2026-06-24 — "Approve as-is")

Artifact: `scrollback-mock.html` → `scrollback-mock.png` (token-accurate Appearance-tab mock).

- **Location:** the New/Settings Terminal dialog **Appearance** tab, directly below Font size — a
  display/buffer setting, sibling to font.
- **Control:** **preset chips** (not a stepper — scrollback spans orders of magnitude; chips also
  telegraph the memory ladder). Presets: **1,000 · 2,000 (default) · 10,000 · 50,000**.
- **Default stays 2,000** — unset boards are unchanged (no regression).
- **No "Unlimited"** — capped at 50,000 (~70 MB worst case/terminal) to preserve the SLICE-012
  bounded-buffer invariant; a true `Infinity` risks OOM on a runaway log.
- **Hint:** "Lines of output kept above the viewport. More history stays searchable, using more memory."

## Implementation (mirrors the `fontSize?` precedent end-to-end)

1. **`terminalScrollback.ts`** (NEW, mirrors `terminalFont.ts`): `DEFAULT_TERMINAL_SCROLLBACK=2000`,
   `MIN=0`/`MAX=50000`, `SCROLLBACK_PRESETS=[1000,2000,10000,50000]`, `clampScrollback`,
   `read/writeStickyScrollback` (localStorage `ca.terminal.scrollback`), `resolveInitialScrollback`.
2. **`boardSchema.ts`**: add optional `scrollback?: number` to `TerminalBoard`; `assertBoard`
   rejects non-finite/negative; `fromObject` clamps to `[0,50000]`. **No schemaVersion bump** —
   additive optional field, defaulted at read (exactly like terminal `fontSize` / `previewSourceId`).
   `toObject` already passes board fields through by reference, so it persists for free.
3. **`useTerminalSpawn.ts`**: `scrollbackRef` (construction read) + a live effect on
   `board.scrollback` that sets `term.options.scrollback` — xterm's option is mutable, so an edit
   applies **without respawning the PTY** (no session loss; mirrors the live font seam). The xterm
   constructor reads `resolveInitialScrollback(scrollbackRef.current)`.
4. **`NewTerminalDialog.tsx`**: a `Scrollback` field of preset chips in the Appearance tab; seed
   from `resolveInitialScrollback(board.scrollback)`; on apply pin `board.scrollback` (when changed)
   **and** `writeStickyScrollback` (the dialog is scrollback's only entry point, so it owns the
   sticky default — unlike font, which the in-terminal Ctrl+/- gesture also writes).

## Tests

- `terminalScrollback.test.ts` — clamp bounds/floor/non-finite, sticky read/write round-trip + miss,
  resolveInitial pin-vs-sticky.
- `e2e/terminalScrollbackConfig.e2e.ts` (`@terminal`) — Settings → Appearance → pick a preset →
  `board.scrollback` persists; reopen reflects the pin; new terminal inherits the sticky default.
  (Named `…Config` to avoid clobbering the Phase-1 `terminalScrollback.e2e.ts` full-view spec.)

## Out of scope

Web-links/unicode11 (Phase 4) · serialize/restore + save-to-file (Phase 5).
