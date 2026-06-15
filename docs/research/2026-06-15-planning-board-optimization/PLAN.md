# Planning Board Optimization — Epic execution plan (parallel slices)

> **Epic branch:** `feat/planning-board-epic` · **Base:** `main` @ `70a9966` (2026-06-15)
> **Research / rationale:** [`REPORT.md`](./REPORT.md) (multi-agent research, 2026-06-15). Read it for the *why*; this file is the *how* + parallel coordination.
> **Coordination:** the live claim board is `.claude/coordination/ACTIVE-WORK.md` › **MUST-WORK-NOW: Planning Board epic**. Claim a slice there before starting.

## What this epic delivers

Three outcomes, decomposed into 5 file-disjoint slices so multiple sessions can build in parallel:

1. **Optimize** the Planning board — kill the per-keystroke whole-well re-render and the O(n) hot paths (no visible behavior change, big perf headroom).
2. **Diagrams** on the board — a themed **Mermaid `Diagram` element** (additive element kind, rendered in a hidden BrowserWindow worker), *not* the deferred geometric shapes epic.
3. **Agent → live plan visual** — a terminal agent (CLI coding agent) can create/populate a Planning board to visualize the current plan, via a new confirmed MCP write path. Defaults to structured checklist/note elements; emits diagrams once they exist.

Locked context (do not re-decide): React Flow (ADR 0001), custom whiteboard (vendored perfect-freehand), two-tier schema versioning (ADR 0007: `SCHEMA_VERSION` + `MIN_READER_VERSION`, centralized in `boardSchemaVersion.ts`), security invariants (contextIsolation/sandbox/thin preload; MCP egress/trust ADR 0003; native-view occlusion ADR 0002), design tokens (one accent blue `#4f8cff` functional only; calm/dense; no gradients/glow/glassmorphism).

Current baseline (verified on `main` @ `70a9966`): `SCHEMA_VERSION = 10`, `MIN_READER_VERSION = 9`; planning element kinds = `note · text · arrow · stroke · checklist · image` (6, no diagram); the MAIN/renderer schema lock-step (BUG-013/024) is **already fixed** (single source = `boardSchemaVersion.ts`, MAIN mirrors at `projectStore.ts:32`).

---

## Slice map & start order

| Slice | Title | Branch | Status | Start | Blocked by | Collides with |
|---|---|---|---|---|---|---|
| **S1** | P0 perf + hygiene quick-wins | `fix/planning-perf-quickwins` | AVAILABLE | **NOW** | — | S3, S4 (planning files) |
| **S2** | P3 agent → planning MCP write path | `feat/planning-agent-write` | AVAILABLE | **NOW** | — | S4 (schema lines only — avoid by staying in existing kinds) |
| **S5** | Doc reconcile + token promotion | `docs/planning-design-reconcile` | AVAILABLE | **NOW** | — | S1 (light: `tints.ts`/`index.css`) |
| **S3** | P1 element-registry + unified-geometry rail | `refactor/planning-element-registry` | blocked | after **S1** merges | S1 | S4 |
| **S4** | P2 Mermaid Diagram element (schema v11) | `feat/planning-diagram-element` | blocked | after **S3** merges | S3 | S2 (schema lines) |

**Immediately parallel: S1 ∥ S2 ∥ S5** (three sessions, fully file-disjoint). Then **S3** (rides the planning files after S1), then **S4** (rides the registry rail from S3). Up to 3 sessions now, narrowing to a single planning lane for S3→S4 while S2/S5 run alongside.

**Per-session ritual:** `git fetch origin && git rebase origin/main`; create your worktree with `pwsh .claude/tools/new-worktree.ps1 -Name <slice-name> -Zone "<owns>"`; update your row on the board; read `REPORT.md` + this file via `git show feat/planning-board-epic:docs/research/2026-06-15-planning-board-optimization/PLAN.md` if not on the epic branch. Full gate + e2e matrix (both legs) once per PR at the pre-merge gate; inline-reply every bot review comment.

