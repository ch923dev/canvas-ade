import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchUpdateMeta } from './autoUpdateWiring'

// fetchUpdateMeta is the ONE real-network seam initAutoUpdate injects as `getMeta` (autoUpdate.ts
// unit-tests the classifier with a mock getMeta and never touches the real fetch). These tests mock
// global `fetch` to cover the seam itself: the bounded/fail-open contract the feed relies on.

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A minimal Response-like for the fetch mock (only .ok + .json are read). */
const okJson = (body: unknown): Response =>
  ({ ok: true, json: () => Promise.resolve(body) }) as unknown as Response

describe('fetchUpdateMeta — bounded, fail-open feed fetch', () => {
  it('bounds the fetch with an AbortSignal (timeout) and coerces an OK payload', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(okJson({ minSupported: '0.10.0', tiers: { '0.11.0': 'recommended' } }))
    )
    vi.stubGlobal('fetch', fetchMock)

    const meta = await fetchUpdateMeta()
    expect(meta).toEqual({ minSupported: '0.10.0', tiers: { '0.11.0': 'recommended' } })
    // The bound is what keeps a hung feed from stalling the "Checking…" spinner: the request
    // MUST carry an AbortSignal (from AbortSignal.timeout) so it can't wait indefinitely.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/updates\.json$/),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('runs the payload through coerceUpdateMeta — a non-string floor is dropped, not trusted', async () => {
    // The crash vector: a hand-edited `"minSupported": 0.9`. It must not survive to cmpVersion.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(okJson({ minSupported: 0.9 })))
    )
    const meta = await fetchUpdateMeta()
    expect(meta?.minSupported).toBeUndefined()
  })

  it('returns null on a non-OK response (404 = no manifest published yet → fail open)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: false } as Response))
    )
    expect(await fetchUpdateMeta()).toBeNull()
  })

  it('lets an abort (hung/slow feed) REJECT so runCheck fails open instead of hanging', async () => {
    // AbortSignal.timeout firing rejects the fetch with an AbortError. fetchUpdateMeta does NOT
    // swallow it — it propagates to runCheck's `getMeta().catch(() => null)` (autoUpdate.ts), the
    // same fail-open path as an unreachable feed. The regression this guards: a fetch that never
    // settles would otherwise leave the check (and the spinner) hanging.
    const abortErr = new DOMException('The operation was aborted', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(abortErr))
    )
    await expect(fetchUpdateMeta()).rejects.toBe(abortErr)
  })
})
