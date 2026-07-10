import { buildOrchestrator, type BoardRegistry } from './mcpOrchestrator'
import type { BoardResult, TokenStore } from '@expanse-ade/mcp'
import type { AppModel } from './appModel'
import type { SpawnGroupInput, SpawnGroupResult } from './mcpLifecycle'
import { getCurrentDir } from './projectStore'
import { recordBoardProject } from './mcpBoardProjects'
import {
  isOrchestrationEnabled,
  __setTerminalTokenMinter,
  type TerminalToken
} from './orchestration/seam'

/**
 * 🔒 S2 planning content-write path gate (ADR 0003): the `add_planning_elements` tool + the
 * `spawn_board` planning `seed` are registered ONLY when this returns true. True when:
 *   - the e2e harness is on (`CANVAS_E2E`) so the @planning MCP e2e can exercise it, OR
 *   - the dev opt-in flag is set (`CANVAS_MCP_PLANNING_WRITE` = 1/true), OR
 *   - **orchestration consent is granted for `projectDir`** (Agent Orchestration v1) — the
 *     per-project Enable replaces the dev-only flag in PROD. Still ConfirmModal-gated per write.
 *
 * `projectDir` defaults to the live current project (`getCurrentDir()`); the package re-evaluates
 * this PER SESSION (the MCP server is a process singleton but consent is per-project + runtime-
 * toggleable), so a terminal that connects after Enable sees the write tool. A null dir (no project
 * open) ⇒ no consent path, exactly as before.
 */
export function planningWriteEnabled(
  env: NodeJS.ProcessEnv = process.env,
  projectDir: string | null = getCurrentDir()
): boolean {
  if (env.CANVAS_E2E === '1') return true
  const v = env.CANVAS_MCP_PLANNING_WRITE
  if (v === '1' || v === 'true') return true
  return projectDir ? isOrchestrationEnabled(projectDir) : false
}

/**
 * FIND-015: per-board lifecycle for `connected`-tier MCP tokens. The package's TokenStore revokes
 * only by token STRING, so the host remembers which live token belongs to which board:
 *   - `track` keeps ONE entry per board — a re-spawn ROTATES it (revoking the board's prior token
 *     before recording the new one), so the store holds one live connected token per board instead
 *     of one per spawn (bounds accretion).
 *   - `revoke` (BUG-019) kills the ONE token bound to a single board — wired to the lifecycle's
 *     `closeBoard` (the human-gated close_board tool) so a board's token dies THE MOMENT the board does,
 *     instead of staying live in the TokenStore until a re-spawn rotates it or a full consent-revoke
 *     fires. A no-op for a board with no tracked token (never minted one, or already revoked).
 *   - `revokeAll` kills every live connected token at once (consent revoke), so a bearer still
 *     sitting in a CLI config on disk is dead immediately — not only after the next app restart.
 * Pure of the ESM-only package (takes a `revoke` thunk) so it stays unit-testable.
 */
export function makeConnectedTokenTracker(revoke: (token: string) => void): {
  track(boardId: string, token: string): void
  revoke(boardId: string): void
  revokeAll(): void
  clear(): void
} {
  const byBoard = new Map<string, string>()
  return {
    track(boardId, token) {
      const prior = byBoard.get(boardId)
      if (prior) revoke(prior)
      byBoard.set(boardId, token)
    },
    revoke(boardId) {
      const token = byBoard.get(boardId)
      if (!token) return
      byBoard.delete(boardId)
      revoke(token)
    },
    revokeAll() {
      for (const token of byBoard.values()) revoke(token)
      byBoard.clear()
    },
    clear() {
      byBoard.clear()
    }
  }
}

