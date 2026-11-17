import { describe, it, expect, vi } from 'vitest'

// The module also assembles the real deps (pty probes, audit, mirror) — stub them so the handler
// registrar unit-tests without Electron / node-pty.
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))
vi.mock('./pty', () => ({
  getTerminalActivityStaleMs: vi.fn(),
  getTerminalBootInfo: vi.fn(),
  getTerminalCwd: vi.fn(),
  isBracketedPasteEnabled: vi.fn(),
  listPtySessions: vi.fn(() => []),
  readPtyOutput: vi.fn(() => ({ text: '' })),
  writeToPty: vi.fn()
}))
vi.mock('./auditIpc', () => ({ appendAuditEntry: vi.fn() }))
vi.mock('./boardRegistry', () => ({ listWorkspaces: vi.fn(() => []) }))
vi.mock('./projectStore', () => ({ getCurrentDir: vi.fn(() => null) }))

import { registerWorkspaceHandlers, relativeToProject } from './workspaceIpc'
import type { WorkspaceStore } from './workspaceStore'

type Handler = (e: unknown, ...args: unknown[]) => unknown

function setup(project: string | null = 'C:\\work\\my project') {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (ch: string, fn: Handler) => handlers.set(ch, fn) }
  const mainFrame = { id: 'main' }
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, mainFrame } }
  const store = {
    probe: vi.fn(async (root: string) => ({ ok: true, root })),
    listRepos: vi.fn(async () => [{ rel: 'api' }]),
    listBranches: vi.fn(async () => ({ ok: true, current: 'main', local: [], remote: [] })),
    create: vi.fn(async () => ({ ok: true })),
    abandon: vi.fn(async () => ({ removed: true })),
    status: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true, outcome: 'record' })),
    dirsExist: vi.fn(() => [true]),
    depsPrompt: vi.fn(async () => ({ ok: true, delivery: 'ready' }))
  } as unknown as WorkspaceStore
  const pickFolder = vi.fn(async () => 'C:\\work\\my project\\api' as string | null)
  registerWorkspaceHandlers(ipcMain as never, () => win as never, {
    store,
    pickFolder,
    getProjectDir: () => project
  })
  const trusted = { senderFrame: mainFrame }
  const foreign = { senderFrame: { id: 'iframe' } }
  const call = (ch: string, e: unknown, ...a: unknown[]): unknown => handlers.get(ch)!(e, ...a)
  return { handlers, store, pickFolder, trusted, foreign, call }
}

const CHANNELS = [
  'workspace:probe',
  'workspace:listRepos',
  'workspace:listBranches',
  'workspace:create',
  'workspace:abandon',
  'workspace:status',
  'workspace:delete',
  'workspace:dirsExist',
  'workspace:depsPrompt',
  'workspace:pickFolder'
]

describe('workspace:* IPC', () => {
  it('registers every channel', () => {
    expect([...setup().handlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  it('a foreign frame is refused on EVERY channel and the store never runs', async () => {
    const { store, pickFolder, foreign, call } = setup()
    for (const ch of CHANNELS) await call(ch, foreign, {})
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled()
    expect(pickFolder).not.toHaveBeenCalled()
  })

  it('the trusted frame reaches the store; depsPrompt forwards only ids (no text)', async () => {
    const { store, trusted, call } = setup()
    await call('workspace:depsPrompt', trusted, {
      workspaceId: 'w',
      boardId: 'b',
      text: 'rm -rf /'
    })
    expect(store.depsPrompt).toHaveBeenCalledWith('w', 'b', { now: false })
    // `now` is a strict boolean — anything else is a plain (heuristic-gated) ask.
    await call('workspace:depsPrompt', trusted, { workspaceId: 'w', boardId: 'b', now: 'yes' })
    expect(store.depsPrompt).toHaveBeenLastCalledWith('w', 'b', { now: false })
    await call('workspace:depsPrompt', trusted, { workspaceId: 'w', boardId: 'b', now: true })
    expect(store.depsPrompt).toHaveBeenLastCalledWith('w', 'b', { now: true })
    await call('workspace:delete', trusted, { id: 'w', disposition: 'keep' })
    expect(store.remove).toHaveBeenCalledWith({ id: 'w', disposition: 'keep' })
  })

  it('pickFolder hands a picked folder to the probe as a project-relative path', async () => {
    const { store, trusted, call } = setup()
    expect(await call('workspace:pickFolder', trusted)).toEqual({ ok: true, root: 'api' })
    expect(store.probe).toHaveBeenCalledWith('api')
  })

  it('pickFolder refuses a folder outside the project without probing it', async () => {
    const { store, pickFolder, trusted, call } = setup()
    pickFolder.mockResolvedValueOnce('D:\\elsewhere\\docs')
    const r = (await call('workspace:pickFolder', trusted)) as { ok: boolean; reason: string }
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('outside this project')
    expect(store.probe).not.toHaveBeenCalled()
  })

  it('pickFolder: a cancelled picker is reported as cancelled', async () => {
    const { pickFolder, trusted, call } = setup()
    pickFolder.mockResolvedValueOnce(null)
    expect(await call('workspace:pickFolder', trusted)).toEqual({ ok: false, reason: 'cancelled' })
  })
})

describe('relativeToProject', () => {
  const P = 'C:\\work\\my project'
  it('maps the project itself to "." and a child to its POSIX path', () => {
    expect(relativeToProject(P, P)).toBe('.')
    expect(relativeToProject(P, 'C:\\work\\my project\\api\\src')).toBe('api/src')
  })
  it('refuses a sibling that only shares the prefix, and a path elsewhere', () => {
    expect(relativeToProject(P, 'C:\\work\\my project-old\\api')).toBeNull()
    expect(relativeToProject(P, 'D:\\other')).toBeNull()
  })
})
