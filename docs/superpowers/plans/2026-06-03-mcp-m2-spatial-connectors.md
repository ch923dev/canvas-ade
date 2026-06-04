# Plan — MCP M2: Spatial connectors (typed board-to-board edges)

- **Date:** 2026-06-03
- **Milestone:** M2 (Spatial connectors, feature-proposal SB-4) — **renderer/state-only**, no pkg/MCP,
  no MAIN/node-pty/simple-git. Dep: M0 (done). Parallel to M1 (done).
- **Goal:** typed, **persisted** board-to-board connector edges — the visual substrate M4 dispatch
  later flows along (drag a cable = an orchestration link). Generalizes the existing
  `PreviewEdge` / `BrowserBoard.previewSourceId`.
- **Branch:** sub-branch per task off `feat/mcp-integration`, squash back. Gate = `check`
  (typecheck/lint/format/unit/build); e2e run locally for green (FROZEN in CI). Handoff per task.

## Grounding (how it works today)
- Schema `SCHEMA_VERSION = 4` (`src/renderer/src/lib/boardSchema.ts:15`); `MIGRATIONS` keyed by
  FROM-version, each +1; `CanvasDoc = {schemaVersion, viewport, boards}` — **no `connectors` field**.
- The preview "edge" is **NOT an interactive RF edge**: per-board `BrowserBoard.previewSourceId`
  (`boardSchema.ts:47`) → derived by pure `previewEdges(boards, runningIds)`
  (`src/renderer/src/lib/previewEdges.ts:16`) → rendered by custom floating RF edge `PreviewEdge`
  (`src/renderer/src/canvas/edges/PreviewEdge.tsx`, registered `edgeTypes={{preview}}`
  `Canvas.tsx:70`). Endpoints from live node geometry (`useInternalNode`+`borderPoint`) → **reroutes
  on move with zero per-edge writes**. No `onConnect`/`onEdgesChange`/`connectionMode` wired.
- Undo rail snapshots `Board[]` only (`canvasStore.ts:53`); all mutations route through
  `trackedChange` (`canvasStore.ts:160`); phantom-step discipline in `lastRecorded`/`beginChange`.
- Autosave fires only on `boards`/`viewport` ref change (`useAutosave.ts:98`).
- Cleanup: `removeBoard` clears dangling `previewSourceId` (`canvasStore.ts:299`); `fromObject`
  strips dangling on load (`boardSchema.ts:437`); duplicate KEEPS `previewSourceId` (`canvasStore.ts:320`).
- e2e: probes in `src/main/e2e/probes/`, load-bearing playlist `src/main/e2e/index.ts:59`, renderer
  hooks `window.__canvasE2E` (`src/renderer/src/smoke/e2eHooks.ts`); a final `seed` probe asserts the
  board count returned to baseline (probes must clean up).

## Decisions (defaults adopted unless flagged for confirmation)
- **A — Rendering (ADOPT):** keep the floating-derived edge approach; do NOT switch to RF
  `onConnect`/`onEdgesChange`. Orchestration edges derive from the `connectors` array (new pure
  `orchestrationEdges(connectors, boards)`), mirroring `previewEdges`. Reroute-for-free, no regression
  to the controlled-nodes/snap path.
