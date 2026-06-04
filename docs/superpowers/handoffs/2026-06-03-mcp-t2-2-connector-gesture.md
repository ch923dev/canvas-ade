# Handoff — MCP M2 T2.2: Draw / delete connector gesture

- **Date:** 2026-06-03
- **Branch:** `feat/mcp-t2-2-connector-gesture` (off `feat/mcp-integration`) → squash-merge to umbrella when green.
- **Milestone:** M2 (Spatial connectors). T2.2 of T2.1→T2.2→T2.3.
- **Status:** gate green (typecheck/lint/format/670 unit/build); local e2e connector probes green (see e2e note).

## What shipped

Interactive draw + delete for orchestration connectors, on top of T2.1's data model.

### Pure core — `src/renderer/src/lib/resolveConnectTarget.ts` (+ test)
`resolveConnectTarget(boards, fromId, flowPoint)` — DOM-free hit-test in FLOW coords: returns the
topmost board (higher `z`, then later array order) containing the point, never the source (no
self-link), null over empty canvas. Both the real pointer gesture AND the e2e harness resolve through
this exact function (sidesteps the synthetic-event CSS-transform hit-test problem, memory
`e2e-sendinputevent-vs-dispatchevent`).

### Title-bar connector handle
- `Icon.tsx`: new `connector` glyph (two node rings + a diagonal link).
- `BoardFrame.tsx`: `IconBtn` gains an optional `onPointerDown` (press-to-drag start — fires before
  click/long-press timing so a press-drag-release that ends off the button still begins the gesture).
  New `onStartConnect?` prop renders a connector `IconBtn` in the pinned controls (sibling of
  maximize/⋯), hidden in full view.
- `boardActions.ts`: `BoardActions.startConnect(fromBoardId)`. `BoardNode.tsx` builds it per id and
  threads it through the shared `actions` into all three board types (`Terminal`/`Browser`/`Planning`
  each pass `onStartConnect` to their `BoardFrame`).

### Gesture + render + delete — `Canvas.tsx`
- Ephemeral `connectFromId`/`connectPointer` state (NEVER persisted — scene/session split). `startConnect`
  arms the drag; a window `pointermove`/`pointerup` effect tracks the rubber-band and, on release,
  `resolveConnectTarget(...)` → `addConnector(from, target, 'orchestration')`.
- Rubber-band overlay: a `position:fixed` dashed SVG line (source-center → pointer), client-coordinate
  space (no pane-rect/ref read in render).
- Orchestration edges concatenated into the `edges` memo (kind `orchestration`, dangling-skipped),
  rendered by new `edges/OrchestrationEdge.tsx` (floating geometry; calm neutral ~2px stroke, distinct
  from the accent preview edge; hosts a midpoint ✕ via `EdgeLabelRenderer`, shown when selected).
- Delete: `selectedConnectorId` + `onEdgeClick` (selecting a connector clears the board selection so
  RF's `deleteKeyCode` can't double-delete a board) + a Delete/Backspace effect + the edge ✕.
  `clearSelection` also clears the connector selection.

### e2e
- `e2eHooks.ts`: `startConnect`/`completeConnectAt(flowX,flowY)` (same resolution path) + `selectConnector`
  (via a new `E2EHostHooks.selectConnector` → CanvasInner `setSelectedConnectorId`).
- `probes/connectors.ts`: new `connectorDrawDelete` — draw via `completeConnectAt`, ✕-delete (select →
  midpoint ✕ visible → click), and `removeBoard` drops the incident cable + `undo` restores both. Restores
  baseline (seed stays 4). Registered after `connectorRoundtrip`.

## ⚠️ NOTE for T2.3 (the gate)
- `OrchestrationEdge.tsx` currently **duplicates** PreviewEdge's `box`/`borderPoint`/`edgePositions`
  geometry inline. T2.3 must **extract `edges/floatingPath.ts`** shared by both edges (the plan's
  extraction step) + finalize DESIGN §7.3 styling.
- The orchestration edge mapping is **inline** in Canvas's `edges` memo. T2.3 replaces it with the pure
  `orchestrationEdges(connectors, boards)` module + unit test.
- T2.3 gate probes: distinct stroke vs preview, reroute-on-move, and **preview edges no regression**
  (the PreviewEdge refactor must keep `preview-edge-stale`/`duplicate-keeps-link`/`preview-connect-gesture`
  green).

## Verify
```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; CANVAS_SMOKE=e2e pnpm start   # connector-roundtrip + connector-draw-delete ok
```