---

## S1 — P0 perf + hygiene quick-wins  ·  `fix/planning-perf-quickwins`  ·  no schema change

**Goal:** near-zero-risk perf + correctness wins. One note keystroke must stop re-rendering the whole well.

**Owns (edit):**
- `src/renderer/src/canvas/boards/planning/{NoteCard,ChecklistCard,FreeText,ImageCard}.tsx` — wrap in `React.memo` (handler props are already stable `useCallback`s — verify before relying on it).
- `src/renderer/src/canvas/boards/planning/WhiteboardSvg.tsx` — drop the dead `strokePaths` `useMemo` (dep is a fresh `.filter()` every render → never skips); rely on the per-stroke WeakMap cache (`WhiteboardSvg.tsx:108`).
- `src/renderer/src/canvas/boards/PlanningBoard.tsx` — lift the per-render `arrows`/`strokes` filters out of the hot path (`PlanningBoard.tsx:420-421`); move `setItem`/`setTitle`/`setNoteText` from the stale-closure form to the live-read `commit((cur)=>…)` form their siblings use (`PlanningBoard.tsx:181-185,243-252` — closes the latent BUG-023 lost-update class).
- `src/renderer/src/canvas/boards/planning/erase.ts` — arc-length-adaptive bezier sampling in `nearArrow` (fixed `STEPS=16` skips the middle of long curved arrows, `erase.ts:61`).
- **Failure toast** for export + image-write errors (close the open W5 follow-up): the error returns + cancel-vs-error distinction already exist; only the user-visible surface is missing — route through the shipped `toastStore` (`store/toastStore.ts`).
- Resolve the dead `BoardCommon.z` orphan field (hygiene).

**Acceptance:** typing in one note re-renders 1 card, not N (verify via a render-count probe or React Profiler note in the PR); existing planning e2e (`@planning`) green; new unit test for the live-read mutators; export/image-write failure shows a toast; full gate + e2e matrix green.

**Do NOT touch:** the element schema, `elements.ts` geometry structure (that is S3), MCP/main.

---

## S2 — P3 agent → planning MCP write path  ·  `feat/planning-agent-write`  ·  no schema bump (stays at floor 9)

**Goal:** a terminal agent can create and populate a Planning board to render the current plan — **human-confirmed at write time**. Default to structured `checklist` + `note` elements (existing kinds → `MIN_READER_VERSION` stays 9).

**The gap (verified):** an agent can `spawn_board('planning')` but the factory hardcodes `elements: []` (`boardSchema.ts`), and the only MAIN→renderer write channel is the closed 4-variant `McpCommand` union (`ping | addBoard | removeBoard | configureBoard` — `mcpCommand.ts:20-28`); none carries content. The store-side apply path already exists: `PATCHABLE_KEYS.planning` already includes `'elements'` (`canvasStore.ts:489-509`). **Missing = transport + tool only.** Do **NOT** close this by loosening `configureBoard` (it is hardened against off-type forgery) — add a purpose-built command.

**Owns (edit):**
- **`@expanse-ade/mcp` pkg** (sibling repo `../canvas-ade-mcp`, published `@expanse-ade/mcp`) — new tool `add_planning_elements(boardId, spec)` + an optional seed arg on `spawn_board` to mint a pre-populated board in one call. Bump pkg version; the app pins `^0.9.x`.
- `src/main/mcpCommand.ts` — new `McpCommand` variant `patchPlanning{ id, ops }` (append/update note · checklist + items · text · arrow).
- `src/main/mcpOrchestrator.ts` + `src/main/mcpConfirm.ts` — MAIN-side: validate every op against `assertPlanningElement`; **sanitize text/markdown**; **cap element count + total byte size** (no upper bound today → canvas.json / undo-snapshot bloat risk); route through the shipped `requestConfirm` gate (fail-closed, MAIN owns the decision) + the `DispatchStatus` audit vocabulary.
- `src/preload/index.ts` — extend the `api.mcp` surface for the new command.
- `src/renderer/.../canvasStore.ts` apply path (small) — apply via the existing `updateBoard` → `PATCHABLE_KEYS.planning='elements'`, through the same live-read `commit((cur)=>…)` + lazy `beginChange()` so human+agent edits chain (BUG-023) into discrete undo steps; agent auto-fit/grow uses the untracked `growBoardHeight` path (no phantom undo step, BUG-024).

