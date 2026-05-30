import type { BoardId, BoardSummary, Orchestrator } from '@ch923dev/canvas-ade-mcp'

/** The thin MAIN-owned board view the adapter reads (a slice of the PTY session map). */
export interface BoardRegistry {
  listSessions(): Array<{ id: string; status: string }>
}

/**
 * Build an Orchestrator backed by the PTY session registry. Pure — imports only
 * types from the package, so the contract test runs without loading node-pty.
 * Methods with no MAIN source yet throw an explicit phase-gated error; no tool or
 * resource registered in this milestone reaches them.
 */
export function buildPtyOrchestrator(registry: BoardRegistry): Orchestrator {
  return {
    async listBoards(): Promise<BoardSummary[]> {
      return registry.listSessions().map((s) => ({ id: s.id, type: 'terminal', status: s.status }))
    },
    async boardStatus(boardId: BoardId): Promise<string> {
      const found = registry.listSessions().find((s) => s.id === boardId)
      if (!found) throw new Error(`board not found: ${boardId}`)
      return found.status
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
