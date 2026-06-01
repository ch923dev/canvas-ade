# NEW-ALIGN-1: stale overlap tints persist when dragged board is removed from store mid-drag

- **Severity:** Low
- **Category:** alignmentGuides
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`
- **Assigned:** _(blank)_

## Summary
In the drag-snap pass inside `onNodesChange`, both `setGuides` and `setOverlaps` are only called when `boards.find((b) => b.id === single.id)` succeeds. If the board being dragged disappears from the store mid-gesture (e.g., an undo fires while the board is dragged), neither state update runs and the guides/overlaps from the preceding frame are left on screen. They persist until `onNodeDragStop` fires (which React Flow will eventually send when the drag gesture ends). In the interim, alignment guide lines and overlap tint rects remain visible even though no snap is active.

## Where
`src/renderer/src/canvas/Canvas.tsx`:211–223:
```ts
if (single && single.type === 'position' && single.position && !snapSuppressRef.current) {
  const dragged = boards.find((b) => b.id === single.id)
  if (dragged) {
    // ...
    setGuides(snap.guides)
    setOverlaps(snap.overlaps)
  }
  // ← no `else` to clear guides/overlaps when dragged is not found
}
```

`onNodeDragStop` (Canvas.tsx:339–343) is the only other clear path:
```ts
const onNodeDragStop = useCallback(() => {
  setNodeGesture(false)
  setGuides((g) => (g.length ? [] : g))
  setOverlaps((o) => (o.length ? [] : o))
}, [setNodeGesture])
```

## How it triggers
1. User starts dragging a board that triggers alignment guides (overlaps are visible).
2. While still holding the mouse, the user triggers undo via Ctrl+Z (keyboard shortcut is live during drag — no guard prevents it).
3. The undo removes the board from `useCanvasStore`, so `boards.find(...)` returns `undefined` on the very next `onNodesChange` call React Flow fires.
4. The `if (dragged)` block is skipped: `setGuides` and `setOverlaps` are NOT called.
5. Guides and overlap tints remain visible even though the snap pass did not run.

## Verification evidence
`onNodesChange` drag-snap block (Canvas.tsx:209–228):
```ts
const active = changes.filter((c) => c.type === 'position' && c.dragging)
const single = active.length === 1 ? active[0] : null
if (single && single.type === 'position' && single.position && !snapSuppressRef.current) {
  const dragged = boards.find((b) => b.id === single.id)
  if (dragged) {
    const others = boards
      .filter((b) => b.id !== single.id)
      .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
    const rect = { x: single.position.x, y: single.position.y, w: dragged.w, h: dragged.h }
    const snap = computeAlignment(rect, others, SNAP_THRESHOLD_PX / rf.getZoom())
    single.position.x = snap.x
    single.position.y = snap.y
    setGuides(snap.guides)
    setOverlaps(snap.overlaps)
  }
  // no else — guides/overlaps from the prior frame remain
} else if (active.length > 0) {
  // Dragging but suppressed or multi-select → no guides/overlaps (no-op if already empty).
  setGuides((g) => (g.length ? [] : g))
  setOverlaps((o) => (o.length ? [] : o))
}
```

The `else if` on line 224 only clears when `active.length > 0` AND `single` is null (multi-select or suppressed). It does NOT cover the case where `single` is non-null but `dragged` is undefined.

## Suggested fix direction
Add an `else` branch inside the `if (single...)` block when `dragged` is not found:

```ts
if (dragged) {
  // ... snap and set ...
} else {
  // Board gone from store mid-drag — clear any stale guides/overlaps.
  setGuides((g) => (g.length ? [] : g))
  setOverlaps((o) => (o.length ? [] : o))
}
```

## Collision notes: TBD
