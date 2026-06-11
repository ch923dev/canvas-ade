# D4-A — Command palette (Ctrl+K) + `?` shortcut view — SPEC

> Design-audit Wave D4 lane A (`docs/reviews/2026-06-10-design-ux-audit-waves.md`). Per-slice doc:
> deleted in the PR that merges this feature. Status: **awaiting design sign-off** — no
> implementation until the artifact (mock-default.png / mock-shortcuts.png in this folder) is
> approved.

## Why (audit §2, §7.1–7.2)

The app's expert ceiling is high but nothing teaches the hidden gestures (`1`/`0`/`T` camera keys,
Ctrl+G groups, F2 rename, double-click focus). Every modern peer (Linear, Raycast, VS Code, Figma)
solves discoverability with a command palette + shortcut sheet. The palette makes every verb a
searchable row **with its shortcut printed** — it teaches the keyboard while being usable by mouse.
The `?` overlay (deferred from D2) folds in here as a view of the same surface.

## Scope

One new floating island (DESIGN.md §8) with two views:

1. **Command view** (Ctrl/⌘+K): fuzzy-searchable verb list, grouped by section, shortcut chips on
   the right, ArrowUp/Down + Enter to run.
2. **Shortcuts view** (`?` bare key, or the "Keyboard shortcuts" verb): every app shortcut as a
   read-only, searchable reference — including bindings that are not palette verbs (Del, Esc
   layers, Shift+Enter in terminals, planning-board keys, drag modifiers).

Out of scope: MCP/agent verbs (future home noted in the registry design), minimap/board list
(D4-C), Tab-cycle (D4-B).

## Verb inventory (command view)

Context rows are **hidden** (not disabled) when their predicate fails — Raycast/Linear convention,
keeps the list calm. Dynamic rows (one per board/group) are generated from store state at open.

| Section | Verb | Shortcut chip | Gating / behavior |
|---|---|---|---|
| Boards | New terminal board | — | `addBoard('terminal')` at viewport center (freeSlot-nudged), select it |
| Boards | New browser board | — | same |
| Boards | New planning board | — | same |
| Boards | Go to board: *title* | — | one row per board, type glyph; select + animated `rf.fitView({nodes:[{id}]})` |
| Selected board | Rename board | `F2` | single board selected; enters the D2-A inline title edit |
| Selected board | Duplicate board | — | single board selected |
| Selected board | Delete board… | `Del` | single board selected; routes through the existing confirm path |
| Selected board | Open full view | — | single board selected (per-type full-view path) |
| Selected board | Restart terminal: resume session | — | selected terminal with resumable session |
| Selected board | Restart terminal: new session | — | selected terminal |
| Selected board | Export planning board as PNG / as SVG | — | selected planning board (2 rows) |
| Groups | Group selected boards | `Ctrl G` | ≥2 boards selected |
| Groups | Focus group: *name* | `F` | one row per named group; grouped-focus camera move |
| Groups | Ungroup: *name* | — | one row per named group |
| Canvas | Tidy boards | `T` | always |
| Canvas | Fit all boards | `1` | always |
| Canvas | Reset zoom to 100% | `0` | always |
| Edit | Undo | `Ctrl Z` | `pastLen > 0` (else hidden) |
| Edit | Redo | `Ctrl ⇧ Z` | `futureLen > 0` (else hidden) |
| Help | Keyboard shortcuts | `?` | switches the island to the shortcuts view |

(mac chips render ⌘ instead of Ctrl — one `isMac` display helper, no second registry.)

## Shortcuts view content

Same island, same search input, read-only rows. Sections: **Canvas** (1/0/T/F, Ctrl+G, Ctrl+Z/Y,
Esc, Del, double-click focus, Ctrl while dragging = disable snap) · **Boards** (F2, double-click
title, Shift+drag multi-select) · **Terminal** (Shift+Enter = newline, Ctrl+K caveat: goes to the
agent while the terminal owns focus) · **Planning** (tool keys, arrow nudge 1px/⇧10px, Ctrl+G/
Ctrl+⇧+G element groups, Shift+F10 context menu) · **Palette** (Ctrl+K, ?, ↑↓, ↵, Esc). Exact rows
are enumerated from the registry at implementation time — the spec locks the *shape*, not the
final row list.

## One shared registry (the no-duplication constraint)

New `src/renderer/src/canvas/palette/commandRegistry.ts`:

- `Command = { id, section, title, keywords, chip?, visible(ctx), run(ctx) }` — built as a pure
  function of a context snapshot (boards, groups, selection, undo/redo depth, platform).
- `ShortcutRow = { section, label, chips }` for shortcut-sheet-only bindings (Del, Esc, …).
- **Drift guard:** `resolveCanvasKeyAction` stays the untouched, unit-tested key dispatcher. A new
  unit test feeds each registry chip that claims a canvas chord into `resolveCanvasKeyAction` and
  asserts it resolves to the matching action kind — the chips can't silently drift from the real
  keymap.
