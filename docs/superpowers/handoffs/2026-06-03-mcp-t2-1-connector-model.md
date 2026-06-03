# Handoff — MCP M2 T2.1: Connector data model + persistence

- **Date:** 2026-06-03
- **Branch:** `feat/mcp-integration` (squash-merged `b90be53`; sub-branch `feat/mcp-t2-1-connector-model` deleted)
- **Milestone:** M2 (Spatial connectors) — renderer/state-only. T2.1 of T2.1→T2.2→T2.3.
- **Status:** ✅ DONE. Gate green; local board e2e `E2E_DONE ok:true` (47/47).

## What shipped

The persisted connector substrate M2 builds on — a typed board↔board edge model that
generalizes the preview link, plus the undo/autosave plumbing to carry it.

### `src/renderer/src/lib/boardSchema.ts`
- `ConnectorKind = 'preview' | 'orchestration'`, `Connector {id, sourceId, targetId, kind}`.
- `connectors: Connector[]` added to `CanvasDoc` (**required**).
- `SCHEMA_VERSION 4 → 5` + a claim comment (draw.io D2/D3 + whiteboard rebase to v6+).
- `MIGRATIONS[4]`: backfills `connectors`, folds each Browser's present+valid
  `previewSourceId` → a `preview` connector with the **stable id `preview-<browserId>`**
  (matches PreviewEdge's edge id) via the new pure `previewConnectorsFor(boards)`.
- `toObject(boards, viewport, connectors = [])` — 3rd param optional (back-compat for the
  many 2-arg callers/tests); deep-clones connectors.
- `assertConnector` (validates id/sourceId/targetId strings + known kind) + a new
  `reconcileConnectors(doc)` run inside `fromObject` post-migrate: validates, **strips
  danglers** (an endpoint board absent), **folds `preview` connectors back into
  `previewSourceId`** and drops them — only `orchestration` connectors load into memory
  (Decision B, dual-source).

### `src/renderer/src/store/canvasStore.ts`  ⚠️ undo-rail-sensitive
- `connectors: Connector[]` state (orchestration only in memory).
- Undo rail widened `Board[][]` → `CanvasSnapshot[]` where `CanvasSnapshot = {boards, connectors}`
  (Decision C). `history.ts` is generic `<T>` — **unchanged**.
- `trackedChange` now takes `{boards?, connectors?}` and pushes a `{boards, connectors}`
  checkpoint; `lastRecorded: CanvasSnapshot | null`; new `sameSnapshot(snap, s)` compares
  BOTH refs (a connector-only edit changes `connectors` only). beginChange/undo/redo
  rewritten over snapshots. **Phantom-step discipline preserved** (memory
  `undo-lastrecorded-phantom`): add/remove/connector ops pass `reflectPresent:false`
  (granular-undoable, tolerated post-no-op phantom); tidy/tile keep `true`.
- `addConnector(s,t,kind)` — rejects self-link / missing endpoint / exact dup; returns id|null;
  one tracked step; leaves `boards` ref untouched. `removeConnector(id)` — no-op on unknown.
- `removeBoard` drops incident connectors **in the same trackedChange step** (one undo
  restores board + cables). `duplicateBoard` inherits **none** (Decision E).
- `toObject` re-derives preview (`previewConnectorsFor`) + concats orchestration.
  `loadObject`/`applyOpenResult` set `connectors` from the doc + reset history.

### `src/renderer/src/store/useAutosave.ts`
- Dirty predicate watches `connectors` (its own ref — a cable add/remove leaves `boards` alone).

### e2e
- `e2eHooks.ts`: `addConnector` / `getConnectors` / `removeConnector` / `serializedConnectorCount`.
- New `src/main/e2e/probes/connectors.ts` → `connectorRoundtrip` (add → reflected → survives
  serialize round-trip → remove restores baseline). Registered after `previewConnectGesture`
  in the playlist; cleans up (connectors don't change the seed-4 board count).

## Tests (TDD-first, all green)
- `boardSchema.test.ts`: previewConnectorsFor, migrate 4→5 (backfill/fold/dangling), fromObject
  dual-source reconciliation (fold-back, orchestration round-trip, dangling-strip, idempotent),
  assertConnector rejects. Plus the v4→v5 bump edits to the existing version-assert tests.
- `canvasStore.test.ts`: add=1 step, self-link/missing/dupe reject, undo/redo, removeConnector,
  removeBoard one-step incident cleanup + undo restores both, duplicate=no cables, toObject
  derive+concat, loadObject.
- `persistence.integration.test.ts`: orchestration survives reopen; preview folds via previewSourceId.

## Verify
```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build   # all green (663 unit)
pnpm build; CANVAS_SMOKE=e2e pnpm start   # E2E_DONE ok:true, connector-roundtrip ok, preview probes no regression
```

## For T2.2 (draw/delete gesture)
- The store API is ready: `addConnector(fromId, targetId, 'orchestration')` + `removeConnector(id)`.
- `connectors` is live state to subscribe to in Canvas; `previewConnectorsFor` is the pattern to
  mirror for `orchestrationEdges` in T2.3.
- Keep the in-flight "connecting" gesture EPHEMERAL (React/Zustand only) — never into `connectors[]`
  (scene/session split; the `toObject` comment spells this out).
