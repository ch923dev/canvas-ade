import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetBoardResults,
  pruneBoardResults,
  readBoardResult,
  recordBoardResult
} from './boardResults'

afterEach(() => __resetBoardResults())

describe('boardResults', () => {
  it('returns the empty shell for a board with no recorded result', () => {
    expect(readBoardResult('nope')).toEqual({ present: false })
  })

  it('round-trips a recorded structured result', () => {
    recordBoardResult('b1', { present: true, status: 'success', summary: 'ok', refs: ['a.ts'] })
    expect(readBoardResult('b1')).toEqual({
      present: true,
      status: 'success',
      summary: 'ok',
      refs: ['a.ts']
    })
  })

  it('a later record overwrites the earlier one (last result wins)', () => {
    recordBoardResult('b1', { present: true, status: 'failure' })
    recordBoardResult('b1', { present: true, status: 'success' })
    expect(readBoardResult('b1').status).toBe('success')
  })

  it('keeps results per board', () => {
    recordBoardResult('b1', { present: true, status: 'success' })
    expect(readBoardResult('b2')).toEqual({ present: false })
  })
})

// BUG-035 regression: pruneBoardResults must clear stale results on project switch/deletion.
describe('pruneBoardResults (BUG-035)', () => {
  it('removes entries for boards absent from the live set', () => {
    recordBoardResult('b1', { present: true, status: 'success' })
    recordBoardResult('b2', { present: true, status: 'failure' })
    pruneBoardResults(new Set(['b1'])) // b2 deleted
    expect(readBoardResult('b1')).toEqual({ present: true, status: 'success' })
    expect(readBoardResult('b2')).toEqual({ present: false }) // pruned
  })

  it('clears all entries when the live set is empty (project switch)', () => {
    recordBoardResult('b1', { present: true, status: 'success' })
    recordBoardResult('b2', { present: true, status: 'failure' })
    pruneBoardResults(new Set())
    expect(readBoardResult('b1')).toEqual({ present: false })
    expect(readBoardResult('b2')).toEqual({ present: false })
  })

  it('is a no-op when all boards are still live', () => {
    recordBoardResult('b1', { present: true, status: 'success' })
    pruneBoardResults(new Set(['b1', 'b2']))
    expect(readBoardResult('b1')).toEqual({ present: true, status: 'success' })
  })
})
