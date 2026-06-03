import { describe, expect, it } from 'vitest'
import { __setMirrorForTest, listBoardMirror, sanitizeSnapshot } from './boardRegistry'

describe('boardRegistry', () => {
  it('sanitizeSnapshot keeps well-formed entries and drops malformed ones', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'T' },
      { id: 'b', type: 'browser', title: 'B' },
      { id: 1, type: 'planning', title: 'P' }, // bad id
      { id: 'c', type: 'planning' }, // missing title
      'nope'
    ])
    expect(out).toEqual([
      { id: 'a', type: 'terminal', title: 'T' },
      { id: 'b', type: 'browser', title: 'B' }
    ])
  })

  it('keeps a valid status bucket and drops an invalid/absent one', () => {
    const out = sanitizeSnapshot([
      { id: 'a', type: 'terminal', title: 'T', status: 'running' },
      { id: 'b', type: 'browser', title: 'B', status: 'bogus-bucket' }, // invalid → dropped
      { id: 'c', type: 'planning', title: 'P', status: 123 }, // non-string → dropped
      { id: 'd', type: 'terminal', title: 'D' } // legacy, no status
    ])
    expect(out).toEqual([
      { id: 'a', type: 'terminal', title: 'T', status: 'running' },
      { id: 'b', type: 'browser', title: 'B' },
      { id: 'c', type: 'planning', title: 'P' },
      { id: 'd', type: 'terminal', title: 'D' }
    ])
  })

  it('listBoardMirror returns the last stored snapshot (empty by default)', () => {
    __setMirrorForTest([{ id: 'x', type: 'terminal', title: 'X' }])
    expect(listBoardMirror()).toEqual([{ id: 'x', type: 'terminal', title: 'X' }])
    __setMirrorForTest([])
    expect(listBoardMirror()).toEqual([])
  })
})
