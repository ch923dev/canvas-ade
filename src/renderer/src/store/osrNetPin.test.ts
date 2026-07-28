import { describe, it, expect, beforeEach } from 'vitest'
import {
  pinOsrNet,
  dropOsrNetMessage,
  osrNetPinStats,
  clearOsrNetPins,
  type OsrNetDropKind
} from './osrNetPin'
import { useOsrNetworkStore } from './osrNetworkStore'

// The pin is the replacement for PR #396's `BoardNet.frozen`, which shipped green on Windows and
// failed the Linux leg 3/3. These tests pin the two properties that fix could not have: the guard
// state lives OUTSIDE the object `clearBoard` deletes, and it covers `cleared`/`delta` — not just
// `replay`. A green unit run is NOT evidence the flake is fixed (only the Linux leg is); what these
// guard is that the mechanism does not silently regress later.
describe('osrNetPin — harness-owned capture (E2E-only)', () => {
  beforeEach(() => {
    clearOsrNetPins()
    useOsrNetworkStore.setState({ byBoard: {} })
  })

  it('drops nothing while no board is pinned (the production path)', () => {
    const kinds: OsrNetDropKind[] = ['replay', 'delta', 'cleared', 'clearBoard']
    for (const kind of kinds) expect(dropOsrNetMessage('b1', kind)).toBe(false)
    expect(osrNetPinStats('b1')).toBeNull()
  })

  it('drops ALL FOUR writers for a pinned board and tallies them per kind', () => {
    pinOsrNet('b1')
    // `frozen` blocked only `replay`; `cleared` (the OSR nav boundary) and `delta` (real rows) were
    // let through by design, and `clearBoard` deleted the flag itself.
    expect(dropOsrNetMessage('b1', 'replay')).toBe(true)
    expect(dropOsrNetMessage('b1', 'cleared')).toBe(true)
    expect(dropOsrNetMessage('b1', 'delta')).toBe(true)
    expect(dropOsrNetMessage('b1', 'delta')).toBe(true)
    expect(dropOsrNetMessage('b1', 'clearBoard')).toBe(true)
    expect(osrNetPinStats('b1')).toEqual({ replay: 1, cleared: 1, delta: 2, clearBoard: 1 })
  })

  it('leaves an unpinned board alone while another board is pinned', () => {
    pinOsrNet('b1')
    expect(dropOsrNetMessage('b2', 'replay')).toBe(false)
    expect(osrNetPinStats('b2')).toBeNull()
  })

  it('survives clearBoard — the exact failure that killed the BoardNet.frozen fix', () => {
    const store = useOsrNetworkStore.getState()
    store.apply('b1', { id: 'b1', kind: 'replay', records: [{ requestId: 'r1' }] as never })
    pinOsrNet('b1')
    // The LOD swap is a hard mount/unmount for non-terminal boards, so this fires mid-spec.
    store.clearBoard('b1')
    expect(useOsrNetworkStore.getState().byBoard.b1?.records).toHaveLength(1)
    // …and the pin is still armed afterwards, because it never lived in the deleted entry.
    expect(dropOsrNetMessage('b1', 'replay')).toBe(true)
  })

  it('clearBoard still deletes an UNPINNED board (FIND-011 unmount cleanup intact)', () => {
    const store = useOsrNetworkStore.getState()
    store.apply('b1', { id: 'b1', kind: 'replay', records: [{ requestId: 'r1' }] as never })
    store.clearBoard('b1')
    expect(useOsrNetworkStore.getState().byBoard.b1).toBeUndefined()
  })

  it('clearOsrNetPins returns the released ids (reset() deletes exactly those entries)', () => {
    pinOsrNet('b1')
    pinOsrNet('b2')
    expect(clearOsrNetPins().sort()).toEqual(['b1', 'b2'])
    expect(dropOsrNetMessage('b1', 'replay')).toBe(false)
    expect(osrNetPinStats('b1')).toBeNull()
    expect(clearOsrNetPins()).toEqual([]) // idempotent
  })
})
