# P4b — Planning element **appearance props** (Board Inspector epic) · fresh-session handoff

> **Bootstrap residue.** This doc exists to launch a fresh session on P4b. Once you have branched
> and read it, **delete it in your first feature commit** (same as the P4/P3 handoffs, which were
> committed on the umbrella then deleted in the phase's first commit). Its residue is the
> build-history line.

## 0. TL;DR

P4 re-homed the **existing** element controls into the inspector's Element section (no schema). P4b
adds the **new appearance props** that were deferred from P4 — the reference-image extras:

- **opacity** — a 0–1 element opacity (all kinds).
- **stroke** — stroke **color** + **width** for the line kinds (arrow, pen `stroke`); optionally the
  note border. (NOT text — text already has `color`; NOT a fill on everything.)
- **z-order** — bring-to-front / send-to-back / forward / backward. This is **array reordering**
  (`elements[]` order == paint order), so it needs **NO schema change at all**.

opacity + stroke are **NEW optional element fields** → per **ADR 0007** they are **ADDITIVE**: bump
`SCHEMA_VERSION` (writer) **only**, `MIN_READER_VERSION` (the compat floor) **UNCHANGED**. (The old
`board-inspector-redesign` memory said "minReaderVersion bump" — that is **over-cautious**; an
optional field defaulted-at-read is exactly the v7-typography / v16-terminal-theme pattern: writer
bump, floor stays. See §3.)

**This phase is bigger + riskier than P4** — P4 was pure re-home; P4b touches the **schema**, **every
card renderer** (they must READ the new props), and the **SVG export mirror**. Budget accordingly.

## 1. Where P4b sits

Epic = `feat/board-inspector-umbrella`. Each phase branches OFF it, PRs INTO it; umbrella → `main`
ONCE at the end with the full e2e matrix. **Umbrella tip when this was written: `117c245f`**
(P0 shell · P0.5 arch+Terminal · P1 Browser · P2 Command/DataFlow/File · P3 Planning tools · **P4
Planning element bridge ✅**).

- **P4 (done):** re-homed typography/tint + lock/group/align/distribute/duplicate/send/delete into an
  always-visible **Element** section (`planning/inspector/`). No schema.
- **P4b (this):** the schema-touching appearance props (opacity / stroke / z-order). Extends the P4
  sub-module + Element section.
- **P5 (after):** polish (collapse persistence, keyboard, MOVE-vs-mirror revisit for the TextToolbar).

## 2. Branch + setup

```
# from the board-inspector worktree, on feat/board-inspector-umbrella @ 117c245f (or newer)
git fetch origin && git checkout feat/board-inspector-umbrella && git pull
git switch -c feat/board-inspector-p4b-appearance-props
# node 22 via nvm — node 25 default skews vitest (localStorage shadow)
export PATH="/c/nvm4w/nodejs:$PATH"    # then `corepack pnpm ...`
```

**BEFORE any code: produce a design mock** of the Element section WITH the new controls (opacity
slider, stroke color+width, z-order buttons) and get the maintainer's sign-off (CLAUDE.md § *Design
artifact before code*). Extend the P4 mock: `docs/research/mocks/board-inspector-planning-element-mock.{html,png}`
(it already shows a greyed "P4b" panel — promote those controls to real). Surface §5's decisions.

## 3. Schema — the ADR 0007 mechanics (read carefully)

**Current on the umbrella:** `SCHEMA_VERSION = 16`, `MIN_READER_VERSION = 15` (in
`src/renderer/src/lib/boardSchemaVersion.ts`). opacity/stroke are additive optional fields:

