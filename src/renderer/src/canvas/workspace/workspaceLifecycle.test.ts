import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCanvasStore } from '../../store/canvasStore'
import type { TerminalBoard } from '../../lib/boardSchema'
import {
  agentKindFor,
  createWorkspaceFlow,
  finishDelete,
  pickBase,
  sanitizeLaunch,
  wantsDepsPrompt,
  type CreateWorkspaceInput,
  type WorkspaceApi
} from './workspaceLifecycle'

// WS-4 renderer lifecycle (design §4.3): MAIN first, the record only after; base memory; starter
// boards; the dependency prompt only for a git-backed workspace whose terminal runs an agent.

const get = () => useCanvasStore.getState()
const WT_ABS = 'C:\\p\\.canvas\\worktrees\\ws-api'

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    past: [],
    future: [],
    workspaces: [],
    repoDefaults: {},
    workspaceMissing: {},
    selectedId: null,
    selectedIds: [],
    project: { dir: 'C:\\p', name: 'p', status: 'open' } as never
  })
})

function fakeApi(over: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    probe: vi.fn(),
    pickFolder: vi.fn(),
    listRepos: vi.fn(),
    listBranches: vi.fn(),
    create: vi.fn(async () => ({
      ok: true as const,
      id: 'ws-1',
      root: 'api',
      cwd: WT_ABS,
      worktree: {
        repoRoot: 'api',
        worktree: '.canvas/worktrees/ws-api',
        branch: 'ws/api',
        baseRef: 'release',
        base: 'abc'
      }
    })),
    abandon: vi.fn(async () => ({ removed: true })),
    status: vi.fn(),
    remove: vi.fn(),
    dirsExist: vi.fn(),
    depsPrompt: vi.fn(async () => ({ ok: true as const, delivery: 'ready' as const })),
    ...over
  } as WorkspaceApi
}

const input = (over: Partial<CreateWorkspaceInput> = {}): CreateWorkspaceInput => ({
  name: 'API',
  goal: 'build auth',
  color: 'violet',
  root: 'api',
  mode: 'worktree',
  base: 'release',
  remember: true,
  deps: true,
  terminal: true,
  launchCommand: 'claude',
  browser: false,
  at: { x: 0, y: 0 },
  ...over
})

describe('pickBase (O-10)', () => {
  const b = { current: 'main', local: ['main', 'release'], remote: ['origin/main'] }
  it('first time: the current branch, to confirm', () => {
    expect(pickBase(b, undefined)).toEqual({ base: 'main', kind: 'first' })
  })
  it('remembered and still there: pre-filled', () => {
    expect(pickBase(b, 'release')).toEqual({ base: 'release', kind: 'remembered' })
    expect(pickBase(b, 'origin/main')).toEqual({ base: 'origin/main', kind: 'remembered' })
  })
  it('remembered but gone: HEAD stands in, and the missing name is reported', () => {
    expect(pickBase(b, 'upgrade-manifest')).toEqual({
      base: 'main',
      kind: 'fallback',
      missing: 'upgrade-manifest'
    })
    expect(pickBase({ ...b, current: null }, 'gone')).toMatchObject({
      base: 'HEAD',
      kind: 'fallback'
    })
  })
})

describe('launch helpers', () => {
  it('sanitizeLaunch keeps one line', () => {
    expect(sanitizeLaunch('  claude\r\nrm -rf / ')).toBe('claude rm -rf /')
  })
  it('agentKindFor maps a preset bin, never the bare shell', () => {
    expect(agentKindFor('claude --model x')).toBe('claude')
    expect(agentKindFor('pwsh')).toBeUndefined()
    expect(agentKindFor('')).toBeUndefined()
  })
  it('the deps prompt needs a git mode, the tick, a terminal AND an agent command', () => {
    expect(wantsDepsPrompt(input())).toBe(true)
    expect(wantsDepsPrompt(input({ mode: 'folder' }))).toBe(false)
    expect(wantsDepsPrompt(input({ deps: false }))).toBe(false)
    expect(wantsDepsPrompt(input({ terminal: false }))).toBe(false)
    expect(wantsDepsPrompt(input({ launchCommand: '  ' }))).toBe(false)
  })
})

