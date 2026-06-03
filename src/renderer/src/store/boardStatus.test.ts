import { describe, expect, it } from 'vitest'
import { boardStatusBucket, bucketToPill, buildBoardSnapshot } from './boardStatus'

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

  it('the pill mapping is derived from the same bucket the MCP sees (T1.6)', () => {
    // running pulses (--ok); idle is neutral; attention buckets warn/err; static = no pill.
    expect(bucketToPill('running')).toEqual({ dot: 'var(--ok)', label: 'running' })
    expect(bucketToPill('idle')).toEqual({ dot: 'var(--text-3)', label: 'idle' })
    expect(bucketToPill('awaiting-review')).toEqual({
      dot: 'var(--warn)',
      label: 'awaiting review'
    })
    expect(bucketToPill('blocked')).toEqual({ dot: 'var(--warn)', label: 'blocked' })
    expect(bucketToPill('failed')).toEqual({ dot: 'var(--err)', label: 'failed' })
    expect(bucketToPill('static')).toBeNull()
  })

  it('the live browser pill agrees with the browser bucket end-to-end', () => {
    // The exact divergence T1.6 closes: a loaded browser reads idle (not a green
    // "connected"), a loading one running, a failed one failed — same as canvas://boards.
    expect(bucketToPill(boardStatusBucket('browser', { preview: 'connected' }))).toEqual({
      dot: 'var(--text-3)',
      label: 'idle'
    })
    expect(bucketToPill(boardStatusBucket('browser', { preview: 'connecting' }))?.dot).toBe(
      'var(--ok)'
    )
    expect(bucketToPill(boardStatusBucket('browser', { preview: 'load-failed' }))?.dot).toBe(
      'var(--err)'
    )
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
