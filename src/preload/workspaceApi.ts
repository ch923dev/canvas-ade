/**
 * Project Workspaces WS-4 preload namespace (own file per the mcpApi/recapApi max-lines
 * precedent). Control-plane invokes only: every channel is frame-guarded in MAIN
 * (`workspaceIpc.ts`), and the renderer sends project-relative paths, ids and a closed
 * disposition — never a command, an absolute path to act on, or prompt text.
 */
import { ipcRenderer } from 'electron'
import type {
  WorkspaceBranchesResult,
  WorkspaceCreateRequest,
  WorkspaceCreateResult,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResult,
  WorkspaceDepsPromptResult,
  WorkspacePickResult,
  WorkspaceProbeResult,
  WorkspaceRepo,
  WorkspaceStatusResult
} from '../shared/workspaceIpcTypes'

export const workspaceApi = {
  /** What one project-relative folder is, git-wise (repo root, current branch, or why not). */
  probe: (root: string): Promise<WorkspaceProbeResult> =>
    ipcRenderer.invoke('workspace:probe', root),
  /** The OS folder picker, opened at the project; refuses a folder outside it. */
  pickFolder: (): Promise<WorkspacePickResult> => ipcRenderer.invoke('workspace:pickFolder'),
  /** Every git repo in the project — the root and one level down. */
  listRepos: (): Promise<WorkspaceRepo[]> => ipcRenderer.invoke('workspace:listRepos'),
  /** A repo's local + remote-tracking branches, as they are on disk (never fetched). */
  listBranches: (repoRoot: string): Promise<WorkspaceBranchesResult> =>
    ipcRenderer.invoke('workspace:listBranches', repoRoot),
  /** Probe + (worktree modes) allocate + stat-prove; returns the record to write. */
  create: (req: WorkspaceCreateRequest): Promise<WorkspaceCreateResult> =>
    ipcRenderer.invoke('workspace:create', req),
  /** Take back a just-created clean worktree whose record could not be written. */
  abandon: (worktree: string): Promise<{ removed: boolean }> =>
    ipcRenderer.invoke('workspace:abandon', worktree),
  /** What deleting this workspace would meet (dirty count, live terminals inside). */
  status: (id: string): Promise<WorkspaceStatusResult> =>
    ipcRenderer.invoke('workspace:status', id),
  /** Delete: folder ⇒ record only; worktree ⇒ remove when clean, else the human's disposition. */
  remove: (req: WorkspaceDeleteRequest): Promise<WorkspaceDeleteResult> =>
    ipcRenderer.invoke('workspace:delete', req),
  /** Which of these project-relative folders exist (open-time "missing" reconcile). */
  dirsExist: (paths: string[]): Promise<boolean[]> =>
    ipcRenderer.invoke('workspace:dirsExist', paths),
  /** Spend the single-use dependency prompt armed by `create` on the starter terminal. */
  depsPrompt: (workspaceId: string, boardId: string): Promise<WorkspaceDepsPromptResult> =>
    ipcRenderer.invoke('workspace:depsPrompt', { workspaceId, boardId })
}
