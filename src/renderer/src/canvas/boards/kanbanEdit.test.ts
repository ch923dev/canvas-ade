import { describe, it, expect } from 'vitest'
import type { KanbanBoard } from '../../lib/boardSchema'
import {
  addCard,
  addColumn,
  moveCard,
  removeCard,
  removeColumn,
  renameCard,
  renameColumn,
  setColumnWip
} from './kanbanEdit'

const board = (over: Partial<KanbanBoard> = {}): KanbanBoard => ({
  id: 'k1',
  type: 'kanban',
  x: 0,
  y: 0,
  w: 900,
  h: 520,
  title: 'Plan',
  columns: [
    { id: 'backlog', title: 'Backlog' },
    { id: 'progress', title: 'In Progress', wip: 2 },
    { id: 'review', title: 'Review' }
  ],
  cards: [
    { id: 'c1', columnId: 'backlog', title: 'One' },
    { id: 'c2', columnId: 'progress', title: 'Two' }
  ],
  ...over
})

describe('kanbanEdit — card ops', () => {
  it('addCard appends a fresh-id card to the tail of its column', () => {
    const out = addCard(board(), 'backlog', '  New task  ')
    expect(out).toHaveLength(3)
    expect(out[2]).toMatchObject({ columnId: 'backlog', title: 'New task' })
    expect(out[2].id).toBeTruthy()
    expect(out[2].id).not.toBe('c1')
  })

  it('addCard is a ref-stable no-op on a blank title', () => {
    const b = board()
    expect(addCard(b, 'backlog', '   ')).toBe(b.cards)
  })

  it('renameCard trims and retitles; blank reverts (no-op)', () => {
    const b = board()
    expect(renameCard(b, 'c1', '  Renamed ')[0].title).toBe('Renamed')
    expect(renameCard(b, 'c1', '   ')).toBe(b.cards)
    expect(renameCard(b, 'c1', 'One')).toBe(b.cards) // identical → same ref
  })

  it('removeCard drops the card', () => {
    const out = removeCard(board(), 'c1')
    expect(out.map((c) => c.id)).toEqual(['c2'])
  })

  it('moveCard re-parents and re-appends to the new column tail', () => {
    const out = moveCard(board(), 'c1', 'review')
    expect(out).toEqual([
      { id: 'c2', columnId: 'progress', title: 'Two' },
      { id: 'c1', columnId: 'review', title: 'One' }
    ])
  })

  it('moveCard no-ops on same column, unknown card, or unknown column', () => {
    const b = board()
    expect(moveCard(b, 'c1', 'backlog')).toBe(b.cards) // same column
    expect(moveCard(b, 'nope', 'review')).toBe(b.cards) // unknown card
    expect(moveCard(b, 'c1', 'ghost')).toBe(b.cards) // unknown column
  })
})

describe('kanbanEdit — column ops', () => {
  it('addColumn appends a fresh-id lane; blank is a no-op', () => {
    const b = board()
    const out = addColumn(b, ' Done ')
    expect(out).toHaveLength(4)
    expect(out[3]).toMatchObject({ title: 'Done' })
    expect(out[3].id).toBeTruthy()
    expect(addColumn(b, '  ')).toBe(b.columns)
  })

  it('renameColumn trims; blank reverts', () => {
    const b = board()
    expect(renameColumn(b, 'backlog', ' Todo ')[0].title).toBe('Todo')
    expect(renameColumn(b, 'backlog', '  ')).toBe(b.columns)
  })

  it('setColumnWip sets a floored positive limit and clears on empty/zero/NaN', () => {
    const b = board()
    expect(setColumnWip(b, 'backlog', 3)[0].wip).toBe(3)
    expect(setColumnWip(b, 'backlog', 2.9)[0].wip).toBe(2)
    // clear: undefined/0/NaN drop the field entirely
    expect(setColumnWip(b, 'progress', undefined)[1]).toEqual({
      id: 'progress',
      title: 'In Progress'
    })
    expect(setColumnWip(b, 'progress', 0)[1].wip).toBeUndefined()
    expect(setColumnWip(b, 'progress', Number.NaN)[1].wip).toBeUndefined()
  })

  it('removeColumn reflows orphaned cards to the neighbour and refuses the last lane', () => {
    const b = board()
    // remove middle lane 'progress' → its card reflows to the lane that slides into place ('review')
    const out = removeColumn(b, 'progress')
    expect(out).not.toBeNull()
    expect(out?.columns.map((c) => c.id)).toEqual(['backlog', 'review'])
    expect(out?.cards.find((c) => c.id === 'c2')?.columnId).toBe('review')

    // removing the LAST remaining lane is refused (a Kanban keeps ≥1 lane)
    const single = board({ columns: [{ id: 'only', title: 'Only' }], cards: [] })
    expect(removeColumn(single, 'only')).toBeNull()
    // unknown column id is refused
    expect(removeColumn(b, 'ghost')).toBeNull()
  })

  it('removeColumn reflows to the previous lane when the last column is removed', () => {
    const out = removeColumn(board(), 'review')
    // 'review' had no cards; removing it leaves backlog+progress, no card change
    expect(out?.columns.map((c) => c.id)).toEqual(['backlog', 'progress'])
  })
})
