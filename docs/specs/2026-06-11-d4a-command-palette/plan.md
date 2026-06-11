# D4-A — implementation plan (post-sign-off 2026-06-11)

Sign-off received: design approved as mocked; Ctrl+K opens from canvas text inputs too (xterm
exempt by propagation). One spec correction discovered while planning: the existing ⋯-menu Delete
has NO confirm (undo covers it) — the palette's "Delete board" uses the same `boardActions.remove`
path, no new confirm.

## New files

| File | Contents |
|---|---|
| `canvas/palette/commandRegistry.ts` | `PaletteCtx` (boards, groups, selectedIds, canUndo/canRedo, isMac, action callbacks) · `buildCommands(ctx): PaletteCommand[]` (pure — visibility gating inline) · `SHORTCUT_ROWS` (static shortcut-sheet rows) · chip display helper (mac ⌘) |
| `canvas/palette/paletteSearch.ts` | case-insensitive word-prefix + subsequence scorer, `filterCommands` |
| `canvas/palette/CommandPalette.tsx` | the island on `Modal` (zIndex 400 — above full-view 200/menus 250, below RecapConsent 1000/Confirm 10000): combobox input + listbox rows + `aria-activedescendant`, ↑↓/Home/End/Enter, sections, footer, shortcuts view, token-keyed `setMenuOpen` detach (ADR 0002), `scrimProps: { 'data-palette-open': '' }` |
| `canvas/palette/paletteIntentStore.ts` | ephemeral zustand channel `{ nonce, boardId, kind: 'rename' \| 'restart-resume' \| 'restart-new' }` — verbs whose implementation lives inside a board component |
| `canvas/boards/terminal/usePaletteRestart.ts` | consumes restart intents for this board id → calls the spawn hook's `restart` (resume via existing `launchOverrideRef` path) |
| `canvas/boards/planning/runExport.ts` | verbatim extraction of ExportPopover's `runExport` body → `runBoardExport(board, format)`; popover + palette both call it |

## Modified files

- `useCanvasKeybindings.ts` — two new action kinds in `resolveCanvasKeyAction`:
  `mod+K → {kind:'palette'}` (**no typing guard** — sign-off; no Shift/Alt) and
  `'?' + bareKeyAllowed → {kind:'shortcuts'}` (no modifiers). New optional dep `openPalette(view)`.
  Capture-phase full-view Esc gains, AFTER the `[data-confirm-active]` bail (BUG-005 order
  unchanged): `if (document.querySelector('[data-palette-open]')) return`.
- `Canvas.tsx` — `paletteView` state (`null | 'commands' | 'shortcuts'`; Ctrl+K toggles), build
  `PaletteCtx` actions from what Canvas already owns (addBoard-at-center via store, selectBoard +
  `rf.fitView({nodes:[{id}]})`, boardActions, groupSelection/focusGroup, tidyAndFit, fit/reset
  frames, doUndo/doRedo, intent sends), render `<CommandPalette/>`. **Ratchet payment:** verbatim
  extraction of the `boardActions` useMemo (~70 code lines) → `canvas/hooks/useBoardActions.ts`
  (same D3-A/B pattern) — keeps Canvas under its 779 pin.
- `BoardFrame.tsx` — consume `rename` intents (board id match + single-selected) → enter the
  existing D2-A title-edit state. Intent is sent one macrotask AFTER the palette closes so Modal's
  focus-restore can't stomp the title input's focus.
- `TerminalBoard.tsx` — one hook call (`usePaletteRestart(board.id, restart, ...)`); stays under
  its 631 pin.
- `ExportPopover.tsx` — `runExport` body replaced by the extracted helper call.
- `index.css` — `.cp-*` island styles per the mock + thin dark scrollbar on the list + 120ms
  entry fade behind `prefers-reduced-motion`.

## Behavior pins (from spec + sign-off)

- Esc layering: confirm gate → palette → full view. One Esc, one layer.
- Run = close palette first, execute verb after (intents deferred one macrotask).
- Hidden-not-disabled gating; dynamic rows from store state each open (and live via store
  subscription while open — cheap, the list is small).
- Resume row gated on `board.agentSessionId`; export rows on selected planning board; restart
  rows on selected terminal.
- Registry drift guard: unit test feeds every command chip that claims a canvas chord into
  `resolveCanvasKeyAction` and asserts the action kind.

## Test plan

- **Unit:** paletteSearch scoring/ordering · registry visibility matrix (selection type ×
  undo/redo depth × groups × agentSessionId) · chip↔resolver drift guard · mac chip display ·
  intent store nonce/consume semantics.
- **Integration (jsdom):** open renders grouped rows from a seeded store · type-to-filter ·
  Enter runs (board count changes) · ↑↓ wrap + aria-activedescendant · `?` view renders
  SHORTCUT_ROWS · Esc calls onClose · scrim carries `data-palette-open` · rename intent reaches
  BoardFrame (title input appears).
- **e2e (real input, `commandPalette.e2e.ts`):** Ctrl+K opens · type "term" + Enter creates a
  terminal board · Esc closes + focus restored · full view open → Esc closes palette first, second
  Esc exits full view · `?` opens shortcuts view · with a live preview, palette open ⇒ native view
  detached (snapshot under it), close ⇒ reattach.

## Order

1. registry + search + intent store (+ unit tests) — pure, no UI.
2. runExport extraction (+ existing tests stay green).
3. CommandPalette UI + CSS (+ integration tests).
4. Keymap + Esc-layer change (+ resolver unit tests) + Canvas wiring + boardActions extraction.
5. BoardFrame/TerminalBoard intent consumers.
6. e2e + full gate + manual `pnpm test:e2e:matrix` (first-push skip) → PR.
