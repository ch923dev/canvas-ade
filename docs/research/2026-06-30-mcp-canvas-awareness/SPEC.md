# MCP Canvas Awareness — epic spec

> Umbrella: `feat/mcp-canvas-awareness-umbrella`. Sub-phases PR into the umbrella; umbrella → `main`
> once (full e2e matrix at the single pre-merge gate), per the terminal-crisp / planning-transfer
> pattern. Design artifact: `mocks/kanban-and-visualize-prompt.{html,png}` (signed off 2026-06-30).

## Status (2026-07-01)

- **P1a — DONE, exposed.** Geometry (`x/y/w/h`) on `canvas://boards` + `app-model` (host+renderer,
  no package release). Committed `50590c84`.
- **P1b — DONE, wired; goes live at integration.** `buildLayoutDigest` (`b533df1c`) + host
  `describeLayout` wiring (`10c01269`). Package published: **`@expanse-ade/mcp@0.18.0-rc.1`** on npm
  (`next` dist-tag; `latest` still `0.17.0`) — `canvas://layout` resource + `Orchestrator.describeLayout`
  (sibling `feat/canvas-layout`, tag `v0.18.0-rc.1`; publish workflow fixed to route prereleases →
  `next`). The host type compiles against 0.17.0 (forward-compatible `Omit`), so **the one pending
  action is the app pin bump `^0.17.0` → `0.18.0-rc.1` + install, deferred to the umbrella→main
  integration** ("change deps on MAIN then merge" — avoids disturbing the shared node_modules the
  other live worktrees junction to). `canvas://layout` is served only once the app consumes the rc.
- **P4.1 — DONE (board type + read-only render).** New `kanban` board type — breaking **schema v17 /
  reader-floor 17** (ADR 0007). Persists `columns` + a flat `cards` list (bound by `columnId`; schema
  shapes live in the leaf `kanbanSchema.ts` to keep `boardSchema.ts` under the max-lines gate).
  `KanbanBoard.tsx` renders the lanes/cards/chips per the signed-off mock; creatable via ⌘K ("New
  kanban board") + the empty-state row. `PATCHABLE_KEYS.kanban = [...common, columns, cards]` (so
  human/agent edits round-trip), digest + status-bucket ('static') + type glyph wired. Gate GREEN:
  typecheck/lint/format 0 · 3834 unit pass · manual dev-check screenshot matches the mock.
  DEFERRED to later slices: drag/inline-edit (P4.2), MCP card mutate (P3), the visualize gate (P5),
  and the `kanban` `APP_BOARD_TYPES` self-model entry (added in P3/P5 once tools target it — mirrors
  `dataflow`, which is likewise absent from that table until it has agent tools).
