# ADR 0005 — Per-board terminal font size

**Status:** Accepted · **Date:** 2026-06-08 · **Sibling of:** ADR 0004 (planning text font controls).

## Context
The terminal board's xterm font was a hard-coded `12.5px`. On some displays it reads too large, and
the pain recurred on every new terminal — there was no per-board control and no way to shift the
default.

## Decision
Add a per-board font size: an optional `TerminalBoard.fontSize?` (numeric, clamped `[8, 22]`, step 1,
reset `12.5`). Four user triggers — keyboard (`Ctrl/Cmd +/-/0`) + Ctrl-wheel, title-bar `A-`/`A+`,
the Configure popover row, and the well right-click menu — all funnel into one persist helper. A
`board.fontSize`-reactive effect applies the change to the live xterm and refits (→ PTY resize). A
global `localStorage` **sticky default** (`ca.terminal.fontSize`) seeds the size of the next terminal,
so the adjustment is paid once. **Reset (`Ctrl+0`) is per-board:** it returns this board to `12.5` but
deliberately does NOT rewrite the sticky, so resetting one board never clobbers the user's global
default (decided 2026-06-09 after PR review — a per-board reset should not have a global side effect).

## What stays cut
Font family / weight / line-height controls; a global Settings-modal panel; any change to the Browser
or Planning boards. We deliberately shadow `Ctrl+=`/`Ctrl+-`/`Ctrl+0` from the shell (VS Code / iTerm
parity).

## Consequences
- **Migration-free field (no bump of its own).** `fontSize?` is optional + default-at-read (mirrors
  `previewSourceId` / `agentSessionId`); old docs parse unchanged. It rode in alongside the
  `text-create-edit-ux` work that took the canvas to **v8** (#92) — no separate migration was needed.
  The next schema consumer (the Mermaid diagram element, PR #72) therefore targets **v9**.
- Reversible: dropping the controls leaves `fontSize` data that still validates.
- **Two refs carry the font invariants** (verify on any future edit). `liveFontRef` is the
  authoritative size, advanced *synchronously* in `setFont`; `nudgeFont` steps from it (not xterm's
  `options.fontSize`, which only updates after the apply effect runs next paint) so a Ctrl-wheel
  burst steps once per notch instead of collapsing. `bornFont` (a lazy-init `useState`, render-safe)
  is the size the board was *born* with (sticky at mount, frozen); the apply effect + the disabled
  state fall back to it for an UNPINNED board rather
  than the live sticky — this board's own nudges mutate the sticky, so a live fallback would not
  revert when undo clears the pin to `undefined`. The sticky still seeds the *next* terminal.
- **Clip-free fit folded in.** Because font size IS cell height, this feature subsumes the bottom-row
  clip bug: a measure-first probe roots the cause and a `fitWhole` wrapper + 12px padding + a
  `devicePixelRatio`-change refit keep the grid within the well at every size. `BoardFrame`'s
  `overflow:hidden` is unchanged — the grid sizing is fixed, not the clip.
