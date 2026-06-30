# MCP Canvas Awareness — epic spec

> Umbrella: `feat/mcp-canvas-awareness-umbrella`. Sub-phases PR into the umbrella; umbrella → `main`
> once (full e2e matrix at the single pre-merge gate), per the terminal-crisp / planning-transfer
> pattern. Design artifact: `mocks/kanban-and-visualize-prompt.{html,png}` (signed off 2026-06-30).

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
