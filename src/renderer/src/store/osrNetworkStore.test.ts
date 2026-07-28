import { describe, it, expect } from 'vitest'
import { capTail } from './osrNetworkStore'

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
