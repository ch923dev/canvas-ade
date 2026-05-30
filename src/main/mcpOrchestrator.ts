import type { BoardId, BoardSummary, Orchestrator } from '@ch923dev/canvas-ade-mcp'

/** MAIN-owned board sources the adapter reads: the renderer mirror + the PTY map. */
export interface BoardRegistry {
  listBoards(): Array<{ id: string; type: string; title: string }>
  listSessions(): Array<{ id: string; status: string }>
}

function deriveStatus(
  board: { id: string; type: string },
  sessionById: Map<string, string>
): string {
  if (board.type === 'terminal') return sessionById.get(board.id) ?? 'no-session'
  if (board.type === 'browser') return 'open'
  if (board.type === 'planning') return 'static'
  return 'unknown'
}

/**
 * Build an Orchestrator backed by the board mirror, with PTY status overlaid on
 * terminal boards. Pure (type-only package imports → contract test loads no
 * node-pty). spawnBoard/dispatchPrompt/gitDiff stay phase-gated.
 */
export function buildOrchestrator(registry: BoardRegistry): Orchestrator {
  const sessionMap = (): Map<string, string> =>
    new Map(registry.listSessions().map((s) => [s.id, s.status]))
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
    async spawnBoard(): Promise<{ id: BoardId }> {
      throw new Error('spawnBoard not available until Phase 3')
    },
    async dispatchPrompt(): Promise<void> {
      throw new Error('dispatchPrompt not available until Phase 4')
    },
    async gitDiff(): Promise<string> {
      throw new Error('gitDiff not available until Phase 6')
    }
  }
}
