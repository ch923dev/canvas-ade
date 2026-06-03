import { describe, expect, it } from 'vitest'
import { boardStatusBucket, buildBoardSnapshot } from './boardStatus'

describe('boardStatusBucket', () => {
  it('a running terminal is running, an idle/unstarted terminal is idle', () => {
    expect(boardStatusBucket('terminal', { terminalRunning: true })).toBe('running')
    expect(boardStatusBucket('terminal', { terminalRunning: false })).toBe('idle')
    expect(boardStatusBucket('terminal', {})).toBe('idle')
  })

  it('a browser maps its preview load state to a bucket', () => {
    expect(boardStatusBucket('browser', { preview: 'connecting' })).toBe('running')
    expect(boardStatusBucket('browser', { preview: 'load-failed' })).toBe('failed')
    expect(boardStatusBucket('browser', { preview: 'connected' })).toBe('idle')
    expect(boardStatusBucket('browser', { preview: 'idle' })).toBe('idle')
    expect(boardStatusBucket('browser', {})).toBe('idle')
  })

  it('a planning board is static; an unknown/forward type is static', () => {
    expect(boardStatusBucket('planning', {})).toBe('static')
    expect(boardStatusBucket('whatever-future', {})).toBe('static')
  })
})

describe('buildBoardSnapshot', () => {
  it('enriches each board with its derived status bucket, keyed by id', () => {
    const boards = [
      { id: 't1', type: 'terminal', title: 'Term A' },
      { id: 't2', type: 'terminal', title: 'Term B' },
      { id: 'b1', type: 'browser', title: 'Web' },
      { id: 'p1', type: 'planning', title: 'Plan' }
    ]
    const snapshot = buildBoardSnapshot(boards, {
      running: { t1: true, t2: false },
      preview: { b1: { status: 'load-failed' } }
    })
    expect(snapshot).toEqual([
      { id: 't1', type: 'terminal', title: 'Term A', status: 'running' },
      { id: 't2', type: 'terminal', title: 'Term B', status: 'idle' },
      { id: 'b1', type: 'browser', title: 'Web', status: 'failed' },
      { id: 'p1', type: 'planning', title: 'Plan', status: 'static' }
    ])
  })

  it('defaults absent runtime entries to the resting bucket', () => {
    const snapshot = buildBoardSnapshot([{ id: 't1', type: 'terminal', title: 'T' }], {
      running: {},
      preview: {}
    })
    expect(snapshot[0].status).toBe('idle')
  })
})
