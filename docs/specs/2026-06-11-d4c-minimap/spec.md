# D4-C — Wayfinding at scale: minimap island (spec)

> Lane: `feat/design-w4-wayfinding` · last lane of Wave D4 and of the 2026-06-10 design/UX
> audit umbrella. Decision-first per CLAUDE.md (design artifact before code).
>
> **Decision (user pick, 2026-06-11):** between the two side-by-side wireframes — (a) minimap
> island, (b) board list/outline — the user picked **(a) the minimap island**, with visibility
> **toggled + remembered** (hidden on first run; the toggle persists across sessions).
> The wireframe pair + rationale are preserved in the PR description.

## Why minimap (and not the board list)

D4-A's palette (`Ctrl+K → goto`) already gives **searchable named** navigation. The audit's
remaining gap is **spatial** ("at >10 boards spatial memory is the only nav aid", §2). A board
list duplicates palette-goto's named jump and the boards' own status words; the minimap is the
true complement (where am I / where is everything / teleport without knowing a name) and is
already the contract's optional island: DESIGN.md §8 — *"Bottom-right (optional): minimap —
`--surface-raised` rounded rect, board rects in `--border-strong`, viewport rect in `--accent`."*
React Flow v12 ships `<MiniMap>` (currently unimported), so the build is token theming + wiring.

## Contract

### Surface
- New `canvas/wayfinding/MinimapIsland.tsx` wrapping RF `<MiniMap>`, mounted **inside
  `<ReactFlow>`** in Canvas (needs the RF store for nodes/viewport). Hidden ⇒ returns `null`
  (no DOM, no exclusion zone, zero cost).
- Position: RF Panel **bottom-right** (the §8 slot; default `<MiniMap>` position), default RF
  size (~200×150). Audit button stays bottom-left; toasts stack **above** it (see below).
- Theming (index.css, on `.react-flow__minimap*` / the `--xy-minimap-*` vars RF exposes):
  island = `--surface-raised`, 1px `--border-subtle`, `--shadow-pop`, radius per island
  convention; board rects = `--border-strong` fill (uniform — calm, no type rainbow); the
  **selected** board's rect strokes `--accent` (RF adds `.selected`); mask = translucent
  void dim; viewport rect stroke = `--accent` ~1.5px. 120ms fade-in on show, gated under
  `prefers-reduced-motion`. `aria-label="Canvas minimap"` (RF renders it as the svg title).

### Interactions
- **Click a board rect → jump**: `onNodeClick` → the existing `focusBoardById`
  (useBoardKeyboardNav, D4-B) — the same camera-fit + dim path Enter/double-click/palette-goto
  use; `cameraAnim` 200ms, collapses to 0 under reduced-motion. `stopPropagation()` so the
  svg-level click below can't double-fire.
- **Click empty map → teleport**: `onClick(position)` → `rf.setCenter(position, current zoom,
  cameraAnim)`. No focus mode (no board).
- **Drag the viewport mask → live pan** (`pannable`); **wheel → zoom** (`zoomable`). Camera
  motion from the map flows through `useOnViewportChange` like any pan/zoom, so preview
  detach/snapshot + the #122 settled-zoom snap band apply unchanged.
- **No Esc interaction.** The minimap is persistent chrome (like the dock), not a transient
  layer — it does not join the Esc stack (confirm gate → palette → full view untouched).

### Toggle + persistence
- Bare **`M`** toggles (same grammar as `T` tidy / `F` focus-group / `1` / `0`): new
  `{ kind: 'toggleMinimap' }` in `resolveCanvasKeyAction`, guarded by `bareKeyAllowed`
  (`shouldFireCameraShortcut`) — never fires from xterm / planning well / inputs / traps.
- Palette verb **"Toggle minimap"** (Canvas section, chips `['M']`) + a `?`-sheet row; both
  feed the chip↔resolver **drift-guard test** (new claim).
- New `store/wayfindingStore.ts` (zustand): `minimapVisible` initialized **lazily** from
  localStorage (`hintDismissal.ts` discipline — no module cache, guarded, so the e2e harness's
  persistent userData stays resettable), `toggleMinimap()` writes back. App-level preference
  (NOT canvas.json — scene/session split).

### ADR 0002 (native-view occlusion)
- While visible, the island's rect joins the preview manager's chrome zones:
  `usePreviewManager.resolveChromeZones` reads `.react-flow__minimap`'s live DOM rect (the
  digest-panel/toast pattern), and a `minimapVisible` subscription joins the liveness-pass
  deps beside `toastCount` so show/hide re-runs the pass. Overlapping live previews demote
  to their HTML snapshots; nothing else changes.
- Toast coexistence: both live bottom-right. While the minimap is visible the toast island
  lifts above it (`.toast-island` modifier read from the store) so a toast never covers the
  map and the map never hides a toast.

### Out of scope (declined for v1)
- Board list/outline (the unpicked option — palette-goto covers named scan).
- Auto-show at >N boards (user picked plain toggled+remembered).
- Minimap node labels/status dots (calm; rects only, per §8).

## Files

| File | Change |
|---|---|
| `canvas/wayfinding/MinimapIsland.tsx` | NEW — themed `<MiniMap>` + jump/teleport handlers, null when hidden |
| `store/wayfindingStore.ts` (+test) | NEW — visibility + localStorage persistence |
| `canvas/hooks/useCanvasKeybindings.ts` (+test) | `m` → `toggleMinimap` action + dispatch dep |
| `canvas/palette/commandRegistry.ts` (+test) | verb + `?`-row + drift claim |
| `canvas/palette/usePaletteController.ts` | `toggleMinimap` verb adapter |
| `canvas/boards/usePreviewManager.ts` | minimap rect in `resolveChromeZones` + visibility dep |
| `canvas/Toast.tsx` + `index.css` | lift toast island while minimap visible |
| `canvas/Canvas.tsx` | mount + keybinding dep (ratchet 757/779 — stay under, extract if tripped) |
| `e2e/wayfinding.e2e.ts` | NEW — real-input toggle · node-click jump · preview demote · Esc layering · localStorage leading-reset |
| `docs/testing/MANUAL-CHECKS.md` | D4-C section |

This folder is deleted in the merge PR per doc lifecycle (build-history line + the PR
description carry the residue).
