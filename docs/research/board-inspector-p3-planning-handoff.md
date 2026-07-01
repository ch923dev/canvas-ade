# Handoff — Board Inspector **P3: PlanningInspector**

**For:** a fresh session picking up P3 of the Board Inspector epic.
**Branch to create:** `feat/board-inspector-p3-planning`, **off** `feat/board-inspector-umbrella`
(current umbrella tip `1d27aea2` = P0 #262/#264 + P1 #271 + P2 #272). **PR into the umbrella**, not `main`.
**Delete this handoff doc in the P3 merge** (doc-lifecycle — it is bootstrap-only residue).

> ⚠️ Read the design-decision section FIRST. P3 is **not** a pure additive copy like P0.5/P1/P2 —
> the signed-off direction is to **MOVE** the Planning tool palette off the board into the Inspector.
> That is a bigger, higher-regression change and it needs a **mock + user sign-off before any code**
> (CLAUDE.md › "Design artifact before code"). Do not start coding until the user signs off the mock.

---

## 1. What the epic is (context)

A per-board "Board Inspector" — one screen-space **compact popover, docked left, reveal-on-select**,
rendered as app chrome OUTSIDE the React Flow transform. It retargets to the single selected board and
shows that board's controls. Architecture = **composition, not inheritance**:

- **Shell** `src/renderer/src/canvas/BoardInspector.tsx` — owns identity head (TypeGlyph · type tag ·
  Jump-to-board · **`board.title`**) + a **Duplicate** foot + a content **slot** (`.ca-inspector-body`).
  Reveal = `inspectorRevealed(inspectorEligible(selCount, zoom))` (single selection, zoom ≥ 0.4).
  It reads `canvasStore` purely; NEVER writes selection. The head shows `board.title` uniformly (no
  per-type status line, no per-type title — a known limitation; P2 File shows "File" not the filename).
- **Slot channel** `canvas/inspector/inspectorSlotStore.ts` — the shell publishes `{slotEl, activeBoardId}`;
  the single eligible board `createPortal`s its own `<XInspector>` into the slot via
  `useInspectorSlot(board.id)` (returns the slot node iff this board is active, else null).
- **Primitives** `canvas/inspector/primitives.tsx` — the shared toolkit EVERY per-type inspector
  composes from: `InspectorSection` (collapsible, `defaultOpen`), `InspectorRow` (label + control),
  `InspectorStepper`, `InspectorAction` (icon/primary/danger/active/disabled/kbd/dataTest),
  `InspectorMeta` (mono key/value), `InspectorSegmented<T>` (radiogroup, `fill`), `InspectorToggle`
  (switch), `InspectorSlider` (0–1 range). **STYLE-02:** components are structure+behaviour only —
  colours live in `styles/chrome/boardinspector.css` (token-driven, no raw hex/rgba).
- **Styles** `styles/chrome/boardinspector.css` — all inspector CSS. P2 added `.ca-inspector-chips`
  (chip cluster) + `.ca-inspector-pbar`/`-pfill` (progress bar). Reuse `.ca-inspector-status[data-tone]`
  for status chips.

**Shipped consumers to copy the pattern from (READ THESE):**
- `boards/terminal/TerminalInspector.tsx` (P0.5) — Appearance/Session/Configuration/Linking.
- `boards/browser/BrowserInspector.tsx` (P1) — Segmented + Toggle + Slider + nav cluster + status chip.
- `boards/command/CommandInspector.tsx`, `boards/dataflow/DataFlowInspector.tsx`,
  `boards/file/FileInspector.tsx` (P2) — Command singleton, DataFlow adaptive states, File.

Each board wires it identically: `const slot = useInspectorSlot(board.id)`, then
`return (<>{slot && createPortal(<XInspector .../>, slot)}<BoardFrame …>…</BoardFrame></>)`.
Presentation-only: reuse the board's EXACT existing handlers; zero lifted state, zero duplication.

---

## 2. P3 scope — the Planning tool palette

Today (`boards/planning/PlanningToolbar.tsx`, rendered in the BoardFrame **action slot**, selected-only):

- **8 tools** (`boards/planning/tools.ts` › `TOOL_META`, the single source of truth):
  `select`(s) · `note`(n) · `text`(**x**) · `check`(c) · `diagram`(d) · `arrow`(a) · `pen`(p) · `erase`(e).
  Bare-letter keys, deliberately avoiding `t`/`1`/`0` (global canvas bindings). `shortcutTool()` is the
  always-on keyboard path (unit-tested).
- **Snap toggle** (magnet icon).
- **Export** (`ExportPopover` — a popover: PNG/SVG export).

Tool + snap state is **board-local `useState`** in `PlanningBoard.tsx` (`const [tool,setTool]`,
`const [snapEnabled,setSnapEnabled]`), threaded into `PlanningToolbar` AND `usePlanningKeyboard`.
A separate floating **`TextToolbar`** (per-element typography, appears on text-element selection) is
**element-contextual → OUT of P3 scope** (it is not board chrome; leave it). Same for
`ElementContextMenu`, checklist item controls, etc.

**The P3 deliverable:** `boards/planning/PlanningInspector.tsx` surfacing the 8-tool palette + snap +
export in the popover, portaled from `PlanningBoard`, reusing its exact `setTool`/`setSnapEnabled`/
export handlers.

---

## 3. DECISIONS TO RESOLVE WITH THE USER (mock first, before code)

1. **MOVE vs ADDITIVE.** The 2026-06-26 sign-off said the palette **MOVES into the Inspector** (removed
   from the on-board action slot). P0.5/P1/P2 were all *additive* (kept on-board). MOVE is the bigger,
   riskier change. **Recommendation:** confirm MOVE with the user but consider keeping the on-board
   palette as a fallback for the first cut (additive), then remove it in a follow-up once the Inspector
   palette is proven — lower regression risk. Get an explicit decision.
2. **Palette layout in the popover.** Options to mock: (a) a compact **icon grid** (8 tools, 4×2, active
   = accent-wash — closest to today's cluster); (b) `InspectorSegmented`-style rows; (c) labelled
   `InspectorAction` rows with the shortcut letter as `kbd`. The icon grid is the most space-efficient
   and matches muscle memory — likely needs one small new CSS block (`.ca-inspector-toolgrid`).
3. **Auto-hide vs continuous drawing (the known tension).** The Inspector reveals on selection and hides
   on deselect. While drawing, the Planning board stays SELECTED → the Inspector stays revealed, so
   there is likely **no** mid-draw hide problem. **Confirm:** (a) the bare-letter shortcuts REMAIN the
   always-on fast path regardless of the Inspector (they must); (b) picking a tool in the Inspector must
   not deselect the board. State this explicitly in the mock so the user signs off the interaction.
4. **Snap → `InspectorToggle`. Export → `InspectorAction` that opens the existing `ExportPopover`** (or
   re-home the export UI as inspector rows). Decide whether Export stays a popover or becomes inline.

Produce the artifact as a throwaway HTML/JSX mock built with the real `index.css` tokens (or extend
`docs/research/mocks/board-inspector-popover-mock.html` with a Planning hero, screenshot it, and get the
nod) — same as P1/P2 did. **No UI lands code-first.**

---

## 4. Hard constraint — the max-lines ratchet

**`PlanningBoard.tsx` is AT its per-file cap of 666** (eslint override in `eslint.config.mjs`, skipBlank
+skipComments). Verify: `pnpm exec eslint src/renderer/src/canvas/boards/PlanningBoard.tsx --rule
'{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'`. **Any** portal wiring
breaches it, so P3 MUST offset:
- If **MOVE**: removing the on-board `PlanningToolbar` from the `actions` slot frees lines — may be near
  net-neutral. Still verify ≤ 666.
- If **ADDITIVE**: you must extract a chunk out of PlanningBoard (e.g. the `actions` assembly, or another
  cluster) into a sibling file, exactly as P2 did with `file/FileActions.tsx` (689→590) and as
  `PlanningToolbar`/`TerminalActions` already did. Pins move DOWNWARD only — do not raise the 666.

---

## 5. Build + verify + ship recipe (same as P1/P2)

Environment: node **22.17** (`nvm`, NOT the default 25 — Node 25 skews some unit tests), `corepack pnpm`.
Docker Desktop must be **running** for the Linux e2e leg.

1. `git fetch origin && git checkout feat/board-inspector-umbrella && git checkout -b feat/board-inspector-p3-planning`.
2. Mock → **user sign-off** → then implement (portal wiring + `PlanningInspector.tsx` + CSS + extraction).
3. Add an e2e case to `e2e/boardInspector.e2e.ts` (seed `planning`, select, `setZoom(1)`, **poll** a
   `data-test` probe BEFORE reading section labels — the shell reveals a tick before the portal mounts;
   P2's DataFlow case failed once on exactly this race). Round-trip a tool pick through the real store.
4. Gate: `pnpm typecheck` · `pnpm lint` (0 errors) · `pnpm format:check` · `env -u SSH_ASKPASS pnpm test`
   (the `SSH_ASKPASS` unset avoids the gitDiff-integration false-fail from the Bash tool).
5. **Manual dev check** — capture the Planning inspector from the running app (a throwaway `_electron`
   spec that seeds a planning board, selects it, and `.screenshot()`s `[data-test="board-inspector"]`;
   see how P2 did it) and confirm it matches the signed-off mock. Stamp the window title
   (`$env:CANVAS_DEV_TITLE='PR#NNN P3'`).
6. Push. The pre-push hook auto-selects the **FULL matrix** (the diff touches `e2e/`). Push in the
   background to dodge the 10-min foreground cap; verify `PUSH_EXIT=0` + `git ls-remote`.
   - **Flake note:** a manual `pnpm test:e2e:matrix` runs **retries:0**, so the documented
     `osrCropSupersample → terminalTheme` victim pair can hard-fail under full-suite load (context-close
     cascade — see memory `e2e-scrollback-victim-osr-teardown-flake`). Prove flake by running those two
     specs alone (they pass); the **pre-push hook uses retries:2** and recovers them. `&&` in
     `test:e2e:matrix` short-circuits the Linux leg if Windows fails.
7. Open the PR **into `feat/board-inspector-umbrella`** (`gh auth switch --user ch923dev` first — the
   default account lacks push). Babysit CI (check · analyze · CodeQL · claude-review). **Reply inline to
   EVERY `[critical]`/`[warning]` reviewer comment** (disposition-aware reviewer — a bare summary is not
   enough; nits need no reply). Merge with `gh pr merge <n> --squash --delete-branch` once green + user OK.
8. After merge: repoint the worktree (`git checkout feat/board-inspector-umbrella && git fetch &&
   git reset --hard origin/feat/board-inspector-umbrella`), delete the P3 branch, update the
   `board-inspector-redesign` memory.

**No schema change expected** (tool/snap are ephemeral session state, never serialized). If the mock adds
NEW persisted element props (stroke/opacity/z-index were floated as later, schema-touching work), that is
**out of P3** unless explicitly pulled in with a `minReaderVersion` bump (ADR 0007).

---

## 6. After P3 — the rest of the epic

P4 = Planning **element bridge** (per-element props in the Inspector when an element is selected). P5 =
polish (collapse-state persistence, etc.). **Umbrella → `main`** is the single final step once P3–P5
land: rebase `feat/board-inspector-umbrella` onto `origin/main` (currently behind — integration tip was
~`9f14d3f`/#270 at handoff time; re-check), run the FULL e2e matrix both legs at the pre-merge gate, then
merge. See memory `board-inspector-redesign` for the running epic log.
