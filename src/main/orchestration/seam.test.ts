import { describe, it, expect } from 'vitest'
import type { ConnectorMirror } from '../boardRegistry'
import {
  canRelay,
  mintTerminalToken,
  setOrchestrationEnabled,
  isOrchestrationEnabled
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

describe('seam stubs (owned by later phases — must not silently succeed)', () => {
  it('mintTerminalToken throws until P0 implements it', () => {
    expect(() => mintTerminalToken('board-1')).toThrow(/not implemented until P0/)
  })

  it('setOrchestrationEnabled throws until P1 implements it', () => {
    expect(() => setOrchestrationEnabled('/proj', true)).toThrow(/not implemented until P1/)
  })

  it('isOrchestrationEnabled defaults closed (false) until P1 implements it', () => {
    expect(isOrchestrationEnabled('/proj')).toBe(false)
  })
})
