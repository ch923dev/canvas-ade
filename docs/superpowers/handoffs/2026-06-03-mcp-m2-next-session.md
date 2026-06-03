# Kickoff — MCP M2 (Spatial connectors), next session

You are continuing the Canvas ADE × MCP integration roadmap. **M1 (Observation) is COMPLETE.** This
session: build **Milestone M2 — Spatial connectors** by completing **T2.1 → T2.2 → T2.3 SEQUENTIALLY**
(one task fully green + squash-merged + handed off before the next). Do NOT parallelize. M2 is
**RENDERER / STATE-ONLY** — no MCP package, no MAIN/node-pty, no `simple-git`, no publish.

## REPOS / RUNTIME
- **WORK HERE:** `Z:\canvas-ade-mcp-int` — branch `feat/mcp-integration` (PR #32). Cut task sub-branches
  off it; squash back.
- APP `Z:\Canvas ADE` (main) — integration only; **NEVER work here** (a parallel session uses it;
  shared-dir collision hit this project twice).
- PKG `Z:\canvas-ade-mcp` — **NOT touched by M2** (M2 has no MCP surface). Leave the held 0.3.x chain
  alone (see State).

## READ FIRST (in order)
1. `Z:\Canvas ADE\CLAUDE.md` — durable contract (stack, security, conventions, Persistence §, the
   scene/session split: ephemeral state NEVER routed into `elements[]`/a board patch key).
2. `docs/superpowers/plans/2026-06-03-mcp-m2-spatial-connectors.md` — **THE plan for this session**
   (grounded against the real code; decisions locked). Execute it task-by-task.
3. `docs/roadmap-mcp.md` § M2 — the three task cards + the M2 gate.
4. The M1 completion handoffs for the cadence pattern:
   `docs/superpowers/handoffs/2026-06-03-mcp-t1-4-output.md` … `-t1-7-memory.md`.
5. Memories (recalled automatically): `undo-lastrecorded-phantom` (the undo rail — load-bearing for
   T2.1), `e2e-sendinputevent-vs-dispatchevent` + `e2e-modifier-keys-synthetic` (e2e gesture driving),
   `parallel-agent-worktrees`, `e2e-browser-trio-flake`.

## STATE OF PLAY (2026-06-03)
- **M1 DONE** on `feat/mcp-integration` (pushed): T1.4 output `efb6726` (pkg 0.3.0) · T1.5 result
  `ef32ae5` (pkg 0.3.1) · T1.6 pill `7c00b3d` (renderer-only) · T1.7 memory `48cda99` (pkg 0.3.2).
  Live MCP smoke all `MCP_*_OK` exit 0; board e2e clean.
- **pkg HELD chain since last publish (0.2.4): 0.3.0 + 0.3.1 + 0.3.2** (`feat/board-output` →
  `feat/board-result` → `feat/board-memory`, stacked + pushed, NOT merged to pkg main, NOT published —
  **user-gated, do NOT publish**). App still consumes `^0.2.4`; the `pnpm mcp:link` symlink overrides
  the floor to the sibling 0.3.2 in dev. **M2 needs none of this** — it touches no pkg. Do not run
  `pnpm install` / publish / bump the floor this session.
- `feat/mcp-integration` is NOT merged to APP `main` (user's decision). Stay on the umbrella.
- ⚠️ The worktree's `node_modules` is its OWN (de-junctioned). Normal `pnpm` works; do NOT re-junction.

## THE 3 TASKS, IN ORDER (full steps in the plan doc § Tasks)
**T2.1 — Connector data model + persistence** (`feat/mcp-t2-1-connector-model`)
  `Connector {id, sourceId, targetId, kind∈{preview,orchestration}}` + a `connectors: Connector[]` on
  `CanvasDoc`. `SCHEMA_VERSION 4→5` + migration that FOLDS each board's `previewSourceId` into a
  `preview` connector (stable id `preview-<browserId>`). Widen the undo snapshot to
  `{boards, connectors}[]` (history.ts is generic; only the store types + `trackedChange` change — mind
  `undo-lastrecorded-phantom`). Extend the autosave dirty-predicate + `toObject` to include
  `connectors`. Store actions `addConnector`/`removeConnector` (reject self-link/missing/dupe), and
  `removeBoard` drops incident connectors **in the same `trackedChange` step**; `duplicateBoard` adds
  none. TDD FIRST: migration (fold + dangling-strip + idempotent round-trip), store (add=1 undo step,
  self-link reject, dedupe, removeBoard one-step cleanup+undo, duplicate=no cables, dirty-on-add),
  extend `persistence.integration.test.ts`. e2e: `addConnector`/`getConnectors` harness hooks + a
  `connector-roundtrip` probe (clean up after).

**T2.2 — Draw / delete connector gesture** (`feat/mcp-t2-2-connector-gesture`)
  Connector handle in the **BoardFrame title-bar control cluster** (sibling of maximize/⋯, reuse
  `IconBtn`) → `onStartConnect(fromId)` threaded via `BoardActionsContext`. Pointer-drag with an
  EPHEMERAL "connecting" state (never persisted) + rubber-band overlay; pointerup resolves the target
  from **store geometry** (`rf.screenToFlowPosition` + board rects), NOT DOM hit-testing → pure
  `resolveConnectTarget(boards, fromId, flowPoint)` (DOM-free, unit-tested) → `addConnector(...,
  'orchestration')`. Delete: an ✕ on the edge (`EdgeLabelRenderer` midpoint) + select-edge + Del/Backspace
  (track `selectedConnectorId`; guard against double-firing board-delete). e2e: expose imperative
  `startConnect`/`completeConnectAt(flowX,flowY)` hooks exercising the SAME resolution path; probe
  `connector-draw-delete` (add, ✕-delete, delete-board cleanup + undo restores both); restore baseline.

**T2.3 — Typed edge render** (`feat/mcp-t2-3-typed-edge-render`) — **the M2 gate**
  Pure `orchestrationEdges(connectors, boards)` (mirror `previewEdges.ts`, skip dangling) + test.
  Extract the shared floating-path helper out of `PreviewEdge.tsx` → `edges/floatingPath.ts`; new
  `edges/OrchestrationEdge.tsx` imports it, styled **distinct from the accent preview edge** per DESIGN
  §7.3 (~2px neutral `--border-strong`/`--text-2`, distinct arrowhead; calm, no glow/gradient). Register
  the `orchestration` edge type + concat into `Canvas.tsx`'s `edges` memo (preview decoration
  untouched). e2e: assert distinct stroke vs preview, reroute on board move, and **preview edges show
  NO regression** (existing `preview-edge-stale` / `duplicate-keeps-link` / `preview-connect-gesture`
  stay green).

## LOCKED DECISIONS (do NOT re-litigate — confirmed by the user 2026-06-03)
- **Dual-source model:** `previewSourceId` stays the RUNTIME source-of-truth for preview links;
  `connectors[]` holds **orchestration only** in memory; the migration writes preview connectors into
  the persisted doc, `fromObject` folds them back. (Zero preview-regression risk.)
- **Duplicate = no inherited orchestration cables** (`previewSourceId` is still kept on duplicate).
- **Title-bar connector handle** (not RF border `Handle`); target via store geometry.
- Floating-derived edges (NOT RF `onConnect`/`onEdgesChange`/`connectionMode`). Undo snapshot widened
  to `{boards, connectors}[]`. **M2 claims schema v5** (draw.io D2/D3 + whiteboard rebase to v6+; leave
  a claim comment at `SCHEMA_VERSION`).

## CADENCE — MANDATORY per task
- One sub-branch off `feat/mcp-integration` → squash-merge back when green → THEN next task.
- TDD: write the failing pure-function test first, watch it fail, then implement (migration / connector
  add-remove-cleanup / target-resolution / edge-derivation are all pure → unit-test them).
- e2e: add ONE probe per task to `src/main/e2e/probes/` (new `connectors.ts`) + the playlist in
  `src/main/e2e/index.ts` (order is load-bearing; probes MUST restore baseline so the final `seed`
  count check holds). Add harness hooks to `src/renderer/src/smoke/e2eHooks.ts`.
- **Gate before each handoff:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test &&
  pnpm build` (this is the REAL gate — `check` job). Also run the board e2e LOCALLY:
  `pnpm build; CANVAS_SMOKE=e2e pnpm start` (FROZEN in CI; run it here — the
  browser/browser-gesture/focus-detach trio + `preview-edge-stale`/`duplicate-keeps-link` are known
  env/RF-measurement-race flakes → rerun for a clean `E2E_DONE ok:true`, not a regression; memory
  `e2e-browser-trio-flake`). Note: `pnpm start` exit code can mask the marker — grep for
  `E2E_DONE {"ok":true` and any `"ok":false` parts.
- Write a handoff `docs/superpowers/handoffs/<date>-mcp-t2-N-*.md` after each task.
- Declare each sub-branch's zones on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing
  (the row currently reads "M1 COMPLETE"). ⚠️ CROSS-ZONE: `boardSchema.ts` (schema v5) +
  `canvasStore.ts` (undo rail) are shared-sensitive vs the draw.io/whiteboard tracks — note the v5
  claim. `feat/context` (parallel) touches `index.ts`/`preload` additively, not these renderer files.

## SECURITY (never weaken)
`contextIsolation`/`sandbox`/`no-nodeIntegration`; renderer never touches Node/native; connectors are
pure renderer state (no PTY, no IPC widening). Ephemeral "connecting" gesture state is React/Zustand
only — NEVER serialized into the canvas doc (scene/session split).

## DO NOT
- Do NOT touch the pkg (`Z:\canvas-ade-mcp`) or publish — M2 has no MCP surface; the 0.3.x chain stays
  held + user-gated.
- Do NOT merge `feat/mcp-integration` to APP `main`. Do NOT work in the `Z:\Canvas ADE` main dir.
- Do NOT switch to RF interactive edges (`onConnect`/`connectionMode`) — it regresses the floating
  preview edges. Do NOT copy orchestration cables on duplicate. Do NOT re-junction node_modules.
- Do NOT let a connector add/remove create a phantom undo step (route through `trackedChange`; sync
  `lastRecorded` — memory `undo-lastrecorded-phantom`).

## START BY
`cd Z:\canvas-ade-mcp-int` ; confirm branch `feat/mcp-integration` + `pnpm mcp:link` symlink active ;
read the plan doc + `docs/roadmap-mcp.md` § M2 ; confirm the current `SCHEMA_VERSION` (=4) and the
`previewSourceId`/`previewEdges`/`PreviewEdge` plumbing ; declare T2.1 zones on ACTIVE-WORK.md ; then
build T2.1 test-first. Finish + squash-merge + handoff T2.1 before starting T2.2.
**M2 is done when** connectors persist + round-trip, draw/delete works, orchestration edges render
distinct from preview edges and reroute on move, and the preview-edge probes show no regression.
