# Settings redesign — Tile launcher (impl plan)

**Branch:** `feat/settings-tiles` · **Base:** `main` @ `5e62f8b` · **Date:** 2026-07-04
**Design sign-off:** APPROVED (3-direction mock; user picked **Tiles + standard scrim**).
Design reference: `./design-mock.html` (open in a browser; Style→Tiles). Artifact `a50f6722`.

## Goal

Reshape the LLM/Settings modal from a **single ~380px scrolling column** into a **windowed
tile-launcher panel**: a category grid → click a tile → slide to that section's detail pane with a
`‹ Settings` back chevron. Windowed over the live canvas (boards/wallpaper visible behind), on the
existing shared `Modal`.

## Non-goals (scope fence)

- **No new settings features.** Only reshape/relocate what already exists.
- **No "Add MCP server".** Does not exist today; it is its own future session
  (memory `mcp-add-server-feature`). The MCP tile here is read-only / "coming" — **no fake Add button.**
- **No schema change.** Settings persist via existing IPC (`llm.*`, `recap.*`, `orchestration.*`,
  `voice.*`) + `userData`, NOT `canvas.json`. Nothing touches `PATCHABLE_KEYS`.
- **No scrim change.** `--scrim` is already `0.5` (= "standard"). The mock's "light 0.2" was a
  mock-only override; production keeps the token. Nothing to change.

## Current state

- `src/renderer/src/canvas/SettingsModal.tsx` — one component, single column on shared `Modal`
  (`cardStyle` width 380, maxHeight 86vh, scroll). Sections stacked: Account · Context·LLM · Terminal
  · Voice (`SettingsVoiceSection`) · Agent orchestration. Opened from `AppChrome.tsx` (3 call sites),
  `zIndex={300}`.
- `src/renderer/src/canvas/Modal.tsx` — shared scrim/portal/Esc/focus-trap. `cardStyle` override is
  the supported per-caller knob. Esc = bubble-phase window listener; focus trap is card-scoped.
- Existing pieces to REUSE, not rebuild: `AccountSection` (in SettingsModal), `SettingsVoiceSection`,
  `BackdropPicker.tsx` (→ Appearance tile), `AccountAvatar`, the orchestration row + spawn-cap field,
  the LLM provider/model/key/max-calls form, `Icon.tsx`.
- Tests that will move: `SettingsModal.test.tsx`, `SettingsModal.orchestration.test.tsx`,
  and `modal.e2e.ts` (@chrome voice-section test opens Settings). These currently assert controls are
  immediately visible — after the reshape they must **navigate into the tile first.** This is the main cost.

## Architecture

- **Keep the shared `Modal`.** Widen `cardStyle` to the windowed panel (~`min(660px,93vw)` ×
  `min(560px,82vh)`), keep `zIndex={300}`, keep `closeDisabled={busy}` semantics.
- **Two-layer track inside the card:** `home` (tile grid) + `detail` (active section), a flex track
  width 200% with `translateX(-50%)` when drilled (matches the mock). `prefers-reduced-motion` →
  no slide (instant swap).
- **Section registry** (`settings/sections.tsx` or similar): `{ id, label, icon, group, Component }`.
  Each `Component` is the section's detail body, rendering the EXISTING controls + wiring. Groups:
  You (Account, Billing) · Application (Appearance, Terminal, Voice) · Agents & AI (Context·LLM,
  Orchestration, MCP) · System (About).
- **State:** `activeSection: string | null` local to the panel (`null` = home). Not persisted.
- **Focus / keyboard (extends the Modal contract, handled in the panel):**
  - Drill → move focus to the detail's back button (or first control); Back → restore focus to the
    originating tile.
  - `Esc`: if drilled → go back (don't close); if home → close. (Layer the panel's own keydown ABOVE
    Modal's Esc, or pass a guard — Modal's Esc is bubble-phase, so a panel handler that
    `stopPropagation()`s when drilled is enough.)
  - Modal's card-scoped focus trap keeps working (the track is inside the card).
- **Per-section wiring is unchanged** — same IPC calls, same busy/error handling, same
  cancellation-guard patterns already in `SettingsModal.tsx` (BUG-007/029/031/065). Save/Cancel stay
  where they belong (LLM has Save; toggles are immediate-apply, per the voice-section precedent).

## Section content (existing → tile)

| Tile | Group | Content (all exists today) |
|---|---|---|
| Account | You | `AccountSection` (profile/plan/session/sign-out) |
| Billing | You | plan badge + "Manage subscription" (disabled until Phase 2) — same as today's stub |
| Appearance | Application | mount `BackdropPicker` (wallpaper/dim/saturation) |
| Terminal | Application | recap-consent toggle (existing) |
| Voice | Application | `SettingsVoiceSection` (renders null w/o `window.api.voice`) |
| Context·LLM | Agents & AI | provider/model/baseUrl/key/max-calls + Save/Clear |
| Orchestration | Agents & AI | orchestration toggle + Sync + spawn-cap field |
| MCP | Agents & AI | **read-only:** Sync-provisioner status (what exists) + "Add external server — coming" note. NO add button. |
| About | System | version + updates (Phase-5 auto-update surface may still be stubbed) |

> **Open decision for build:** MCP as its own tile (read-only/coming) vs folded into Orchestration.
> Default = keep the tile, read-only, pointing at the future session.

## Build sequence (each step runnable + committed)

1. **Scaffold** — new `SettingsPanel` on the shared `Modal`: tile grid (home) + drill shell (empty
   detail), section registry (labels/icons/groups), slide + reduced-motion. Wire open from
   `AppChrome` (swap the component; trigger unchanged). Runnable, tiles navigate, detail empty.
2. **Port content** — move each section's existing controls/wiring into its detail `Component`
   (reuse `AccountSection`/`SettingsVoiceSection`/`BackdropPicker`/orchestration/LLM). MCP + Billing +
   About = their existing/stub content.
3. **Focus + a11y + responsive** — drill/back focus, Esc-back-then-close, back-button aria, tiles as
   `<button>`, small-viewport behavior (grid scrolls; consider full-height on short screens).
4. **Tests** — update `SettingsModal.test.tsx` + `.orchestration.test.tsx` to navigate into a tile
   before asserting; add tile-nav + drill/back + Esc-layering tests. Update `modal.e2e.ts` voice/
   orchestration paths to open the tile; add a `@chrome` tiles-nav e2e.
5. **Verify** — manual dev check (title-stamped `CANVAS_DEV_TITLE='PR#NNN settings-tiles'`), then the
   FULL e2e matrix at the pre-merge gate (mandatory, both legs).

## Risks / notes

- **Hot file.** `SettingsModal.tsx` was just touched by the voice epic (#300, merged — so its
  `SettingsVoiceSection` mount is on `main`) and the **parked `feat/billing` lane touches the account
  section**. Billing is blocked on external accounts, so no live conflict now, but coordinate before
  billing unparks (it edits the same file).
- **Test churn is the real cost**, not the UI. Budget for it in step 4.
- No native/deps change → worktree junction is fine, no rebuild.

## Done when

Tiles panel ships behind the existing Settings trigger, all sections reachable + functional, standard
scrim over the live canvas, unit + full e2e matrix green, manual dev check passed, MCP add-server
still cleanly deferred.
