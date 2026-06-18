import { describe, it, expect, afterEach } from 'vitest'
import type { ConnectorMirror } from '../boardRegistry'
import {
  canRelay,
  mintTerminalToken,
  __setTerminalTokenMinter,
  setOrchestrationEnabled,
  isOrchestrationEnabled,
  type TerminalToken
} from './seam'

const cable = (
  sourceId: string,
  targetId: string,
  kind: ConnectorMirror['kind']
): ConnectorMirror => ({
  id: `${sourceId}-${targetId}-${kind}`,
  sourceId,
  targetId,
  kind
})

describe('canRelay (P0 seam — real pure body)', () => {
  it('authorizes a directed orchestration cable src→dst', () => {
    expect(canRelay('A', 'B', [cable('A', 'B', 'orchestration')])).toBe(true)
  })

  it('is directional — the reverse cable does NOT authorize', () => {
    expect(canRelay('A', 'B', [cable('B', 'A', 'orchestration')])).toBe(false)
  })

  it('ignores preview cables (only orchestration edges authorize relay)', () => {
    expect(canRelay('A', 'B', [cable('A', 'B', 'preview')])).toBe(false)
  })

  it('rejects when no matching cable exists', () => {
    expect(canRelay('A', 'B', [])).toBe(false)
    expect(canRelay('A', 'B', [cable('A', 'C', 'orchestration')])).toBe(false)
  })

  it('matches the exact directed edge among many', () => {
    const connectors = [
      cable('X', 'Y', 'orchestration'),
      cable('A', 'B', 'preview'),
      cable('A', 'B', 'orchestration')
    ]
    expect(canRelay('A', 'B', connectors)).toBe(true)
    expect(canRelay('X', 'Y', connectors)).toBe(true)
    expect(canRelay('Y', 'X', connectors)).toBe(false)
  })
})

describe('mintTerminalToken (P0 seam — delegates to the registered server minter)', () => {
  afterEach(() => __setTerminalTokenMinter(null))

  it('throws when no MCP server is mounted (no minter registered) — fails loud, never bogus', () => {
    __setTerminalTokenMinter(null)
    expect(() => mintTerminalToken('board-1')).toThrow(/MCP server not mounted/)
  })

  it('delegates to the registered minter, returning its connected-tier token', () => {
    const minted: TerminalToken = { token: 'tok-abc', tier: 'connected', port: 4321 }
    __setTerminalTokenMinter((boardId) => ({ ...minted, token: `${minted.token}:${boardId}` }))
    const out = mintTerminalToken('board-7')
    expect(out).toEqual({ token: 'tok-abc:board-7', tier: 'connected', port: 4321 })
  })

  it('throws again once the minter is cleared (server closed)', () => {
    __setTerminalTokenMinter(() => ({ token: 't', tier: 'connected', port: 1 }))
    expect(mintTerminalToken('b').token).toBe('t')
    __setTerminalTokenMinter(null)
    expect(() => mintTerminalToken('b')).toThrow(/MCP server not mounted/)
  })
})

describe('seam stubs (owned by later phases — must not silently succeed)', () => {
  it('setOrchestrationEnabled throws until P1 implements it', () => {
    expect(() => setOrchestrationEnabled('/proj', true)).toThrow(/not implemented until P1/)
  })

  it('isOrchestrationEnabled defaults closed (false) until P1 implements it', () => {
    expect(isOrchestrationEnabled('/proj')).toBe(false)
  })
})
