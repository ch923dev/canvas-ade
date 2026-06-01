# NEW-ALIGN-2: resize-end cleanup paths never clear overlap tints

- **Severity:** Low
- **Category:** alignmentGuides
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`
- **Assigned:** _(blank)_

## Summary
The three resize-guide cleanup branches in `onNodesChange` (resize suppressed, resize settled) all call `setGuides(...)` but never call `setOverlaps(...)`. While `computeResizeSnap` does not produce overlaps, these branches also serve as the canonical "end of resize" state cleanup. If overlap tints are somehow present when a resize gesture starts (e.g., a drag was interrupted without a clean drag-stop), they will outlive the resize gesture entirely — the only remaining clear path is `onNodeDragStop`, which React Flow will not fire after a resize.

## Where
`src/renderer/src/canvas/Canvas.tsx`:263–273:
```ts
setGuides(snap.guides)
// ← no setOverlaps(...) here for the active-resize path

} else if (resizing) {
  // Resizing but suppressed (Ctrl/⌘ held mid-gesture) → clear guides, mirroring the drag pass.
  setGuides((g) => (g.length ? [] : g))
  // ← no setOverlaps(...)

} else if (changes.some((c) => c.type === 'dimensions' && c.resizing === false)) {
  // Resize settled → clear.
  setGuides((g) => (g.length ? [] : g))
  // ← no setOverlaps(...)
}
```

Compare with `onNodeDragStop` (Canvas.tsx:339–343), which correctly pairs both:
```ts
setGuides((g) => (g.length ? [] : g))
setOverlaps((o) => (o.length ? [] : o))
```

## How it triggers
The most plausible path:
1. A board drag produces overlap tints (a board is on top of another).
2. The user releases the drag handle while the cursor is over a resize handle; React Flow fires `onNodeDragStop` normally and clears overlaps. This is the common path and works correctly.

Edge path where it fails:
1. A drag starts, overlap tints appear.
2. Due to a programmatic `boards` mutation (undo, remove, project switch), `onNodeDragStop` is never called because React Flow's drag state is reset from outside, not from a gesture end event.
3. The user then resizes a board; the active-resize path sets guides but never clears the stale overlaps.
4. When resize ends (resizing:false), overlaps remain until the next `onNodeDragStop` (which may never fire).

## Verification evidence
Full set of resize-path guide/overlap update calls in `onNodesChange` (Canvas.tsx):

Active resize (line 263): `setGuides(snap.guides)` — no `setOverlaps`

Suppressed resize (lines 265–267):
```ts
} else if (resizing) {
  setGuides((g) => (g.length ? [] : g))
}
```

Resize settled (lines 268–272):
```ts
} else if (changes.some((c) => c.type === 'dimensions' && c.resizing === false)) {
  setGuides((g) => (g.length ? [] : g))
}
```

None of these three branches mirror the `onNodeDragStop` pattern of clearing overlaps alongside guides.

## Suggested fix direction
Mirror the `onNodeDragStop` pattern in all three resize cleanup branches:

```ts
// Active resize:
setGuides(snap.guides)
setOverlaps((o) => (o.length ? [] : o))   // resize never produces overlaps; defensive clear

// Suppressed:
} else if (resizing) {
  setGuides((g) => (g.length ? [] : g))
  setOverlaps((o) => (o.length ? [] : o))

// Settled:
} else if (changes.some((c) => c.type === 'dimensions' && c.resizing === false)) {
  setGuides((g) => (g.length ? [] : g))
  setOverlaps((o) => (o.length ? [] : o))
}
```

## Collision notes: TBD
