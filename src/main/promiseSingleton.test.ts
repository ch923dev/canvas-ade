/**
 * Unit tier: the M11 single-flight memoizer. Pins the lazy-start contract createMcpBoot relies on —
 * one shared boot across concurrent triggers, publish-once (incl. resolved-null), and catch-evict so
 * a failed start is retryable.
 */
import { describe, it, expect, vi } from 'vitest'
import { singleFlight } from './promiseSingleton'

describe('singleFlight', () => {
  it('runs start() exactly once across concurrent + subsequent calls', async () => {
    const start = vi.fn().mockResolvedValue('server')
    const onResolve = vi.fn()
    const ensure = singleFlight(start, onResolve)

    // Two calls in the same tick must share ONE in-flight run (promise assigned synchronously).
    const [a, b] = await Promise.all([ensure(), ensure()])
    const c = await ensure() // a later call reuses the settled promise

    expect(a).toBe('server')
    expect(b).toBe('server')
    expect(c).toBe('server')
    expect(start).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith('server')
  })

  it('publishes a resolved null and caches it (bind-failure parity, not retried)', async () => {
    const start = vi.fn().mockResolvedValue(null) // startMcpServer returns null on a non-fatal bind fail
    const onResolve = vi.fn()
    const ensure = singleFlight(start, onResolve)

    expect(await ensure()).toBeNull()
    expect(await ensure()).toBeNull()
    expect(start).toHaveBeenCalledTimes(1) // resolved-null is a valid cached state
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith(null)
  })

  it('catch-evicts on a thrown start so a later call retries a fresh start()', async () => {
    const start = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered')
    const onResolve = vi.fn()
    const ensure = singleFlight(start, onResolve)

    await expect(ensure()).rejects.toThrow('boom')
    expect(onResolve).not.toHaveBeenCalled() // never published a failed start

    // The latch was evicted → the next call retries rather than replaying the rejection.
    expect(await ensure()).toBe('recovered')
    expect(start).toHaveBeenCalledTimes(2)
    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(onResolve).toHaveBeenCalledWith('recovered')
  })
})
