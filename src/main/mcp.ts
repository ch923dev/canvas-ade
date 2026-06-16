import { buildOrchestrator, MCP_IDLE_TTL_MS, type BoardRegistry } from './mcpOrchestrator'
import type { BoardResult, TokenStore } from '@expanse-ade/mcp'
import type { AppModel } from './appModel'
import type { SpawnGroupInput, SpawnGroupResult } from './mcpLifecycle'

/**
 * Parse a positive-millisecond env override, falling back to `fallback` when the value
 * is absent or not a FINITE POSITIVE number (BUG-023). The old `Number(env) || fallback`
 * idiom only caught falsy values (0 / NaN / ''): a NEGATIVE override like `-1` is truthy
 * and passed straight through, which made the idle-reap predicate `t - idleSince >= -1`
 * always true → every MCP-spawned board got reaped on its first idle sweep. Reject any
 * value <= 0 (and NaN) so a misconfigured/negative env can never disable or invert the
 * TTL; a legitimate small POSITIVE value still drives the live smoke's fast reap.
 */
export function positiveMsEnv(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Idle-reap TTL + sweep interval (T3.4). Env-overridable so the live smoke can drive a fast reap. */
const IDLE_TTL_MS = positiveMsEnv(process.env.CANVAS_MCP_IDLE_TTL_MS, MCP_IDLE_TTL_MS)
const REAP_INTERVAL_MS = positiveMsEnv(process.env.CANVAS_MCP_REAP_INTERVAL_MS, 60_000)

/**
 * 🔒 S2 planning content-write path is FLAG-GATED for the first release (ADR 0003): the
 * `add_planning_elements` tool + the `spawn_board` planning `seed` are registered ONLY when
 * this returns true. Always on under the e2e harness (CANVAS_E2E) so the @planning MCP e2e
 * can exercise it; otherwise opt-in via `CANVAS_MCP_PLANNING_WRITE` (1/true). Off by default
 * in production until the write/confirm UX is proven (the P4 "Run"-wiring follow-up).
 */
export function planningWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CANVAS_E2E === '1') return true
  const v = env.CANVAS_MCP_PLANNING_WRITE
  return v === '1' || v === 'true'
}

export interface RunningMcp {
  port: number
  tokens: TokenStore
  orchestratorToken: string
  /** Mint a worker-tier token bound to a board id (consumer: a later .mcp.json slice / the smoke). */
  mintWorkerToken(boardId: string): string
  /** Run an idle-reap sweep now; returns the reaped board ids (T3.4 — drives the live smoke). */
  reapIdle(): Promise<string[]>
  /**
   * PR-2: the read-only working-tree diff for a board, through the SAME orchestrator path a
   * future `git_diff` MCP tool will use (terminal-type check + 100 KB clamp). Exposed here only
   * so the CANVAS_E2E `__canvasE2EMain.gitDiff` seam can invoke it live in-process — the
   * `@expanse-ade/mcp` package registers no `git_diff` tool yet, so it is not wire-reachable.
   */
  gitDiff(boardId: string): Promise<string>
  /**
   * PR-3: assemble the read-only app self-model (board types · tool catalog · live canvas · rules)
   * via the orchestrator. Exposed here for the CANVAS_E2E `__canvasE2EMain.describeApp` seam; the
   * agent-facing `canvas://app-model` MCP resource is a deferred follow-up (PR-3b).
   */
  describeApp(): Promise<AppModel>
  /**
   * PR-5b: spawn a feature-zone cluster (terminal + optional planning/browser + a Named Group +
   * preview wiring) via the orchestrator. Exposed here for the CANVAS_E2E
   * `__canvasE2EMain.spawnGroupNow` seam; the agent-facing `spawn_group` MCP tool is a deferred
   * follow-up (PR-5c), so it is not yet wire-reachable — same split as gitDiff/PR-2b.
   */
  spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>
  /**
   * Phase C / C1: dispatch a prompt into a board's PTY through the SAME gated path the
   * `assign_prompt` MCP tool uses (sanitize → single-use nonce → human confirm → audit). Exposed
   * here so the Command board's frame-guarded renderer → MAIN IPC (`mcpOrchestratorIpc.ts`) can
   * drive it without a token; every write still pays the gate.
   */
  dispatchPrompt(boardId: string, text: string): Promise<void>
  /**
   * Phase C / C2: dispatch a prompt AND await the worker's two-gate settle (PR-0), resolving with
   * its `BoardResult`. The Command board's authoritative done/failed signal — same gate as
   * `dispatchPrompt`, plus the await-idle. A long-pending call (resolves on settle).
   */
  handoffPrompt(boardId: string, text: string): Promise<BoardResult>
  /** Phase C / C1: gated Ctrl-C into a board's PTY (same gate, terminator `\x03`, no sanitize). */
  interrupt(boardId: string): Promise<void>
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
    const { createMcpHttpServer, TokenStore, mintBoardToken } = await import('@expanse-ade/mcp')
    const tokens = new TokenStore()
    const { token: orchestratorToken } = mintBoardToken(tokens, {
      boardId: 'app',
      tier: 'orchestrator'
    })
    const orchestrator = buildOrchestrator(registry, { idleTtlMs: IDLE_TTL_MS })
    // 🔒 BUG-021: bind relay_prompt to the single command-orchestrator board ('app', minted
    // just above). A second orchestrator-tier token (bound to a different board) then can't
    // drive orchestration cables it doesn't own. Matches the orchestratorToken's boardId.
    // 🔒 S2: `planningWrite` flag-gates the `add_planning_elements` content-write tool +
    // `spawn_board` seed (off by default for the first release, ADR 0003).
    const server = await createMcpHttpServer({
      orchestrator,
      tokens,
      commandBoardId: 'app',
      planningWrite: planningWriteEnabled()
    })
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
      gitDiff: (boardId) => orchestrator.gitDiff(boardId),
      describeApp: () => orchestrator.describeApp(),
      spawnGroup: (input) => orchestrator.spawnGroup(input),
      dispatchPrompt: (boardId, text) => orchestrator.dispatchPrompt(boardId, text),
      handoffPrompt: (boardId, text) => orchestrator.handoffPrompt(boardId, text),
      interrupt: (boardId) => orchestrator.interrupt(boardId),
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
