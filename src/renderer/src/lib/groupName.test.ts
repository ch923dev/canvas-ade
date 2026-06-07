import { describe, it, expect } from 'vitest'
import { nextGroupName } from './groupName'

describe('nextGroupName', () => {
  it('returns Group 1 for no groups', () => {
    expect(nextGroupName([])).toBe('Group 1')
  })
  it('skips taken ordinals', () => {
    expect(nextGroupName([{ id: 'a', name: 'Group 1', boardIds: [] }])).toBe('Group 2')
  })
  it('fills the lowest free ordinal', () => {
    expect(
      nextGroupName([
        { id: 'a', name: 'Group 1', boardIds: [] },
        { id: 'b', name: 'Group 3', boardIds: [] }
      ])
    ).toBe('Group 2')
  })
})
