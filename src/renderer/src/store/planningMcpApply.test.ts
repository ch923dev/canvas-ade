import { describe, it, expect } from 'vitest'
import {
  diagramFootprint,
  materializePlanningOps,
  neededBoardHeight,
  neededBoardWidth,
  type PlanningOp
} from './planningMcpApply'
import { assertPlanningElement, type PlanningElement } from '../lib/boardSchema'

const note = (text: string): PlanningOp => ({ kind: 'note', text, tint: 'yellow' })

describe('materializePlanningOps', () => {
  it('mints ids + positions and produces schema-valid elements of each kind', () => {
    const ops: PlanningOp[] = [
      { kind: 'note', text: 'a note', tint: 'blue' },
      {
        kind: 'checklist',
        title: 'Plan',
        items: [
          { label: 'one', done: true },
          { label: 'two', done: false }
        ]
      },
      { kind: 'text', text: 'see ADR 0003' },
      { kind: 'arrow', dx: 80, dy: 40 },
      { kind: 'diagram', engine: 'mermaid', source: 'graph TD\n  A-->B' }
    ]
    const out = materializePlanningOps(ops, [])
    expect(out.map((e) => e.kind)).toEqual(['note', 'checklist', 'text', 'arrow', 'diagram'])
    // Every materialized element must pass the canvas schema validator (defense in depth).
    out.forEach(assertPlanningElement)
    // The diagram materializes with its source + engine, no svgCache (the card renders it on display).
    const diagram = out.find((e) => e.kind === 'diagram') as Extract<
      PlanningElement,
      { kind: 'diagram' }
    >
    expect(diagram).toMatchObject({
      kind: 'diagram',
      source: 'graph TD\n  A-->B',
      engine: 'mermaid'
    })
    expect(diagram.svgCache).toBeUndefined()
    expect(diagram.w).toBeGreaterThan(0)
    expect(diagram.h).toBeGreaterThan(0)
    // Unique ids (board elements + nested checklist items).
    const ids = out.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const checklist = out.find((e) => e.kind === 'checklist') as Extract<
      PlanningElement,
      { kind: 'checklist' }
    >
    expect(checklist.items).toHaveLength(2)
    expect(checklist.items[0]).toMatchObject({ label: 'one', done: true })
    expect(new Set(checklist.items.map((i) => i.id)).size).toBe(2)
  })

  it('lays a uniform batch into an aligned grid (masonry degenerates to a grid)', () => {
    // 6 equal-height notes → gridColumns(6) = ceil(√6) = 3 columns; equal heights make the
    // shortest-column masonry fill row-by-row, so columns align like a grid.
    const out = materializePlanningOps(
      Array.from({ length: 6 }, (_, i) => note(`n${i}`)),
      []
    )
    // Agent order is preserved (top row fills left→right).
    expect(out.map((e) => (e as Extract<PlanningElement, { kind: 'note' }>).text)).toEqual([
      'n0',
      'n1',
      'n2',
      'n3',
      'n4',
      'n5'
    ])
    const xs = out.map((e) => e.x)
    const ys = out.map((e) => e.y)
    // Row 0 (first 3) share a y; row 1 (next 3) share a strictly lower (greater) y.
    expect(ys[0]).toBe(ys[1])
    expect(ys[1]).toBe(ys[2])
    expect(ys[3]).toBeGreaterThan(ys[0])
    expect(ys[3]).toBe(ys[4])
    expect(ys[4]).toBe(ys[5])
    // Columns align (i and i+cols share an x) and increase left→right across a row.
    expect(xs[0]).toBe(xs[3])
    expect(xs[1]).toBe(xs[4])
    expect(xs[0]).toBeLessThan(xs[1])
    expect(xs[1]).toBeLessThan(xs[2])
  })

  it('places a 2-element batch side by side (a grid, not a column)', () => {
    const out = materializePlanningOps([note('a'), note('b')], [])
    expect(out[0].y).toBe(out[1].y) // same row
    expect(out[1].x).toBeGreaterThan(out[0].x) // next column
  })

  it('never overlaps cards even when heights vary wildly (the masonry fix)', () => {
    // A tall prose note next to short notes — the bug was the next card landing ON TOP of the
    // tall one (positioned by a 96px seed while the note renders ~10× taller). Masonry + content
    // height estimates must keep every note's rect disjoint.
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i} of a long agent note`).join(
      '\n'
    )
    const ops: PlanningOp[] = [
      { kind: 'note', text: longText, tint: 'yellow' },
      ...Array.from({ length: 6 }, (_, i) => note(`short ${i}`))
    ]
    const out = materializePlanningOps(ops, []) as Array<{
      x: number
      y: number
      w: number
      h: number
    }>
    // The tall note must actually be tall (estimated from its content, not the 96px seed).
    expect(out[0].h).toBeGreaterThan(300)
    const overlaps = (a: (typeof out)[number], b: (typeof out)[number]): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i], out[j])).toBe(false)
      }
    }
  })

  it('keeps a negative-delta arrow inside its reserved column (anchors at the far edge)', () => {
    // MAIN bounds an arrow's magnitude but not its sign — a left/up-pointing arrow (dx/dy < 0)
    // must still lay out rightward/downward of its column origin, not shoot into the preceding
    // column. The materializer anchors such an arrow at the cell's far edge.
    const out = materializePlanningOps(
      [
        { kind: 'note', text: 'anchor', tint: 'yellow' },
        { kind: 'arrow', dx: -80, dy: -40 }
      ],
      []
    )
    const arrow = out.find((e) => e.kind === 'arrow') as Extract<PlanningElement, { kind: 'arrow' }>
    // Both endpoints sit at or right-of / below the arrow's own cell origin (min x/y ≥ column left).
    const minX = Math.min(arrow.x, arrow.x2)
    const minY = Math.min(arrow.y, arrow.y2)
    expect(minX).toBeGreaterThanOrEqual(0)
    expect(minY).toBeGreaterThanOrEqual(0)
    // The far endpoint is the anchor; the head points back toward (anchor + delta) but stays ≥ origin.
    expect(arrow.x2).toBe(arrow.x - 80)
    expect(arrow.y2).toBe(arrow.y - 40)
  })

  it('starts BELOW existing content (does not overlap a pre-existing element)', () => {
    const existing: PlanningElement[] = [
      { id: 'x', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'yellow', text: 'old' }
    ]
    const out = materializePlanningOps([{ kind: 'note', text: 'new', tint: 'green' }], existing)
    // The new note's top must be at or below the existing note's bottom (0 + 96).
    expect(out[0].y).toBeGreaterThanOrEqual(96)
  })
})

describe('materializePlanningOps — sections (2a)', () => {
  const secNote = (text: string, section: string): PlanningOp => ({
    kind: 'note',
    text,
    tint: 'yellow',
    section
  })

  it('lays one COLUMN PER SECTION in first-appearance order (tops share a row, xs increase)', () => {
    const out = materializePlanningOps(
      [
        secNote('intro', 'Overview'),
        {
          kind: 'checklist',
          title: 'Setup',
          items: [{ label: 'env', done: false }],
          section: 'Setup'
        },
        {
          kind: 'checklist',
          title: 'Build',
          items: [{ label: 'api', done: false }],
          section: 'Build'
        }
      ],
      []
    )
    // Three distinct columns; the first card of each sits at the same top y.
    expect(out[0].y).toBe(out[1].y)
    expect(out[1].y).toBe(out[2].y)
    // Column order follows first appearance: Overview < Setup < Build (left → right).
    expect(out[0].x).toBeLessThan(out[1].x)
    expect(out[1].x).toBeLessThan(out[2].x)
  })

  it('stacks same-section cards top-to-bottom in array order (one column, increasing y)', () => {
    const out = materializePlanningOps(
      [secNote('a', 'Setup'), secNote('b', 'Setup'), secNote('c', 'Setup')],
      []
    )
    // All in one column (same x), in agent order down the column.
    expect(out[0].x).toBe(out[1].x)
    expect(out[1].x).toBe(out[2].x)
    expect(out[0].y).toBeLessThan(out[1].y)
    expect(out[1].y).toBeLessThan(out[2].y)
  })

  it('a pre-section un-tagged element forms the leading "" column', () => {
    const out = materializePlanningOps([note('intro'), secNote('setup work', 'Setup')], [])
    // The un-tagged intro leads (first appearance of key ""), then the Setup column.
    expect(out[0].y).toBe(out[1].y)
    expect(out[0].x).toBeLessThan(out[1].x)
  })

  it('never overlaps cards across sections with wildly varying heights', () => {
    const longText = Array.from({ length: 40 }, (_, i) => `line ${i} of a long agent note`).join(
      '\n'
    )
    const out = materializePlanningOps(
      [
        secNote(longText, 'Overview'), // a very tall card
        secNote('s1', 'Setup'),
        secNote('s2', 'Setup'),
        { kind: 'checklist', title: 'Test', items: [{ label: 't', done: false }], section: 'Test' }
      ],
      []
    ) as Array<{ x: number; y: number; w: number; h: number }>
    const overlaps = (a: (typeof out)[number], b: (typeof out)[number]): boolean =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(overlaps(out[i], out[j])).toBe(false)
      }
    }
  })

  it('falls back to MASONRY when no element carries a section (Phase-1 behaviour)', () => {
    // 6 equal notes with NO section → masonry's √n grid (3 cols), which row-aligns. Asserting the
    // row structure (ys[0]==ys[1]==ys[2], ys[3] lower) proves the section path did NOT engage.
    const out = materializePlanningOps(
      Array.from({ length: 6 }, (_, i) => note(`n${i}`)),
      []
    )
    const ys = out.map((e) => e.y)
    expect(ys[0]).toBe(ys[1])
    expect(ys[1]).toBe(ys[2])
    expect(ys[3]).toBeGreaterThan(ys[0])
  })
})

describe('materializePlanningOps — 2c presentation (widen / diagram footprint / tighter gaps)', () => {
  it('materializes an MCP checklist at the widened 300px width (not the 240px user default)', () => {
    const out = materializePlanningOps(
      [{ kind: 'checklist', title: 'T', items: [{ label: 'a', done: false }] }],
      []
    )
    const cl = out.find((e) => e.kind === 'checklist') as Extract<
      PlanningElement,
      { kind: 'checklist' }
    >
    expect(cl.w).toBe(300)
  })

  it('diagramFootprint reads the agent source orientation: LR/ER/direction ⇒ wide, TD/seq/unknown ⇒ tall', () => {
    const wide = diagramFootprint('graph LR\n A-->B')
    // The aspect flips with orientation: a wide footprint is landscape, a tall one is portrait-ish.
    expect(wide.w).toBeGreaterThan(wide.h)
    const tall = diagramFootprint('graph TD\n A-->B')
    expect(tall.h).toBeGreaterThan(tall.w)
    // Horizontal forms all resolve to the SAME wide footprint…
    expect(diagramFootprint('flowchart RL\n A-->B')).toEqual(wide)
    expect(diagramFootprint('erDiagram\n CUSTOMER ||--o{ ORDER : places')).toEqual(wide)
    expect(diagramFootprint('gantt\n title Plan')).toEqual(wide)
    expect(diagramFootprint('stateDiagram-v2\n  direction LR\n  A --> B')).toEqual(wide)
    // …and vertical / sequence / unknown all resolve to the SAME tall footprint (conservative).
    expect(diagramFootprint('flowchart BT\n A-->B')).toEqual(tall)
    expect(diagramFootprint('sequenceDiagram\n A->>B: hi')).toEqual(tall)
    expect(diagramFootprint('pie title Pets\n "Dogs": 3')).toEqual(tall)
    // The `direction` keyword only counts as a line-level statement — the phrase inside a node label
    // must NOT flip a TD flow to wide (the whole-source-scan false-match).
    expect(diagramFootprint('graph TD\n A["Set direction LR for the pipeline"]-->B')).toEqual(tall)
  })

  it('honors the footprint at materialize: a wide-source diagram is wider, a tall one is taller — both > the 280×200 default', () => {
    const [wide] = materializePlanningOps(
      [{ kind: 'diagram', engine: 'mermaid', source: 'graph LR\n A-->B' }],
      []
    ) as Array<Extract<PlanningElement, { kind: 'diagram' }>>
    const [tall] = materializePlanningOps(
      [{ kind: 'diagram', engine: 'mermaid', source: 'graph TD\n A-->B' }],
      []
    ) as Array<Extract<PlanningElement, { kind: 'diagram' }>>
    expect(wide.w).toBeGreaterThan(tall.w)
    expect(tall.h).toBeGreaterThan(wide.h)
    // Both larger than the legacy fixed 280×200 so an agent diagram is legible.
    expect(wide.w).toBeGreaterThan(280)
    expect(tall.h).toBeGreaterThan(200)
  })

  it('🔒 overlap invariant: a stacked checklist reserves ≥ its real rendered height (tighten can never undershoot)', () => {
    // The gap-tighten lowers CHECK_ROW; the load-bearing invariant is that the reserved spacing
    // still clears the REAL interactive render (≈ 77 + 24·N px — header + N×16px rows + 8px gaps +
    // footer + padding; checkbox 16×16). A sibling card is absolutely positioned, so under-reserving
    // would drop the next card ON TOP of a tall checklist. This guards a future over-tighten.
    const items = (n: number): { label: string; done: boolean }[] =>
      Array.from({ length: n }, (_, i) => ({ label: `item ${i}`, done: false }))
    const out = materializePlanningOps(
      [
        { kind: 'checklist', title: 'A', items: items(8), section: 'Plan' },
        { kind: 'checklist', title: 'B', items: items(3), section: 'Plan' },
        { kind: 'checklist', title: 'C', items: items(5), section: 'Plan' }
      ],
      []
    ) as Array<Extract<PlanningElement, { kind: 'checklist' }>>
    const realLowerBound = (n: number): number => 77 + 24 * n
    // All in one column (same x), strictly increasing y, each gap clearing the upper card's real height.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].x).toBe(out[0].x)
      const gap = out[i].y - out[i - 1].y
      expect(gap).toBeGreaterThanOrEqual(realLowerBound(out[i - 1].items.length))
    }
  })

  it('reserves MORE height for a WRAPPING label (the estimate counts wrapped lines, not just items)', () => {
    // At MCP_CHECKLIST_W=300 a label wraps ~every 35 chars; a 90-char label is ~3 lines. The card
    // below a long-label checklist must drop further than below a one-liner — else the wrapped card
    // (which self-measures taller) would overlap it (the W-label-wrap regression of 2c's estimate).
    const stack = (label: string): PlanningElement[] =>
      materializePlanningOps(
        [
          { kind: 'checklist', title: 'A', items: [{ label, done: false }], section: 'P' },
          { kind: 'note', text: 'below', tint: 'yellow', section: 'P' }
        ],
        []
      )
    const long = stack('x'.repeat(90))
    const short = stack('short')
    const longGap = long[1].y - long[0].y
    const shortGap = short[1].y - short[0].y
    expect(longGap).toBeGreaterThan(shortGap) // the wrapping label reserved more vertical space
  })
})

describe('neededBoardHeight / neededBoardWidth', () => {
  it('height is 0 for an empty board and grows with content', () => {
    expect(neededBoardHeight([])).toBe(0)
    const out = materializePlanningOps(
      Array.from({ length: 5 }, (_, i) => note(`n${i}`)),
      []
    )
    expect(neededBoardHeight(out)).toBeGreaterThan(96)
  })

  it('width is 0 for an empty board and a multi-column batch is wider than a single card', () => {
    expect(neededBoardWidth([])).toBe(0)
    const single = materializePlanningOps([note('only')], [])
    const grid = materializePlanningOps(
      Array.from({ length: 6 }, (_, i) => note(`n${i}`)),
      []
    )
    // The single note is one column; the 6-note grid spans 3 columns → strictly wider.
    expect(neededBoardWidth(grid)).toBeGreaterThan(neededBoardWidth(single))
  })
})
