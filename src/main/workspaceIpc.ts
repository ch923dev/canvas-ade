/**
 * Project Workspaces WS-4 — the frame-guarded `workspace:*` IPC (design: docs/research/
 * 2026-11-02-project-workspaces §4.3). The lifecycle logic lives in `workspaceStore.ts`; this file
 * is the trust boundary and the wiring:
 *
 *   - every handler first runs `isForeignSender` — a foreign frame gets a refusal and nothing runs
 *     (the same guard every other MAIN surface uses; `simple-git` never runs on its behalf);
 *   - `registerWorkspaceHandlers` takes its store + folder picker injected, so the handlers unit-
 *     test without Electron, node-pty or git;
 *   - `registerWorkspaceIpc` assembles the real deps: the ONE allocator, MAIN's own workspace
 *     mirror, the PTY session probes, and the shared PTY write gate for the dependency prompt.
 *
 * 🔒 The dependency prompt (O-9) travels the SAME gate every agent dispatch pays
 * (`dispatchGate.createGatedWriter`: sanitize → single-use nonce → readiness wait → paste-framed
 * write → submit → audit). Its confirm step is supplied through the gate's `confirmOverride` seam
 * from the human's own tick in the New Workspace dialog — MAIN-held, single-use (`workspaceStore`
 * arms it at create and spends it here), and the text is MAIN's fixed constant, so the renderer can
 * name a workspace + board and nothing else. That is the documented "the tick is the consent".
 */
import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron'
import { isForeignSender } from './ipcGuard'
import { appendAuditEntry } from './auditIpc'
import { listWorkspaces } from './boardRegistry'
import { createGatedWriter } from './dispatchGate'
import { createDispatchGuard } from './dispatchGuard'
import { getCurrentDir } from './projectStore'
import {
  getTerminalActivityStaleMs,
  getTerminalBootInfo,
  getTerminalCwd,
  isBracketedPasteEnabled,
  listPtySessions,
  readPtyOutput,
  writeToPty
} from './pty'
import { createSwarmWorktreeStore } from './swarmWorktree'
import { createReadinessWaiter } from './terminalReadiness'
import { createWorkspaceStore, type WorkspaceStore } from './workspaceStore'
import { normalizeWorkspaceRoot } from '../shared/workspaceRules'
import type {
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspacePickResult
} from '../shared/workspaceIpcTypes'

export interface WorkspaceIpcDeps {
  store: WorkspaceStore
  /** The OS folder picker, opened at the project. Resolves to the picked ABSOLUTE path or null. */
  pickFolder: (defaultPath: string) => Promise<string | null>
  getProjectDir: () => string | null
}

const FORBIDDEN = { ok: false as const, reason: 'forbidden' }

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function registerWorkspaceHandlers(
  ipcMain: Pick<IpcMain, 'handle'>,
  getWin: () => BrowserWindow | null,
  deps: WorkspaceIpcDeps
): void {
  const { store } = deps
  const foreign = (e: IpcMainInvokeEvent): boolean => isForeignSender(e, getWin)

  ipcMain.handle('workspace:probe', (e, root: unknown) =>
    foreign(e) ? FORBIDDEN : store.probe(str(root))
  )
  ipcMain.handle('workspace:listRepos', (e) => (foreign(e) ? [] : store.listRepos()))
  ipcMain.handle('workspace:listBranches', (e, repoRoot: unknown) =>
    foreign(e) ? FORBIDDEN : store.listBranches(str(repoRoot))
  )
  ipcMain.handle('workspace:create', (e, req: unknown) =>
    foreign(e) ? FORBIDDEN : store.create((req ?? {}) as WorkspaceCreateRequest)
  )
  ipcMain.handle('workspace:abandon', (e, worktree: unknown) =>
    foreign(e) ? { removed: false } : store.abandon(str(worktree))
  )
  ipcMain.handle('workspace:status', (e, id: unknown) =>
    foreign(e) ? FORBIDDEN : store.status(str(id))
  )
  ipcMain.handle('workspace:delete', (e, req: unknown) =>
    foreign(e) ? FORBIDDEN : store.remove((req ?? {}) as WorkspaceDeleteRequest)
  )
  ipcMain.handle('workspace:dirsExist', (e, paths: unknown) =>
    foreign(e) ? [] : store.dirsExist(Array.isArray(paths) ? paths.map(str) : [])
  )
  ipcMain.handle('workspace:depsPrompt', (e, arg: unknown) => {
    if (foreign(e)) return FORBIDDEN
    const a = (arg ?? {}) as { workspaceId?: unknown; boardId?: unknown; now?: unknown }
    return store.depsPrompt(str(a.workspaceId), str(a.boardId), { now: a.now === true })
  })
  ipcMain.handle('workspace:pickFolder', async (e): Promise<WorkspacePickResult> => {
    if (foreign(e)) return FORBIDDEN
    const project = deps.getProjectDir()
    if (!project) return { ok: false, reason: 'No project is open.' }
    const picked = await deps.pickFolder(project)
    if (!picked) return { ok: false, reason: 'cancelled' }
    // Containment is the probe's job (realpath, O-7): hand it the lexical relative path and let it
    // refuse an escape — including a junction that only escapes once resolved.
    const rel = relativeToProject(project, picked)
    if (rel === null) {
      return {
        ok: false,
        reason:
          "That folder is outside this project. In this version a workspace's folder must be inside the project."
      }
    }
    const p = await store.probe(rel)
    return p.ok ? { ok: true, root: p.root } : p
  })
}

