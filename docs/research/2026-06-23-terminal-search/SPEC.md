# Phase 2 — Find-in-terminal (search)

*Part of the terminal-capabilities umbrella (`feat/terminal-capabilities`). Roadmap:
`docs/research/2026-06-23-terminal-scrollback-reflow/REPORT.md` §7. Branch: `feat/terminal-search`.*

## Goal

The single biggest win for "reading logs / debugging" (the original terminal complaint): a
**Ctrl/Cmd+F find bar** over the terminal well, powered by `@xterm/addon-search`. Highlights every
match in the live buffer, steps through them, and counts them — works on a running, exited, or
scrolled-back terminal alike (the buffer is searched, independent of PTY state).

## Design (signed off 2026-06-23)

Artifact: `find-bar-mock.png` (token-accurate mock) → **approved as-is**. Real-app result:
`find-bar-real.png`. A calm floating island, top-right of the well, **one accent (blue)**:

```
⌕  [error            ]  1 / 4  | Aa  .*  | ↑  ↓  | ✕
```

- **Input** — type-ahead (incremental) search; seeded from a single-line xterm selection on open.
- **Counter** — `i+1 / N`, `No results` (warn-toned) when nothing matches, `N` if the highlight
  threshold is exceeded.
- **Toggles** — `Aa` match-case, `.*` regex (accent-wash when on). *Whole-word was declined as
  rarely used for log reading.*
- **Nav** — `↑`/`↓`; **Enter** next, **Shift+Enter** prev, both wrap. **Esc** closes (focus → xterm).
- **Decorations** — every match a muted-blue cell wash; the active match brighter + a light-blue
  border. Colours in `terminalSearch.ts` (`#RRGGBB` per the addon constraint), mirroring `--accent`.

## Implementation

| File | Change |
|---|---|
| `package.json` / lockfile | `@xterm/addon-search@^0.15.0` (devDep — Vite-bundled, like the other addons) |
| `terminalKeymap.ts` | new `{ kind: 'find' }` action (Ctrl/Cmd+F, bare primary modifier) + `find()` effect |
| `useTerminalSpawn.ts` | load `SearchAddon` per-term (beside fit); own `findOpen` state; `find` effect → open; expose `{ findOpen, findApi }` (stable `findApi = {close, addonRef, termRef}`) |
| `terminalSearch.ts` (new) | pure helpers: `formatMatchCount`, `buildSearchOptions`, `SEARCH_DECORATIONS` |
| `TerminalFindBar.tsx` (new) | the bar — local query/option/result state, memo'd, compiler-clean (no manual memo) |
| `styles/islands/terminal-find.css` (new) | the island styles (tokens; mirrors the command-palette grammar) |
| `TerminalBoard.tsx` | render `{findOpen && <TerminalFindBar api={findApi} />}` in the well |
| `terminalBoardStyles.ts` (new) | extracted TerminalBoard style consts (reclaims its max-lines budget) |

### Why the bar is a DOM input, not xterm

Its `Enter`/`Shift+Enter` must mean next/prev — **not** xterm's newline (LF). As a separate DOM
input it never reaches xterm's `attachCustomKeyEventHandler`, so there is zero collision. It
`stopPropagation`s pointer + key events so the well's focus-grab and React Flow's global shortcuts
(board-delete, zoom, Esc→exit-full-view) don't fire while searching.

## Testing

- **Unit** (`terminalSearch.test.ts`, `terminalKeymap.test.ts`) — counter label, option builder,
  decoration constraints; the Ctrl/Cmd+F chord (incl. mac Cmd-vs-Ctrl, Shift/Alt guards).
- **e2e** (`terminalSearch.e2e.ts`, `@terminal`) — real pipeline: synthetic Ctrl+F → bar opens;
  count tracks matches; Enter advances + wraps; Esc closes; match-case narrows; no-results warns.
- Full `@terminal` suite green (41) — no regression from the spawn/style refactors.

## Out of scope (later phases)

Whole-word toggle (declined), configurable scrollback (Phase 3), serialize/save (Phase 5),
search-in-all-terminals. Ligatures remain declined (no WebGL support).
