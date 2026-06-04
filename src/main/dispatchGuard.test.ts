import { describe, expect, it } from 'vitest'
import { createDispatchGuard } from './dispatchGuard'

describe('createDispatchGuard (🔒 single-use nonce + monotonic sequence, T4.3)', () => {
  it('issue() returns a unique nonce and a monotonic, gap-free sequence', () => {
    const guard = createDispatchGuard()
    const a = guard.issue()
    const b = guard.issue()
    const c = guard.issue()
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(c.seq).toBe(3)
    // Nonces are distinct, non-empty strings.
    expect(new Set([a.nonce, b.nonce, c.nonce]).size).toBe(3)
    expect(a.nonce.length).toBeGreaterThan(0)
  })

  it('consume(nonce) returns true exactly once for an issued nonce, then false (replay rejected)', () => {
    const guard = createDispatchGuard()
    const { nonce } = guard.issue()
    expect(guard.consume(nonce)).toBe(true)
    expect(guard.consume(nonce)).toBe(false) // replay
    expect(guard.consume(nonce)).toBe(false) // still rejected
  })

  it('consume() of an unknown / forged nonce is rejected', () => {
    const guard = createDispatchGuard()
    guard.issue()
    expect(guard.consume('never-issued')).toBe(false)
    expect(guard.consume('')).toBe(false)
  })

  it('consuming one nonce does not invalidate another outstanding nonce', () => {
    const guard = createDispatchGuard()
    const a = guard.issue()
    const b = guard.issue()
    expect(guard.consume(a.nonce)).toBe(true)
    // b is still valid for its single use.
    expect(guard.consume(b.nonce)).toBe(true)
    expect(guard.consume(b.nonce)).toBe(false)
  })
})
