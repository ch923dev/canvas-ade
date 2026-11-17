/**
 * WS-8 boot glue: wires the workspace status writer (`workspaceStatus.ts`) and the Claude workspace
 * rules (`claudeRules.ts`) into the running app, so index.ts only makes one call (it sits at its
 * max-lines ratchet). Design: docs/research/2026-11-02-project-workspaces §4.4–4.5.
 *
 *   - mirror publish  → refresh every workspace's status (each throttled to one write / 5 s);
 *   - recorded result → remembered (last 5) + its workspace refreshed;
 *   - recap settle    → its workspace refreshed (the caller forwards the watcher's onIntent);
 *   - a status write  → `file:treeEvent` {change} for the file, so an open Brief board reloads
 *     (only when it holds no unsaved edits — the renderer decides). `.canvas/` is outside the file
 *     watcher on purpose (H3), so this targeted event is the Brief's only reload signal.
 */
import type { BrowserWindow } from 'electron'
import { listBoardMirror, listWorkspaces, subscribeBoardSnapshot } from './boardRegistry'
import { onBoardResult } from './boardResults'
import { type ClaudeWorkspaceRules, NO_WORKSPACE_RULES } from './cliProvisioners/claudeRules'
import type { RecapFacts } from './recapFacts'
import { createSwarmWorktreeStore } from './swarmWorktree'
import { claudeRulesForBoard, listWorktreeDirs } from './workspaceContext'
import { createWorkspaceStatusWriter } from './workspaceStatus'

export interface WorkspaceContextHandle {
  /** The Claude rules for a terminal board's cwd at spawn (the orchestration sync provider). */
  claudeRulesFor: (boardId: string, targetDir: string) => ClaudeWorkspaceRules
  /** A board's recap transcript settled: refresh its workspace. */
  onRecapSettle: (boardId: string) => void
  dispose: () => void
}

export function startWorkspaceContext(deps: {
  getProjectDir: () => string | null
  recapFacts: (boardId: string) => RecapFacts | null
  getWin: () => BrowserWindow | null
}): WorkspaceContextHandle {
  const allocator = createSwarmWorktreeStore({ getProjectDir: deps.getProjectDir })
  const writer = createWorkspaceStatusWriter({
    getProjectDir: deps.getProjectDir,
    listWorkspaces,
    listBoards: listBoardMirror,
    recapFacts: deps.recapFacts,
    changedFiles: async (dir) => {
      const st = await allocator.status(dir)
      return st.exists ? st.changed : null
    },
    onWritten: (path) => {
      const win = deps.getWin()
      if (win && !win.isDestroyed())
        win.webContents.send('file:treeEvent', { type: 'change', path })
    }
  })

  let project = deps.getProjectDir()
  const unsubs = [
    subscribeBoardSnapshot(() => {
      const dir = deps.getProjectDir()
      if (dir !== project) {
        project = dir
        writer.reset() // a project switch: no timer or result of the old project carries over
      }
      writer.scheduleAll()
    }),
    onBoardResult((id, result) => writer.onResult(id, result))
  ]

  return {
    claudeRulesFor: (boardId) => {
      const projectDir = deps.getProjectDir()
      if (!projectDir) return NO_WORKSPACE_RULES
      return claudeRulesForBoard({
        projectDir,
        boardId,
        boards: listBoardMirror(),
        workspaces: listWorkspaces(),
        worktreeDirs: listWorktreeDirs(projectDir),
        platform: process.platform
      })
    },
    onRecapSettle: (boardId) => writer.scheduleForBoard(boardId),
    dispose: () => {
      for (const u of unsubs) u()
      writer.reset()
    }
  }
}
