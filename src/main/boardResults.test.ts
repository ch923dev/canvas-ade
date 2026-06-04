import { afterEach, describe, expect, it } from 'vitest'
import { __resetBoardResults, readBoardResult, recordBoardResult } from './boardResults'

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