/** An absolute picked path → project-relative POSIX, or null when it is not under the project. */
export function relativeToProject(project: string, abs: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = norm(project)
  const target = norm(abs)
  const ci = process.platform === 'win32'
  const eq = (a: string, b: string): boolean => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (eq(target, base)) return '.'
  const head = target.slice(0, base.length + 1)
  if (!eq(head, base + '/')) return null
  return normalizeWorkspaceRoot(target.slice(base.length + 1))
}

/** Assemble the real deps and register the handlers (index.ts calls this once at boot). */
export function registerWorkspaceIpc(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  const awaitReady = createReadinessWaiter({
    bootInfo: getTerminalBootInfo,
    activityStaleMs: getTerminalActivityStaleMs,
    now: Date.now
  }).awaitTerminalReady
  const runGatedWrite = createGatedWriter({
    guard: createDispatchGuard(),
    // Never consulted: every write here carries a confirmOverride. Fail-closed if it ever were.
    confirm: async () => ({ approved: false }),
    writeToPty: (id, text) => writeToPty(id, text),
    awaitReady,
    isBracketedPaste: isBracketedPasteEnabled,
    activityStaleMs: getTerminalActivityStaleMs,
    audit: appendAuditEntry
  })
  const store = createWorkspaceStore({
    getProjectDir: getCurrentDir,
    worktrees: createSwarmWorktreeStore({ getProjectDir: getCurrentDir }),
    getWorkspace: (id) => listWorkspaces().find((w) => w.id === id),
    liveTerminals: () =>
      listPtySessions()
        .filter((s) => s.status === 'running' || s.status === 'spawning')
        .flatMap((s) => {
          const cwd = getTerminalCwd(s.id)
          return cwd ? [{ id: s.id, cwd }] : []
        }),
    terminalCwd: (id) =>
      listPtySessions().some((s) => s.id === id && s.status === 'running')
        ? getTerminalCwd(id)
        : undefined,
    awaitReady: async (boardId) => (await awaitReady(boardId)).outcome,
    screenTail: (boardId) => readPtyOutput(boardId, { limit: 4000 }).text,
    sendPrompt: async (boardId, text) => {
      const { delivery } = await runGatedWrite({
        type: 'workspace_deps_prompt',
        targetId: boardId,
        text,
        terminator: '\r',
        confirmTitle: 'Install dependencies',
        confirmBody: (safe) => safe,
        // The human's tick in the New Workspace dialog, armed single-use by workspace:create.
        confirmOverride: async () => ({ approved: true })
      })
      return { delivery }
    }
  })
  registerWorkspaceHandlers(ipcMain, getWin, {
    store,
    getProjectDir: getCurrentDir,
    pickFolder: async (defaultPath) => {
      const win = getWin()
      const opts = { defaultPath, properties: ['openDirectory' as const] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    }
  })
}
