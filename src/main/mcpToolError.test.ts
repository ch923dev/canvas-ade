import { describe, expect, it } from 'vitest'
import { TOOL_ERROR_CODES, toolErrorCodeOf } from '@expanse-ade/mcp'
import { McpToolError } from './mcpToolError'

/**
 * The host twin is only useful if the package's tool boundary classifies it. `toolErrorCodeOf` is
 * the exact function `guardHandler` runs on a thrown host error, so a package bump that tightens its
 * duck-typing (e.g. to `instanceof CanvasToolError`) fails here instead of silently turning every
 * host `declined` / `invalid_input` into `internal`.
 */
describe('McpToolError ↔ @expanse-ade/mcp toolErrorCodeOf', () => {
  it('every package error code round-trips through the host twin', () => {
    for (const code of TOOL_ERROR_CODES) {
      expect(toolErrorCodeOf(new McpToolError(code, `x: ${code}`))).toBe(code)
    }
  })

  it('a plain Error stays unclassified (internal)', () => {
    expect(toolErrorCodeOf(new Error('boom'))).toBe('internal')
  })
})
