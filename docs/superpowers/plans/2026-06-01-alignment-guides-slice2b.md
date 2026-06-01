# Smart Alignment Guides — Slice 2b (Equal-spacing distribution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. BUILDS ON slices 1 + 2a
> (committed: `lib/alignmentGuides.ts` with the `Guide` union + `computeAlignment`, the overlay, the
> Canvas wiring). No `Canvas.tsx` change is needed in this slice.

**Goal:** While dragging a board, when it falls between two perpendicular-neighbors, snap it so the
gap on each side is EQUAL (centered distribution) and draw the two equal gap segments with distance
pills — the Figma "equal spacing" feel for 3 boards in a row/column.

**Architecture:** Extend the pure `lib/alignmentGuides.ts`: add a `distribute` variant to the `Guide`
union and a `bestDistribution` per-axis detector. `computeAlignment` now picks, per axis, the best of
{align/gap match, distribution match} by smallest diff (align/gap wins exact ties). Rendering reuses
the slice-2a `projectGapGuide` for each equal segment, so the overlay only gains one `kind` branch
and `Canvas.tsx` is untouched (distribution is just another `Guide`).

**Tech Stack:** React 18, TypeScript (strict), `@xyflow/react` v12, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-alignment-guides.md`.
**Builds on:** slice-2a plan `docs/superpowers/plans/2026-06-01-alignment-guides-slice2a.md`.

**Scope note:** v1 = centered-between-two (the immediate left + immediate right perp-neighbor).
End-of-row "match the adjacent gap rhythm" (Case B) is deferred — not in this slice.

---

## File Structure

- **Modify** `src/renderer/src/lib/alignmentGuides.ts` — `DistributionGuide` in the union,
  `bestDistribution`, per-axis pick in `computeAlignment`.
- **Modify** `src/renderer/src/lib/alignmentGuides.test.ts` — distribution detection tests.
- **Modify** `src/renderer/src/canvas/AlignmentGuides.tsx` — render the `distribute` kind (reuse
  `projectGapGuide` per equal segment).
- (No `Canvas.tsx` change. No new CSS — reuses `.align-connector` / `.align-tick` / `.align-pill`.)

---

### Task 1: Detection — `DistributionGuide` + `bestDistribution` + per-axis pick

**Files:**
- Modify: `src/renderer/src/lib/alignmentGuides.ts`
- Test: `src/renderer/src/lib/alignmentGuides.test.ts`

- [ ] **Step 1: Add the failing tests**

Append:

```ts
describe('computeAlignment — equal-spacing distribution (centered between two)', () => {
  const L = { x: 0, y: 0, w: 100, h: 100 }
  const R = { x: 400, y: 0, w: 100, h: 100 }

  test('centers a board equally between two perpendicular-neighbors', () => {
    // free = (R.left 400 - L.right 100) - w 100 = 200 → gap 100 → origin 200. Approach at 198.
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [L, R], 8)
    expect(r.x).toBe(200)
    const d = r.guides.find((g) => g.kind === 'distribute')
    expect(d).toBeDefined()
    expect(d).toMatchObject({ kind: 'distribute', axis: 'x', distance: 100 })
    if (d && d.kind === 'distribute') {
      expect(d.gaps).toHaveLength(2)
      // left gap [100,200], right gap [300,400] — each length 100
      expect(d.gaps[0]).toEqual({ from: 100, to: 200 })
      expect(d.gaps[1]).toEqual({ from: 300, to: 400 })
    }
  })

  test('no distribution snap beyond the threshold', () => {
    const r = computeAlignment({ x: 185, y: 0, w: 100, h: 100 }, [L, R], 8) // diff 15 > 8
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('no distribution when there is not enough room (would overlap)', () => {
    const tightR = { x: 150, y: 0, w: 100, h: 100 } // free = (150-100)-100 = -50
    const r = computeAlignment({ x: 110, y: 0, w: 100, h: 100 }, [L, tightR], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('no distribution with only one neighbor', () => {
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [L], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('ignores non-neighbors (no perpendicular overlap) when picking L/R', () => {
    const farR = { x: 400, y: 500, w: 100, h: 100 } // no Y overlap with the dragged board
    const r = computeAlignment({ x: 198, y: 0, w: 100, h: 100 }, [L, farR], 8)
    expect(r.guides.some((g) => g.kind === 'distribute')).toBe(false)
  })

  test('distributes on the Y axis too (vertical stack)', () => {
    const T = { x: 0, y: 0, w: 100, h: 100 }
    const B = { x: 0, y: 400, w: 100, h: 100 }
    // free = (400 - 100) - 100 = 200 → gap 100 → origin y 200. Approach at 203.
    const r = computeAlignment({ x: 0, y: 203, w: 100, h: 100 }, [T, B], 8)
    expect(r.y).toBe(200)
    expect(r.guides.some((g) => g.kind === 'distribute' && g.axis === 'y')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: FAIL — no `distribute` guide produced.

- [ ] **Step 3: Add `DistributionGuide` to the union**

In `alignmentGuides.ts`, after the `GapGuide` interface, add:

```ts
/** An equal-spacing indicator (slice 2b): the dragged board is centered between two neighbors so
 *  both gaps match. Each entry in `gaps` is an equal segment on `axis` (world coords from→to);
 *  `perp` anchors the connectors+pills; `distance` is the (equal) gap size. */
export interface DistributionGuide {
  kind: 'distribute'
  axis: 'x' | 'y'
  gaps: { from: number; to: number }[]
  perp: number
  distance: number
}
```

And widen the union:

```ts
export type Guide = AlignGuide | GapGuide | DistributionGuide
```

- [ ] **Step 4: Add `bestDistribution` and fold it into `computeAlignment`**

Add this helper just above `computeAlignment` (it reuses `OtherAxis`, `AxisMatch`, `rangesOverlap`
already in the file):

```ts
/**
 * Best centered-distribution match on one axis: if the dragged board has BOTH an immediate
 * perpendicular-neighbor to each side with room between them, the position that makes the two side
 * gaps equal. Returns the snapped origin + a `distribute` guide, or null. `others` is the axis-mapped
 * neighbor list (same shape `bestAxisMatch` consumes).
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
  const dragCenter = dragOrigin + dragSize / 2
  let L: OtherAxis | null = null // immediate left (rightmost far edge among left neighbors)
  let R: OtherAxis | null = null // immediate right (leftmost near edge among right neighbors)
  for (const o of others) {
    if (!rangesOverlap(dragPerpMin, dragPerpMax, o.perpMin, o.perpMax)) continue
    const oCenter = o.origin + o.size / 2
    if (oCenter < dragCenter) {
      if (!L || o.origin + o.size > L.origin + L.size) L = o
    } else if (oCenter > dragCenter) {
      if (!R || o.origin < R.origin) R = o
    }
  }
  if (!L || !R) return null

  const lFar = L.origin + L.size
  const rNear = R.origin
  const free = rNear - lFar - dragSize
  if (free < 0) return null // no room → would overlap; not a distribution

  const gap = free / 2
  const origin = lFar + gap
  const diff = Math.abs(dragOrigin - origin)
  if (diff > threshold) return null

  // Indicator row: center of the perp overlap shared by L, dragged, and R (fallback: dragged center).
  const pMin = Math.max(dragPerpMin, L.perpMin, R.perpMin)
  const pMax = Math.min(dragPerpMax, L.perpMax, R.perpMax)
  const perp = pMin < pMax ? (pMin + pMax) / 2 : (dragPerpMin + dragPerpMax) / 2

  const guide: DistributionGuide = {
    kind: 'distribute',
    axis,
    gaps: [
      { from: lFar, to: lFar + gap },
      { from: origin + dragSize, to: rNear }
    ],
    perp,
    distance: gap
  }
  return { diff, origin, guide }
}

/** Pick the better of two axis candidates: smaller diff wins; on an exact tie keep `primary`
 *  (edge/center align or gutter), since alignment is the primary intent over distribution. */
function pickAxis(primary: AxisMatch | null, distribution: AxisMatch | null): AxisMatch | null {
  if (!primary) return distribution
  if (!distribution) return primary
  return distribution.diff < primary.diff ? distribution : primary
}
```

Then update `computeAlignment` to compute the distribution match per axis and pick. Replace the two
`const xMatch = ...` / `const yMatch = ...` assignments and the body that follows with:

```ts
export function computeAlignment(rect: Rect, others: Rect[], threshold: number): AlignResult {
  const xOthers = others.map((o) => ({ origin: o.x, size: o.w, perpMin: o.y, perpMax: o.y + o.h }))
  const yOthers = others.map((o) => ({ origin: o.y, size: o.h, perpMin: o.x, perpMax: o.x + o.w }))

  const xMatch = pickAxis(
    bestAxisMatch('x', rect.x, rect.w, rect.y, rect.y + rect.h, xOthers, threshold),
    bestDistribution('x', rect.x, rect.w, rect.y, rect.y + rect.h, xOthers, threshold)
  )
  const yMatch = pickAxis(
    bestAxisMatch('y', rect.y, rect.h, rect.x, rect.x + rect.w, yOthers, threshold),
    bestDistribution('y', rect.y, rect.h, rect.x, rect.x + rect.w, yOthers, threshold)
  )

  const x = xMatch ? xMatch.origin : rect.x
  const y = yMatch ? yMatch.origin : rect.y
  const guides: Guide[] = []
  if (xMatch) guides.push(xMatch.guide)
  if (yMatch) guides.push(yMatch.guide)

  const snapped: Rect = { x, y, w: rect.w, h: rect.h }
  const overlaps: Rect[] = []
  for (const o of others) {
    const hit = intersect(snapped, o)
    if (hit) overlaps.push(hit)
  }

  return { x, y, guides, overlaps }
}
```

> This relies on `bestAxisMatch` having an `axis` first parameter and returning `AxisMatch | null`
> (added in slice 2a). If your slice-2a `bestAxisMatch` does not yet take `axis` / return `AxisMatch`,
> reconcile to that shape first (it should, per the 2a plan). Do not duplicate the `xOthers`/`yOthers`
> mapping — define it once as above.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run src/renderer/src/lib/alignmentGuides.test.ts`
Expected: PASS (distribution group + all prior align/gap/overlap groups still green).

- [ ] **Step 6: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/lib/alignmentGuides.ts src/renderer/src/lib/alignmentGuides.test.ts
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): equal-spacing distribution detection (slice 2b)"
```

---

### Task 2: Render the `distribute` guide in the overlay

**Files:**
- Modify: `src/renderer/src/canvas/AlignmentGuides.tsx`

- [ ] **Step 1: Add the `distribute` branch (reusing the gap visual per segment)**

In `AlignmentGuides.tsx`, the `guides.map` currently handles `align` and falls through to `gap`. Make
it explicit and add `distribute`. Replace the `guides.map(...)` callback body with:

```tsx
      {guides.map((g, i) => {
        if (g.kind === 'align') {
          const l = projectGuide(g, transform)
          return <line key={`a${i}`} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
        }
        // gap (single gutter) and distribute (two equal segments) share the connector+pill visual.
        const segments =
          g.kind === 'gap'
            ? [{ pos: g.pos, perp: g.perp, distance: g.distance, axis: g.axis }]
            : g.gaps.map((seg) => ({
                pos: (seg.from + seg.to) / 2,
                perp: g.perp,
                distance: seg.to - seg.from,
                axis: g.axis
              }))
        return (
          <g key={`g${i}`} className={g.kind === 'gap' ? 'align-gap' : 'align-distribute'}>
            {segments.map((s, j) => {
              const v = projectGapGuide(
                { kind: 'gap', axis: s.axis, pos: s.pos, perp: s.perp, distance: s.distance },
                transform
              )
              const vertical = s.axis === 'y'
              const tick = (cx: number, cy: number): ReactElement =>
                vertical ? (
                  <line className="align-tick" x1={cx - TICK} y1={cy} x2={cx + TICK} y2={cy} />
                ) : (
                  <line className="align-tick" x1={cx} y1={cy - TICK} x2={cx} y2={cy + TICK} />
                )
              return (
                <g key={j}>
                  <line className="align-connector" x1={v.ax} y1={v.ay} x2={v.bx} y2={v.by} />
                  <g>{tick(v.ax, v.ay)}</g>
                  <g>{tick(v.bx, v.by)}</g>
                  <rect className="align-pill" x={v.lx - 14} y={v.ly - 8} width={28} height={16} rx={3} />
                  <text
                    className="align-pill-text"
                    x={v.lx}
                    y={v.ly}
                    textAnchor="middle"
                    dominantBaseline="central"
                  >
                    {Math.round(v.distance)}
                  </text>
                </g>
              )
            })}
          </g>
        )
      })}
```

> This generalizes the slice-2a single-gap render to N segments; `gap` is the 1-segment case and
> `distribute` is the 2-segment case. `projectGapGuide`/`TICK` are already imported from slice 2a.

- [ ] **Step 2: Typecheck (exhaustive union)**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck`
Expected: PASS. (TS narrows `g.kind`: `align` handled first, then `gap` vs `distribute` in the
segment-builder ternary — both arms covered, no unhandled-kind error.)

- [ ] **Step 3: Commit**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add src/renderer/src/canvas/AlignmentGuides.tsx
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "feat(align): render equal-spacing distribution indicators (slice 2b)"
```

---

### Task 3: Full verification + manual check + e2e gate

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" vitest run`
Expected: PASS — all prior + the new distribution tests.

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" typecheck && pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" lint`
Expected: PASS.

- [ ] **Step 3: Manual check in dev**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" dev`
1. Place two boards apart in a row. Drag a third between them → it snaps to dead-center; two equal
   gap segments + matching distance pills appear.
2. Same vertically (two stacked, drag a third between).
3. Off-center drag (>8px from center) → no distribution snap (free drag).
4. Boards too close (no room) → no distribution, overlap tint shows if you force it on top.
5. Ctrl/⌘ → distribution suppressed with everything else.

- [ ] **Step 4: Board e2e harness**

Run: `pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" build`, then `$env:CANVAS_SMOKE='e2e'; pnpm -C "Z:\Canvas ADE\.claude\worktrees\align" start`.
Expected: `E2E_DONE`, parts `ok:true`. The browser/browser-gesture/focus-detach trio is the known
env capturePage flake (rerun once; not a regression — this slice adds only pure detection + an
overlay branch, no native-view path change).

- [ ] **Step 5: Commit any fixups**

```bash
git -C "Z:\Canvas ADE\.claude\worktrees\align" add -A
git -C "Z:\Canvas ADE\.claude\worktrees\align" commit -m "chore(align): slice 2b verified (unit + typecheck + lint + e2e)"
```

---

## Self-Review

**Spec coverage (slice 2b):**
- Equal-spacing across 3 boards (centered between two) → Task 1 `bestDistribution`. ✓
- Distribution snaps + shows equal gap segments with distance pills → Task 1 (guide) + Task 2
  (render, reusing `projectGapGuide`). ✓
- Both axes → Task 1 (x and y picks). ✓
- Distribution competes with align/gap, smallest diff wins, align ties → Task 1 `pickAxis`. ✓
- No room → no distribution (no forced overlap) → Task 1 `free < 0` guard. ✓
- Ctrl/⌘ suppress, ephemeral, no persistence → inherited from slice 1/2a (no Canvas change). ✓
- typecheck/lint/unit/e2e → Task 3. ✓

**Placeholder scan:** none — full code per step; commands have expected output.

**Type consistency:** `DistributionGuide` added to `Guide`; `bestDistribution`/`pickAxis` return the
existing `AxisMatch`; `computeAlignment` signature/return unchanged (`{x,y,guides,overlaps}`) so
`Canvas.tsx` and the overlay props are untouched. The overlay's new branch consumes `g.gaps` (only on
`distribute`) and reuses `projectGapGuide` + `TICK` from slice 2a.

**Deferred:** end-of-row "match adjacent gap rhythm" (Case B) distribution. Not in this slice.
