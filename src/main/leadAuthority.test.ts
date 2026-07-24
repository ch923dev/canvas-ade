import { describe, expect, it, vi } from 'vitest'
import { makeLeadAuthority } from './leadAuthority'

describe('leadAuthority — single-active-lead designation + token lifecycle', () => {
  it('starts undesignated; grant designates; re-grant of the same board is idempotent ok', () => {
    const lead = makeLeadAuthority(vi.fn())
    expect(lead.designated()).toBeNull()
    expect(lead.grant('t1')).toEqual({ ok: true })
    expect(lead.designated()).toBe('t1')
    expect(lead.grant('t1')).toEqual({ ok: true })
    expect(lead.designated()).toBe('t1')
  })

  it('🔒 Q2 invariant: granting a SECOND board while one is active is refused with the holder', () => {
    const lead = makeLeadAuthority(vi.fn())
    lead.grant('t1')
    expect(lead.grant('t2')).toEqual({ ok: false, reason: 'already-active', holder: 't1' })
    expect(lead.designated()).toBe('t1')
  })

  it('revoke drops the designation AND revokes the live token; then a new grant succeeds', () => {
    const revoke = vi.fn()
    const lead = makeLeadAuthority(revoke)
    lead.grant('t1')
    lead.track('t1', 'tok-1')
    lead.revoke()
    expect(revoke).toHaveBeenCalledWith('tok-1')
    expect(lead.designated()).toBeNull()
    expect(lead.grant('t2')).toEqual({ ok: true })
  })

  it('revoke with no live token is a safe no-op on the token thunk', () => {
    const revoke = vi.fn()
    const lead = makeLeadAuthority(revoke)
    lead.grant('t1')
    lead.revoke()
    expect(revoke).not.toHaveBeenCalled()
  })

  it('track rotates: a re-mint revokes the prior token before recording the new one', () => {
    const revoke = vi.fn()
    const lead = makeLeadAuthority(revoke)
    lead.grant('t1')
    lead.track('t1', 'tok-1')
    lead.track('t1', 'tok-2')
    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('tok-1')
    lead.revoke()
    expect(revoke).toHaveBeenCalledWith('tok-2')
  })

  it('🔒 track for a NON-designated board revokes that token immediately (raced revoke)', () => {
    const revoke = vi.fn()
    const lead = makeLeadAuthority(revoke)
    lead.grant('t1')
    lead.track('t2', 'stray-tok')
    expect(revoke).toHaveBeenCalledWith('stray-tok')
    // The designation and its (absent) token are untouched.
    expect(lead.designated()).toBe('t1')
  })

  it('onBoardClosed for the lead board revokes designation + token; other boards are ignored', () => {
    const revoke = vi.fn()
    const lead = makeLeadAuthority(revoke)
    lead.grant('t1')
    lead.track('t1', 'tok-1')
    lead.onBoardClosed('other')
    expect(lead.designated()).toBe('t1')
    lead.onBoardClosed('t1')
    expect(revoke).toHaveBeenCalledWith('tok-1')
    expect(lead.designated()).toBeNull()
  })

  it('clear forgets designation + token WITHOUT revoking (server teardown path)', () => {
    const revoke = vi.fn()
    const lead = makeLeadAuthority(revoke)
    lead.grant('t1')
    lead.track('t1', 'tok-1')
    lead.clear()
    expect(revoke).not.toHaveBeenCalled()
    expect(lead.designated()).toBeNull()
  })
})
