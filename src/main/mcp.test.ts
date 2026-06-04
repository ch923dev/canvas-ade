import { describe, it, expect } from 'vitest'
import { positiveMsEnv } from './mcp'
import { MCP_IDLE_TTL_MS } from './mcpOrchestrator'

describe('positiveMsEnv (idle-reap TTL / interval env parsing — BUG-023)', () => {
  it('passes a finite positive override through unchanged (smoke fast-reap still works)', () => {
    expect(positiveMsEnv('1000', MCP_IDLE_TTL_MS)).toBe(1000)
    expect(positiveMsEnv('1', MCP_IDLE_TTL_MS)).toBe(1) // a small positive value is allowed
  })

  it('🔒 BUG-023: rejects a NEGATIVE override (the always-reap inversion) and falls back', () => {
    // OLD `Number('-1') || default` returned -1 (truthy) → `t - idleSince >= -1` is always
    // true → every spawned board reaped on its first idle sweep. The fix falls back.
    expect(positiveMsEnv('-1', MCP_IDLE_TTL_MS)).toBe(MCP_IDLE_TTL_MS)
    expect(positiveMsEnv('-99999', 60_000)).toBe(60_000)
  })

  it('falls back for zero, NaN, empty, and absent values', () => {
    expect(positiveMsEnv('0', MCP_IDLE_TTL_MS)).toBe(MCP_IDLE_TTL_MS) // 0 disables the reap
    expect(positiveMsEnv('not-a-number', MCP_IDLE_TTL_MS)).toBe(MCP_IDLE_TTL_MS)
    expect(positiveMsEnv('', MCP_IDLE_TTL_MS)).toBe(MCP_IDLE_TTL_MS)
    expect(positiveMsEnv(undefined, MCP_IDLE_TTL_MS)).toBe(MCP_IDLE_TTL_MS)
  })
})
