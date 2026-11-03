import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../canvasStore'
import { createBoard, fromObject, type Board } from '../../lib/boardSchema'
import { clearWorkspaceRefs } from './workspaceSlice'

// v24 Project Workspaces — the store contract (workspaceSlice.ts): workspace RECORDS are
// settings-class (never on the undo rail); board MEMBERSHIP is an undoable board patch.

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
    selectedId: null,
    selectedIds: []
  })
}

const t1 = (): Board => createBoard('terminal', { id: 't1', x: 0, y: 0 })
const t2 = (): Board => createBoard('terminal', { id: 't2', x: 500, y: 0 })

beforeEach(() => seed([t1(), t2()]))

describe('workspace records are settings-class (not undoable)', () => {
  it('create adds the record, records NO undo step, and a following undo leaves it alone', () => {
    const id = get().createWorkspace({ name: 'API', goal: 'build auth', root: 'api' })
    expect(id).not.toBeNull()
    expect(get().workspaces).toEqual([
      { id, name: 'API', goal: 'build auth', color: 'blue', root: 'api' }
    ])
    expect(get().past).toEqual([])
    get().undo()
    expect(get().workspaces).toHaveLength(1)
  })

  it('create normalizes its input and hands out the next unused colour', () => {
    get().createWorkspace({ name: 'API', root: 'api' })
    const id = get().createWorkspace({ name: '  Up\nloader ', goal: 'a\nb', root: './uploader/' })
    expect(get().workspaces.find((w) => w.id === id)).toMatchObject({
      name: 'Up loader',
      goal: 'a b',
      color: 'green',
      root: 'uploader'
    })
  })

  it('create refuses a blank name, a taken name (case-insensitive), an escaping root, a taken id', () => {
    const id = get().createWorkspace({ id: 'ws-1', name: 'API', root: 'api' })
    expect(id).toBe('ws-1')
    expect(get().createWorkspace({ name: '   ', root: 'x' })).toBeNull()
    expect(get().createWorkspace({ name: 'api', root: 'x' })).toBeNull()
    expect(get().createWorkspace({ name: 'Web', root: '../web' })).toBeNull()
    expect(get().createWorkspace({ name: 'Web', root: 'C:/web' })).toBeNull()
    expect(get().createWorkspace({ id: 'ws-1', name: 'Web', root: 'web' })).toBeNull()
    const wt = {
      repoRoot: 'web',
      worktree: '.canvas/worktrees/w',
      branch: 'ws/w',
      baseRef: 'main',
      base: 'abc'
    }
    expect(get().createWorkspace({ name: 'Web', root: 'web', worktrees: [wt, wt] })).toBeNull()
    expect(get().workspaces).toHaveLength(1)
  })

  it('rename + edit goal change the record without an undo step', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().createWorkspace({ name: 'Uploader', root: 'uploader' })
    expect(get().renameWorkspace(id, 'Auth API')).toBe(true)
    expect(get().renameWorkspace(id, 'uploader')).toBe(false) // taken
    expect(get().renameWorkspace(id, '')).toBe(false)
    expect(get().renameWorkspace('nope', 'X')).toBe(false)
    get().setWorkspaceGoal(id, 'ship\n login')
    expect(get().workspaces[0]).toMatchObject({ name: 'Auth API', goal: 'ship login' })
    expect(get().past).toEqual([])
  })
})

