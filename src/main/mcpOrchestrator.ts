import { randomUUID } from 'node:crypto'
import type {
  BoardId,
  BoardOutput,
  BoardResult,
  BoardSummary,
  MemoryDoc,
  Orchestrator
} from '@ch923dev/canvas-ade-mcp'
import type { McpCommand, McpCommandAck } from './mcpCommand'

/**
 * 🔒 Hard cap on the number of live boards a single MCP session may have spawned
 * (the runaway-swarm guard, T3.1). Reconciled against the live mirror + idle-reaped
 * (T3.4). Spawns past the cap are rejected with a clear error.
 */
export const MCP_SPAWN_CAP = 4

/** Default idle TTL before an MCP-spawned board is reaped (T3.4). */
export const MCP_IDLE_TTL_MS = 5 * 60 * 1000

/**
 * Grace after a spawn during which a tracked board is NOT reconciled away even if it
 * is absent from the mirror — the renderer publishes the new board asynchronously
 * (~150ms debounce), so a just-spawned id legitimately isn't in `listBoards()` yet.
 */
export const MCP_SPAWN_GRACE_MS = 5_000

/** Tuning + clock seam for the lifecycle cap/reaper (all optional; injected by tests). */
export interface OrchestratorOpts {
  now?: () => number
  cap?: number
  idleTtlMs?: number
  spawnGraceMs?: number
}

/** The adapter + the T3.4 idle-reap sweep (extra method beyond the package contract). */
export type LifecycleOrchestrator = Orchestrator & {
  /** Close every MCP-spawned board idle past the TTL; returns the reaped ids. */
  reapIdle(): Promise<string[]>
}

/** MAIN-owned board sources the adapter reads: the renderer mirror + the PTY map. */
export interface BoardRegistry {
  listBoards(): Array<{ id: string; type: string; title: string; status?: string }>
  listSessions(): Array<{ id: string; status: string }>
  /**
   * Drive the canvas via the MAIN → renderer control-plane command channel (T3.1+).
   * MAIN injects a frame-guarded `sendMcpCommand`; the renderer applies the command
   * to `canvasStore` and acks. The ONLY write path from the MCP layer to the canvas.
   */
  sendCommand(command: McpCommand): Promise<McpCommandAck>
  /**
   * Read one capped, ANSI-stripped page of a board's PTY scrollback (T1.4 🔒).
   * MAIN injects `pty.ts`'s `readPtyOutput`; non-terminal/unknown ids read empty.
   */
  readOutput(id: string, opts?: { cursor?: number }): BoardOutput
  /**
   * Read a board's structured last result (T1.5). MAIN injects `boardResults.ts`'s
   * `readBoardResult`; a board with no recorded result reads the empty shell.
   */
  readResult(id: string): BoardResult
  /**
   * Read the project memory index (T1.7 🔒). MAIN injects `boardMemory.ts`'s
   * `readProjectMemory`; empty shell when the memory engine is absent.
   */
  readMemory(): MemoryDoc
  /**
   * Read a board's memory summary (T1.7 🔒). MAIN injects `readBoardSummary` (which
   * path-guards the agent-supplied id); empty shell when absent/invalid.
   */
  readSummary(id: string): MemoryDoc
  /**
   * Gracefully drain (then tree-kill) a board's PTY before it is removed (T3.2).
   * MAIN injects `pty.ts`'s `drainPty`; a non-terminal / absent id resolves to a
   * no-op. Always resolves — close is best-effort graceful, never throws on the PTY.
   */
  drainPty(id: string): Promise<void>
}

/**
 * Coarse status bucket for a board (T1.1). The renderer-supplied `status` bucket
 * wins — it is derived from the live runtime stores (terminalRuntimeStore +
 * previewStore) and is the single source of truth shared with the on-canvas pill.
 * When the mirror carries no bucket (a renderer predating T1.1, or a board not yet
 * republished), fall back to a bucket derived from MAIN's own signals: the PTY
 * session map for terminals, presence for the rest. The fallback is intentionally
 * coarse — `running` only when the PTY is live, otherwise `idle`; `browser` is
 * `idle` (presence, not liveness — a crashed browser still reads idle here);
 * `planning` and any forward/unknown type are `static`.
 */
function deriveStatus(
  board: { id: string; type: string; status?: string },
  sessionById: Map<string, string>
): string {
  if (board.status) return board.status
  if (board.type === 'terminal') return sessionById.get(board.id) === 'running' ? 'running' : 'idle'
  if (board.type === 'browser') return 'idle'
  return 'static'
}

/**
 * Build an Orchestrator backed by the board mirror, with PTY status overlaid on
 * terminal boards. Pure (type-only package imports → contract test loads no
 * node-pty). spawnBoard/dispatchPrompt/gitDiff stay phase-gated.
 */
