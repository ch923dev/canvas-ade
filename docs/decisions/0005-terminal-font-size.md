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
so the adjustment is paid once.

## What stays cut
Font family / weight / line-height controls; a global Settings-modal panel; any change to the Browser
or Planning boards. We deliberately shadow `Ctrl+=`/`Ctrl+-`/`Ctrl+0` from the shell (VS Code / iTerm
parity).

## Consequences
- **No `SCHEMA_VERSION` bump.** `fontSize?` is optional + default-at-read (mirrors `previewSourceId` /
  `agentSessionId`); old docs parse unchanged. This keeps schema **v8 free** for the Mermaid diagram
  element (ADR 0004) and avoids collision with the in-flight `text-create-edit-ux` work.
- Reversible: dropping the controls leaves `fontSize` data that still validates.
- **Clip-free fit folded in.** Because font size IS cell height, this feature subsumes the bottom-row
  clip bug: a measure-first probe roots the cause and a `fitWhole` wrapper + 12px padding + a
  `devicePixelRatio`-change refit keep the grid within the well at every size. `BoardFrame`'s
  `overflow:hidden` is unchanged — the grid sizing is fixed, not the clip.
