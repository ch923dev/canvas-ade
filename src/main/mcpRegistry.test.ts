import { describe, expect, it, vi } from 'vitest'
import { deriveStatus, makeSessionLookup } from './mcpRegistry'

describe('deriveStatus', () => {
  /** A lookup that always reports "no live PTY session" for the id. */
  const noSessions = (): string | undefined => undefined

  it('the renderer-supplied mirror status always wins (every board type)', () => {
    expect(
      deriveStatus({ id: 't', type: 'terminal', status: 'awaiting-review' }, () => 'running')
    ).toBe('awaiting-review')
    expect(deriveStatus({ id: 'b', type: 'browser', status: 'failed' }, noSessions)).toBe('failed')
    expect(deriveStatus({ id: 'p', type: 'planning', status: 'static' }, noSessions)).toBe('static')
  })

  it('a terminal with no mirror status is `running` ONLY when its PTY session is running', () => {
    expect(
      deriveStatus({ id: 't1', type: 'terminal' }, (id) => (id === 't1' ? 'running' : undefined))
    ).toBe('running')
    // a live-but-not-running session reads idle (the bucket is coarse: running iff live PTY)
    expect(deriveStatus({ id: 't1', type: 'terminal' }, () => 'exited')).toBe('idle')
    // no live PTY at all → idle
    expect(deriveStatus({ id: 't1', type: 'terminal' }, noSessions)).toBe('idle')
  })

  it('a browser with no mirror status is idle (presence, not liveness)', () => {
    expect(deriveStatus({ id: 'b1', type: 'browser' }, noSessions)).toBe('idle')
  })

  it('planning + any forward/unknown type with no mirror status is static', () => {
    expect(deriveStatus({ id: 'p1', type: 'planning' }, noSessions)).toBe('static')
    expect(deriveStatus({ id: 'x1', type: 'whatever' }, noSessions)).toBe('static')
  })

  it('consults sessionStatusFor with the board id on the terminal-fallback branch', () => {
    const lookup = vi.fn(() => 'running')
    deriveStatus({ id: 't9', type: 'terminal' }, lookup)
    expect(lookup).toHaveBeenCalledWith('t9')
  })

  it('does NOT consult sessionStatusFor when the mirror status is present', () => {
    const lookup = vi.fn(() => 'running')
    deriveStatus({ id: 't9', type: 'terminal', status: 'idle' }, lookup)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('does NOT consult sessionStatusFor for a non-terminal board', () => {
    const lookup = vi.fn(() => 'running')
    deriveStatus({ id: 'b1', type: 'browser' }, lookup)
    deriveStatus({ id: 'p1', type: 'planning' }, lookup)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('makeSessionLookup (lazy session-status resolver)', () => {
  it('does NOT read listSessions until a status is actually looked up', () => {
    const listSessions = vi.fn(() => [{ id: 't1', status: 'running' }])
    makeSessionLookup(listSessions) // building the resolver must not touch the session list
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('materialises the session map at most ONCE across many lookups', () => {
    const listSessions = vi.fn(() => [
      { id: 't1', status: 'running' },
      { id: 't2', status: 'exited' }
    ])
    const lookup = makeSessionLookup(listSessions)
    expect(lookup('t1')).toBe('running')
    expect(lookup('t2')).toBe('exited')
    expect(lookup('ghost')).toBeUndefined()
    expect(listSessions).toHaveBeenCalledTimes(1) // built once on the first lookup, then reused
  })

  it('a fresh resolver re-reads listSessions (live status, never a stale snapshot — BUG-008)', () => {
    let live = [{ id: 't1', status: 'running' }]
    const listSessions = vi.fn(() => live)
    // first logical read sees running
    expect(makeSessionLookup(listSessions)('t1')).toBe('running')
    // the session exits; a NEW resolver (one per logical status read) reflects the LIVE value,
    // proving the orchestrator never reuses a captured snapshot across reads.
    live = [{ id: 't1', status: 'exited' }]
    expect(makeSessionLookup(listSessions)('t1')).toBe('exited')
    expect(listSessions).toHaveBeenCalledTimes(2)
  })
})