describe('board membership is undoable', () => {
  it('assign is ONE undo step; undo unassigns, redo reassigns', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().assignBoardsToWorkspace(['t1', 't2'], id)
    expect(get().boards.map((b) => b.workspaceId)).toEqual([id, id])
    expect(get().past).toHaveLength(1)
    get().undo()
    expect(get().boards.map((b) => b.workspaceId)).toEqual([undefined, undefined])
    expect(get().workspaces).toHaveLength(1) // the record is untouched by undo
    get().redo()
    expect(get().boards.map((b) => b.workspaceId)).toEqual([id, id])
  })

  it('unassign (null) removes the key; a no-op or an unknown workspace records nothing', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().assignBoardsToWorkspace(['t1'], id)
    get().assignBoardsToWorkspace(['t1'], id) // already there
    get().assignBoardsToWorkspace(['t2'], 'ws-nope')
    expect(get().past).toHaveLength(1)
    get().assignBoardsToWorkspace(['t1'], null)
    expect('workspaceId' in get().boards[0]).toBe(false)
    expect(get().past).toHaveLength(2)
  })

  it('updateBoard accepts workspaceId (it is a patchable key on every board type)', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().beginChange()
    get().updateBoard('t2', { workspaceId: id })
    expect(get().boards[1].workspaceId).toBe(id)
    expect(get().past).toHaveLength(1)
  })

  it('a swarm board brings its docked workers; a docked worker alone does not move', () => {
    const swarm = createBoard('swarm', { id: 's1', x: 0, y: 900 })
    const worker = { ...createBoard('terminal', { id: 'w1', x: 0, y: 0 }), dockedIn: 's1' } as Board
    seed([t1(), swarm, worker])
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().assignBoardsToWorkspace(['w1'], id)
    expect(get().boards.every((b) => b.workspaceId === undefined)).toBe(true)
    get().assignBoardsToWorkspace(['s1'], id)
    expect(Object.fromEntries(get().boards.map((b) => [b.id, b.workspaceId]))).toEqual({
      t1: undefined,
      s1: id,
      w1: id
    })
  })
})

describe('delete leaves the boards as project-level boards (O-8) on every rail', () => {
  it('delete is not undoable, and no undo/redo resurrects a dangling workspaceId', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().assignBoardsToWorkspace(['t1'], id) // past[0]: pre-assign
    get().assignBoardsToWorkspace(['t2'], id) // past[1]: t1 assigned
    get().undo() // future[0]: both assigned
    const pastLen = get().past.length
    get().deleteWorkspace(id)
    expect(get().workspaces).toEqual([])
    expect(get().boards.every((b) => !('workspaceId' in b))).toBe(true)
    expect(get().past).toHaveLength(pastLen) // no step of its own
    const allRails = [...get().past, ...get().future].flatMap((snap) => snap.boards)
    expect(allRails.some((b) => b.workspaceId === id)).toBe(false)
    get().redo()
    get().undo()
    get().undo()
    expect(get().boards.some((b) => b.workspaceId === id)).toBe(false)
  })

  it('an armed gesture checkpoint is rewritten too (a later edit cannot record the dead id)', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().assignBoardsToWorkspace(['t1'], id)
    get().beginChange() // armed BEFORE the delete
    get().deleteWorkspace(id)
    get().updateBoard('t2', { x: 42 }) // consumes the armed checkpoint onto `past`
    get().undo()
    expect(get().boards.find((b) => b.id === 't1')?.workspaceId).toBeUndefined()
  })

  it('deleting an unknown workspace changes nothing', () => {
    const before = get().boards
    get().deleteWorkspace('nope')
    expect(get().boards).toBe(before)
  })

  it('clearWorkspaceRefs returns the SAME array when nothing referred (no-change convention)', () => {
    const boards = [t1()]
    expect(clearWorkspaceRefs(boards, 'x')).toBe(boards)
  })
})

describe('persistence through the store', () => {
  it('toObject carries workspaces + repoDefaults; loadObject restores them with clean history', () => {
    const id = get().createWorkspace({ name: 'API', root: 'api' })!
    get().assignBoardsToWorkspace(['t1'], id)
    useCanvasStore.setState({ repoDefaults: { api: { base: 'release' } } })
    const doc = JSON.parse(JSON.stringify(get().toObject()))
    expect(doc.workspaces).toHaveLength(1)
    expect(doc.repoDefaults).toEqual({ api: { base: 'release' } })
    seed([])
    get().loadObject(doc)
    expect(get().workspaces).toEqual(fromObject(doc).workspaces)
    expect(get().repoDefaults).toEqual({ api: { base: 'release' } })
    expect(get().boards[0].workspaceId).toBe(id)
    expect(get().past).toEqual([])
  })

  it('loading a pre-v24 doc yields no workspaces and an empty repoDefaults', () => {
    get().createWorkspace({ name: 'API', root: 'api' })
    get().loadObject({
      schemaVersion: 23,
      minReaderVersion: 23,
      viewport: null,
      connectors: [],
      boards: []
    })
    expect(get().workspaces).toEqual([])
    expect(get().repoDefaults).toEqual({})
  })
})