**Trust guardrails (ADR 0003 — this is the revisit trigger ADR 0003 §M-expose names — it is the first MCP path writing attacker-influenceable *content* onto the durable canvas):**
- Human-in-the-loop confirm **at write time**, showing the **full rendered content** (not just a count) — one batch confirm per write.
- Agent content is **untrusted passive context**: it renders but **never auto-arms an action**. A "Run"-wired checklist item must require an **unconditional, separate** human confirm before any PTY dispatch (lethal-trifecta guard) — that "Run" binding is **P4, out of this slice**.
- Default the MCP write tool **flag-gated** for the first release.

**Acceptance:** an agent spawns + populates a planning board (checklist + notes) behind a write-time confirm showing the content; declining writes nothing; element count/size caps enforced (unit-tested); audit row recorded; full gate + e2e (`@planning` + an MCP e2e, mirror `e2e/mcp.e2e.ts`) green.

**Do NOT touch:** planning renderer card files (S1/S3); the schema element union (diagram kind is S4).

---

## S5 — Doc reconcile + token promotion  ·  `docs/planning-design-reconcile`  ·  docs + tokens

**Goal:** make the design contract match the shipped board so S2/S4 contributors inherit a correct baseline.

**Owns (edit):**
- `design-reference/project/DESIGN.md` §7.3 — reconcile the tool list to the shipped 7-tool board (select · note · text · check · arrow · pen · erase + snap + export); note it diverges from the frozen prototype intentionally.
- Promote the 4 note tints + connector colors to **named CSS tokens** in `src/renderer/src/index.css` + `planning/tints.ts`.
- Add a draw.io license-split ADR addendum (Apache/GPL copyleft note) under `docs/decisions/`.

**Acceptance:** docs build/prettier green; tokens render identically (no visual diff); coordinate the `index.css`/`tints.ts` lines with S1 if both are live (note it on the board first).

---

## S3 — P1 element-registry + unified-geometry rail  ·  `refactor/planning-element-registry`  ·  no schema change  ·  **after S1**

**Goal:** one clean rail for adding element kinds, so the diagram kind (S4) rides it. Behavior-identical refactor.

**Owns (edit):**
- New `src/renderer/.../planning/elementRegistry.ts` — a per-kind descriptor table giving compile-time exhaustiveness; collapse the ~7 scattered `switch(el.kind)` sites into it.
- Unify geometry: merge the two independent sources — `elementBBox` (`elements.ts:293-337`) and `eraseHitTest` (`erase.ts:98-135`), plus the `TEXT_NOMINAL`/`TEXT_HIT` nominal sizes — into one module (removes the R4 drift class where a card-layout change silently desyncs selection/snap/erase/export).

**Method:** verbatim-move per extraction, re-point existing tests, run e2e:matrix after each. **Acceptance:** identical behavior, all planning tests green, one place to register a new kind.

---

## S4 — P2 Mermaid Diagram element  ·  `feat/planning-diagram-element`  ·  **schema v11 (breaking)**  ·  **after S3**

**Goal:** users (and agents) author themed Mermaid diagrams as a first-class Planning element.

