import type { BoardRegistry } from './mcpOrchestrator'
import { buildPtyOrchestrator } from './mcpOrchestrator'
import type { TokenStore } from '@ch923dev/canvas-ade-mcp'

export interface RunningMcp {
  port: number
  tokens: TokenStore
  orchestratorToken: string
  /** Mint a worker-tier token bound to a board id (consumer: a later .mcp.json slice / the smoke). */
  mintWorkerToken(boardId: string): string
  close(): Promise<void>
}

/**
 * Mount the canvas-ade-mcp loopback HTTP server inside MAIN. The package is
 * ESM-only and MAIN is CJS, so it is loaded via dynamic import() inside this async
 * fn. A bind/load failure is non-fatal (the server is a convenience layer, not a
 * boot dependency) — log and return null, mirroring startLocalServer.
 */
export async function startMcpServer(registry: BoardRegistry): Promise<RunningMcp | null> {
  try {
    const { createMcpHttpServer, TokenStore, mintBoardToken } =
      await import('@ch923dev/canvas-ade-mcp')
    const tokens = new TokenStore()
    const { token: orchestratorToken } = mintBoardToken(tokens, {
      boardId: 'app',
      tier: 'orchestrator'
    })
    const server = await createMcpHttpServer({
      orchestrator: buildPtyOrchestrator(registry),
      tokens
    })
    return {
      port: server.port,
      tokens,
      orchestratorToken,
      mintWorkerToken: (boardId) => mintBoardToken(tokens, { boardId, tier: 'worker' }).token,
      close: () => server.close()
    }
  } catch (err) {
    // Graceful-degrade either way (the server is a convenience layer), but make a
    // real wiring bug LOUD: an expected port/bind failure (EADDRINUSE/EACCES) is
    // info-level "continuing without it"; anything else is a defect in this change.
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'EADDRINUSE' || code === 'EACCES') {
      console.error(`MCP server could not bind (${code}) — continuing without it.`)
    } else {
      console.error('MCP wiring bug — server failed to start, continuing without it.', err)
    }
    return null
  }
}
