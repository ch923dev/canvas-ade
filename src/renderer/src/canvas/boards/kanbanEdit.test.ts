import { describe, it, expect } from 'vitest'
import type { KanbanBoard } from '../../lib/boardSchema'
import type { KanbanAttachment } from '../../lib/kanbanSchema'
import {
  addCard,
  addCardDetailed,
  addColumn,
  effectiveTags,
  moveCard,
  removeCard,
  removeColumn,
  renameCard,
  renameColumn,
  setCardAssignee,
  setCardAttachments,
  setCardDescription,
  setCardFileRefs,
  setCardRef,
  setCardTags,
  setColumnWip,
  tagTint
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

describe('kanbanEdit — card-detail ops (v19)', () => {
  it('setCardDescription sets/updates, drops the key when blank, and no-ops when unchanged', () => {
    const b = board()
    expect(setCardDescription(b, 'c1', '  Do the thing  ')[0]).toMatchObject({
      id: 'c1',
      description: 'Do the thing'
    })
    // unchanged (already absent) → ref-stable no-op
    expect(setCardDescription(b, 'c1', '   ')).toBe(b.cards)
    // clearing an existing description DROPS the key rather than storing ''
    const withDesc = board({
      cards: [{ id: 'c1', columnId: 'backlog', title: 'One', description: 'x' }]
    })
    const cleared = setCardDescription(withDesc, 'c1', '')
    expect('description' in cleared[0]).toBe(false)
    expect(setCardDescription(b, 'nope', 'x')).toBe(b.cards) // unknown card
  })

  it('setCardTags cleans/dedupes, drops the legacy singular tag, and clears on empty', () => {
    const legacy = board({ cards: [{ id: 'c1', columnId: 'backlog', title: 'One', tag: 'old' }] })
    const out = setCardTags(legacy, 'c1', [' feature ', 'schema', 'feature', '  '])
    expect(out[0].tags).toEqual(['feature', 'schema']) // trimmed + deduped, blanks dropped
    expect('tag' in out[0]).toBe(false) // legacy singular tag shed on any tags write
    // empty result drops both keys
    const cleared = setCardTags(
      board({ cards: [{ id: 'c1', columnId: 'backlog', title: 'One', tags: ['a'] }] }),
      'c1',
      []
    )
    expect('tags' in cleared[0]).toBe(false)
    // same tags AND no legacy tag → ref-stable no-op
    const same = board({
      cards: [{ id: 'c1', columnId: 'backlog', title: 'One', tags: ['a', 'b'] }]
    })
    expect(setCardTags(same, 'c1', ['a', 'b'])).toBe(same.cards)
  })

  it('setCardFileRefs normalizes path/line/endLine and keeps a range only when endLine > line', () => {
    const b = board()
    const out = setCardFileRefs(b, 'c1', [
      { path: '  src/a.ts  ', line: 12.7, endLine: 20 }, // path trimmed, line floored, real range
      { path: 'src/b.ts', line: 0 }, // non-positive line dropped → opens at top
      { path: 'src/c.ts', line: 5, endLine: 5 }, // endLine == line → collapses to single line
      { path: '   ' } // blank path dropped entirely
    ])
    expect(out[0].fileRefs).toEqual([
      { path: 'src/a.ts', line: 12, endLine: 20 },
      { path: 'src/b.ts' },
      { path: 'src/c.ts', line: 5 }
    ])
    // structurally identical → ref-stable no-op
    const same = board({
      cards: [
        { id: 'c1', columnId: 'backlog', title: 'One', fileRefs: [{ path: 'x.ts', line: 3 }] }
      ]
    })
    expect(setCardFileRefs(same, 'c1', [{ path: 'x.ts', line: 3 }])).toBe(same.cards)
    // empty result drops the key
    expect('fileRefs' in setCardFileRefs(same, 'c1', [])[0]).toBe(false)
  })

  it('setCardAssignee / setCardRef set, drop on blank, and no-op when unchanged', () => {
    const b = board()
    expect(setCardAssignee(b, 'c1', ' claude ')[0]).toMatchObject({ assignee: 'claude' })
    expect(setCardRef(b, 'c1', ' PR #7 ')[0]).toMatchObject({ ref: 'PR #7' })
    const withAssignee = board({
      cards: [{ id: 'c1', columnId: 'backlog', title: 'One', assignee: 'x' }]
    })
    expect('assignee' in setCardAssignee(withAssignee, 'c1', '')[0]).toBe(false)
    expect(setCardAssignee(b, 'c1', '')).toBe(b.cards) // already absent → no-op
  })

  it('setCardAttachments stores entries, drops the key on empty, and no-ops when unchanged (#346)', () => {
    const b = board()
    const atts: KanbanAttachment[] = [
      { assetId: 'assets/a.png', name: 'a.png', kind: 'image', mime: 'image/png', size: 12 }
    ]
    expect(setCardAttachments(b, 'c1', atts)[0].attachments).toEqual(atts)
    // clearing an existing list DROPS the key rather than storing []
    const withAtt = board({
      cards: [{ id: 'c1', columnId: 'backlog', title: 'One', attachments: atts }]
    })
    expect('attachments' in setCardAttachments(withAtt, 'c1', [])[0]).toBe(false)
    // structurally identical → ref-stable no-op
    expect(
      setCardAttachments(withAtt, 'c1', [
        { assetId: 'assets/a.png', name: 'a.png', kind: 'image', mime: 'image/png', size: 12 }
      ])
    ).toBe(withAtt.cards)
    expect(setCardAttachments(b, 'nope', atts)).toBe(b.cards) // unknown card
  })

  it('addCardDetailed appends a normalized new card with every field (#346)', () => {
    const b = board()
    const out = addCardDetailed(b, 'review', {
      title: '  Ship it ',
      description: '  body  ',
      tags: [' feature ', 'feature', '  '], // trimmed + deduped, blank dropped
      assignee: ' claude ',
      ref: ' PR #9 ',
      fileRefs: [{ path: ' src/x.ts ', line: 3.9 }, { path: '   ' }], // path trimmed, line floored, blank dropped
      attachments: [{ assetId: 'assets/v.mp4', name: 'v.mp4', kind: 'video' }]
    })
    expect(out).toHaveLength(3)
    const c = out[2]
    expect(c).toMatchObject({
      columnId: 'review',
      title: 'Ship it',
      description: 'body',
      tags: ['feature'],
      assignee: 'claude',
      ref: 'PR #9',
      fileRefs: [{ path: 'src/x.ts', line: 3 }],
      attachments: [{ assetId: 'assets/v.mp4', name: 'v.mp4', kind: 'video' }]
    })
    expect(c.id).toBeTruthy()
  })

  it('addCardDetailed omits empty fields and refuses a blank title (#346)', () => {
    const b = board()
    const out = addCardDetailed(b, 'backlog', { title: 'Bare' })
    const c = out[2]
    expect(c).toEqual({ id: c.id, columnId: 'backlog', title: 'Bare' })
    for (const k of ['description', 'tags', 'assignee', 'ref', 'fileRefs', 'attachments']) {
      expect(k in c).toBe(false)
    }
    // blank title → ref-stable no-op (no card added)
    expect(addCardDetailed(b, 'backlog', { title: '   ' })).toBe(b.cards)
  })

  it('effectiveTags prefers tags[], falls back to the legacy tag, else empty', () => {
    expect(effectiveTags({ id: 'c', columnId: 'x', title: 't', tags: ['a', 'b'] })).toEqual([
      'a',
      'b'
    ])
    expect(effectiveTags({ id: 'c', columnId: 'x', title: 't', tag: 'old' })).toEqual(['old'])
    expect(effectiveTags({ id: 'c', columnId: 'x', title: 't' })).toEqual([])
    // an explicit tags[] wins even when a legacy tag is also present
    expect(
      effectiveTags({ id: 'c', columnId: 'x', title: 't', tag: 'old', tags: ['new'] })
    ).toEqual(['new'])
  })

  it('tagTint buckets by keyword and falls back to muted', () => {
    expect(tagTint('shipped')).toBe('ok')
    expect(tagTint('needs review')).toBe('warn')
    expect(tagTint('feature')).toBe('accent')
    expect(tagTint('random')).toBe('muted')
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