describe('createWorkspaceFlow', () => {
  it('MAIN first, then the record, the remembered base, the starter terminal and ONE deps prompt', async () => {
    const api = fakeApi()
    const out = await createWorkspaceFlow(input(), api)
    expect(out).toMatchObject({ ok: true, id: 'ws-1', depsArmed: true })
    expect(api.create).toHaveBeenCalledWith({
      name: 'API',
      root: 'api',
      mode: 'worktree',
      base: 'release',
      deps: true
    })
    expect(get().workspaces[0]).toMatchObject({
      id: 'ws-1',
      name: 'API',
      color: 'violet',
      worktrees: [{ branch: 'ws/api' }]
    })
    expect(get().repoDefaults).toEqual({ api: { base: 'release' } })
    const t = get().boards[0] as TerminalBoard
    expect(t).toMatchObject({
      type: 'terminal',
      workspaceId: 'ws-1',
      cwd: WT_ABS,
      launchCommand: 'claude',
      agentKind: 'claude'
    })
    await vi.waitFor(() => expect(api.depsPrompt).toHaveBeenCalledTimes(1))
    expect(api.depsPrompt).toHaveBeenCalledWith('ws-1', t.id)
  })

  it('a plain shell starter never gets the prompt (it would run it as a command)', async () => {
    const api = fakeApi()
    const out = await createWorkspaceFlow(input({ launchCommand: '' }), api)
    expect(out).toMatchObject({ ok: true, depsArmed: false })
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ deps: false }))
    expect(api.depsPrompt).not.toHaveBeenCalled()
  })

  it('Remember unticked leaves the memory alone', async () => {
    useCanvasStore.setState({ repoDefaults: { api: { base: 'main' } } })
    await createWorkspaceFlow(input({ remember: false }), fakeApi())
    expect(get().repoDefaults).toEqual({ api: { base: 'main' } })
  })

  it('a taken name is refused before MAIN allocates anything', async () => {
    get().createWorkspace({ name: 'api', root: 'x' })
    const api = fakeApi()
    expect(await createWorkspaceFlow(input(), api)).toMatchObject({ ok: false })
    expect(api.create).not.toHaveBeenCalled()
  })

  it("MAIN's refusal is returned and nothing is written", async () => {
    const api = fakeApi({
      create: vi.fn(async () => ({ ok: false as const, reason: 'git said no' }))
    })
    expect(await createWorkspaceFlow(input(), api)).toEqual({ ok: false, reason: 'git said no' })
    expect(get().workspaces).toEqual([])
    expect(get().boards).toEqual([])
  })

  it('a record the store refuses takes the fresh worktree back (no orphan)', async () => {
    // MAIN mints an id the store already holds ⇒ createWorkspace returns null.
    useCanvasStore.setState({
      workspaces: [{ id: 'ws-1', name: 'Other', goal: '', color: 'blue', root: 'x' }]
    })
    const api = fakeApi()
    expect(await createWorkspaceFlow(input(), api)).toMatchObject({ ok: false })
    expect(api.abandon).toHaveBeenCalledWith('.canvas/worktrees/ws-api')
  })
})

describe('finishDelete (O-8)', () => {
  function seedWs(): void {
    useCanvasStore.setState({
      workspaces: [
        {
          id: 'w',
          name: 'API',
          goal: '',
          color: 'blue',
          root: 'api',
          worktrees: [
            {
              repoRoot: 'api',
              worktree: '.canvas/worktrees/ws-api',
              branch: 'ws/api',
              baseRef: 'main',
              base: 'a'
            }
          ]
        }
      ]
    })
    get().addWorkspaceStarters({ workspaceId: 'w', at: { x: 0, y: 0 }, terminal: { cwd: WT_ABS } })
  }

  it('removed + Keep: the record goes, the board stays project-level without the dead cwd', () => {
    seedWs()
    finishDelete(get().workspaces[0], 'removed', false)
    expect(get().workspaces).toEqual([])
    const t = get().boards[0] as TerminalBoard
    expect(t.workspaceId).toBeUndefined()
    expect('cwd' in t).toBe(false)
  })

  it('archived + Keep: the record stays archived, the boards become project-level', () => {
    seedWs()
    finishDelete(get().workspaces[0], 'archived', false)
    expect(get().workspaces[0].state).toBe('archived')
    expect(get().boards[0].workspaceId).toBeUndefined()
    expect((get().boards[0] as TerminalBoard).cwd).toBe(WT_ABS)
  })

  it('Close: the boards are removed', () => {
    seedWs()
    finishDelete(get().workspaces[0], 'removed', true)
    expect(get().boards).toEqual([])
    expect(get().workspaces).toEqual([])
  })
})
