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

  it('unseen attention outranks liveness: needs-input → awaiting-review, error → failed (P2)', () => {
    // A Claude Notification fires while the PTY is still running — attention must win.
    expect(boardStatusBucket('terminal', { terminalRunning: true, attention: 'needs-input' })).toBe(
      'awaiting-review'
    )
    expect(boardStatusBucket('terminal', { terminalRunning: true, attention: 'error' })).toBe(
      'failed'
    )
  })

  it('done-unseen keeps the liveness derivation (badge-only per DESIGN.md)', () => {
    expect(boardStatusBucket('terminal', { terminalRunning: true, attention: 'done' })).toBe(
      'running'
    )
    expect(boardStatusBucket('terminal', { attention: 'done' })).toBe('idle')
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

  it('threads per-board attention into the bucket (P2 — the canvas://attention feed)', () => {
    const snapshot = buildBoardSnapshot(
      [
        { id: 't1', type: 'terminal', title: 'A' },
        { id: 't2', type: 'terminal', title: 'B' }
      ],
      { running: { t1: true, t2: true }, preview: {}, attention: { t1: 'needs-input' } }
    )
    expect(snapshot[0].status).toBe('awaiting-review')
    expect(snapshot[1].status).toBe('running')
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

  it('projects a planning board’s elements with ids + editable fields, dropping id-less ones (S6)', () => {
    const snapshot = buildBoardSnapshot(
      [
        {
          id: 'p1',
          type: 'planning',
          title: 'Plan',
          elements: [
            { id: 'n1', kind: 'note', text: 'Phase 1', tint: 'yellow' },
            {
              id: 'c1',
              kind: 'checklist',
              title: 'Progress',
              items: [{ id: 'i1', label: 'a', done: true }]
            },
            { kind: 'note', text: 'no-id' } // no id → dropped from the projection
          ]
        }
      ],
      { running: {}, preview: {} }
    )
    expect(snapshot[0].planning).toEqual({
      elements: [
        { id: 'n1', kind: 'note', text: 'Phase 1', tint: 'yellow' },
        {
          id: 'c1',
          kind: 'checklist',
          title: 'Progress',
          items: [{ id: 'i1', label: 'a', done: true }]
        }
      ]
    })
  })

  it('omits planning for a non-planning board even with stray elements (S6)', () => {
    const snapshot = buildBoardSnapshot(
      [{ id: 'k1', type: 'kanban', title: 'K', elements: [{ id: 'n1', kind: 'note', text: 'x' }] }],
      { running: {}, preview: {} }
    )
    expect('planning' in snapshot[0]).toBe(false)
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

  it('forwards world-space geometry x/y/w/h when present (P1 canvas awareness)', () => {
    const snapshot = buildBoardSnapshot(
      [{ id: 'b1', type: 'planning', title: 'Plan', x: 120, y: 40, w: 640, h: 480 }],
      {
        running: {},
        preview: {}
      }
    )
    expect(snapshot[0]).toEqual({
      id: 'b1',
      type: 'planning',
      title: 'Plan',
      status: 'static',
      x: 120,
      y: 40,
      w: 640,
      h: 480
    })
  })

  it('omits geometry for a stub without it (byte-identical) + drops non-finite values (P1)', () => {
    const [noGeo, badGeo] = buildBoardSnapshot(
      [
        { id: 'a', type: 'terminal', title: 'A' },
        // A NaN/∞ must never reach the mirror — the finite guard drops it, keeps the board.
        { id: 'b', type: 'terminal', title: 'B', x: NaN, y: Infinity, w: 300, h: 200 }
      ],
      { running: {}, preview: {} }
    )
    expect(noGeo).toEqual({ id: 'a', type: 'terminal', title: 'A', status: 'idle' })
    expect('x' in noGeo).toBe(false)
    expect('x' in badGeo).toBe(false)
    expect('y' in badGeo).toBe(false)
    expect(badGeo).toMatchObject({ w: 300, h: 200 })
  })

  it('projects a kanban board bounded columns+cards; chips + wip ride through (P3b)', () => {
    const [board] = buildBoardSnapshot(
      [
        {
          id: 'k1',
          type: 'kanban',
          title: 'Sprint',
          columns: [
            { id: 'backlog', title: 'Backlog' },
            { id: 'wip', title: 'In Progress', wip: 2 }
          ],
          cards: [
            {
              id: 'c1',
              columnId: 'backlog',
              title: 'One',
              tag: 'feature',
              assignee: 'claude',
              ref: 'PR #1'
            },
            { id: 'c2', columnId: 'wip', title: 'Two' }
          ]
        }
      ],
      { running: {}, preview: {} }
    )
    expect(board.status).toBe('static')
    expect(board.kanban).toEqual({
      columns: [
        { id: 'backlog', title: 'Backlog' },
        { id: 'wip', title: 'In Progress', wip: 2 }
      ],
      cards: [
        {
          id: 'c1',
          columnId: 'backlog',
          title: 'One',
          tag: 'feature',
          assignee: 'claude',
          ref: 'PR #1'
        },
        { id: 'c2', columnId: 'wip', title: 'Two' }
      ]
    })
  })

  it('omits kanban for every non-kanban board (byte-identical) even if it carries stray columns (P3b)', () => {
    const [plan] = buildBoardSnapshot(
      // A non-kanban board carrying stray `columns`/`cards` must not project a kanban field.
      [{ id: 'p', type: 'planning', title: 'Plan', columns: [{ id: 'x', title: 'X' }], cards: [] }],
      { running: {}, preview: {} }
    )
    expect(plan).toEqual({ id: 'p', type: 'planning', title: 'Plan', status: 'static' })
    expect('kanban' in plan).toBe(false)
  })

  it('drops malformed columns/cards and count-caps the projection (P3b)', () => {
    const [board] = buildBoardSnapshot(
      [
        {
          id: 'k',
          type: 'kanban',
          title: 'K',
          columns: [
            { id: 'ok', title: 'OK' },
            // missing id → dropped
            { id: '', title: 'Empty' } as { id: string; title: string }
          ],
          cards: Array.from({ length: 305 }, (_, i) => ({
            id: `c${i}`,
            columnId: 'ok',
            title: `n${i}`
          }))
        }
      ],
      { running: {}, preview: {} }
    )
    expect(board.kanban?.columns).toEqual([{ id: 'ok', title: 'OK' }])
    expect(board.kanban?.cards).toHaveLength(300) // MAX_KANBAN_CARDS
  })
})