export function buildOrchestrator(
  registry: BoardRegistry,
  opts: OrchestratorOpts = {}
): LifecycleOrchestrator {
  const now = opts.now ?? Date.now
  const cap = opts.cap ?? MCP_SPAWN_CAP
  const idleTtlMs = opts.idleTtlMs ?? MCP_IDLE_TTL_MS
  const spawnGraceMs = opts.spawnGraceMs ?? MCP_SPAWN_GRACE_MS
  const sessionMap = (): Map<string, string> =>
    new Map(registry.listSessions().map((s) => [s.id, s.status]))
  // Boards this orchestrator has spawned — the cap budget (T3.1). `spawnedAt` gates
  // reconciliation (T3.4): an id absent from the live mirror is dropped only after the
  // spawn grace, so a just-spawned not-yet-published board isn't pruned. `idleSince`
  // tracks how long the board has been idle for the reaper.
  const tracked = new Map<string, { spawnedAt: number; idleSince: number | null }>()

  /** Drop tracked boards the user has since closed (gone from the mirror past the grace). */
  const reconcile = (): void => {
    const live = new Set(registry.listBoards().map((b) => b.id))
    const t = now()
    for (const [id, rec] of tracked) {
      if (!live.has(id) && t - rec.spawnedAt > spawnGraceMs) tracked.delete(id)
    }
  }

  return {
    async listBoards(): Promise<BoardSummary[]> {
      const sessions = sessionMap()
      return registry
        .listBoards()
        .map((b) => ({ id: b.id, type: b.type, title: b.title, status: deriveStatus(b, sessions) }))
    },
    async boardStatus(boardId: BoardId): Promise<string> {
      const board = registry.listBoards().find((b) => b.id === boardId)
      if (!board) throw new Error(`board not found: ${boardId}`)
      return deriveStatus(board, sessionMap())
    },
    async boardOutput(boardId: BoardId, opts?: { cursor?: number }): Promise<BoardOutput> {
      // Read-only scrollback page (T1.4). An absent board reads as empty (the
      // accessor returns an empty page), not an error — output is observational.
      return registry.readOutput(boardId, opts)
    },
    async boardResult(boardId: BoardId): Promise<BoardResult> {
      // Read-only structured last result (T1.5). No result recorded → empty shell.
      return registry.readResult(boardId)
    },
    async projectMemory(): Promise<MemoryDoc> {
      // 🔒 read-only passive context (T1.7). Absent memory engine → empty shell.
      return registry.readMemory()
    },
    async boardSummary(boardId: BoardId): Promise<MemoryDoc> {
      // 🔒 read-only passive context (T1.7). Path-guarded id; absent → empty shell.
      return registry.readSummary(boardId)
    },
    async spawnBoard(input: { type: string; prompt?: string; cwd?: string }): Promise<{
      id: BoardId
    }> {
      // 🔒 Runaway-swarm guard: reconcile away user-closed boards first (so a real
      // slot can be reused), then reject BEFORE minting/sending so a capped spawn has
      // no side effects.
      reconcile()
      if (tracked.size >= cap) {
        throw new Error(
          `MCP spawn concurrency cap reached (${cap} live spawned boards); close one first`
        )
      }
      // MAIN mints the id (server-issued) so the tool can return it to the agent and
      // later lifecycle tools (close/configure) can address the exact board. The
      // renderer builds the full board (free-slot placement, per-type defaults).
      // `prompt`/`cwd` are accepted now but applied in T3.3 (configure_board).
      const id = randomUUID()
      const ack = await registry.sendCommand({ type: 'addBoard', board: { id, type: input.type } })
      if (!ack.ok) throw new Error(`spawn_board failed: ${ack.error}`)
      tracked.set(id, { spawnedAt: now(), idleSince: null })
      return { id }
    },
    async closeBoard(boardId: BoardId): Promise<void> {
      // Graceful FIRST: drain (then tree-kill) the PTY so the shell/agent gets a clean
      // exit rather than an abrupt SIGKILL. Best-effort — a non-terminal id is a no-op.
      await registry.drainPty(boardId)
      // Then remove the board from the canvas via the command channel.
      const ack = await registry.sendCommand({ type: 'removeBoard', id: boardId })
      if (!ack.ok) throw new Error(`close_board failed: ${ack.error}`)
      // Free the cap budget so a later spawn can reuse the slot (T3.1 cap).
      tracked.delete(boardId)
    },
    async reapIdle(): Promise<string[]> {
      // 🔒 Idle-reaping (T3.4): close MCP-spawned boards that have stayed idle past the
      // TTL — the swarm doesn't accrete dormant boards. `idleSince` is sweep-tracked:
      // first idle sighting arms the clock; a return to running clears it; an idle span
      // ≥ TTL reaps. Reconcile first so a user-closed board isn't reaped twice.
      reconcile()
      const statuses = new Map((await this.listBoards()).map((b) => [b.id, b.status] as const))
      const t = now()
      const reapable: string[] = []
      for (const [id, rec] of tracked) {
        const status = statuses.get(id)
        const idle = status === undefined || status === 'idle'
        if (!idle) {
          rec.idleSince = null
          continue
        }
        if (rec.idleSince === null) {
          rec.idleSince = t
          continue
        }
        if (t - rec.idleSince >= idleTtlMs) reapable.push(id)
      }
      for (const id of reapable) await this.closeBoard(id)
      return reapable
    },
    async configureBoard(
      boardId: BoardId,
      config: { shell?: string; launchCommand?: string; cwd?: string }
    ): Promise<void> {
      // Apply the durable per-type config via the command channel. The renderer's
      // updateBoard filters to PATCHABLE_KEYS, so an off-type/ephemeral key is dropped.
      const ack = await registry.sendCommand({ type: 'configureBoard', id: boardId, patch: config })
      if (!ack.ok) throw new Error(`configure_board failed: ${ack.error}`)
    },
    async dispatchPrompt(): Promise<void> {
      throw new Error('dispatchPrompt not available until Phase 4')
    },
    async gitDiff(): Promise<string> {
      throw new Error('gitDiff not available until Phase 6')
    }
  }
}
