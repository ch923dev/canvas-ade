import { describe, it, expect } from 'vitest'
import { recordPast, applyUndo, applyRedo } from './history'

describe('history helpers', () => {
  it('recordPast appends and caps at the limit', () => {
    expect(recordPast([1, 2], 3)).toEqual([1, 2, 3])
    expect(recordPast([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })
  it('applyUndo returns null when there is nothing to undo', () => {
    expect(applyUndo([], 'present', [])).toBeNull()
  })
  it('applyUndo moves present→future and pops past→present', () => {
    expect(applyUndo(['a', 'b'], 'c', [])).toEqual({ past: ['a'], present: 'b', future: ['c'] })
  })
  it('applyRedo returns null when there is nothing to redo', () => {
    expect(applyRedo([], 'present', [])).toBeNull()
  })
  it('applyRedo moves present→past and shifts future→present', () => {
    expect(applyRedo(['a'], 'b', ['c', 'd'])).toEqual({
      past: ['a', 'b'],
      present: 'c',
      future: ['d']
    })
  })
})
