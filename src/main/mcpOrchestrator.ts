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
 * (the runaway-swarm guard, T3.1). Counted in the adapter; T3.4 adds idle-reaping +
 * mirror reconciliation on top. Spawns past the cap are rejected with a clear error.
 */
export const MCP_SPAWN_CAP = 4

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
export function buildOrchestrator(registry: BoardRegistry): Orchestrator {
  const sessionMap = (): Map<string, string> =>
    new Map(registry.listSessions().map((s) => [s.id, s.status]))
  // Ids this orchestrator has spawned — the cap budget (T3.1). Per-instance closure
  // state; T3.2 close_board removes from it, T3.4 reaps idle ids + reconciles vs the
  // mirror. Overcounts (never undercounts) on a user-side manual close — the SAFE
  // direction for a runaway guard until T3.4 reconciles.
  const spawnedIds = new Set<string>()
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
      // 🔒 Runaway-swarm guard: reject BEFORE minting/sending so a capped spawn has
      // no side effects. (Cap-budget check; T3.4 reconciles + reaps idle ids.)
      if (spawnedIds.size >= MCP_SPAWN_CAP) {
        throw new Error(
          `MCP spawn concurrency cap reached (${MCP_SPAWN_CAP} live spawned boards); close one first`
        )
      }
      // MAIN mints the id (server-issued) so the tool can return it to the agent and
      // later lifecycle tools (close/configure) can address the exact board. The
      // renderer builds the full board (free-slot placement, per-type defaults).
      // `prompt`/`cwd` are accepted now but applied in T3.3 (configure_board).
      const id = randomUUID()
      const ack = await registry.sendCommand({ type: 'addBoard', board: { id, type: input.type } })
      if (!ack.ok) throw new Error(`spawn_board failed: ${ack.error}`)
      spawnedIds.add(id)
      return { id }
    },
    async dispatchPrompt(): Promise<void> {
      throw new Error('dispatchPrompt not available until Phase 4')
    },
    async gitDiff(): Promise<string> {
      throw new Error('gitDiff not available until Phase 6')
    }
  }
}
