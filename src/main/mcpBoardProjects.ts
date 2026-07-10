/**
 * Board → project-dir memory for MCP cross-project routing (2026-07-09).
 *
 * The MCP server is a process SINGLETON but a connected-tier token is minted per Terminal board,
 * and the board belongs to exactly one project — the one that was ACTIVE when the spawn-time
 * provisioner minted its token (`mcp.ts` › `mintConnectedToken` records it here). The visualize
 * gate reads the map to resolve a CALLER'S OWN project, so a backgrounded project's agent routes
 * its new board to its own canvas instead of whichever project happens to be foregrounded.
 *
 * In-memory only, matching the TokenStore it shadows: tokens die with the app run and every spawn
 * re-mints (rotate-on-respawn), so each run repopulates the map before any routed call can arrive.
 * The manual-Sync pseudo board (`orchestration-sync`) shares one id across projects — its map entry
 * is overwritten on each Sync exactly like its token is rotated, so the id always resolves to the
 * project holding the only LIVE pseudo token.
 */

/** Bound the map so a hostile/looping mint path can't grow MAIN memory (mirrors MAX_BOARDS). */
const MAX_BOARD_PROJECTS = 500

const byBoard = new Map<string, string>()

/**
 * Remember which project owned `boardId` at token-mint time. A re-mint refreshes the entry
 * (Map insertion order is the eviction order, so refreshed boards outlive stale ones); a null
 * dir (no project open — e.g. an e2e boot mint) records nothing.
 */
export function recordBoardProject(boardId: string, dir: string | null): void {
  if (!dir || boardId.length === 0) return
  byBoard.delete(boardId)
  byBoard.set(boardId, dir)
  if (byBoard.size > MAX_BOARD_PROJECTS) {
    const oldest = byBoard.keys().next().value
    if (oldest !== undefined) byBoard.delete(oldest)
  }
}

/** The project dir that owned `boardId` when its token was minted, or null when unknown. */
export function boardProjectDir(boardId: string): string | null {
  return byBoard.get(boardId) ?? null
}

/** Test seam — reset the map between tests (unit tests only). */
export function __clearBoardProjectsForTest(): void {
  byBoard.clear()
}
