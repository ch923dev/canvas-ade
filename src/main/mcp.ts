import { buildOrchestrator, MCP_IDLE_TTL_MS, type BoardRegistry } from './mcpOrchestrator'
import type { TokenStore } from '@ch923dev/canvas-ade-mcp'

/** Idle-reap TTL + sweep interval (T3.4). Env-overridable so the live smoke can drive a fast reap. */
const IDLE_TTL_MS = Number(process.env.CANVAS_MCP_IDLE_TTL_MS) || MCP_IDLE_TTL_MS
const REAP_INTERVAL_MS = Number(process.env.CANVAS_MCP_REAP_INTERVAL_MS) || 60_000

export interface RunningMcp {
  port: number
  tokens: TokenStore
  orchestratorToken: string
  /** Mint a worker-tier token bound to a board id (consumer: a later .mcp.json slice / the smoke). */
  mintWorkerToken(boardId: string): string
  /** Run an idle-reap sweep now; returns the reaped board ids (T3.4 — drives the live smoke). */
  reapIdle(): Promise<string[]>
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
    const orchestrator = buildOrchestrator(registry, { idleTtlMs: IDLE_TTL_MS })
    const server = await createMcpHttpServer({ orchestrator, tokens })
    // 🔒 Idle-reap sweep (T3.4): periodically close MCP-spawned boards that have gone
    // idle past the TTL, so the swarm can't accrete dormant boards. unref() so the
    // timer never keeps the process alive at shutdown.
    const reapTimer = setInterval(() => {
      void orchestrator.reapIdle().catch(() => {})
    }, REAP_INTERVAL_MS)
    reapTimer.unref?.()
    return {
      port: server.port,
      tokens,
      orchestratorToken,
      mintWorkerToken: (boardId) => mintBoardToken(tokens, { boardId, tier: 'worker' }).token,
      reapIdle: () => orchestrator.reapIdle(),
      close: () => {
        clearInterval(reapTimer)
        return server.close()
      }
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
