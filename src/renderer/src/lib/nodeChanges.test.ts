import { describe, it, expect } from 'vitest'
import { nodeChangesToIntents } from './nodeChanges'

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
