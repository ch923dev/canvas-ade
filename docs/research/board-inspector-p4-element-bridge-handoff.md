# P4 — Planning **element bridge** (Board Inspector epic) · fresh-session handoff

> **Bootstrap residue.** This doc exists to launch a fresh session on P4. Once you have branched
> and read it, **delete it in your first feature commit** (same as the P3 handoff, which was
> committed on the umbrella at `53c84763` then deleted). Its residue is the build-history line.

## 0. TL;DR

The Board Inspector morphs by board **type** (P0–P3). P4 makes the **Planning** inspector also morph
by the **selected element(s)** on that board: select a note/text/arrow/stroke/checklist/etc. and the
inspector grows an **Element** section with that element's controls — typography, tint, lock,
group/ungroup, align/distribute, duplicate, delete, send-to-board. These controls **already exist**
today, split across the on-board `TextToolbar` (typography) and the right-click `ElementContextMenu`
(everything else). P4 surfaces them in the always-visible Inspector, keyed off element selection.

**The pleasant surprise:** no new selection plumbing is needed (see §3). The hard constraint: the
**666 max-lines cap on `PlanningBoard.tsx`** (currently ~653 counted). Do the work in
`PlanningInspector.tsx` / a new `planning/inspector/` sub-module; only thread props through the board.

## 1. Where P4 sits

Epic = `feat/board-inspector-umbrella`. Each phase branches OFF it, PRs INTO it; umbrella → `main`
ONCE at the end with the full e2e matrix. Umbrella tip when this was written: **`8745a012`**
(P0 shell · P0.5 arch+Terminal · P1 Browser · P2 Command/DataFlow/File · **P3 Planning tools ✅**).

- **P3 (done):** MOVED the 8-tool palette off-board into the inspector (`PlanningInspector.tsx`,
  Tools grid + Canvas section). Deleted `PlanningToolbar.tsx`. Bare-letter shortcuts stay always-on.
- **P4 (this):** element bridge — inspector morphs to the selected element's controls.
- **P5 (next):** polish.

## 2. Branch + setup

```
# from the board-inspector worktree, on feat/board-inspector-umbrella @ 8745a012 (or newer)
git fetch origin && git checkout feat/board-inspector-umbrella && git pull
git switch -c feat/board-inspector-p4-element-bridge
# node 22 via nvm — node 25 default skews vitest (localStorage shadow)
export PATH="/c/nvm4w/nodejs:$PATH"    # then `corepack pnpm ...`
```

**BEFORE any code: produce a design mock** of the Planning inspector's Element section and get the
maintainer's sign-off (CLAUDE.md § *Design artifact before code*). Reuse the exact tokens from
`src/renderer/src/index.css` + the existing inspector classes; screenshot it. Mirror how P3 did it:
`docs/research/mocks/board-inspector-planning-mock.{html,png}` is the reference for the medium.
Surface the open decisions in §5 with the mock.

## 3. Architecture — the bridge needs NO new store

`PlanningInspector` is `createPortal`-ed from **inside** `PlanningBoard`'s React subtree into the
shell's slot (`useInspectorSlot(board.id)` → `inspectorSlotStore`). It renders in the shell's DOM but
lives in the board's tree — so **it already has access to everything PlanningBoard has**. Today
`PlanningBoard.tsx:594` passes it only `{board, tool, snapEnabled, onPickTool, onToggleSnap}`.

P4 threads MORE existing props into that same portal call — no new cross-tree channel:

| Inspector needs | Already exists in PlanningBoard as | Source |
|---|---|---|
| the selected element ids | `selectedIds` (`useState`, line ~109) | board-local |
| the elements | `elements` / `viewElements` | props / `usePlanningViewElements` |
| typography patch | `onTextPatch(id, TextStylePatch)` (line ~262) | `TextToolbar` uses it |
| note tint | `setNoteTint` | `elements.ts`, context menu uses it |
| lock/group/ungroup/duplicate/delete | `buildContextMenuEntries` deps (`beginChange`/`commit`/`setSelectedIds`/`clearSel`/`newId`) | `contextMenuEntries.ts` |
| align/distribute | `alignElements`/`distributeElements` (need `wb` + `measured`) | `align.ts` |
| send-to-board | `onOpenSendTo` | `useSendToBoard` |

