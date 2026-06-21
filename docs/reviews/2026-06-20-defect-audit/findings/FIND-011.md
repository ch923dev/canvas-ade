# FIND-011 — previewStore.byId entries leak on browser-board unmount and project switch — clear() has no production caller (monotonic growth per browser-board mount)

| | |
|---|---|
| **Severity** | Low |
| **Category** | resource leak |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/renderer/src/canvas/boards/useOffscreenPreview.ts:173-181` |
| **Discovery slice** | R-STORE (run 1) |

## Summary
previewStore.clear(boardId) is never invoked anywhere in production code (verified by grep: only the test files reference clear). useOffscreenPreview's unmount cleanup closes the offscreen window (window.api.closeOsrPreview) but does NOT remove the board's previewStore.byId entry. Every Browser board that ever mounts calls usePreviewStore.patch(boardId,{status:'connecting'}) (line 121), which creates an entry; nothing ever deletes it. canvasStore.removeBoard does not clear it, and applyLoadedDoc (the project-switch reset path) resets canvasStore + commandStore but never touches previewStore — so byId also accumulates stale entries from every previously-opened project across project switches. This is monotonic growth bounded only by total browser-board mounts over the app's lifetime. It directly contradicts the store's own stated design: previewStore.ts lines 53-57 say patchIfPresent exists so a late event 'after the board was deleted (clear already ran)' can't resurrect a 'cleared, never-cleaned-up orphan entry (Bug #32)' — i.e. the team intended clear() to run on deletion, but it does not. The sibling runtime stores follow the correct pattern: terminalRuntimeStore is cleared on unmount in useTerminalSpawn.ts:265, and osrWidgetStore is cleared on unmount in useOsrWidgetEvents.ts:32 — useOffscreenPreview is the lone omission. No functional corruption results because board ids are UUIDs (never reused, so a fresh board defaults to idle), but it is a real unbounded leak.

## Trigger
Open/close many Browser boards, or switch projects repeatedly with Browser boards present. Each browser-board mount adds a permanent previewStore.byId[uuid] entry; deleting the board or switching projects leaves the entry behind forever. Over a long session the byId record grows without bound.

## Evidence / concrete faulty path (code-grounded)
CONFIRMED leak path: (1) BrowserBoard.tsx:147 `useOffscreenPreview(board.id, board.url, osrCanvasRef)` mounts for every browser board. (2) useOffscreenPreview.ts:121 `usePreviewStore.getState().patch(boardId, { status: 'connecting', error: null })` — patch creates the byId entry (previewStore.ts:70-73 spreads DEFAULT_RUNTIME into a new byId[id]). (3) Unmount cleanup useOffscreenPreview.ts:173-181 returns `() => { off(); offEvent(); if (rafId) cancelAnimationFrame(rafId); queue = []; void window.api.closeOsrPreview(boardId) }` — no previewStore.clear(boardId). (4) Grep `\.clear\(` / `byId:\s*\{\}` shows previewStore.clear and byId-reset ONLY in *.test.ts. (5) removeBoard (canvasStore.ts:665-718) and applyLoadedDoc (canvasStore.ts:467-492) never reference previewStore. Contrast: useTerminalSpawn.ts:265 `useEffect(() => () => useTerminalRuntimeStore.getState().clear(board.id), [board.id])` and useOsrWidgetEvents.ts:32 `useOsrWidgetStore.getState().clearBoard(boardId)`. Manifests as: open/close N browser boards or switch projects with browser boards → previewStore.byId grows by one permanent entry per browser-board mount, never freed for the app session. No user-visible corruption (UUID keys never collide); pure slow memory growth.

## Verifier reasoning (why CONFIRMED; scope & severity)
Verified every claim against the actual code. previewStore.clear() (previewStore.ts:76-82) has zero production callers — grep across all .ts/.tsx shows it referenced ONLY in previewStore.test.ts. Every Browser board mount creates a byId entry: BrowserBoard.tsx:147 unconditionally calls useOffscreenPreview(board.id,...), which at useOffscreenPreview.ts:121 calls usePreviewStore.getState().patch(boardId,{status:'connecting'}) — patch is create-if-absent (previewStore.ts:70-73). The unmount cleanup (useOffscreenPreview.ts:173-181: off(); offEvent(); cancelAnimationFrame; queue=[]; closeOsrPreview(boardId)) closes the offscreen window but never removes the byId entry. No deletion path exists: removeBoard (canvasStore.ts:665-718) filters boards/connectors/groups/selection and parks the idle-terminal flag but never touches previewStore; the removal pre-step planner planNodeRemovalCleanup (canvasDecisions.ts:56-65) only tears down full-view state; applyLoadedDoc (canvasStore.ts:467-492, the project-switch reset) resets boards/connectors/groups/viewport + commandStore but never previewStore, so entries also survive project switches. The only byId:{} resets are the store initializer (previewStore.ts:69) and test setup. Sibling runtime stores DO clean up on unmount (useTerminalSpawn.ts:265 clears terminalRuntimeStore; useOsrWidgetEvents.ts:32 clears osrWidgetStore), confirming useOffscreenPreview is the lone omission, and the store's own comment (previewStore.ts:51-57) documents the intended contract that clear() runs on deletion. Not tracked by the 2026-06-19 feature audit (no previewStore/orphan entry in REPORT.md). It is a real, monotonic, unbounded leak in browser-board-mount count. Severity stays Low: board ids are UUIDs (never reused) so orphan entries never cause functional corruption — a fresh board re-patches to connecting and stale entries are merely unread dead weight — and each entry is a tiny fixed-shape 5-field object. In scope as a genuine resource/memory-leak defect (not a perf-re-render/a11y/styling/UX item).

## Fix direction (audit only — NOT applied)
Call previewStore.clear(boardId) in the useOffscreenPreview unmount cleanup (mirror terminalRuntimeStore/osrWidgetStore), and reset previewStore in applyLoadedDoc on project switch, so byId does not grow monotonically per browser-board mount.

## Files this card touches
- `src/renderer/src/canvas/boards/useOffscreenPreview.ts (mount 121; unmount cleanup 173-181)`
- `src/renderer/src/store/previewStore.ts (clear has no prod caller)`
- `src/renderer/src/store/canvasStore.ts (applyLoadedDoc)`

## Collision flags (sequence with)
- None — independently fixable in parallel.
