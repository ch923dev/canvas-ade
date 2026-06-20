import { describe, it, expect } from 'vitest'
import { classifyConnectorReject, CONNECTOR_REJECT_MESSAGE } from './connectorReject'
import type { Connector } from './boardSchema'

const ids = (...xs: string[]): Set<string> => new Set(xs)

describe('classifyConnectorReject', () => {
  it('returns null for a valid new connector', () => {
    expect(classifyConnectorReject([], ids('a', 'b'), 'a', 'b', 'orchestration')).toBeNull()
  })

  it("flags a self-link as 'self'", () => {
    expect(classifyConnectorReject([], ids('a'), 'a', 'a', 'orchestration')).toBe('self')
  })

  it("flags a missing endpoint as 'missing'", () => {
    expect(classifyConnectorReject([], ids('a'), 'a', 'gone', 'orchestration')).toBe('missing')
    expect(classifyConnectorReject([], ids('b'), 'gone', 'b', 'orchestration')).toBe('missing')
  })

  it("flags an exact duplicate (same source+target+kind) as 'duplicate'", () => {
    const existing: Connector[] = [
      { id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }
    ]
    expect(classifyConnectorReject(existing, ids('a', 'b'), 'a', 'b', 'orchestration')).toBe(
      'duplicate'
    )
  })

  it('treats the reverse direction as a NEW connector (not a duplicate)', () => {
    const existing: Connector[] = [
      { id: 'c1', sourceId: 'a', targetId: 'b', kind: 'orchestration' }
    ]
    expect(classifyConnectorReject(existing, ids('a', 'b'), 'b', 'a', 'orchestration')).toBeNull()
  })

  it('checks self BEFORE duplicate/missing (precedence)', () => {
    // A self id that is also absent from the board set still reports 'self' first.
    expect(classifyConnectorReject([], ids(), 'x', 'x', 'orchestration')).toBe('self')
  })

  it('exposes speakable copy for self + duplicate', () => {
    expect(CONNECTOR_REJECT_MESSAGE.self).toMatch(/itself/i)
    expect(CONNECTOR_REJECT_MESSAGE.duplicate).toMatch(/already/i)
  })
})
