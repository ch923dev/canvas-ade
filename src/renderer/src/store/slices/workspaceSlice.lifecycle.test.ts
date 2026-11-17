import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../canvasStore'
import { createBoard, type Board, type TerminalBoard } from '../../lib/boardSchema'
import { clearCwdsUnder, isUnderPath } from './workspaceSlice'

// WS-4 store extensions (workspaceSlice.ts): repoDefaults memory, archive, the ephemeral missing
// set, starter boards, and the kept-terminal cwd sweep on a worktree delete.

const get = () => useCanvasStore.getState()

function seed(boards: Board[]): void {
  useCanvasStore.setState({
    boards,
    connectors: [],
    groups: [],
    past: [],
    future: [],
    workspaces: [],
    repoDefaults: {},
    workspaceMissing: {},
    selectedId: null,
    selectedIds: []
  })
}

const WT = 'C:\\work\\my project\\.canvas\\worktrees\\ws-api'

beforeEach(() => seed([]))

describe('repoDefaults (O-10)', () => {
  it('remembers a base per canonical repo key, settings-class (no undo step)', () => {
    get().setRepoDefault('./api/', 'release')
    expect(get().repoDefaults).toEqual({ api: { base: 'release' } })
    expect(get().past).toEqual([])
  })
  it('ignores a key outside the project and an invalid ref', () => {
    get().setRepoDefault('../x', 'main')
    get().setRepoDefault('api', '')
    expect(get().repoDefaults).toEqual({})
  })
})

describe('archive', () => {
  it('archives and re-opens a workspace record (not undoable)', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().setWorkspaceArchived(id, true)
    expect(get().workspaces[0].state).toBe('archived')
    get().setWorkspaceArchived(id, false)
    expect('state' in get().workspaces[0]).toBe(false)
    expect(get().past).toEqual([])
  })
})

describe('workspaceMissing is ephemeral', () => {
  it('is set by the reconcile and reset by a load', () => {
    get().setWorkspaceMissing(['a', 'b'])
    expect(get().workspaceMissing).toEqual({ a: true, b: true })
  })
})

describe('addWorkspaceStarters', () => {
  it('places terminal + browser together, inside the workspace, wired, in ONE undo step', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    const out = get().addWorkspaceStarters({
      workspaceId: id,
      at: { x: 0, y: 0 },
      terminal: { cwd: WT, launchCommand: 'claude', agentKind: 'claude' },
      browser: true
    })
    const t = get().boards.find((b) => b.id === out.terminalId) as TerminalBoard
    const br = get().boards.find((b) => b.id === out.browserId)!
    expect(t).toMatchObject({
      type: 'terminal',
      workspaceId: id,
      cwd: WT,
      launchCommand: 'claude',
      agentKind: 'claude'
    })
    expect(br).toMatchObject({ type: 'browser', workspaceId: id, previewSourceId: t.id })
    expect(br.y).toBe(t.y)
    expect(br.x).toBeGreaterThan(t.x)
    expect(get().past).toHaveLength(1)
    get().undo()
    expect(get().boards).toEqual([])
  })
  it('no-ops for an unknown workspace or an empty spec', () => {
    expect(
      get().addWorkspaceStarters({ workspaceId: 'nope', at: { x: 0, y: 0 }, browser: true })
    ).toEqual({})
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    expect(get().addWorkspaceStarters({ workspaceId: id, at: { x: 0, y: 0 } })).toEqual({})
    expect(get().boards).toEqual([])
  })
})

describe('delete with a removed worktree (O-8 + no dead cwd)', () => {
  it('kept boards become project-level and a terminal inside the worktree loses its cwd on every rail', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    const inside: Board = {
      ...createBoard('terminal', { id: 't1', x: 0, y: 0 }),
      workspaceId: id,
      cwd: `${WT}\\src`
    } as Board
    const outside: Board = {
      ...createBoard('terminal', { id: 't2', x: 600, y: 0 }),
      cwd: 'C:\\work\\my project'
    } as Board
    seed([inside, outside])
    useCanvasStore.setState({
      workspaces: [{ id, name: 'API', goal: '', color: 'blue', root: 'api' }]
    })
    useCanvasStore.setState({ past: [{ ...get(), boards: [inside, outside] } as never] })
    get().deleteWorkspace(id, { cwdUnder: WT.replace(/\\/g, '/') })
    const t1 = get().boards.find((b) => b.id === 't1') as TerminalBoard
    expect(t1.workspaceId).toBeUndefined()
    expect('cwd' in t1).toBe(false)
    expect((get().boards.find((b) => b.id === 't2') as TerminalBoard).cwd).toBe(
      'C:\\work\\my project'
    )
    const railT1 = (get().past[0] as unknown as { boards: Board[] }).boards.find(
      (b) => b.id === 't1'
    ) as TerminalBoard
    expect('cwd' in railT1).toBe(false)
  })
})

describe('path helpers', () => {
  it('isUnderPath ignores separators/case and refuses a prefix-only sibling', () => {
    expect(isUnderPath('C:/a/b', 'c:\\A\\B\\c')).toBe(true)
    expect(isUnderPath('C:/a/b', 'C:/a/b')).toBe(true)
    expect(isUnderPath('C:/a/b', 'C:/a/bc')).toBe(false)
    expect(isUnderPath('', 'C:/a')).toBe(false)
  })
  it('clearCwdsUnder returns the SAME array when nothing matched', () => {
    const boards = [createBoard('terminal', { id: 'x', x: 0, y: 0 })]
    expect(clearCwdsUnder(boards, WT)).toBe(boards)
  })
})
