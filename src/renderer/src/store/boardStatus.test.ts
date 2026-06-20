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
    expect(boardStatusBucket('browser', { preview: 'crashed' })).toBe('failed') // D2-C
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

  it('forwards v10 agentKind + monitorActivity only when present (Phase B)', () => {
    const snapshot = buildBoardSnapshot(
      [
        { id: 't1', type: 'terminal', title: 'Claude', agentKind: 'claude', monitorActivity: true },
        { id: 't2', type: 'terminal', title: 'Shell', monitorActivity: false },
        { id: 't3', type: 'terminal', title: 'Plain' } // neither field set
      ],
      { running: { t1: true }, preview: {} }
    )
    expect(snapshot).toEqual([
      {
        id: 't1',
        type: 'terminal',
        title: 'Claude',
        status: 'running',
        agentKind: 'claude',
        monitorActivity: true
      },
      { id: 't2', type: 'terminal', title: 'Shell', status: 'idle', monitorActivity: false },
      { id: 't3', type: 'terminal', title: 'Plain', status: 'idle' }
    ])
    // Absent fields must not appear as keys (no `agentKind: undefined` noise on the wire).
    expect('agentKind' in snapshot[2]).toBe(false)
    expect('monitorActivity' in snapshot[2]).toBe(false)
  })

  it('forwards a file board path (S5), omitting it for an unbound file board', () => {
    const snapshot = buildBoardSnapshot(
      [
        { id: 'f1', type: 'file', title: 'main.ts', path: 'src/main.ts' },
        { id: 'f2', type: 'file', title: 'Untitled' } // unbound placeholder — no path
      ],
      { running: {}, preview: {} }
    )
    expect(snapshot[0]).toEqual({
      id: 'f1',
      type: 'file',
      title: 'main.ts',
      status: 'static',
      path: 'src/main.ts'
    })
    expect(snapshot[1]).toEqual({ id: 'f2', type: 'file', title: 'Untitled', status: 'static' })
    expect('path' in snapshot[1]).toBe(false)
  })

  it('aggregates a planning board fileref elements into fileRefs (S5)', () => {
    const snapshot = buildBoardSnapshot(
      [
        {
          id: 'p1',
          type: 'planning',
          title: 'Plan',
          elements: [
            { kind: 'note' }, // ignored
            { kind: 'fileref', path: 'src/app.ts', label: 'app.ts' },
            { kind: 'fileref', path: 'docs/spec/README.md' }, // label falls back to basename
            { kind: 'fileref', label: 'no-path' }, // dropped: no path
            { kind: 'stroke' } // ignored
          ]
        }
      ],
      { running: {}, preview: {} }
    )
    expect(snapshot[0]).toEqual({
      id: 'p1',
      type: 'planning',
      title: 'Plan',
      status: 'static',
      fileRefs: [
        { path: 'src/app.ts', label: 'app.ts' },
        { path: 'docs/spec/README.md', label: 'README.md' }
      ]
    })
  })

  it('omits fileRefs for a planning board with no fileref elements (byte-identical) (S5)', () => {
    const snapshot = buildBoardSnapshot(
      [
        {
          id: 'p1',
          type: 'planning',
          title: 'Plan',
          elements: [{ kind: 'note' }, { kind: 'arrow' }]
        }
      ],
      { running: {}, preview: {} }
    )
    expect(snapshot[0]).toEqual({ id: 'p1', type: 'planning', title: 'Plan', status: 'static' })
    expect('fileRefs' in snapshot[0]).toBe(false)
  })

  it('does not cross file context across board types: path only on file, fileRefs only on planning (S5)', () => {
    const snapshot = buildBoardSnapshot(
      [
        // A non-file board carrying a stray `path` must not leak it to the mirror.
        { id: 't1', type: 'terminal', title: 'T', path: 'should/not/appear' },
        // A non-planning board carrying stray `elements` must not produce fileRefs.
        {
          id: 'b1',
          type: 'browser',
          title: 'Web',
          elements: [{ kind: 'fileref', path: 'x.ts', label: 'x.ts' }]
        }
      ],
      { running: {}, preview: {} }
    )
    expect('path' in snapshot[0]).toBe(false)
    expect('fileRefs' in snapshot[1]).toBe(false)
  })
})