export interface RunningMcp {
  port: number
  tokens: TokenStore
  orchestratorToken: string
  /** Mint a worker-tier token bound to a board id (consumer: a later .mcp.json slice / the smoke). */
  mintWorkerToken(boardId: string): string
  /**
   * Mint a `connected`-tier MCP token bound to a Terminal board (Agent Orchestration v1). Returns
   * `{ token, tier:'connected', port }` — what the P3 spawn-time provisioner writes into the
   * agent's per-CLI MCP config so a consented terminal can `relay_prompt` along its own cables +
   * spawn/configure/plan-write the canvas. The seam's `mintTerminalToken` delegates here. 🔒 NEVER
   * log the token (PLAN §6).
   */
  mintConnectedToken(boardId: string): TerminalToken
  /**
   * PR-2: the read-only working-tree diff for a board, through the SAME orchestrator path the
   * agent-facing `git_diff` MCP tool uses (terminal-type check + 100 KB clamp). The pinned
   * `@expanse-ade/mcp` (^0.13.0, shipped ≥ 0.11.0) DOES register a `git_diff` tool that routes to
   * `orchestrator.gitDiff(boardId)` — so the wire path exists; this in-process surface remains for
   * the CANVAS_E2E `__canvasE2EMain.gitDiff` seam to invoke it live without the HTTP transport.
   * Reachability gating (per [[mcp-not-wired-to-terminals]]): the tool is registered ONLY at the
   * `orchestrator` tier (not `connected`/`worker`), and terminal agents aren't auto-connected, so
   * an agent reaching it depends on a minted orchestrator-tier token + scope.
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
   * `__canvasE2EMain.spawnGroupNow` seam. WIRE-REACHABLE since the ≥0.18.0 pin (H4 / Lane H doc
   * fix — the "package registers no spawn_group tool" note was stale): the package registers
   * `spawn_group` at the ORCHESTRATOR tier (`registerSpawnGroup`), routing here through
   * `orchestrator.spawnGroup`, whose `launchCommand` is sanitized as an exec vector in
   * `mcpLifecycle.spawnGroup` (`sanitizeLaunch` — the PR-5c gating requirement, already paid).
   */
  spawnGroup(input: SpawnGroupInput): Promise<SpawnGroupResult>
  /**
   * rc.6 auto-cable: spawn one board through the same cap-checked path the `spawn_board` tool
   * uses, incl. the optional `sourceBoardId` (a connected caller's token-derived board id → the
   * renderer creates the spawner→spawned orchestration cable). Exposed for the CANVAS_E2E
   * `spawnBoardNow` seam; the wire path arrives with the ≥0.18.0-rc.6 package pin (whose
   * connected-tier tool supplies ctx.boardId).
   */
  spawnBoard(input: {
    type: string
    prompt?: string
    cwd?: string
    title?: string
    sourceBoardId?: string
  }): Promise<{ id: string }>
  /**
   * Phase C / C1: dispatch a prompt into a board's PTY through the SAME gated path the
   * `assign_prompt` MCP tool uses (sanitize → single-use nonce → human confirm → audit). Exposed
   * here so the Command board's frame-guarded renderer → MAIN IPC (`mcpOrchestratorIpc.ts`) can
   * drive it without a token; every write still pays the gate. Resolves with the readiness
   * verdict (2026-07-03): `'ready'` = landed in a readiness-confirmed REPL; `'unconfirmed'` =
   * written, but the target never showed boot-quiet before the backstop.
   */
  dispatchPrompt(boardId: string, text: string): Promise<{ delivery: 'ready' | 'unconfirmed' }>
  /**
   * Phase C / C2: dispatch a prompt AND await the worker's two-gate settle (PR-0), resolving with
   * its `BoardResult`. The Command board's authoritative done/failed signal — same gate as
   * `dispatchPrompt`, plus the await-idle. A long-pending call (resolves on settle).
   */
  handoffPrompt(boardId: string, text: string): Promise<BoardResult>
  /**
   * Phase C / C2e: await a worker's task to SETTLE (output silence after activity / its own
   * `write_result` / a backstop) WITHOUT a write — the verdict half of a dispatch whose prompt was
   * delivered as a launch arg (`claude "<prompt>"`). Read-only (no gate). Resolves with its result.
   */
  awaitSettled(boardId: string): Promise<BoardResult>
  /** Phase C / C1: gated Ctrl-C into a board's PTY (same gate, terminator `\x03`, no sanitize). */
  interrupt(boardId: string): Promise<void>
  /**
   * FIND-015: revoke every live `connected`-tier token (across all boards). Called on orchestration
   * consent REVOKE so a bearer left on disk in a CLI config is dead immediately — not only after
   * the next app restart. Per-board accretion is separately bounded by rotate-on-respawn in
   * `mintConnectedToken` (a re-spawn revokes the board's prior token).
   */
  revokeAllConnected(): void
  close(): Promise<void>
}

/**
 * Mount the canvas-ade-mcp loopback HTTP server inside MAIN. The package is
 * ESM-only and MAIN is CJS, so it is loaded via dynamic import() inside this async
 * fn. A bind/load failure is non-fatal (the server is a convenience layer, not a
 * boot dependency) — log and return null, mirroring startLocalServer.
 */
