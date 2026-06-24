# Planning-MCP Phase 2c — card-widen + agent-honored diagram footprint + gap tighten

> Umbrella `feat/planning-mcp-umbrella` (off 2a tip `a4b442d9`). After eyeballing a live agent plan
> (the "Tonkotsu Tuesday" ramen plan), three presentation pains surfaced: (1) checklist item labels
> **truncate** at the 240px card width — the #1 readability hit; (2) every MCP diagram renders in a
> fixed **280×200** box → a real flow/ERD is too small to read; (3) checklist cards leave a **visible
> vertical gap** below them in a column (the height estimate over-shoots the real render). 2c fixes all
> three. **Renderer-only — no `@expanse-ade/mcp` bump, no `schemaVersion` bump** (everything is a
> materialize-time size choice; the stored `PlanningElement` already carries `w/h`).

## Decision (user-confirmed 2026-06-25)

**Host honors the agent's intent; it does not add new agent knobs.** The agent already owns a
diagram's orientation (the Mermaid `source`: `graph LR` vs `graph TD`), so the host **infers** the
footprint from that source rather than adding a `footprint`/`width` field to the MCP schema (the
rejected "agent-explicit" option — redundant with the source direction, and it would cost a package
bump). Checklist widen + gap tighten are pure host layout constants on the MCP write path.

## Changes (all in `src/renderer/src/store/planningMcpApply.ts`)

### 1. Checklist widen — `MCP_CHECKLIST_W = 300`
- MCP-authored checklists materialize at **300px** (was the shared `CHECKLIST_W = 240`). `ChecklistCard`
  already renders at the element's persisted `w` (`ChecklistCard.tsx:145`), so this is purely the
  width we seed — no card-component edit.
- **Eases** truncation; does **not** fully solve it. Item labels are a single-line `<input>`
  (`ChecklistCard.tsx:289`) that can't wrap — true wrap = `<input>`→`<textarea>` in `ChecklistCard.tsx`,
  which is the **cross-board-transfer umbrella's** `boards/planning/*` zone → **deferred / coordinate**.
- User-created checklists keep their 240px default (unchanged factory in `elements.ts`).

### 2. Diagram footprint — host infers orientation from the source
- New `diagramFootprint(source)` picks a size by reading the Mermaid header:
  - **WIDE `460×300`** (landscape) — `graph|flowchart LR|RL`, `erDiagram`, `gantt`, `timeline`,
    `journey`, `gitGraph`, or a later `direction LR|RL` line (class/state diagrams).
  - **TALL `340×400`** (portrait) — `graph|flowchart TD|TB|BT`, `sequenceDiagram`, and everything else
    / unknown (conservative default). Portrait gives a vertical flow more height under `object-fit`.
- Both buckets are larger than the old `280×200`, so the diagram is legible; the SVG is vector and
  `DiagramCard` uses `object-fit: contain` (`DiagramCard.tsx:517`), so enlarging the box scales it up
  **crisply** with no re-render. User-created diagrams keep `DIAGRAM_SIZE = 280×200` (unchanged
  `makeDiagram` factory).

### 3. Gap tighten — `CHECK_ROW 38 → 26`
- The masonry/section placement reserves each checklist's **estimated** height. The real interactive
  render is `≈ 77 + 24·N` px (header 16 + 3px bar + `N` × 16px rows + 8px inter-row gaps + footer +
  `11/12/12` padding; checkbox is 16×16). The old estimate `88 + 38·N` over-shot by `11 + 14·N`
  (≈81px for a 5-item card) → that's the gap.
- Trimming **only** `CHECK_ROW` to 26 (real row 16 + gap 8 = 24, +2 cushion) drops the overshoot to
  `11 + 2·N` (≈21px for 5 items). `CHECK_HEAD`/`CHECK_FOOT` keep their small safe cushion.
- **Invariant:** the estimate must stay **≥** the real render — a sibling card is absolutely
  positioned, so under-estimating would **overlap** it (cards don't reflow). 26 keeps a per-row margin.
- Note/text estimates are left as-is (notes auto-grow their textarea to the real height on render, so
  their seed isn't a hard gap source like the fixed-position checklist is).

## Tests
- `planningMcpApply.test.ts`: an MCP checklist materializes at `w === 300`; `diagramFootprint` returns
  WIDE for `graph LR`/`erDiagram`/`direction LR`, TALL for `graph TD`/`sequenceDiagram`/unknown; the
  tightened estimate stays ≥ the documented real-height lower bound (regression on the overlap
  invariant).
- e2e (`mcpPlanning.e2e.ts`): the existing section write already asserts column layout; extend a
  diagram-bearing write to assert the diagram element lands at a 2c footprint (≥ the old 280×200).

## Out of scope (still in this umbrella)
- **2b — agent board title** (`spawn_board(title?)` → the existing editable `board.title`; crosses the
  package boundary → its own bump).
- **True checklist label wrap** (`<input>`→`<textarea>`) — cross-board-transfer umbrella's zone.
- **Phase 3** — multi-board (one planning board per topic) + host cluster auto-arrange.
