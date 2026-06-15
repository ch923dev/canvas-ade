import { describe, it, expect } from 'vitest'
import { materializePlanningOps, neededBoardHeight, type PlanningOp } from './planningMcpApply'
import { assertPlanningElement, type PlanningElement } from '../lib/boardSchema'

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
      { kind: 'arrow', dx: 80, dy: 40 }
    ]
    const out = materializePlanningOps(ops, [])
    expect(out.map((e) => e.kind)).toEqual(['note', 'checklist', 'text', 'arrow'])
    // Every materialized element must pass the canvas schema validator (defense in depth).
    out.forEach(assertPlanningElement)
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

  it('stacks new elements vertically (strictly increasing y, no overlap of card kinds)', () => {
    const ops: PlanningOp[] = [
      { kind: 'note', text: 'n1', tint: 'yellow' },
      { kind: 'note', text: 'n2', tint: 'yellow' }
    ]
    const out = materializePlanningOps(ops, [])
    expect(out[1].y).toBeGreaterThan(out[0].y)
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

describe('neededBoardHeight', () => {
  it('is 0 for an empty board and grows with content', () => {
    expect(neededBoardHeight([])).toBe(0)
    const out = materializePlanningOps(
      Array.from({ length: 5 }, (_, i) => ({
        kind: 'note' as const,
        text: `n${i}`,
        tint: 'yellow' as const
      })),
      []
    )
    expect(neededBoardHeight(out)).toBeGreaterThan(96)
  })
})
