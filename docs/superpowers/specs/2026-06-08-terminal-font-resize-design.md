# Terminal font resize — design

**Status:** Approved (brainstorm) · **Date:** 2026-06-08 · **Branch:** `feat/terminal-font-resize`
**Sibling:** ADR 0004 (planning text font controls). This feature gets its own **ADR 0005**.

## Problem

The terminal board's xterm font size is a hard-coded constant (`fontSize: 12.5` in
`TerminalBoard.tsx`). Every terminal renders at that size with no way to change it. On the user's
display the default reads too large, and the pain repeats on **every** new terminal — there is no
per-board control and no way to shift the default.

## Goals

- Per-board font size the user can shrink/grow/reset on a live terminal.
- A **sticky default**: once the user picks a size, every **new** terminal starts at that size, so
  the "every new terminal is too big" pain is paid once, not per board.
- Four ways to drive it (all confirmed with the user): keyboard + Ctrl-wheel, title-bar `A−`/`A+`,
  the Configure popover, and the well right-click menu.
- A font change reflows the grid and resizes the PTY (the agent's TUI reflows to the new columns).
- Persist per board across reload; zero schema migration.
- **Clip-free fit at every supported size** (folds in the bottom-row-clip bug): the rendered grid
  must never spill past the well's clip boundary, at any font size × board height × display scaling ×
  camera-zoom in the working band. Measured, not assumed (see "Clip-free fit" below).

## Non-goals

- No global Settings-modal UI for terminal font (the sticky default covers the "set once" need).
- No font-family / line-height / weight controls — size only. (Family stays the `--term-mono`
  token; line-height stays `1.2`.)
- No change to the Browser or Planning boards.
- Not bumping `SCHEMA_VERSION` (v8 is reserved for the Mermaid diagram per ADR 0004; another
  worktree is already eyeing v8 — see Coordination).

## Confirmed parameters

| Parameter | Value |
|---|---|
| Default / reset target | `DEFAULT_TERMINAL_FONT = 12.5` |
| Min / max | `8` / `22` (clamped) |
| Step | `±1` per nudge |
| Scope | Per-board pin + sticky last-used default |
| Sticky store | Global `localStorage['ca.terminal.fontSize']` (per-machine, all projects) |
| Title-bar buttons | `A−`/`A+`, revealed only on hover/select (calm at rest) |

## Data model & persistence

- New **optional** field on `TerminalBoard` (`src/renderer/src/lib/boardSchema.ts`):
  ```ts
  export interface TerminalBoard extends BoardCommon {
    type: 'terminal'
    // ...existing...
    /** Per-board xterm font size in px. Absent ⇒ use the sticky default (else 12.5). */
    fontSize?: number
  }
  ```
  **Zero-migration**, exactly like `previewSourceId` / `agentSessionId` / `agentTranscriptPath` were
  added (optional + default-at-read). No `SCHEMA_VERSION` bump, no migration entry. An old doc with
  no `fontSize` still parses and reads the sticky default.

- Add `'fontSize'` to `PATCHABLE_KEYS.terminal` (`src/renderer/src/store/canvasStore.ts`) so
  `updateBoard` accepts it and `toObject` round-trips it. (`assertBoard` needs no change — the field
  is optional; if it validates board shape, allow an optional finite number.)

- **Sticky model.** `board.fontSize` is the per-board **pin**, written the first time the user sizes
  that board. A board with `fontSize` **absent** is unpinned and shows the current sticky default.
  - Initial size at mount = `board.fontSize ?? readStickyFont() ?? DEFAULT_TERMINAL_FONT`.
  - **Every** size change writes BOTH `board.fontSize` (pins the board) AND the sticky store (updates
    the new-terminal default). So a new terminal always opens at "the last size I chose anywhere."
  - This needs **no** `createBoard`/`addBoard` change: unpinned new boards read sticky at mount;
    pinning happens on first change.

## Pure helper — `src/renderer/src/canvas/boards/terminal/terminalFont.ts` (new)

Small, pure, unit-tested. Isolates the constants, clamp, and the (try/catch-guarded) sticky store.

```ts
export const DEFAULT_TERMINAL_FONT = 12.5
export const MIN_TERMINAL_FONT = 8
export const MAX_TERMINAL_FONT = 22
const STICKY_KEY = 'ca.terminal.fontSize'

/** Clamp to [MIN, MAX]; non-finite ⇒ DEFAULT. */
export function clampTerminalFont(n: number): number { /* ... */ }

/** Read the global sticky default (localStorage), clamped; DEFAULT on miss/parse-fail/no-storage. */
export function readStickyFont(): number { /* try/catch */ }

/** Persist the global sticky default (clamped). No-op if storage unavailable. */
export function writeStickyFont(n: number): void { /* try/catch */ }

/** Initial size for a board: its pin if present, else the sticky default. */
export function resolveInitialFont(boardFontSize: number | undefined): number {
  return boardFontSize != null ? clampTerminalFont(boardFontSize) : readStickyFont()
}
```

`localStorage` is wrapped in try/catch (disabled/private-mode/test) and falls back to `DEFAULT`.
jsdom provides `localStorage`, so the unit tests run without mocks.

## Core action — persist + one reactive effect (`TerminalBoard.tsx`)

The four triggers do **not** touch xterm directly. They all call one persist helper; a single effect
keyed on `board.fontSize` applies the change to the live term and refits. This decouples "persist the
pin" from "apply to the term", so the Configure popover (which only knows how to `updateBoard`) and
the keyboard/wheel/menu/title-bar paths all converge on the same one place that mutates the term.

```
// persist — the four triggers call these (no term access)
setFont(next):
  next = clampTerminalFont(next)
  if next === clampTerminalFont(board.fontSize ?? readStickyFont()) → return   // no-op: no phantom undo / sticky churn
  beginFontBurst()                          // leading-edge undo checkpoint (coalesced; see below)
  updateBoard(board.id, { fontSize: next }) // persist the per-board pin
  writeStickyFont(next)                     // update the new-terminal default

nudge(delta): setFont((termRef.current?.options.fontSize ?? DEFAULT_TERMINAL_FONT) + delta)
resetFont():  setFont(DEFAULT_TERMINAL_FONT)

// apply — one effect reacts to the persisted pin
useEffect(() => {
  const term = termRef.current
  if (!term) return
  const fs = clampTerminalFont(board.fontSize ?? readStickyFont())
  if (term.options.fontSize === fs) return
  term.options.fontSize = fs          // xterm v5 setter rebuilds the glyph atlas (WebGL too)
  refit()                             // fit.fit() → onResize → PTY resize (the TUI reflows)
}, [board.fontSize])
```

- **`refit()`** = the existing guarded fit pattern: `try { fitRef.current?.fit() } catch {}`. On an
  unfitted well (LOD / `display:none`) `fit()` no-ops; the persisted `fontSize` is unaffected and the
  size lands on the next good fit via the existing `ResizeObserver`. (The `term.options.fontSize` set
  still takes hold for when the well next shows.)
- **Initial construction.** Replace the literal `fontSize: 12.5` in `new Terminal({...})` with
  `fontSize: resolveInitialFont(fontSizeRef.current)`. `fontSize` must **not** be a `spawn` dependency
  (a size change must never respawn the PTY), so it is read through a ref (`fontSizeRef`, kept in sync
  by an effect — the existing `lodRef` / `fullViewRef` pattern). The reactive effect above then no-ops
  on first mount (constructed size already equals the pin). A later LOD remount reconstructs xterm at
  the pinned size the same way.
- **WebGL.** Setting `term.options.fontSize` fires xterm's options-changed path, which rebuilds the
  texture atlas; the WebGL addon clears its atlas on that signal. No extra call expected; the plan
  verifies glyphs are crisp after a resize and, if not, adds a defensive
  `webglRef.current?.clearTextureAtlas()`.
- **Undo coalescing.** Rapid nudges (Ctrl-wheel, held `Ctrl+-`) must collapse to **one** undo step.
  `beginFontBurst()` calls `beginChange()` only at the **leading edge** of a burst (when no burst
  timer is active) and arms/refreshes a ~500ms idle timer; subsequent nudges in the burst skip
  `beginChange()` so they coalesce into the single pre-burst snapshot. (`beginChange` already dedups
  identical snapshots — memory `undo-lastrecorded-phantom`.)

## The four triggers

### 1 · Keyboard + Ctrl-wheel
- **Keymap** (`terminal/terminalKeymap.ts`): extend `resolveTerminalKey` with the font chords, using
  the existing primary-modifier rule (Cmd on macOS, Ctrl elsewhere; never with Alt):
  - `Ctrl/Cmd` + (`=` or `+`) → `{ kind: 'fontInc' }`
  - `Ctrl/Cmd` + (`-` or `_`) → `{ kind: 'fontDec' }`
  - `Ctrl/Cmd` + `0` → `{ kind: 'fontReset' }`
  - Extend `TerminalKeyAction` and `TerminalKeyEffects` (`fontStep(delta)`, `fontReset()`).
    `handleTerminalKey` owns these (preventDefault → suppress xterm AND the browser page-zoom default
    → run the effect). We deliberately **shadow** `Ctrl+=`/`Ctrl+-`/`Ctrl+0` from the shell, matching
    VS Code / iTerm. Documented in the keymap comment.
- **Ctrl-wheel** (`TerminalBoard.tsx`): a **native, non-passive** `wheel` listener on the screen wrap
  (registered in `spawn`, beside the existing `keydown` `stopKeys` listener — React's synthetic
  `onWheel` is passive, so `preventDefault` needs the native listener). `if (e.ctrlKey)` →
  `preventDefault(); stopPropagation(); nudge(e.deltaY < 0 ? +1 : -1)`. The wrap is already `nowheel`,
  so React Flow never zooms. macOS pinch-zoom arrives as ctrl-wheel → free.

### 2 · Title-bar `A−` / `A+`
- Two compact `IconBtn`-style buttons added to the `actions` group, wrapped so they render only when
  `selected || hovered` (calm at rest; the bar already holds interrupt/globe/gear/restart/flip).
  `A−` → `nudge(-1)`, `A+` → `nudge(+1)`; disabled at the min/max bound.

### 3 · Configure popover row (`TerminalConfig.tsx`)
- A `Font size` row below `Working dir`: `A−  [12.5]  A+` (read-only numeric display + two steppers).
  The steppers call `setFont` **live** (via `updateBoard` → the reactive effect applies it to the
  term), **not** gated behind `Apply & restart` — a font change must not restart the session. The row
  reads the board's effective size (`board.fontSize ?? sticky ?? 12.5`) for the display. Because the
  Configure component only has the `board` + the store, it needs no new prop wiring — the persist path
  is the store, and the live apply is the board's effect.

### 4 · Well right-click menu
- Append to `menuEntries` (after `Clear`): `Bigger font` → `nudge(+1)`, `Smaller font` → `nudge(-1)`,
  `Reset font` → `resetFont()`.

## ADR 0005

Add `docs/decisions/0005-terminal-font-size.md` — sibling to 0004. Decision: per-board terminal font
size, numeric + clamped `[8,22]`, sticky default in localStorage, reversible (optional field, drops
clean). What stays out: family/weight/line-height, a global settings panel, any non-terminal board.

## Testing

- `terminalFont.test.ts` — `clampTerminalFont` (bounds, NaN/Infinity → default), `readStickyFont`
  (parse, clamp, missing/garbage → default, storage-throws → default), `resolveInitialFont`
  (pin vs sticky).
- `terminalKeymap.test.ts` — `resolveTerminalKey` returns `fontInc`/`fontDec`/`fontReset` for the
  chords on Win (Ctrl) and mac (Cmd), and `null` for plain `=`/`-`/`0` and for Alt-modified.
- Schema/store — a terminal with `fontSize` round-trips through `toObject`/`fromObject`;
  `PATCHABLE_KEYS.terminal` includes `fontSize` (a `url`-on-terminal style cross-type patch is still
  dropped).
- e2e `terminalFont.e2e.ts` — seed a terminal; drive a real `Ctrl+'-'` keydown (sendInputEvent) over
  the well; assert `e2eTerminals.get(id).options.fontSize` dropped by 1 AND `getBoards()` shows the
  persisted `fontSize`; then a new seeded terminal opens at the sticky size.

## Edge cases

- Clamp at `[8,22]`; steppers/menu no-op at the bound (title-bar buttons also disable).
- Reset target is `12.5`; reset also writes sticky `12.5` (consistent "last size chosen wins").
- LOD / idle / `display:none` mount: refit defers to the next good fit; the pin still persists.
- A font change never respawns the PTY (fontSize is not a `spawn` dep; read via ref).
- Sticky store unavailable (private mode/test) → silently falls back to `DEFAULT`.

## Clip-free fit (folds in the terminal bottom-row-clip bug)

**Symptom.** At specific board heights the terminal's last row renders horizontally clipped (top half
of the glyph visible, bottom half gone) — stable at rest, not a pan/zoom transient. Reproduces with a
running agent's pinned footer and with a plain shell on the last row. Likely sensitive to Windows
display scaling (`devicePixelRatio` 1.25/1.5) and React Flow's fractional `scale(z)`.