**Owns (edit):**
- New `src/main/diagramWorker.ts` — a hidden `BrowserWindow` (`show:false, sandbox:true`) render worker, **one shared keep-alive window, renders serialized**, modeled on `previewOsr.ts`. Mermaid 11 needs `eval` (dagre / `new Function`) → give **that window only** a scoped `script-src 'self' 'unsafe-eval'`; the main-window CSP stays locked (`csp.ts:27`). Never jsdom-in-MAIN (breaks `getComputedTextLength`).
- `src/main/csp.ts` (+ tests) — pin the scoped worker CSP; assert the main-window CSP is unchanged.
- New `src/renderer/.../planning/DiagramCard.tsx` — = `ImageCard` (inert `<img>` of the cached SVG via blob URL; `img-src 'self' data: blob:` already allows it) + a `</>` source-edit mode (mono editor, debounced re-render). Reuses the S3 registry + the arrow endpoint-handle pattern for a resize handle.
- `src/renderer/.../lib/boardSchema.ts` — add `DiagramElement { kind:'diagram', source, engine:'mermaid', svgCache?: assetId, w, h }` to the union + an `assertPlanningElement` branch + an **identity migration in the same commit** (the default branch throws on unknown kind). Source is canonical; SVG is a derived, content-addressed asset cache (a source replace auto-invalidates).
- `src/renderer/.../lib/boardSchemaVersion.ts` — bump **`SCHEMA_VERSION 10 → 11` AND `MIN_READER_VERSION 9 → 11`** (a new kind is breaking per ADR 0007 → pre-11 apps get a clean "update the app" message via `assertReadableVersion`). Mirror MAIN's `projectStore.ts:32` constant in lock-step (already centralized — verify it still mirrors).
- `src/main/projectStore.ts` `collectAssetIds` (~`:246`) **and** the export gatherer — register `svgCache` or the asset GC sweeps the cached SVG on reopen (the documented backdrop-asset gotcha).

**Security:** `securityLevel:'strict'` + `htmlLabels:false` + `click` off + namespaced SVG ids, **in the worker only**; cap `maxTextSize` (DoS); SVG rendered as inert `<img>`; Mermaid has real XSS→RCE history — pin all of this in `csp.ts` + a worker test. **Theme** to the neutral token palette (`theme:'base'` + `themeVariables` mapped to app tokens; one accent on active/selected only; Geist; no rainbow/gradient/glow). The async `svgCache` write-back must be a **silent, non-undoable** patch (`lastRecorded` rule) or every render pollutes the undo rail.

**Gate:** **design artifact (the REPORT §4 wireframe) signed off + a title-stamped `pnpm dev` check** before merge. Ship flowchart/sequence/ERD first. Full gate + e2e matrix.

---

## Locked decisions for this epic (from REPORT §7)

- **Mermaid element now; geometric shapes epic stays parked** — ship Mermaid as the explicit demand-gate before ever reopening ADR 0001.
- **Agent emits hybrid** — default to structured checklist/note for plans (no breaking bump, S2); Mermaid for architecture/flow once S4 lands; always emit validated structure → convert → keep editable.
- **Hold `MIN_READER_VERSION` at 9 for the first agent-write slice (S2)** by staying within existing kinds; pay the breaking `9→11` bump only when the diagram kind (S4) lands.
- **MCP write tool flag-gated** + mandatory write-time human confirm for the first release.
- **One shared diagram render worker**, serialized (not per-diagram).
- **Persist `svgCache`** for instant open (accept the GC-registration cost — must add to `collectAssetIds` + export gatherer).
- **Plan↔worker link = the existing `orchestration` connector** first (already designed + tokened); add a data field only if proximity/label matching proves insufficient.

## Open items still needing a user call before the dependent slice starts

- **S4 reader-floor:** confirm we accept the `MIN_READER_VERSION 9→11` breaking bump when the diagram kind lands (older apps will require an update to open newer projects). *Recommend: yes, with a clean "update the app" message.*
- **S2 default-on vs flag-gated** for the agent write tool at first release. *Recommend: flag-gated.*
- **P4 (closed loop: "Run" a checklist item → bound PTY + generate-plan-from-prompt)** is intentionally **out of this epic** — gated on S2 proving the write + confirm UX, and a new ADR extending 0003.
