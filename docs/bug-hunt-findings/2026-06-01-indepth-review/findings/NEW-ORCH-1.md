# NEW-ORCH-1: Keyboard-delete of the full-view board leaves fullViewEntering/fullViewClosing stale

- **Severity:** Low
- **Category:** full-view portal/LOD
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`
- **Assigned:** _(blank)_

## Summary
When the user deletes a board via the keyboard delete key (Backspace/Delete) while that board is in full view, the `onNodesChange` handler calls `removeBoard` but does NOT call `hardCloseFullView()`. The `boards` effect (line 427–432) then fires, calls `setFullViewId(null)` (because the board is gone from `boards`), and unmounts `FullViewModal`. However, `fullViewClosing` and `fullViewEntering` are never cleared. After the deletion, `CanvasInner` holds stale `fullViewClosing` or `fullViewEntering` state. The next call to `openFullView` correctly resets `fullViewClosing=false` and `fullViewEntering=true`, masking the issue for the common case — but `fullViewEntering` stuck `true` during the gap between deletion and the next open means `fullViewMotion` is `true`, so `BrowserPreviewLayer`'s full-view rAF tick (line 673) skips the native-view attach for a single frame-batch. For Terminal and Planning boards the stale flags are cosmetically harmless. The mismatch is a code-correctness defect that can interact poorly with rapid open-after-delete sequences.

## Where
`src/renderer/src/canvas/Canvas.tsx`:282–290 — the `onNodesChange` remove branch:

```ts
} else if (intent.kind === 'remove') {
  const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
  if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
  removeBoard(intent.id)
  setFocusedId((f) => (f === intent.id ? null : f))
  // hardCloseFullView() is NOT called here
}
```

Contrast with the `boardActions.remove` path at line 389–394 which DOES check and call `hardCloseFullView()`:

```ts
remove: (id) => {
  ...
  if (fullViewIdRef.current === id) hardCloseFullView()
  removeBoard(id)
  ...
}
```

The stale-flag cleanup in the `boards` effect at line 427–432 only clears `fullViewId`, not the motion flags:

```ts
setFullViewId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
// fullViewClosing and fullViewEntering are NOT touched here
```

## How it triggers
1. Open any board in full view (or start closing it so `fullViewClosing=true`).
2. Press Backspace or Delete to remove the full-view board.
3. `onNodesChange` fires the remove path, calling `removeBoard` without `hardCloseFullView`.
4. `boards` effect clears `fullViewId` but leaves `fullViewClosing`/`fullViewEntering` at their prior values.
5. If `fullViewEntering` was `true` (deleted during enter animation), `fullViewMotion` stays `true` even though no modal is open, causing the next Browser board opened in full view to have its native view attach deferred by `BrowserPreviewLayer`'s motion guard until `openFullView` resets the flag.

## Verification evidence
`onNodesChange` remove branch (Canvas.tsx:282–290) — no `hardCloseFullView()` call:
```ts
} else if (intent.kind === 'remove') {
  const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
  if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
  removeBoard(intent.id)
  setFocusedId((f) => (f === intent.id ? null : f))
}
```

`boardActions.remove` (Canvas.tsx:389–394) — guarded version that DOES exist:
```ts
remove: (id) => {
  const removed = useCanvasStore.getState().boards.find((x) => x.id === id)
  if (removed?.type === 'terminal') void window.api.parkTerminal(id)
  if (fullViewIdRef.current === id) hardCloseFullView()
  removeBoard(id)
  setFocusedId((f) => (f === id ? null : f))
},
```

`boards` effect (Canvas.tsx:427–432) — does NOT clear motion flags:
```ts
useEffect(() => {
  setFocusedId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
  setFullViewId((f) => (f !== null && !boards.some((b) => b.id === f) ? null : f))
}, [boards])
```

## Suggested fix direction
In the `onNodesChange` remove branch, add the same guard that `boardActions.remove` uses:

```ts
} else if (intent.kind === 'remove') {
  const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
  if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
  if (fullViewIdRef.current === intent.id) hardCloseFullView()
  removeBoard(intent.id)
  setFocusedId((f) => (f === intent.id ? null : f))
}
```

Since `hardCloseFullView` is `useCallback(..., [])` (stable), it must also be added to the `onNodesChange` deps array. Alternatively, consolidate the removal logic from both paths into a shared helper.

## Collision notes: TBD
