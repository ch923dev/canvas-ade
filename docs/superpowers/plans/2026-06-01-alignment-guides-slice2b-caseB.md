# Smart Alignment Guides — Slice 2b Case B (End-of-row rhythm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. BUILDS ON all prior slices.
> Single pure-logic change: replace `bestDistribution` in `lib/alignmentGuides.ts`. No overlay,
> no Canvas, no CSS change — the new behavior reuses the existing `distribute` guide.

**Goal:** When dragging a board PAST THE END of a row/column of evenly-spaced boards, snap it so the
new gap equals the existing adjacent gap (extend the rhythm), drawing both equal gap segments — the
Figma "equal spacing at the end of a row" behavior. Complements Case A (centered between two).

**Architecture:** Extend the pure `bestDistribution` to also try a Case B candidate: if the dragged
board sits beyond the outermost perpendicular-neighbor on a side and there are ≥2 neighbors, measure
the reference gap between the two outermost neighbors and snap so the dragged board reproduces it.
Both Case A and Case B emit the existing `DistributionGuide` (`kind:'distribute'`); a local `consider`
picks the smallest-diff candidate. `computeAlignment`/`pickAxis`/the overlay are unchanged.

**Tech Stack:** TypeScript (strict), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-alignment-guides.md`.

---

## File Structure

- **Modify** `src/renderer/src/lib/alignmentGuides.ts` — replace `bestDistribution` (Case A + Case B).
- **Modify** `src/renderer/src/lib/alignmentGuides.test.ts` — Case B tests.

---

### Task 1: Extend `bestDistribution` with end-of-row rhythm (Case B)

**Files:**
- Modify: `src/renderer/src/lib/alignmentGuides.ts`
- Test: `src/renderer/src/lib/alignmentGuides.test.ts`

- [ ] **Step 1: Add the failing tests**

Append:

```ts
describe('computeAlignment — end-of-row rhythm distribution (Case B)', () => {
  const N0 = { x: 0, y: 0, w: 100, h: 100 }
  const N1 = { x: 200, y: 0, w: 100, h: 100 } // gap 100 between N0.right(100) and N1.left(200)

  test('snaps a board past the RIGHT end to match the existing gap', () => {
    // refGap = N1.left(200) - N0.right(100) = 100. origin = N1.right(300) + 100 = 400. approach 398.
    const r = computeAlignment({ x: 398, y: 0, w: 100, h: 100 }, [N0, N1], 8)
    expect(r.x).toBe(400)
    const d = r.guides.find((g) => g.kind === 'distribute')
    expect(d).toBeDefined()
    if (d && d.kind === 'distribute') {
      expect(d.distance).toBe(100)
      expect(d.gaps).toHaveLength(2)
      expect(d.gaps).toContainEqual({ from: 100, to: 200 }) // reference gap (N0↔N1)
      expect(d.gaps).toContainEqual({ from: 300, to: 400 }) // new equal gap (N1↔dragged)
    }
  })

  test('snaps a board past the LEFT end to match the existing gap', () => {
    const A = { x: 200, y: 0, w: 100, h: 100 }
    const B = { x: 400, y: 0, w: 100, h: 100 } // refGap = 400 - 300 = 100
    // origin = A.left(200) - refGap(100) - w(100) = 0. approach at 3.
    const r = computeAlignment({ x: 3, y: 0, w: 100, h: 100 }, [A, B], 8)
    expect(r.x).toBe(0)
    expect(r.guides.some((g) => g.kind === 'distribute' && g.distance === 100)).toBe(true)
  })

  test('no rhythm snap beyond the threshold', () => {
    const r = computeAlignment({ x: 380, y: 0, w: 100, h: 100 }, [N0, N1], 8) // target 400, diff 20
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('no rhythm with only one neighbor', () => {
    const r = computeAlignment({ x: 398, y: 0, w: 100, h: 100 }, [N0], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('ignores non-neighbors (no perpendicular overlap)', () => {
    const far = { x: 200, y: 500, w: 100, h: 100 }
    const r = computeAlignment({ x: 398, y: 0, w: 100, h: 100 }, [N0, far], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('still centers between two (Case A) when the board is between them', () => {
    // regression: between N0(0..100) and a board at 400..500 → centered, not rhythm.
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [N0, { x: 400, y: 0, w: 100, h: 100 }], 8)
    expect(r.x).toBe(200)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — the two rhythm-snap cases produce no `distribute` guide.

- [ ] **Step 3: Replace `bestDistribution` entirely**

Replace the whole existing `bestDistribution` function (the doc-comment + body) with:

```ts
/**
 * Best equal-spacing distribution match on one axis. Two cases, whichever snaps closest:
 *  - Case A (centered): the board has an immediate perpendicular-neighbor on EACH side with room
 *    between them → the position that makes both side gaps equal.
 *  - Case B (end-of-row rhythm): the board sits BEYOND the outermost neighbor on a side and there
 *    are ≥2 neighbors → snap so the new gap equals the existing gap between the two outermost
 *    neighbors (extending an even row/column). Both emit a `distribute` guide. `others` is the
 *    axis-mapped neighbor list.
 */
function bestDistribution(
  axis: 'x' | 'y',
  dragOrigin: number,
  dragSize: number,
  dragPerpMin: number,
  dragPerpMax: number,
  others: OtherAxis[],
  threshold: number
): AxisMatch | null {
  const neighbors = others
    .filter((o) => rangesOverlap(dragPerpMin, dragPerpMax, o.perpMin, o.perpMax))
    .sort((a, b) => a.origin - b.origin)

  let best: AxisMatch | null = null
  const consider = (origin: number, guide: DistributionGuide): void => {
    const diff = Math.abs(dragOrigin - origin)
    if (diff > threshold) return
    if (best && diff >= best.diff) return
    best = { diff, origin, guide }
  }
  // Perp anchor: center of the shared perpendicular overlap of the dragged board and `o`.
  const perpOf = (o: OtherAxis): number => {
    const pMin = Math.max(dragPerpMin, o.perpMin)
    const pMax = Math.min(dragPerpMax, o.perpMax)
    return pMin < pMax ? (pMin + pMax) / 2 : (dragPerpMin + dragPerpMax) / 2
  }

  const dragCenter = dragOrigin + dragSize / 2

  // ── Case A: centered between the immediate left + right neighbors ───────────────
  let L: OtherAxis | null = null
  let R: OtherAxis | null = null
  for (const o of neighbors) {
    const oCenter = o.origin + o.size / 2
    if (oCenter < dragCenter) {
      if (!L || o.origin + o.size > L.origin + L.size) L = o
    } else if (oCenter > dragCenter) {
      if (!R || o.origin < R.origin) R = o
    }
  }
  if (L && R) {
    const lFar = L.origin + L.size
    const rNear = R.origin
    const free = rNear - lFar - dragSize
    if (free >= 0) {
      const gap = free / 2
      const origin = lFar + gap
      const pMin = Math.max(dragPerpMin, L.perpMin, R.perpMin)
      const pMax = Math.min(dragPerpMax, L.perpMax, R.perpMax)
      const perp = pMin < pMax ? (pMin + pMax) / 2 : (dragPerpMin + dragPerpMax) / 2
      consider(origin, {
        kind: 'distribute',
        axis,
        perp,
        distance: gap,
        gaps: [
          { from: lFar, to: lFar + gap },
          { from: origin + dragSize, to: rNear }
        ]
      })
    }
  }

  // ── Case B: end-of-row rhythm — match the adjacent existing gap ─────────────────
  if (neighbors.length >= 2) {
    // Right end: dragged sits to the right of the rightmost neighbor.
    const b = neighbors[neighbors.length - 1]
    const a = neighbors[neighbors.length - 2]
    if (dragCenter > b.origin + b.size / 2) {
      const refGap = b.origin - (a.origin + a.size)
      if (refGap >= 0) {
        const origin = b.origin + b.size + refGap // dragged near-edge
        consider(origin, {
          kind: 'distribute',
          axis,
          perp: perpOf(b),
          distance: refGap,
          gaps: [
            { from: a.origin + a.size, to: b.origin }, // reference gap
            { from: b.origin + b.size, to: origin } // new equal gap
          ]
        })
      }
    }
    // Left end: dragged sits to the left of the leftmost neighbor.
    const a2 = neighbors[0]
    const b2 = neighbors[1]
    if (dragCenter < a2.origin + a2.size / 2) {
      const refGap = b2.origin - (a2.origin + a2.size)
      if (refGap >= 0) {
        const origin = a2.origin - refGap - dragSize // dragged near-edge
        consider(origin, {
          kind: 'distribute',
          axis,
          perp: perpOf(a2),
          distance: refGap,
          gaps: [
            { from: origin + dragSize, to: a2.origin }, // new equal gap
            { from: a2.origin + a2.size, to: b2.origin } // reference gap
          ]
        })
      }
    }
  }

  return best
}
```

> Notes: (1) `neighbors` is now filtered+sorted once and reused by both cases — Case A's behavior is
> unchanged (same immediate-L/R selection, same centered math). (2) Case A and Case B are mutually
> exclusive for a given drag (between-two vs beyond-the-end), so `consider` simply keeps whichever is
> within threshold. (3) `AxisMatch` is `{ diff, origin, guide }` (already defined); `DistributionGuide`
> and `rangesOverlap`/`OtherAxis` are reused unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS — Case B group + all prior groups (Case A, gap, overlap, resize, align) still green.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): end-of-row rhythm distribution (slice 2b Case B)"
```

---

### Task 2: Full verification + manual check + e2e gate

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run`
Expected: PASS — all prior + the new Case B tests.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck && pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" lint`
Expected: PASS.

- [ ] **Step 3: Manual check in dev**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" dev`
1. Place two boards in a row with a clear gap. Drag a third PAST the right end → it snaps so its gap
   to the row equals the existing gap; both gap segments + matching pills show.
2. Same dragging past the left end.
3. Between the two → still centers (Case A), unchanged.
4. Off-rhythm (>8px) → free drag.
5. One board only / non-aligned boards → no rhythm snap.

- [ ] **Step 4: Board e2e harness**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" build`, then kill electron + cooldown, then
`$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" start`.
Expected: `E2E_DONE`; only known environmental flakes (browser trio + the wider load-flake family
fullview-close/preview-edge-stale/duplicate-keeps-link) may appear — rerun once on a cooled-down
electron. This slice is pure detection only; no overlay/Canvas/native-view change.

- [ ] **Step 5: Commit any fixups**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add -A
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "chore(align): slice 2b Case B verified (unit + typecheck + lint + e2e)"
```

---

## Self-Review

**Spec coverage:**
- End-of-row rhythm (match adjacent gap) both sides → Task 1 Case B (right + left). ✓
- Reuses `distribute` guide → no overlay/Canvas/CSS change. ✓
- Case A (centered) preserved → Task 1 keeps it + a regression test. ✓
- Neighbor-gated (perp overlap), ≥2 neighbors, within threshold, smallest-diff wins → Task 1
  `consider`/`neighbors`. ✓
- typecheck/lint/unit/e2e → Task 2. ✓

**Placeholder scan:** none — full code, exact commands + expected output.

**Type consistency:** `bestDistribution` keeps its signature + `AxisMatch` return; emits the existing
`DistributionGuide`; `computeAlignment`/`pickAxis`/overlay untouched. `neighbors`/`consider`/`perpOf`
are local. No new exports.

**Deferred:** matching a NON-adjacent existing gap (arbitrary rhythm across the whole set) — Case B
uses the two outermost neighbors' gap, which equals the rhythm for an evenly-spaced row. Out of scope.
