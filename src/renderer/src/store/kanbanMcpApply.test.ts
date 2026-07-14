import { describe, it, expect } from 'vitest'
import { applyKanbanOps, MAX_KANBAN_BOARD_CARDS } from './kanbanMcpApply'
import type { KanbanBoard } from '../lib/boardSchema'
import type { KanbanOp } from '../../../shared/mcpTypes'

const board = (cards: KanbanBoard['cards'] = []): KanbanBoard => ({
  id: 'k1',
  type: 'kanban',
  x: 0,
  y: 0,
  w: 900,
  h: 520,
  title: 'Plan',
  columns: [
    { id: 'backlog', title: 'Backlog' },
    { id: 'review', title: 'Review' }
  ],
  cards
})

describe('applyKanbanOps', () => {
  it('add appends a fully-specified card to its column', () => {
    const out = applyKanbanOps(board(), [
      { op: 'add', card: { id: 'c1', columnId: 'backlog', title: 'One', tag: 'feature' } }
    ])
    expect(out).toEqual([{ id: 'c1', columnId: 'backlog', title: 'One', tag: 'feature' }])
  })

  it('move re-parents a card and re-appends it to the tail (bottom of the new column)', () => {
    const out = applyKanbanOps(
      board([
        { id: 'c1', columnId: 'backlog', title: 'One' },
        { id: 'c2', columnId: 'backlog', title: 'Two' }
      ]),
      [{ op: 'move', cardId: 'c1', toColumnId: 'review' }]
    )
    // c1 moved to review AND is now last in the array (renders at the bottom of Review).
    expect(out).toEqual([
      { id: 'c2', columnId: 'backlog', title: 'Two' },
      { id: 'c1', columnId: 'review', title: 'One' }
    ])
  })

  it('update merges ONLY the supplied fields', () => {
    const out = applyKanbanOps(board([{ id: 'c1', columnId: 'backlog', title: 'One', tag: 'a' }]), [
      { op: 'update', cardId: 'c1', patch: { tag: 'shipped', ref: 'PR #9' } }
    ])
    expect(out[0]).toEqual({
      id: 'c1',
      columnId: 'backlog',
      title: 'One',
      tag: 'shipped',
      ref: 'PR #9'
    })
  })

  it('remove deletes the card', () => {
    const out = applyKanbanOps(
      board([
        { id: 'c1', columnId: 'backlog', title: 'One' },
        { id: 'c2', columnId: 'backlog', title: 'Two' }
      ]),
      [{ op: 'remove', cardId: 'c1' }]
    )
    expect(out.map((c) => c.id)).toEqual(['c2'])
  })

  it('add carries the v19 detail fields (description / tags / fileRefs)', () => {
    const out = applyKanbanOps(board(), [
      {
        op: 'add',
        card: {
          id: 'c1',
          columnId: 'backlog',
          title: 'One',
          description: 'why',
          tags: ['feature'],
          fileRefs: [{ path: 'a.ts', line: 3 }]
        }
      }
    ])
    expect(out[0]).toEqual({
      id: 'c1',
      columnId: 'backlog',
      title: 'One',
      description: 'why',
      tags: ['feature'],
      fileRefs: [{ path: 'a.ts', line: 3 }]
    })
  })

  it('add with `tags` supersedes (never emits) the legacy singular `tag`', () => {
    const out = applyKanbanOps(board(), [
      {
        op: 'add',
        card: { id: 'c1', columnId: 'backlog', title: 'One', tag: 'legacy', tags: ['new'] }
      }
    ])
    expect(out[0]).toEqual({ id: 'c1', columnId: 'backlog', title: 'One', tags: ['new'] })
    expect(out[0]).not.toHaveProperty('tag')
  })

  it("update merges the v19 detail fields; writing `tags` SHEDS the card's legacy `tag`", () => {
    const out = applyKanbanOps(
      board([{ id: 'c1', columnId: 'backlog', title: 'One', tag: 'legacy' }]),
      [{ op: 'update', cardId: 'c1', patch: { description: 'note', tags: ['shipped'] } }]
    )
    expect(out[0]).toEqual({
      id: 'c1',
      columnId: 'backlog',
      title: 'One',
      description: 'note',
      tags: ['shipped']
    })
    expect(out[0]).not.toHaveProperty('tag')
  })

  it("update writing the legacy `tag` SHEDS the card's v19 `tags` (mutual exclusion, both directions)", () => {
    const out = applyKanbanOps(
      board([{ id: 'c1', columnId: 'backlog', title: 'One', tags: ['feature', 'security'] }]),
      [{ op: 'update', cardId: 'c1', patch: { tag: 'legacy' } }]
    )
    // A later legacy-`tag`-only write must not leave the card carrying BOTH fields.
    expect(out[0]).toEqual({ id: 'c1', columnId: 'backlog', title: 'One', tag: 'legacy' })
    expect(out[0]).not.toHaveProperty('tags')
  })

  it('applies a batch of ops in order', () => {
    const out = applyKanbanOps(board(), [
      { op: 'add', card: { id: 'c1', columnId: 'backlog', title: 'One' } },
      { op: 'move', cardId: 'c1', toColumnId: 'review' },
      { op: 'update', cardId: 'c1', patch: { tag: 'done' } }
    ])
    expect(out).toEqual([{ id: 'c1', columnId: 'review', title: 'One', tag: 'done' }])
  })

  it('throws (lands nothing) on an unknown column, unknown card, or duplicate id', () => {
    expect(() =>
      applyKanbanOps(board(), [{ op: 'add', card: { id: 'c1', columnId: 'ghost', title: 'x' } }])
    ).toThrow(/unknown column/)
    expect(() =>
      applyKanbanOps(board([{ id: 'c1', columnId: 'backlog', title: 'x' }]), [
        { op: 'add', card: { id: 'c1', columnId: 'backlog', title: 'dup' } }
      ])
    ).toThrow(/duplicate/)
    expect(() =>
      applyKanbanOps(board(), [{ op: 'move', cardId: 'nope', toColumnId: 'review' }])
    ).toThrow(/unknown card/)
    expect(() =>
      applyKanbanOps(board([{ id: 'c1', columnId: 'backlog', title: 'x' }]), [
        { op: 'move', cardId: 'c1', toColumnId: 'ghost' }
      ])
    ).toThrow(/unknown column/)
  })

  it('enforces the per-board card cap', () => {
    const many = Array.from({ length: MAX_KANBAN_BOARD_CARDS }, (_, i) => ({
      id: `c${i}`,
      columnId: 'backlog',
      title: `t${i}`
    }))
    const op: KanbanOp = { op: 'add', card: { id: 'over', columnId: 'backlog', title: 'over' } }
    expect(() => applyKanbanOps(board(many), [op])).toThrow(/cap exceeded/)
  })

  it('does not mutate the input board.cards (pure)', () => {
    const cards = [{ id: 'c1', columnId: 'backlog', title: 'One' }]
    const b = board(cards)
    applyKanbanOps(b, [{ op: 'remove', cardId: 'c1' }])
    expect(b.cards).toEqual([{ id: 'c1', columnId: 'backlog', title: 'One' }])
  })
})
