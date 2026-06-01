# NEW-ALIGN-4: Case B end-of-row distribution fires when dragged board still overlaps the rightmost neighbor

- **Severity:** Low
- **Category:** alignmentGuides
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/lib/alignmentGuides.ts`
- **Assigned:** _(blank)_

## Summary
The Case B "end-of-row rhythm" guard for the right-end checks `dragCenter > b.origin + b.size / 2` — i.e., the dragged board's center is past the CENTER of the rightmost neighbor `b`. The intent documented in the comment is "the board sits BEYOND the outermost neighbor on a side." However, when the dragged board's center is in the right half of `b` (past b's midpoint but before b's far edge), the dragged board is still partially overlapping `b`. In this position, producing a rhythm-distribution snap to `b.right + refGap` is semantically incorrect: the user is still inside `b`, not at the end of the row. The equivalent left-end check (`dragCenter < a2.origin + a2.size / 2`) has the same problem on the left side.

In practice this is mostly harmless because the snap target (`b.origin + b.size + refGap`) is far from the dragged position when it overlaps `b`, and `consider()` will reject candidates whose diff exceeds the threshold. However, with a small `refGap` and large dragged board, the snap target can be close enough to fire, producing a misleading distribution guide while the board visually overlaps `b`.

## Where
`src/renderer/src/lib/alignmentGuides.ts`:238–255:
```ts
const b = neighbors[neighbors.length - 1]
const a = neighbors[neighbors.length - 2]
if (dragCenter > b.origin + b.size / 2) {   // ← "past center of b", not "past far edge of b"
  const refGap = b.origin - (a.origin + a.size)
  if (refGap >= 0) {
    const origin = b.origin + b.size + refGap // dragged near-edge
    consider(origin, {
      kind: 'distribute',
      ...
    })
  }
}
```

Left-end (lines 257–274):
```ts
const a2 = neighbors[0]
const b2 = neighbors[1]
if (dragCenter < a2.origin + a2.size / 2) {   // ← "before center of a2", not "before near edge of a2"
```

## How it triggers
Concrete scenario that fires an erroneous guide:
- Board A at x=0..100, board B at x=200..300 (refGap=100 between them).
- Third board (dragSize=50) dragged so its center is at x=275 (inside B, in its right half).
- `dragCenter = 275 > b.origin + b.size / 2 = 250` → condition fires.
- Snap target `origin = 300 + 100 = 400`, diff = `|262.5 - 400| = 137.5` → exceeds threshold → rejected. (Safe with threshold=8.)
- BUT with a tiny refGap (e.g. refGap=5): snap target = `300 + 5 = 305`, dragOrigin = `275 - 25 = 250`, diff = `|250 - 305| = 55` → still exceeds threshold=8. Still safe.

The dangerous edge: refGap=0 (boards touching) AND dragSize large enough that dragOrigin is close to the snap target. E.g.: A at 0..100, B at 100..200 (touching), refGap=0, dragSize=200. DragCenter at B midpoint+1 = 151. DragOrigin = 51. Snap target = `200 + 0 = 200`. Diff = `|51 - 200| = 149` → rejected. In realistic board sizes (min 240px), refGap=0 snaps are blocked by the zero-gap issue (NEW-ALIGN-3).

The primary concern is correctness of the condition, not crash risk.

## Verification evidence
`bestDistribution` (alignmentGuides.ts:238–255):
```ts
if (dragCenter > b.origin + b.size / 2) {
```

The comment on line 237 says "dragged sits to the right of the rightmost neighbor" — but the condition only checks past b's midpoint. The analogous Figma/Canva behavior triggers distribution only when the dragged board is fully clear of the neighbor it would extend the rhythm beyond.

## Suggested fix direction
Change the condition to require the dragged board's center to be past the FAR EDGE of the rightmost neighbor:

```ts
// Right end: dragged is fully past (or at least centered past) the far edge of b.
if (dragCenter > b.origin + b.size) {
```

```ts
// Left end: dragged is fully past (or at least centered past) the near edge of a2.
if (dragCenter < a2.origin) {
```

This aligns the condition with the documented intent and prevents the distribution guide from firing while the board still visually overlaps the neighbor.

## Collision notes: TBD
