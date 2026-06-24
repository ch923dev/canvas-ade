# Planning-MCP Phase 2a — agent-declared sections (column control)

> Umbrella `feat/planning-mcp-umbrella`. Phase 1 (#242) shipped content-estimated **masonry** so an
> agent plan never overlaps. But masonry balances by **height**, so a phase's checklist lands in
> whatever column is shortest → the placement reads "random" (user feedback, Image #5). The host
> can't infer logical grouping; only the agent knows it. Phase 2a lets the agent **declare** the
> columns.

## Decision (user-confirmed 2026-06-24)

**Per-element `section` tag.** Each agent element may carry an optional `section: string`. The host
groups elements by section value and renders **one column per section**, ordered left→right by each
section's **first appearance**, stacking each section's cards **top-to-bottom in array order**. The
checklist's own `title` heads its column (no separate header chrome in 2a).

```
add_planning_elements(boardId, [
  { kind:'note',      section:'Overview', text:'Goal: ship auth' },
  { kind:'checklist', section:'Setup', title:'Setup', items:[…] },
  { kind:'checklist', section:'Build', title:'Build', items:[…] },
  { kind:'checklist', section:'Test',  title:'Test',  items:[…] },
])

┌─Overview───┐ ┌─Setup──┐ ┌─Build──┐ ┌─Test──┐
│ Goal: ship │ │ ☐ env  │ │ ☐ api  │ │ ☐ unit│
│ auth flow  │ │ ☐ deps │ │ ☐ ui   │ │ ☐ e2e │
└────────────┘ └────────┘ └────────┘ └───────┘
```

### Layout rules
- **Trigger:** if **no** element carries a non-empty `section`, fall back to the Phase-1 **masonry**
  (unchanged — older agents + the shipped auto-layout keep working). Sectioned mode activates only
  when the agent opts in.
- **Grouping key** = `op.section ?? ''`. Columns are ordered by **first appearance** of each key
  (so an un-sectioned intro note that precedes the first section forms the leading `''` column).
- **Within a column:** array order, top-to-bottom (deterministic — NOT shortest-column). No
  rebalancing → no rebalance gaps; ragged column bottoms are expected (matches the target mock).
- **Column width** = the widest card in that section (independent per column).
- Board grows in both dims to fit via the existing `neededBoardWidth/neededBoardHeight` (unionBBox —
  layout-agnostic, no change needed).

### NOT persisted → NO schema bump
`section` is consumed at materialize-time to compute `x/y`; the stored `PlanningElement` keeps only
`x/y/w/h` (no `section` field). So this is a pure layout change — **no `schemaVersion` bump**, exactly
like Phase 1.

## Changes

### `@expanse-ade/mcp` (sibling repo) → publish **0.16.0**, bump app pin
- `constants.ts`: `MAX_PLANNING_SECTION = 60`.
- `server/tools/addPlanningElements.ts`: add `section: z.string().min(1).max(MAX_PLANNING_SECTION).optional()`
  to each of note/checklist/text/arrow/diagram specs; extend the tool description to teach sections.
  (Required: the SDK's zod parse **strips** unknown keys, so `section` must be in the schema or MAIN
  never sees it.)
- `orchestrator/Orchestrator.ts`: add `section?: string` to each `PlanningElementSpec` variant.
- Tests: section round-trips through the schema; absent `section` still valid.

### App MAIN
- `src/main/mcpPlanning.ts`: `MAX_PLANNING_SECTION = 60`; `buildOp` sanitizes `el.section` (single-line
  — strip newlines, reuse the control-char sanitizer, cap) and carries it on the `PlanningOp`;
  `renderPlanningConfirmBody` annotates each line with `[section]` when present (the human sees the
  column structure before approving — ADR 0003).
- `src/shared/mcpTypes.ts`: add `section?: string` to each `PlanningOp` variant.

### App renderer
- `src/renderer/src/store/planningMcpApply.ts`: split placement into `placeMasonry` (current) and
  `placeSectioned`; `materializePlanningOps` picks sectioned when any op has a non-empty `section`.
  A single materialize loop then converts `(op, x, y)` → element.
- Tests: sectioned grouping (column order = first appearance; array order within); leading `''`
  column for a pre-section intro note; no-section input still masonry; no overlap.

## Out of scope (later sub-PRs in this umbrella)
- **2b — agent board title** (`spawn_board(title?)` → the existing editable `board.title`).
- **2c — checklist card widen + diagram fit** (renderer-only; true label-wrap stays deferred — the
  `<input>`→textarea change is the cross-board-transfer umbrella's `boards/planning/*` zone).