So the Element section is a presentation layer over callbacks the board already owns. This mirrors P3
(the Tools grid drives the board's existing `setTool`) and the whole-epic pattern: **composition, not
new state**. The reveal is unchanged — the inspector shows whenever the board is selected; the Element
section is a *conditional child* rendered when `selectedIds.size > 0`.

## 4. Files (expected)

- **`planning/PlanningInspector.tsx`** — add an **Element** section (conditional on `selectedIds`).
  Morph by selected kind(s): homogeneous text → typography; homogeneous note → tint; any selection →
  lock/group/duplicate/delete/send-to-board/align/distribute (align needs ≥2, distribute ≥3).
- **`planning/inspector/…`** (NEW sub-module, likely) — if the Element section is big, split the
  per-kind control clusters out (e.g. `ElementTypographyControls.tsx`, `ElementArrangeControls.tsx`)
  so neither `PlanningInspector` nor `PlanningBoard` bloats. Reuse `inspector/primitives.tsx`
  (Section/Row/Segmented/Toggle/Swatch/Action) — add primitives there if a control has no home yet.
- **`PlanningBoard.tsx`** — thread the extra props into the `PlanningInspector` portal call ONLY.
  **Budget: max-lines 666 (eslint.config.mjs:284), ~653 now.** If prop-threading + any new memo
  pushes it over, extract (e.g. hoist the selected-element/measured derivation into a small hook like
  `usePlanningViewElements` already did, or move the context-menu-deps assembly into a helper).
- **`styles/chrome/boardinspector.css`** — token-driven classes only (STYLE-02), like P3's
  `.ca-inspector-toolgrid`.
- Tests: unit for the new inspector section (kinds → controls, patch wiring, multi-select gating);
  an `@planning` case in `e2e/boardInspector.e2e.ts` (select a text element → typography controls
  appear in the inspector → a patch round-trips through the real store, board stays selected).

## 5. Open decisions — surface these WITH the mock (do not pre-decide)

1. **Scope: no-schema v1 vs schema-touching.** P4-v1 = re-home the **existing** controls only (no
   schema bump; ships fast; recommended). The reference-image extras — **stroke color/width, opacity,
   z-order/reorder** — are NEW props. Per ADR 0007 an *optional* element field is **additive →
   `schemaVersion++` only, `minReaderVersion` unchanged** (NOT a floor bump; the older
   `board-inspector-redesign` note said "minReaderVersion bump" — that's over-cautious for optional
   props). z-order via array reordering needs **no** schema change at all. **Recommend:** ship v1
   no-schema first; put the new props behind an explicit P4b (or later) so the schema touch is its own
   reviewable change. Confirm with the maintainer.
2. **MOVE vs mirror vs additive for `TextToolbar`.** P3 MOVED (deleted the on-board palette). The
   element controls are different: the right-click `ElementContextMenu` has muscle memory + fast
   reach — **recommend KEEP it** (additive; inspector mirrors, context menu stays). `TextToolbar`
   (on-board floating, follows the element, shows *while editing* before any grip-select) is the real
   question: MOVE it into the inspector (delete, like P3), MIRROR (both), or keep on-board + inspector
   additive? **Recommend mirror/additive for v1** (editing-time toolbar is contextual and useful);
   revisit a MOVE in P5 if it's redundant. Maintainer's call.
3. **Multi-select behavior.** Mixed-kind selection → show only the shared controls (lock, group,
   align/distribute, duplicate, delete, send-to-board); per-kind controls (typography, tint) appear
   only for a **homogeneous** selection. Confirm the empty/mixed states in the mock.
4. **Section placement + reveal.** Element section above or below the type sections (Tools/Canvas)?
   Does picking a *tool* (P3) and selecting an *element* ever fight for the panel? (They shouldn't —
   tool pick clears element selection via `clearSel`; element selection happens with the select tool.)
   Show the empty state (board selected, no element) in the mock.

## 6. Constraints / gotchas (do not re-learn)

- **PR into `feat/board-inspector-umbrella`, NOT `main`.** Squash. Merge is **gated on the
  maintainer's explicit OK** after a **manual dev-check** in a title-stamped build
  (`$env:CANVAS_DEV_TITLE='PR#NNN P4 element bridge'; pnpm dev`).
- **gh account:** `gh auth switch --user ch923dev` before any push/merge (`ch-dev401` lacks perms).
- **Pre-push e2e gate:** touching `e2e/` auto-selects the **FULL matrix** (Windows + Linux Docker) —
  **Docker Desktop must be running** for the Linux leg. Renderer-only diffs are Windows-leg-only.
- **Full e2e matrix both legs is mandatory once at the pre-merge gate** (into the umbrella).
- **`env -u SSH_ASKPASS`** on the gitDiff-integration test / pushes from the Bash tool (else a
  simple-git guard false-fails `@terminal`).
- **Reviewer:** reply inline to each `[critical]`/`[warning]` with its disposition (the disposition
  loop). Nits under the summary need no reply.
- **Stale-base vs `origin/main` is EXPECTED** — this PR targets the umbrella. The umbrella→main
  rebase + full matrix is the **epic-end** step (after P5), done ONCE.
- Do NOT weaken process-model security; renderer-only change here anyway.

## 7. Definition of done

Mock signed off → element section built in `PlanningInspector` (+ sub-module if needed) → PlanningBoard
still under 666 → typecheck · lint(0) · format · unit green → `e2e/boardInspector.e2e.ts` `@planning`
element case green → full e2e matrix both legs at pre-push → live dev-check matches the mock → PR into
the umbrella (ch923dev) → babysit CI + disposition reviewer → **maintainer OK** → squash-merge →
delete branch → stamp merge SHA into the `board-inspector-redesign` memory → delete this handoff doc.