**Why it belongs here.** It is a cell-height → fit → does-the-grid-fit-the-well problem. Font size *is*
cell height, so this feature re-exercises the exact path and must guarantee a clip-free fit at **every**
supported size — fixing it separately would be redone here.

**Measure before fixing (hard rule).** Root cause is inconclusive from static reading: FitAddon floors
rows against xterm's own `dimensions.css.cell.height`, so `rows * cellHeight ≤ availableHeight` should
hold with ≥ the bottom-padding slack. The observed clip therefore proves a DOM/render assumption is
violated (rendered grid taller than the fit-measured height, stale `rows` vs current cell height,
font-metric timing, a parent/computed-height mismatch, or a fractional-DPR rounding gap). **No
guess-fix.** A runtime probe (Workstream B, Task 11) captures, at a reproducing size: `devicePixelRatio`,
`term.rows`/`cols`, the rendered `.xterm` / `.xterm-viewport` / `.xterm-screen` rects, and the host
well's `clientHeight` + computed height; it computes `gridBottom` vs `wellBottom` and confirms the
overflow + magnitude. The probe drives a **real** resize (NodeResizer / `sendInputEvent`), not a
synthetic event, and reads real DOM rects via the `e2eTerminals` handle.

**Fix selection (after the probe, must hold across ALL font sizes).** Candidates, applied per the
probe finding (each is coded in the plan, Task 12):
1. Restore the design's **12px bottom padding** (`screen` style is `'12px 12px 4px'` — a 4px-bottom
   deviation from DESIGN.md §7.1's 12px that removes the slack which would otherwise hide a sub-cell
   remainder). Cheap; verify it covers the worst-case remainder, do not assume.
