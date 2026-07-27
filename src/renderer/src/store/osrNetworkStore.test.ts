import { describe, it, expect } from 'vitest'
import { capTail, useOsrNetworkStore } from './osrNetworkStore'
import type { NetRecord } from '../../../preload'

// Guards the renderer net-mirror bound (reviewer [warning], osrNetworkStore.ts): deltas only carry
// NEW/updated rows, never evictions, so the mirror must tail-cap to match MAIN's ring (MAX_RECORDS /
// MAX_SOCKETS) or it grows unbounded on a chatty page while the inspector is open.
describe('capTail — renderer net-mirror bound (drop-oldest, mirrors MAIN ring)', () => {
  it('keeps only the last `max`, dropping the oldest', () => {
    const arr = Array.from({ length: 1003 }, (_, i) => i)
    const out = capTail(arr, 1000)
    expect(out.length).toBe(1000)
    expect(out[0]).toBe(3) // 0,1,2 evicted (oldest)
    expect(out[out.length - 1]).toBe(1002) // newest retained
  })

  it('returns the same array reference when at or under the cap (no churn)', () => {
    const arr = [1, 2, 3]
    expect(capTail(arr, 1000)).toBe(arr)
    expect(capTail(arr, 3)).toBe(arr)
  })
})

// Guards the E2E seed-freeze (BoardNet.frozen). A replay REPLACES a board's records
// wholesale, so a harness-seeded board with a LIVE MAIN subscription used to have its
// seed wiped by the real replay landing late — the ambient dataFlow flake. `frozen`
// makes the seed authoritative. It must drop REPLAYS ONLY: dropping deltas/'cleared'
// too would quietly disable the whole channel rather than just pinning the seed.
describe('BoardNet.frozen — E2E seed guard (replays ignored, deltas still applied)', () => {
  const seedFrozen = (): void => {
    useOsrNetworkStore.setState({
      byBoard: {
        b: {
          records: [{ requestId: 'seed', url: 'https://x/seed', method: 'GET' } as NetRecord],
          ws: [],
          dropped: 0,
          open: false,
          dock: 'bottom',
          tab: 'network',
          preserve: false,
          inferShapes: false,
          frozen: true,
          expanded: [],
          schemas: {}
        }
      }
    })
  }

  it('ignores a replay on a frozen board (the seed survives)', () => {
    seedFrozen()
    useOsrNetworkStore.getState().apply('b', {
      id: 'b',
      kind: 'replay',
      records: [{ requestId: 'real', url: 'https://x/real', method: 'GET' } as NetRecord]
    })
    const recs = useOsrNetworkStore.getState().byBoard.b.records
    expect(recs).toHaveLength(1)
    expect(recs[0].requestId).toBe('seed')
  })

  it('STILL applies a delta on a frozen board (freeze is not a channel kill-switch)', () => {
    seedFrozen()
    useOsrNetworkStore.getState().apply('b', {
      id: 'b',
      kind: 'delta',
      records: [{ requestId: 'later', url: 'https://x/later', method: 'GET' } as NetRecord]
    })
    const ids = useOsrNetworkStore.getState().byBoard.b.records.map((r) => r.requestId)
    expect(ids).toContain('seed')
    expect(ids).toContain('later')
  })

  it('applies a replay normally when NOT frozen (default production path)', () => {
    seedFrozen()
    useOsrNetworkStore.setState((s) => ({
      byBoard: { ...s.byBoard, b: { ...s.byBoard.b, frozen: false } }
    }))
    useOsrNetworkStore.getState().apply('b', {
      id: 'b',
      kind: 'replay',
      records: [{ requestId: 'real', url: 'https://x/real', method: 'GET' } as NetRecord]
    })
    const recs = useOsrNetworkStore.getState().byBoard.b.records
    expect(recs).toHaveLength(1)
    expect(recs[0].requestId).toBe('real')
  })
})