export async function startMcpServer(
  registry: BoardRegistry,
  opts: {
    /**
     * Live getter for the runaway-swarm spawn cap (the Settings-backed config). Read fresh on each
     * spawn check so a user's cap change applies without restarting MAIN. Omitted ⇒ MCP_SPAWN_CAP.
     */
    cap?: () => number
  } = {}
): Promise<RunningMcp | null> {
  try {
    const { createMcpHttpServer, TokenStore, mintBoardToken } = await import('@expanse-ade/mcp')
    const tokens = new TokenStore()
    const { token: orchestratorToken } = mintBoardToken(tokens, {
      boardId: 'app',
      tier: 'orchestrator'
    })
    // 🔒 Agent Orchestration v1: bound connected-token accretion + enable consent-revoke
    // invalidation (FIND-015 — see makeConnectedTokenTracker). Built BEFORE the orchestrator so
    // `connected.revoke` can be wired in as `onBoardClosed` below (BUG-019): a board's connected
    // token now dies THE MOMENT the lifecycle closes it (the human-gated close_board tool), not
    // only on a re-spawn rotation or a full consent-revoke.
    const connected = makeConnectedTokenTracker((token) => tokens.revoke(token))
    const orchestrator = buildOrchestrator(registry, {
      cap: opts.cap,
      onBoardClosed: (boardId) => connected.revoke(boardId)
    })
    // 🔒 BUG-021: bind relay_prompt to the single command-orchestrator board ('app', minted
    // just above). A second orchestrator-tier token (bound to a different board) then can't
    // drive orchestration cables it doesn't own. Matches the orchestratorToken's boardId.
    // 🔒 S2 / Agent Orchestration: `planningWrite` is a LAZY getter — re-evaluated per session by
    // the package (the server is a process singleton but orchestration consent is per-project +
    // runtime-toggleable). Gates the `add_planning_elements` content-write tool + `spawn_board`
    // seed for the orchestrator AND `connected` tiers (ADR 0003 + consent, ConfirmModal-gated).
    // ≥0.18.0-rc.6 declares dispatchPrompt/relayPrompt as `Promise<{delivery} | void>`, so the
    // host's honest-ack widening passes straight through — the tools read the verdict and surface
    // a delivery WARNING to the agent on 'unconfirmed'. (The rc.5-era void-shim is gone.)
    const server = await createMcpHttpServer({
      orchestrator,
      tokens,
      commandBoardId: 'app',
      planningWrite: () => planningWriteEnabled()
    })
    // 🔒 Agent Orchestration v1: mint a `connected`-tier token bound to a Terminal board. NEVER
    // logged (PLAN §6). Registered as the seam's `mintTerminalToken` delegate so the P3 spawn-time
    // provisioner can mint a per-board token without importing the ESM-only package or the store.
    const mintConnectedToken = (boardId: string): TerminalToken => {
      const token = mintBoardToken(tokens, { boardId, tier: 'connected' }).token
      connected.track(boardId, token)
      // Cross-project routing (2026-07-09): remember which project owned this board at mint —
      // the board belongs to the ACTIVE project (the spawn-time provisioner runs there). The
      // visualize gate resolves a caller's own project from this so a backgrounded project's
      // agent routes its board to its own canvas. Re-mints refresh; a null dir records nothing.
      recordBoardProject(boardId, getCurrentDir())
      return { token, tier: 'connected', port: server.port }
    }
    __setTerminalTokenMinter(mintConnectedToken)
    // NOTE (2026-07-02): the T3.4 idle-reap sweep that ran here on an interval was REMOVED —
    // boards are deleted ONLY by the user or via the human-gated close_board tool.
    return {
      port: server.port,
      tokens,
      orchestratorToken,
      mintWorkerToken: (boardId) => mintBoardToken(tokens, { boardId, tier: 'worker' }).token,
      mintConnectedToken,
      gitDiff: (boardId) => orchestrator.gitDiff(boardId),
      describeApp: () => orchestrator.describeApp(),
      spawnGroup: (input) => orchestrator.spawnGroup(input),
      spawnBoard: (input) => orchestrator.spawnBoard(input),
      dispatchPrompt: (boardId, text) => orchestrator.dispatchPrompt(boardId, text),
      handoffPrompt: (boardId, text) => orchestrator.handoffPrompt(boardId, text),
      awaitSettled: (boardId) => orchestrator.awaitSettled(boardId),
      interrupt: (boardId) => orchestrator.interrupt(boardId),
      revokeAllConnected: () => connected.revokeAll(),
      close: () => {
        // Clear the seam minter so a post-close `mintTerminalToken` fails loud (no bogus token).
        __setTerminalTokenMinter(null)
        connected.clear()
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
