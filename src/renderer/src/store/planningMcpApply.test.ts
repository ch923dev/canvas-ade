import { describe, it, expect } from 'vitest'
import {
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
      { kind: 'diagram', source: 'graph TD\n  A-->B' }
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

  it('lays a batch out as a GRID — row-major, columns align, order preserved', () => {
    // 6 notes → gridColumns(6) = ceil(√6) = 3 columns, 2 rows.
    const out = materializePlanningOps(
      Array.from({ length: 6 }, (_, i) => note(`n${i}`)),
      []
    )
    // Agent order is preserved (row-major).
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

  it('starts BELOW existing content (does not overlap a pre-existing element)', () => {
    const existing: PlanningElement[] = [
      { id: 'x', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'yellow', text: 'old' }
    ]
    const out = materializePlanningOps([{ kind: 'note', text: 'new', tint: 'green' }], existing)
    // The new note's top must be at or below the existing note's bottom (0 + 96).
    expect(out[0].y).toBeGreaterThanOrEqual(96)
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
