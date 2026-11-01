import type { ToolErrorCode } from '@expanse-ade/mcp'

/**
 * The host's structured MCP tool error (`@expanse-ade/mcp` ≥ 0.26.0 error codes). Throw it from an
 * orchestrator method to classify a failure: the package's tool boundary (`guardHandler` →
 * `toolErrorCodeOf`) maps ANY `Error` whose `code` is a valid `ToolErrorCode` into
 * `structuredContent.error.code`, with `message` as the result text. An unclassified throw maps to
 * `internal`.
 *
 * Why a host twin and not the package's own `CanvasToolError`: the package is ESM-only and MAIN
 * loads it LAZILY (`await import('@expanse-ade/mcp')` in `mcp.ts`, M11 — its Express/SDK heap is
 * paid only on first orchestration use). A VALUE import here would pull it into the eager graph of
 * every module that imports an orchestrator method. The package recognises the code by duck type,
 * so the twin needs only the type import; `mcpToolError.test.ts` pins the round-trip against the
 * package's real `toolErrorCodeOf`.
 */
export class McpToolError extends Error {
  readonly code: ToolErrorCode
  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'McpToolError'
    this.code = code
  }
}
