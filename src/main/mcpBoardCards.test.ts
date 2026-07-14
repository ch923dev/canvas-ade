import { describe, expect, it } from 'vitest'
import { buildBoardCards } from './mcpBoardCards'

describe('buildBoardCards (P3b canvas://board/{id}/cards grouper)', () => {
  it('groups cards under their column in array order, with chips + wip', () => {
    const cards = buildBoardCards({
      id: 'k1',
      title: 'Sprint',
      type: 'kanban',
      kanban: {
        columns: [
          { id: 'backlog', title: 'Backlog' },
          { id: 'wip', title: 'In Progress', wip: 2 }
        ],
        cards: [
          {
            id: 'c1',
            columnId: 'backlog',
            title: 'One',
            tag: 'feature',
            assignee: 'claude',
            ref: 'PR #1'
          },
          { id: 'c2', columnId: 'wip', title: 'Two' },
          { id: 'c3', columnId: 'backlog', title: 'Three' }
        ]
      }
    })
    expect(cards).toEqual({
      boardId: 'k1',
      title: 'Sprint',
      isKanban: true,
      columns: [
        {
          id: 'backlog',
          title: 'Backlog',
          wip: null,
          cards: [
            { id: 'c1', title: 'One', tag: 'feature', assignee: 'claude', ref: 'PR #1' },
            { id: 'c3', title: 'Three' }
          ]
        },
        { id: 'wip', title: 'In Progress', wip: 2, cards: [{ id: 'c2', title: 'Two' }] }
      ]
    })
  })

  it('drops a dangling card (columnId with no matching column)', () => {
    const cards = buildBoardCards({
      id: 'k',
      title: 'K',
      type: 'kanban',
      kanban: {
        columns: [{ id: 'a', title: 'A' }],
        cards: [
          { id: 'c1', columnId: 'a', title: 'kept' },
          { id: 'c2', columnId: 'ghost', title: 'dropped' }
        ]
      }
    })
    expect(cards.columns).toEqual([
      { id: 'a', title: 'A', wip: null, cards: [{ id: 'c1', title: 'kept' }] }
    ])
  })

  it('a non-kanban board reads the graceful shell (never throws)', () => {
    expect(buildBoardCards({ id: 'p', title: 'Plan', type: 'planning' })).toEqual({
      boardId: 'p',
      title: 'Plan',
      isKanban: false,
      columns: []
    })
  })

  it('a kanban board with no projection reads the shell too', () => {
    expect(buildBoardCards({ id: 'k', title: 'K', type: 'kanban' })).toEqual({
      boardId: 'k',
      title: 'K',
      isKanban: false,
      columns: []
    })
  })

  it('omits empty chip strings (never emits an empty tag/assignee/ref)', () => {
    const cards = buildBoardCards({
      id: 'k',
      title: 'K',
      type: 'kanban',
      kanban: {
        columns: [{ id: 'a', title: 'A' }],
        cards: [{ id: 'c1', columnId: 'a', title: 'x', tag: '', assignee: '', ref: '' }]
      }
    })
    expect(cards.columns[0].cards[0]).toEqual({ id: 'c1', title: 'x' })
  })

  it('projects the v19 card-detail fields (description / tags / fileRefs)', () => {
    const cards = buildBoardCards({
      id: 'k',
      title: 'K',
      type: 'kanban',
      kanban: {
        columns: [{ id: 'a', title: 'A' }],
        cards: [
          {
            id: 'c1',
            columnId: 'a',
            title: 'x',
            description: 'why this card',
            tags: ['feature', 'security'],
            fileRefs: [{ path: 'src/x.ts', line: 4, endLine: 9 }, { path: 'README.md' }]
          }
        ]
      }
    })
    expect(cards.columns[0].cards[0]).toEqual({
      id: 'c1',
      title: 'x',
      description: 'why this card',
      tags: ['feature', 'security'],
      fileRefs: [{ path: 'src/x.ts', line: 4, endLine: 9 }, { path: 'README.md' }]
    })
  })

  it('projects card attachments read-only (#346) — assetId + metadata, never the blob', () => {
    const cards = buildBoardCards({
      id: 'k',
      title: 'K',
      type: 'kanban',
      kanban: {
        columns: [{ id: 'a', title: 'A' }],
        cards: [
          {
            id: 'c1',
            columnId: 'a',
            title: 'x',
            attachments: [
              { assetId: 'sha1a', name: 'shot.png', kind: 'image', mime: 'image/png', size: 2048 },
              { assetId: 'sha1b', name: 'notes.txt', kind: 'file' }
            ]
          }
        ]
      }
    })
    expect(cards.columns[0].cards[0].attachments).toEqual([
      { assetId: 'sha1a', name: 'shot.png', kind: 'image', mime: 'image/png', size: 2048 },
      { assetId: 'sha1b', name: 'notes.txt', kind: 'file' }
    ])
  })

  it('surfaces the board column axis + label; omits both when absent', () => {
    const withAxis = buildBoardCards({
      id: 'k',
      title: 'K',
      type: 'kanban',
      kanban: {
        columns: [{ id: 'a', title: 'A' }],
        cards: [],
        columnAxis: 'category',
        axisLabel: 'Subsystem'
      }
    })
    expect(withAxis.columnAxis).toBe('category')
    expect(withAxis.axisLabel).toBe('Subsystem')

    const noAxis = buildBoardCards({
      id: 'k2',
      title: 'K2',
      type: 'kanban',
      kanban: { columns: [{ id: 'a', title: 'A' }], cards: [] }
    })
    expect(noAxis).not.toHaveProperty('columnAxis')
    expect(noAxis).not.toHaveProperty('axisLabel')
  })
})
