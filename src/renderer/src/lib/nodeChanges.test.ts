import { describe, it, expect } from 'vitest'
import { nodeChangesToIntents, foldSelectionIntents, type Intent } from './nodeChanges'

describe('nodeChangesToIntents', () => {
  it('maps a position change to a move intent', () => {
    expect(
      nodeChangesToIntents([{ type: 'position', id: 'a', position: { x: 5, y: 6 } } as never])
    ).toEqual([{ kind: 'move', id: 'a', x: 5, y: 6 }])
  })
  it('maps a resizing dimensions change to a resize intent (ignores non-resizing)', () => {
    expect(
      nodeChangesToIntents([
        {
          type: 'dimensions',
          id: 'a',
          dimensions: { width: 300, height: 200 },
          resizing: true
        } as never,
        {
          type: 'dimensions',
          id: 'b',
          dimensions: { width: 1, height: 1 },
          resizing: false
        } as never
      ])
    ).toEqual([{ kind: 'resize', id: 'a', w: 300, h: 200 }])
  })
  it('maps select/deselect and remove', () => {
    expect(
      nodeChangesToIntents([
        { type: 'select', id: 'a', selected: true } as never,
        { type: 'select', id: 'c', selected: false } as never,
        { type: 'remove', id: 'b' } as never
      ])
    ).toEqual([
      { kind: 'select', id: 'a' },
      { kind: 'deselect', id: 'c' },
      { kind: 'remove', id: 'b' }
    ])
  })
})

describe('foldSelectionIntents', () => {
  const sel = (i: Intent[]): { ids: string[]; changed: boolean } => foldSelectionIntents(['a'], i)

  it('a plain click (select B + deselect A) collapses to the single new id', () => {
    expect(
      sel([
        { kind: 'deselect', id: 'a' },
        { kind: 'select', id: 'b' }
      ])
    ).toEqual({
      ids: ['b'],
      changed: true
    })
  })

  it('additive select keeps prior members (Ctrl-click / marquee multi-select)', () => {
    expect(
      sel([
        { kind: 'select', id: 'b' },
        { kind: 'select', id: 'c' }
      ])
    ).toEqual({
      ids: ['a', 'b', 'c'],
      changed: true
    })
  })

  it('a multi-delete drops every removed id — no ghost id survives the fold', () => {
    expect(
      foldSelectionIntents(
        ['a', 'b', 'c'],
        [
          { kind: 'remove', id: 'a' },
          { kind: 'remove', id: 'b' }
        ]
      )
    ).toEqual({ ids: ['c'], changed: true })
  })

  it('remove wins even if a stale select for the same id appears first', () => {
    expect(
      foldSelectionIntents(
        [],
        [
          { kind: 'select', id: 'a' },
          { kind: 'remove', id: 'a' }
        ]
      )
    ).toEqual({ ids: [], changed: true })
  })

  it('move/resize intents leave the selection untouched and changed:false', () => {
    expect(
      foldSelectionIntents(
        ['a'],
        [
          { kind: 'move', id: 'a', x: 1, y: 2 },
          { kind: 'resize', id: 'a', w: 300, h: 200 }
        ]
      )
    ).toEqual({ ids: ['a'], changed: false })
  })

  it('does not mutate the input selection array', () => {
    const cur = ['a']
    foldSelectionIntents(cur, [{ kind: 'select', id: 'b' }])
    expect(cur).toEqual(['a'])
  })
})
