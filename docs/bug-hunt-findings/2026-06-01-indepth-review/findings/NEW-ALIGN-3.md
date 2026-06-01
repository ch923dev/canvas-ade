# NEW-ALIGN-3: zero-gap DistributionGuide renders degenerate connector and "0" pill

- **Severity:** Low
- **Category:** alignmentGuides
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/lib/alignmentGuides.ts`, `src/renderer/src/canvas/AlignmentGuides.tsx`
- **Assigned:** _(blank)_

## Summary
Both distribution snap cases (`bestDistribution`) use `>= 0` guards that allow a gap of exactly zero. When two neighboring boards are touching flush (no gap), `refGap = 0` (Case B) or `free = 0` (Case A) passes the guard, producing a `DistributionGuide` with `distance: 0`. In `AlignmentGuides.tsx`, each segment is rendered by `projectGapGuide`, which computes `half = distance / 2 = 0`. This collapses the connector to a zero-length segment (`ax === bx`, `ay === by`) and the pill renders at a point showing `Math.round(0) = "0"` — a degenerate visual that looks like a floating label with no connector or tick marks attached to anything.

## Where
`src/renderer/src/lib/alignmentGuides.ts`:

Case B right-end (line 242): `if (refGap >= 0)` — allows `refGap = 0`
```ts
const refGap = b.origin - (a.origin + a.size)
if (refGap >= 0) {
  const origin = b.origin + b.size + refGap
  consider(origin, {
    kind: 'distribute',
    axis,
    perp: perpOf(b),
    distance: refGap,   // ← can be 0
    ...
  })
}
```

Case A (line 216): `if (free >= 0)` — allows `free = 0`, so `gap = 0`:
```ts
const free = rNear - lFar - dragSize
if (free >= 0) {
  const gap = free / 2   // ← can be 0
  consider(origin, {
    kind: 'distribute',
    distance: gap,        // ← can be 0
    ...
  })
}
```

`src/renderer/src/canvas/AlignmentGuides.tsx`:46–51 (distribute segment conversion):
```ts
g.gaps.map((seg) => ({
  pos: (seg.from + seg.to) / 2,
  perp: g.perp,
  distance: seg.to - seg.from,   // ← 0 when gap is zero
  axis: g.axis
}))
```

`projectGapGuide` in `alignmentGuides.ts`:480–504:
```ts
const half = g.distance / 2   // ← 0
// For axis='x':
ax: (g.pos - half) * zoom + tx,  // = g.pos * zoom + tx
bx: (g.pos + half) * zoom + tx,  // = g.pos * zoom + tx  ← ax === bx (point)
```

## How it triggers
1. Two boards are placed exactly touching, e.g., board A at x=0..200, board B at x=200..300.
2. A third board is dragged near the snap target for Case B right-end (`origin = B.right + 0 = 300`).
3. `refGap = 0`, a `DistributionGuide` with `distance: 0` is produced.
4. `AlignmentGuides` renders a connector with `ax === bx` (zero length) and a pill showing "0".

Case A: board L at x=0..100, board R at x=200..300, dragged board width=100. `free = (200 - 100) - 100 = 0`. A guide fires with `distance: 0` and both gap segments having zero length.

## Verification evidence
`bestDistribution` Case B right-end guard (alignmentGuides.ts:242):
```ts
if (refGap >= 0) {
```

`bestDistribution` Case A guard (alignmentGuides.ts:216):
```ts
if (free >= 0) {
```

`projectGapGuide` (alignmentGuides.ts:483):
```ts
const half = g.distance / 2
if (g.axis === 'x') {
  const y = g.perp * zoom + ty
  return {
    ax: (g.pos - half) * zoom + tx,   // collapses to single point when half=0
    ay: y,
    bx: (g.pos + half) * zoom + tx,
    by: y,
    ...
    distance: g.distance              // 0 → pill shows "0"
  }
}
```

## Suggested fix direction
Change the guards from `>= 0` to `> 0` to skip the zero-gap case:

```ts
// Case B right-end (alignmentGuides.ts:242):
if (refGap > 0) {

// Case A (alignmentGuides.ts:216):
if (free > 0) {
```

A zero gap means boards are flush-touching: the correct guide is an `align` guide (edge-on-edge), not a distribution guide. The `bestAxisMatch` already handles that case (near-edge to near-edge alignment). Skipping zero-gap distribution snaps avoids the degenerate connector and the misleading "0" pill.

## Collision notes: TBD
