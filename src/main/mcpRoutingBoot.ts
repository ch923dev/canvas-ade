/**
 * Cross-project MCP command routing — boot wiring (2026-07-09), extracted from index.ts (max-lines
 * ratchet, the voiceBoot/deepLinkBoot discipline). One call wires the whole plane:
 *
 *   - the persisted pending-command store (userData sidecar) a confirmed visualize_plan targeting
 *     a NON-active project queues into (`mcpVisualizeGate`),
 *   - the snapshot-driven drainer that delivers a project's queue — via the SAME frame-guarded
 *     `sendMcpCommand` → renderer-applier path as a live command — when it is next foregrounded,
 *   - and the registry slice (`currentProjectDir` / `boardProjectDir` / `enqueueProjectCommand`)
 *     index.ts spreads into the `startMcpServer` registry literal.
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { getCurrentDir } from './projectStore'
import { boardProjectDir } from './mcpBoardProjects'
import { subscribeBoardSnapshot } from './boardRegistry'
import { sendMcpCommand } from './mcpCommand'
import { createPendingCommandStore, startPendingCommandDrainer } from './mcpPendingCommands'
import type { BoardRegistry } from './mcpRegistry'

export function startMcpCommandRouting(deps: {
  userData: string
  bus: IpcMain
  getWin: () => BrowserWindow | null
}): Required<
  Pick<BoardRegistry, 'currentProjectDir' | 'boardProjectDir' | 'enqueueProjectCommand'>
> {
  const store = createPendingCommandStore(deps.userData)
  startPendingCommandDrainer({
    store,
    currentDir: getCurrentDir,
    send: (command) => sendMcpCommand(deps.bus, deps.getWin, command),
    subscribeSnapshot: subscribeBoardSnapshot
  })
  return {
    currentProjectDir: getCurrentDir,
    boardProjectDir,
    enqueueProjectCommand: (dir, command) => store.enqueue(dir, command)
  }
}