- **P3a — DONE (MCP card mutation), goes live at integration.** Four flag-gated tools —
  `add_card`/`move_card`/`update_card`/`remove_card` — the epic's headline (the mock's
  `move_card #08 → Review`). Package `@expanse-ade/mcp@0.18.0-rc.2` (`feat/canvas-layout`, tag
  `v0.18.0-rc.2`): new `Orchestrator` methods + tools, gated behind the SAME `planningWrite` gate as
  `add_planning_elements` (orchestrator + connected tiers; worker never). Host: 4 methods run the
  shared resolve→kanban-check→sanitize→**human-confirm**→`patchKanban`→audit gate (`mcpKanban.ts` +
  `mcpKanbanGate.ts`, extracted to keep `mcpOrchestrator.ts` under the max-lines gate); MAIN mints +
  returns the card id. Shared `KanbanOp` + `patchKanban` McpCommand variant; renderer `kanbanMcpApply`
  re-validates (column/card exists) + commits one undoable `cards` edit. Gate GREEN: app typecheck/
  lint/format 0 · **3861 app unit + 210 pkg contract pass**. Read resource `canvas://board/{id}/cards`
  (P3b) + human drag/edit (P4.2) still open. **Integration owes** (bundled with P1b's): pin bump
  `^0.17.0`→`0.18.0-rc.2` + `APP_TOOLS` +4 card tools (F25 runs against installed 0.17.0, so adding
  them now would red the drift guard) + install.
- **P5a — DONE (the visualize prompt gate), goes live at integration.** The epic CAPSTONE. New
  `visualize_plan` tool — an agent hands a flat plan (items: title + optional status/tag/assignee/note)
  + a suggested shape; the host surfaces the UPGRADED human-confirm gate as a layout CHOOSER (kanban /
  grid / checklist / columns, the suggestion preselected) and, on approval, creates a NEW board in the
  shape the human PICKED, tidied into open canvas space. Package `@expanse-ade/mcp@0.18.0-rc.3`
  (`feat/canvas-layout`, tag `v0.18.0-rc.3`, run 28502797454 ✅; npm `next`). **Confirm protocol widened**
  with a bounded `choices` chooser (`ConfirmRequest.choices` + `ConfirmDecision.choice`) — reuses the
  whole fail-closed machinery (channels/timeout/foreign-frame guard/queue); the gate re-validates the
  human's pick against the offered set (fail-safe to the suggestion), so a forged `choice` can never
  produce an off-shape board. Host: `mcpVisualize.ts` (sanitize/cap/render — single-line short fields,
  multi-line note, full-plan confirm body) + `mcpVisualizeGate.ts` (the gate, extracted to keep
  `mcpOrchestrator.ts` under the max-lines gate); MAIN MINTS the board id. Renderer: `visualizeMcpApply`
  builds the board (kanban columns from distinct statuses; grid/checklist/columns via the shared
  planning masonry) → new `addPreparedBoard` store action inserts it as ONE undoable board, free-slot
  placed + selected. `ConfirmModal` renders the chooser (choice held on the queue item). Gate GREEN:
  app typecheck/lint/format 0 · **3579 unit + 315 integration + 216 pkg contract pass**. **Integration
  owes** (bundled with P1b/P3a): pin bump `^0.17.0`→`0.18.0-rc.3` + `APP_TOOLS` +`visualize_plan` +
  install. No live UI in the worktree (like P1b/P3a — the package isn't consumed here); the chooser is
  proven by `ConfirmModal.chooser.test` + the gate/applier tests, and the visual is the signed-off mock.
- **P2 · P3b · P4.2** — not started. (P5's remaining polish — the mock's placement mini-preview — folds
  into a later pass.)

## Why

The MCP layer (`@expanse-ade/mcp` v0.17.0 + host `src/main/mcp*.ts`) can spawn, dispatch, and
**append** planning content, but it is **spatially blind** and **append-only**. Concretely:

1. **Awareness is logical, not spatial.** `BoardSummary` (`Orchestrator.ts`) and `AppModelBoard`
   (`src/main/appModel.ts`) carry `id/type/title/status` (+ `agentKind/monitorActivity`, file
   `path`) but **no geometry** — no `x/y/w/h`, no inline group membership. The agent cannot see
   *where* boards are, how big they are, or whether they overlap. It can neither describe nor tidy
   the canvas.
2. **No tidy / move / layout capability.** The app has a deterministic packer (`tidyLayout`,
   `src/renderer/src/lib/tidyLayout.ts`) + `canvasStore.tidyBoards`, but no `McpCommand` and no tool
   reach it. `configure_board` only patches `shell/launchCommand/cwd` (package `BoardConfig` is
   config-only) — even though `applyBoardPatch` (`boardPatch.ts`) would accept `x/y/w/h`.
3. **Planning content is append-only.** `add_planning_elements` → `patchPlanning`
   (`useMcpCommands.ts`) only ever appends to `elements`. No update / toggle / move / reorder /
   delete of an element, and no way to even **read** the current elements (the boards resource
   exposes title/status only). Board-level delete/update *do* exist (`close_board`/`configure_board`)
   — the gap is element-level + geometry.
4. **Plan visualization is masonry, not a Kanban.** The `section` tag → one column per section
   (`planningMcpApply.placeSectioned`) is static + write-once. No move-between-columns, WIP, status,
   or swimlanes.

## Unifying principle (the design decision)

The MCP becomes **canvas-aware**, and a plan write becomes a **prompt-driven, canvas-aware
visualization step** — not a blunt parameter. When the agent calls the MCP to lay out a plan it:

- reads the new awareness resources to see what's already placed,
- **proposes** a layout (Kanban / grid / checklist / columns) inferred from the content shape, and
- surfaces an **on-canvas prompt** (the *upgraded* mandatory human-confirm gate) where the user
  accepts or reshapes it, with canvas-aware placement (tidied into open space).

The deterministic `tidyLayout` engine + the element-mutate tools still exist underneath — they are
*driven by* the prompt + agent reasoning, not exposed as raw knobs. ("Lengthwise/crosswise" is just
one orientation the agent can pick; it is no longer a user-facing requirement.)

## Decisions locked

- **Kanban = a dedicated board type** (a full-board Trello-style board, like the Data-Flow board),
  NOT a Planning element. → new board type ⇒ **breaking schema bump (v18 + reader-floor bump,
  ADR 0007).** Accepted 2026-06-30.
- The visualize prompt is the **existing** `add_planning_elements` human-confirm gate, upgraded into
  a layout chooser. Still passive content — nothing runs.

## Phases

| Phase | What | Package release | Schema |
|---|---|---|---|
| **P1 · Awareness** | Geometry (`x/y/w/h/groupId`) on the `canvas://boards` projection + `AppModelBoard`; new digested `canvas://layout` resource (bbox, row/col structure, overlaps). | layout resource: yes | none |
| **P2 · Tidy** | `tidy_canvas` tool + `tidyBoards` `McpCommand` → `tidyLayout` + `canvasStore.tidyBoards`. orientation/mode/subset params. Reposition-only, undoable. | yes | none |
| **P3 · Mutate** | `canvas://board/{id}/elements` read resource + `update`/`remove`/`move` element tools + commands. The "delete/update resource." | yes | none |
| **P4 · Kanban board** | `kanban` board type: schema, store slice, `KanbanBoard.tsx`, persistence, drag-between-columns; spawn/close wiring. | wiring | **v18 + floor** |
| **P5 · Visualize prompt** | Upgrade the confirm gate into the layout chooser; agent proposes from P1 awareness; placement tidy-aware. | yes | none |

**Sequence:** P1 → (P4 + P3 together — a Kanban is only useful if its cards can be mutated) → P5,
folding P2 in where the prompt needs it.

## Per-phase contract changes

### P1 — awareness (this slice)
- **Host, no package change** — `listBoardSummaries` (`src/main/mcpOrchestrator.ts`) already spreads
  extra fields onto the verbatim-serialized `canvas://boards` projection (the `BoardSummaryWithFiles`
  precedent). Add optional `x/y/w/h` and `groupId`. Mirror onto `AppModelBoard`
  (`src/main/appModel.ts`) — host-owned type, edit directly.
- **Package** — register `canvas://layout`: a digested view (`bbox`, boards as
  `{id, x, y, w, h, groupId?}`, detected `rows`/`columns`, `overlaps`), via a new
  `Orchestrator.describeLayout()` the host implements over the live mirror. Orchestrator-tier (it is
  reasoning fuel; keep it beside `canvas://app-model`).
- **Drift guard** — `appModelDrift.test.ts` (F25) must stay green; update `APP_TOOLS`/board-type
  tables only when P2+ add tools.

(P2–P5 contracts expanded in their sub-PR specs.)

## Open / deferred
- Kanban card → terminal-board linkage (a card that dispatches to an agent) — design in P4, build
  may defer to a follow-up; mock shows the *indicator* only.
- Swimlanes / WIP enforcement — mock shows them; confirm scope in P4.

## Artifacts
- `mocks/kanban-and-visualize-prompt.html` — throwaway static mock built on the real `index.css`
  tokens. `mocks/kanban-and-visualize-prompt.png` — its render.