2. **Snap the usable well height to a whole multiple of the current cell height** before/around fit, so
   no partial row is ever laid out.
3. **Refit on `devicePixelRatio` change** — today only a host `ResizeObserver` fires; moving the window
   between monitors changes DPR (→ cell height) without resizing the host, leaving `rows` stale.
4. **Refit on font-size change** — already in this feature's reactive effect; re-assert the invariant
   after every change.

`BoardFrame.tsx:437`'s `overflow:hidden` is **correct and stays** — fix the grid sizing, not the clip.
Security/process model untouched (no preload/sandbox changes).

**Acceptance.** No bottom-row clip at any board height, at every supported font size, on dpr
1.0 / 1.25 / 1.5, across the working camera-zoom band. Whitespace below the last row is fine; a clipped
glyph is not. e2e regression asserts `gridBottom ≤ wellBottom` (+small tolerance) for a matrix of
{font size × board height} cases, using real DOM rects + a real resize.

## Coordination (cross-zone)

- **`boardSchema.ts`** — additive optional `fontSize?` on **`TerminalBoard`** only, **no version
  bump**. The `text-create-edit-ux` worktree edits the **`TextElement`** interface + bumps to v8;
  different interfaces/lines → additive clean-merge. My change must NOT touch `SCHEMA_VERSION`.
- **`canvasStore.ts`** — one line in `PATCHABLE_KEYS.terminal`; far from that worktree's
  planning/selection code.
- `terminalKeymap.ts` shift+enter (#90) is already on `main`; I build on it.

## Out of scope / future

- Global terminal-font setting in the Settings modal (deferred; sticky default suffices).
- Font family / weight / line-height controls.
- Pinch-zoom on trackpads beyond the ctrl-wheel mapping (already covered incidentally on macOS).