- Future MCP/agent verbs get a section in this registry; nothing else changes.

## Interaction contract

- **Open:** Ctrl/⌘+K. Fires even while typing in canvas inputs (Linear/VS Code convention — the
  chord is never text entry). A focused xterm keeps Ctrl+K for the agent automatically (xterm
  `stopPropagation()`s keydown, so the window listener never sees it) — this is desired and gets a
  shortcuts-view row. `?` (bare key, `shouldFireCameraShortcut` gate so it can't fire from inputs/
  boards) opens straight to the shortcuts view.
- **Close:** Esc · scrim pointerdown · running a verb. Focus restores to the prior element
  (Modal's contract).
- **Esc layering** (the order that must not break): full-view capture listener yields first to
  `[data-confirm-active]` (BUG-005 — unchanged, still wins over everything), **then new: yields to
  `[data-palette-open]`** so Esc bubbles to the palette's own listener and closes it; only then
  does Esc exit full view. One Esc = one layer.
- **Keyboard:** input keeps DOM focus the whole time (combobox pattern, `aria-activedescendant`);
  ↑/↓ move the active row (wrap), Home/End jump, Enter runs, Tab is trapped (Modal). Pointer hover
  moves the active row; click runs.
- **Search:** case-insensitive word-prefix + subsequence match over `title + keywords`, simple
  score (no new dependency). Empty query = full grouped list (the discoverability state). No-match
  state: "No matching commands" in `--text-3`.
- **ADR 0002:** while open, the palette detaches live native previews exactly like `Menu` — the
  token-keyed `previewStore.setMenuOpen(useId(), true/false)` pair. With every view detached to
  its snapshot, no exclusion-zone work is needed.
- **Mid-dispatch listener class:** the global Ctrl+K/`?` listener registers once and reads state
  through refs (the D1-B/D1-C lesson; memory: mid-dispatch-listener-removal).

## Visual design (the artifact renders this)

Built on the D1-B `Modal` primitive (scrim `--scrim`, portal, focus trap/restore, Esc) with
`cardStyle` placing the card top-center (`place-self: start center; margin-top: 16vh`).

- **Island:** 560px wide, max-height 420px; `--surface-raised`, 1px `--border-subtle`,
  `--r-board` (8px), `--shadow-pop`. No glass, no gradient, flat per contract.
- **Search row:** 40px; ⌕ glyph `--text-3`; transparent input, `--fs-body` 13px `--text`,
  placeholder "Type a command or search…" `--text-3`; hairline bottom border `--border-subtle`;
  `esc` kbd chip right.
- **Sections:** `t-micro` style — 10px/500 uppercase, `--text-3`, tracking 0.06em.
- **Rows:** 30px, `--r-ctl`; 16px type glyph `--text-3`; title 13px `--text-2`; right-aligned
  shortcut chips = the `.fullview-hint kbd` recipe (mono 11, `--surface` bg, 1px `--border`,
  radius 4). **Active row:** `--accent-wash` bg, title `--text`, glyph `--accent` — the same
  active grammar as `.pl-tt-btn.is-active`. Hover (non-active): `--surface-overlay`.
- **Footer:** 28px, top hairline; mono `--fs-meta` `--text-3`: `↑↓ navigate · ↵ run · esc close`
  left, `ctrl K` chip right.
- **Shortcuts view:** same island; header row "Keyboard shortcuts" (`--fs-h` 15/600) with a
  `← back` affordance (Backspace on empty query also returns); rows = label left (`--text-2`),
  chips right; section labels as above. Single column (the island stays 560px).
- **Motion:** 120ms ease-out fade/translate-in (≤4px), reduced-motion → instant. Scrim is Modal's.

## Files + ratchet

All new UI in `src/renderer/src/canvas/palette/` (`CommandPalette.tsx`, `commandRegistry.ts`,
`paletteSearch.ts` + tests). Wiring: a thin `usePalette` hook + one mount point inside Canvas's
ReactFlow provider (the registry needs `rf`). Canvas.tsx is pinned at 779 code lines — if wiring
trips the pin, pay with a verbatim extraction (D3-A/B precedent). AppChrome is not touched unless
the plan finds a cheaper mount there.

## Test plan (sketch — full plan after sign-off)

Unit: registry visibility predicates · search scoring · chip↔resolver drift guard · mac chip
display. Integration: open/filter/run against a store with boards+groups. e2e (real input,
`sendInputEvent`): Ctrl+K opens · type-to-filter · Enter runs a verb (board created) · Esc closes
and restores focus · Esc layering with full view open (palette closes first, full view second) ·
`?` opens shortcuts view · open with a live preview → native view detaches (snapshot visible).