- Add `opacity?: number` (+ `strokeColor?` / `strokeWidth?`) to **`ElementCommon`** (boardSchema.ts
  line ~196 — the shared base for all 9 kinds). All optional, **defaulted at read** (absent ⇒ 1 /
  the kind's current default), exactly like `TextElement.color` / `width` (v7/v8).
- Bump `SCHEMA_VERSION` **16 → 17**; add a **version-claim comment** + an **identity migration** entry
  (nothing to backfill — absent ⇒ default at render). Keep `MIN_READER_VERSION` **at 15** (additive →
  floor stays; an older reader ignores the unknown optional keys and they survive the
  `fromObject` structuredClone round-trip). Update the `boardSchema.test.ts` version-parity /
  MAIN-mirror lock-step (`projectStore.ts` hand-mirrors the constants — BUG-013/014).
- **z-order takes NO schema bump** (array reorder only).

> ### ⚠️ HAZARD — version collision at the umbrella→main rebase
> The umbrella is at `SCHEMA_VERSION 16`, but **`main` is already at `17`** (the MCP canvas-awareness
> epic's Kanban board type, a BREAKING bump → floor 17, landed on main as `772394f`). So P4b's `17`
> on the umbrella and main's `17` are **different v17s**. At the epic-end **umbrella→main rebase**
> (after P5), P4b's bump MUST be **re-sequenced to `18`** (additive, on top of Kanban's 17), and
> `MIN_READER_VERSION` becomes **17** (inherited from Kanban's breaking floor — P4b does NOT raise it).
> **Do the bump as `17` on the umbrella now**, but leave a prominent comment flagging the rebase
> re-number, and coordinate at epic-end. (This is the [[schema-forward-compat-adr0007]] worktree-skew
> class — do not let two branches silently claim the same version for different shapes.)

## 4. Files (expected)

- **`lib/boardSchema.ts`** — `opacity?`/`strokeColor?`/`strokeWidth?` on `ElementCommon`; `assertBoard`
  type-checks them (numbers / token strings) WITHOUT rejecting unknowns. **`lib/boardSchemaVersion.ts`**
  — bump + claim. **`boardSchema.test.ts`** — version parity. `projectStore.ts` (MAIN) mirror.
- **Card renderers must READ the props** (the real surface): `NoteCard`, `FreeText`,
  `WhiteboardSvg.tsx` (arrow + pen stroke — already uses `strokeWidth`/`stroke`), `ChecklistCard`,
  `ImageCard`, `DiagramCard`, `FileRefCard` → apply `opacity` (style/attr) + stroke color/width where
  meaningful. A missing prop must render **byte-identical to pre-P4b** (default-at-read).
- **Export mirror** (the R7 lesson — mirrors MUST stay in step): `whiteboardExport.ts` +
  `exportColors.ts` — serialize opacity/stroke into the standalone SVG (the export path can't read CSS
  vars; keep the literal mirror + its shape-guard test, like `textStyle` FAMILY/COLOR_EXPORT).
- **`planning/inspector/` (extend P4)**:
  - `elementModel.ts` — add common `opacity` / `strokeColor` / `strokeWidth` across the selection
    (null = indeterminate, same `common()` helper).
  - `usePlanningElementInspector.ts` — new batch actions (setOpacity / setStroke / z-order reorder),
    each ONE undo step with the live-read guard (mirror `applyTypography`). z-order reorder needs new
    **pure transforms in `elements.ts`** (`bringToFront`/`sendToBack`/`bringForward`/`sendBackward` on
    the `elements[]` array — none exist yet; paint order == array order).
  - `ElementInspectorSection.tsx` — an **Appearance** sub-block: Opacity (reuse `InspectorSlider`),
    Stroke color (reuse `InspectorSwatches`) + width (a stepper or segmented), Z-order (reuse
    `InspectorIconButtons` / actions). Gate by kind: stroke only for line kinds; opacity for all.
- **`styles/chrome/boardinspector.css`** — token-driven only (STYLE-02); reuse existing classes.
- Tests: unit (model common-opacity/stroke; the reorder transforms in `elements.test.ts`; section
  renders + wires the new controls) + an `@planning` e2e case in `boardInspector.e2e.ts` (set opacity
  or bring-to-front → round-trips through the real store + persists).

## 5. Open decisions — surface these WITH the mock (do not pre-decide)

1. **Which kinds get stroke?** Line kinds only (arrow + pen `stroke`) — recommended — vs also the note
   border (notes already have `tint` fill+edge; a separate stroke would compete). **Opacity = all
   kinds** (simple, uniform). Confirm the kind→control matrix.
2. **Stroke-width control shape** — a −/+ stepper (px) vs a 3-way S/M/L segmented (token, like font
   size). Segmented keeps it token-clean + export-portable; stepper is finer. Recommend **token
   segmented** for parity with typography.
3. **Z-order surface** — 4 buttons (front/back/forward/backward) vs 2 (front/back only). Recommend the
   **2-button** front/back (matches the common case; forward/backward are power-user, add later). All
   are array reorders — no schema.
4. **Opacity default + range** — 1.0 default, 0–1; a floor (e.g. min 0.1) so an element can't become
   invisible-and-unfindable? Recommend **min 0.1**. Confirm.
5. **Section placement** — a new **Appearance** sub-block inside the existing Element section, or its
   own collapsible section? Recommend a sub-block under the per-kind controls, above Arrange.

## 6. Constraints / gotchas (do not re-learn)

- **PR into `feat/board-inspector-umbrella`, NOT `main`.** Squash. Merge is gated on the maintainer's
  explicit OK after a **title-stamped dev-check** (`$env:CANVAS_DEV_TITLE='PR#NNN P4b appearance'; pnpm dev`).
- **`PlanningBoard.tsx` is capped at max-lines 666** (`eslint.config.mjs`). It's tight — thread props
  only; do the work in `planning/inspector/`. (P4 already moved the menu-deps assembly into the hook.)
- **⚠️ mcp shared-tree skew (still active until the mcp-canvas-awareness epic reinstalls everywhere):**
  the shared `node_modules` junction holds `@expanse-ade/mcp@0.18.0-rc.5` while the umbrella pins
  `^0.17.0`, so **`typecheck:node` (`mcpOrchestrator.ts`) + `appModelDrift.test.ts` (F25) FAIL LOCALLY
  ONLY** — CI clean-install (0.17.x) is green. Do NOT "fix" it in a renderer PR; do NOT `pnpm install`
  from the worktree (recreates the shared tree). **The skew MASKS your own e2e/main typecheck errors**
  (they print first, `tail` hides them) → **grep the FULL `typecheck:node` output filtered by
  `grep -v mcpOrchestrator`, never `tail` it.** See [[worktree-junction-stale-deps]].
- **Full e2e matrix both legs is mandatory once at the pre-merge gate** (into the umbrella); touching
  `e2e/` auto-selects it. **Docker Desktop must be running** for the Linux leg. Native leg has known
  flakes (OSR/preview "Target page closed") — rerun the single spec to confirm ([[e2e-scrollback-victim-osr-teardown-flake]]).
- **`env -u SSH_ASKPASS`** on pushes from the Bash tool; **`gh auth switch --user ch923dev`** before
  push/merge (`ch-dev401` lacks perms; ch923dev is usually already active).
- **Reviewer:** reply inline to each `[critical]`/`[warning]` with its disposition. Nits need no reply.
- **Run the FULL cheap trio locally before EVERY push** (`--no-verify` is needed only because the mcp
  skew breaks the pre-commit typecheck) — the two CI round-trips P4 ate were a bad cast + an
  unformatted test file that the bypassed pre-commit would have caught.
- **Stale-base vs `origin/main` is EXPECTED** — this PR targets the umbrella. The umbrella→main rebase
  + full matrix (+ the §3 schema re-number) is the epic-end step, done ONCE after P5.

## 7. Definition of done

Mock signed off → schema bumped (v17-on-umbrella, additive, floor stays 15) + identity migration +
parity test → props read by every card renderer (byte-identical when absent) + export mirror updated →
Element-section Appearance controls built (opacity/stroke/z-order) → typecheck(web + filtered node) ·
lint(0) · format · unit green → `@planning` e2e round-trips a new prop → full e2e matrix both legs at
pre-push → live dev-check matches the mock → PR into the umbrella (ch923dev) → babysit CI + disposition
reviewer → **maintainer OK** → squash-merge → delete branch → stamp merge SHA into the
`board-inspector-redesign` memory (note the schema re-number owed at epic-end) → delete this handoff.