- **C — Undo + autosave (ADOPT):** widen the history snapshot to `{boards, connectors}[]`
  (`history.ts` is generic `<T>` → only the store's type params + `trackedChange` body change). One
  atomic undo step covers a connector add/remove and rides with board steps. Extend the autosave
  dirty-predicate + `toObject` to include `connectors`.
- **D — Schema version (ADOPT, coordination flag):** M2 takes **v5**. draw.io D2/D3 + whiteboard
  tracks (all unstarted) also plan a bump → first-to-land takes v5, others rebase to v6+. Leave a
  claim comment at `SCHEMA_VERSION`. Migration `4→5` folds `previewSourceId` → a `preview` connector.
- **B — Model unification (✅ CONFIRMED 2026-06-03: dual-source):** `previewSourceId` stays the
  RUNTIME source of truth for preview links (push flow/picker/duplicate keep working → zero preview
  regression); `connectors` holds orchestration only in memory; the migration writes preview
  connectors into the persisted doc for completeness, `fromObject` folds them back.
- **E — Duplicate semantics (✅ CONFIRMED 2026-06-03: no inherited cables):** a duplicated board
  inherits NO orchestration edges (unlike `previewSourceId`, which is kept). An orchestration edge is a
  user-drawn relationship between two specific boards. Cheap to flip later.
- **Handle placement (✅ CONFIRMED 2026-06-03: title-bar control):** a connector handle in the
  BoardFrame title-bar control cluster (`BoardFrame.tsx:520`, sibling of maximize/⋯, reuse `IconBtn`),
  NOT a React Flow border `Handle`. Avoids native-view occlusion + RF connection-mode wiring. Gesture
  resolves the drop target from STORE geometry (`screenToFlowPosition` + board rects), not DOM
  hit-testing — which also sidesteps the synthetic-event CSS-transform hit-test problem in e2e.

## Tasks

### T2.1 — Connector data model + persistence (`feat/mcp-t2-1-connector-model`)
- `boardSchema.ts`: `ConnectorKind = 'preview'|'orchestration'`, `Connector {id,sourceId,targetId,kind}`;
  add `connectors: Connector[]` to `CanvasDoc`; `SCHEMA_VERSION=5` (+claim comment); `toObject` gains a
  `connectors` param; migration `4` (backfill `[]`, fold present+valid `previewSourceId`→preview
  connector with the stable `preview-<browserId>` id); `fromObject` defaults `[]`, `assertConnector`
  guard, strips dangling connectors, reconciles preview→`previewSourceId` (Decision B).
- `canvasStore.ts`: `connectors` state; widen `past/future` to `{boards,connectors}[]` + `trackedChange`
  (Decision C); `addConnector(s,t,kind)` (reject self-link / missing board / dup; returns id|null),
  `removeConnector(id)` (no-op guard), `removeBoard` drops incident connectors in the SAME step,
  `duplicateBoard` adds none; `toObject` re-derives preview+concats orchestration; `loadObject` sets
  `connectors`, resets history.
- `useAutosave.ts`: add `connectors` to the dirty predicate.
- **TDD first:** `boardSchema.test.ts` (migrate v4→v5 backfill + fold + dangling-strip + round-trip
  idempotent + `assertConnector` rejects), `canvasStore.test.ts` (add=1 undo step, self-link reject,
  dedupe, removeBoard one-step cleanup+undo restores both, duplicate=no connectors, dirty-on-add),
  extend `persistence.integration.test.ts` with a connector.
- e2e: add `addConnector`/`getConnectors` to `window.__canvasE2E`; probe `connector-roundtrip`
  (add→getConnectors reflects→`roundTripOk()`), clean up.

### T2.2 — Draw / delete connector gesture (`feat/mcp-t2-2-connector-gesture`)
- Connector handle in `BoardFrame` title bar → `onStartConnect(fromId,e)` threaded via
  `BoardActionsContext` (mirror `requestFullView`/`duplicate`/`remove`).
- Gesture in `CanvasInner`: pointerdown captures `fromId` + ephemeral "connecting" state (never
  persisted); rubber-band overlay; pointerup hit-tests pointer (flow coords) against store board rects
  → `addConnector(fromId, targetId, 'orchestration')`. Pure `resolveConnectTarget(boards, fromId,
  flowPoint)` (DOM-free, unit-tested).
- Delete: ✕ on the edge (`EdgeLabelRenderer` midpoint button → `removeConnector(id)`) + select-edge +
  Delete/Backspace (track `selectedConnectorId`, guard against board-delete double-fire).
- e2e probe `connector-draw-delete`: expose imperative `startConnect`/`completeConnectAt(flowX,flowY)`
  on the harness exercising the SAME resolution path; assert add, ✕-delete, and delete-board cleanup +
  undo restores both. Restore baseline.

### T2.3 — Typed edge render (`feat/mcp-t2-3-typed-edge-render`) — **the M2 gate**
- New pure `orchestrationEdges(connectors, boards)` (mirror `previewEdges.ts`; skip dangling) + test.
- Extract the shared floating-path helper out of `PreviewEdge.tsx` (`edges/floatingPath.ts`); new
  `edges/OrchestrationEdge.tsx` imports it; style distinct from the accent preview edge per DESIGN §7.3
  (`DESIGN.md:223` — ~2px neutral `--border-strong`/`--text-2`, distinct arrowhead; calm, no glow).
  Hosts the ✕ affordance.
- `Canvas.tsx`: register `orchestration` edge type; subscribe `connectors`; concat into the `edges`
  memo (preview decoration untouched).
- e2e: assert the orchestration edge renders with a distinct stroke vs preview, reroutes on board move,
  and **preview edges show no regression** (existing `preview-edge-stale`/`duplicate-keeps-link`/
  `preview-connect-gesture` stay green). Unit: `orchestrationEdges.test.ts`.

## M2 gate
Connectors persist, round-trip, are visually distinct from preview edges, and there is NO regression to
preview edges. Sets up M4 dispatch (T4.6) flowing along the orchestration cable.

## Critical files
`boardSchema.ts` · `canvasStore.ts` · `Canvas.tsx` · `edges/PreviewEdge.tsx`(+`floatingPath.ts`,
`OrchestrationEdge.tsx`) · `previewEdges.ts`(+`orchestrationEdges.ts`) · `useAutosave.ts` ·
`BoardFrame.tsx`+`boardActions.ts` · `smoke/e2eHooks.ts`+`main/e2e/probes/connectors.ts`+playlist ·
`index.css`/`DESIGN.md`.
