# NEW-ORCH-3: duplicate action unconditionally calls hardCloseFullView — exits full view when duplicating any board, not just the full-view one

- **Severity:** Low
- **Category:** full-view portal/LOD
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`
- **Assigned:** _(blank)_

## Summary
The `boardActions.duplicate` handler in the `useMemo` block (Canvas.tsx:385–388) calls `hardCloseFullView()` unconditionally before `duplicateBoard(id)`:

```ts
duplicate: (id) => {
  hardCloseFullView()
  duplicateBoard(id)
},
```

The `hardCloseFullView()` call has no guard on whether `id === fullViewIdRef.current`. This means that duplicating ANY board while a DIFFERENT board is in full view immediately closes the full view — even though the duplicated board is unrelated to the one being viewed.

By contrast, the `remove` action at line 389–394 correctly guards with `if (fullViewIdRef.current === id) hardCloseFullView()`.

## Where
`src/renderer/src/canvas/Canvas.tsx`:385–388:
```ts
duplicate: (id) => {
  hardCloseFullView()    // ← called regardless of whether id === fullViewIdRef.current
  duplicateBoard(id)
},
```

`boardActions.remove` at line 389–394 for comparison (guarded):
```ts
remove: (id) => {
  ...
  if (fullViewIdRef.current === id) hardCloseFullView()
  removeBoard(id)
  ...
},
```

## How it triggers
1. User opens Board A in full view (e.g., a Planning board with notes, or a Terminal).
2. User opens the ⋯ menu on Board B (a different board visible on canvas) and selects "Duplicate".
3. `boardActions.duplicate('B')` fires. `hardCloseFullView()` is called. Board A exits full view instantly (no animation).
4. Board B is duplicated as expected, but the user is surprised to find Board A's full view has been dismissed.

## Verification evidence
`boardActions` memo (Canvas.tsx:354–403). The `duplicate` entry at line 385–388:
```ts
duplicate: (id) => {
  hardCloseFullView()
  duplicateBoard(id)
},
```

There is no `if (fullViewIdRef.current === id)` guard, unlike `remove`:
```ts
remove: (id) => {
  const removed = useCanvasStore.getState().boards.find((x) => x.id === id)
  if (removed?.type === 'terminal') void window.api.parkTerminal(id)
  if (fullViewIdRef.current === id) hardCloseFullView()   // guarded
  removeBoard(id)
  setFocusedId((f) => (f === id ? null : f))
},
```

## Suggested fix direction
Add the same guard as `remove`:

```ts
duplicate: (id) => {
  if (fullViewIdRef.current === id) hardCloseFullView()
  duplicateBoard(id)
},
```

Rationale: Duplicating the full-view board itself could close the view (the duplicate lands offset on canvas, the original stays in the modal — this is ambiguous UX, so closing the full view is defensible). But duplicating a completely unrelated board must not dismiss an active full view.

## Collision notes: TBD
