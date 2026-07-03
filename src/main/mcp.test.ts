import { describe, it, expect } from 'vitest'
import { makeConnectedTokenTracker } from './mcp'

describe('makeConnectedTokenTracker (FIND-015 connected-token lifecycle)', () => {
  it('rotates a board token on re-spawn (revokes the prior) so the store does not accrete', () => {
    const revoked: string[] = []
    const t = makeConnectedTokenTracker((tok) => revoked.push(tok))
    t.track('b1', 'tok-A')
    t.track('b1', 'tok-B') // re-spawn of the same board rotates → the prior token is revoked
    expect(revoked).toEqual(['tok-A'])
  })

  it('revokeAll invalidates every live connected token at once (consent revoke)', () => {
    const revoked: string[] = []
    const t = makeConnectedTokenTracker((tok) => revoked.push(tok))
    t.track('b1', 'tok-A')
    t.track('b2', 'tok-B')
    t.revokeAll()
    expect(revoked.sort()).toEqual(['tok-A', 'tok-B'])
    // A second revokeAll is a no-op — the live set was cleared (no double-revoke).
    t.revokeAll()
    expect(revoked.sort()).toEqual(['tok-A', 'tok-B'])
  })

  it('clear() drops live tokens WITHOUT revoking (server shutdown discards the store)', () => {
    const revoked: string[] = []
    const t = makeConnectedTokenTracker((tok) => revoked.push(tok))
    t.track('b1', 'tok-A')
    t.clear()
    t.revokeAll()
    expect(revoked).toEqual([]) // nothing left to revoke after clear
  })

  it("🔒 BUG-019: revoke(boardId) kills just that board's live token (board-close wiring)", () => {
    const revoked: string[] = []
    const t = makeConnectedTokenTracker((tok) => revoked.push(tok))
    t.track('b1', 'tok-A')
    t.track('b2', 'tok-B')
    t.revoke('b1')
    expect(revoked).toEqual(['tok-A']) // only b1's token dies; b2 is untouched
    // b2's token is still live and revocable.
    t.revokeAll()
    expect(revoked.sort()).toEqual(['tok-A', 'tok-B'])
  })

  it('🔒 BUG-019: revoke() on a board with no tracked token is a harmless no-op', () => {
    const revoked: string[] = []
    const t = makeConnectedTokenTracker((tok) => revoked.push(tok))
    t.revoke('never-tracked')
    expect(revoked).toEqual([])
  })

  it('🔒 BUG-019: revoke() is idempotent — a second call for the same board no-ops', () => {
    const revoked: string[] = []
    const t = makeConnectedTokenTracker((tok) => revoked.push(tok))
    t.track('b1', 'tok-A')
    t.revoke('b1')
    t.revoke('b1')
    expect(revoked).toEqual(['tok-A'])
  })
})
