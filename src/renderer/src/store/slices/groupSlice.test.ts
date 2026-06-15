// @vitest-environment jsdom
/**
 * Unit tests for `createGroupSlice` — tests the REAL export directly (not a
 * replica, not via the full store). The `group CRUD`, `groups — undo snapshot`,
 * and `removeBoard sweeps groups` describe blocks in canvasStore.test.ts are the
 * behaviour-preservation gate; these tests lock the slice's direct API contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasState } from '../canvasStore'
import type { Board, NamedGroup } from '../../lib/boardSchema'
import type { TrackedChange } from './sliceTypes'
import { createGroupSlice, pruneBoardFromGroups } from './groupSlice'

// ---------------------------------------------------------------------------
// Minimal harness
// ---------------------------------------------------------------------------

/** Build a minimal CanvasState with the fields the slice reads. */
function makeState(boards: Board[] = [], groups: NamedGroup[] = []): CanvasState {
  return {
    boards,
    connectors: [],
    groups,
    selectedId: null,
    selectedIds: [],
    tool: 'select',
    past: [],
    future: [],
    viewport: null,
    background: null,
    configPendingId: null,
    project: { dir: null, name: null, status: 'welcome' },
    // Action stubs — the slice never calls them; they just satisfy the type.
    setBackground: vi.fn() as never,
    addBoard: vi.fn() as never,
    clearConfigPending: vi.fn() as never,
    removeBoard: vi.fn() as never,
    duplicateBoard: vi.fn() as never,
    addConnector: vi.fn() as never,
    removeConnector: vi.fn() as never,
    addGroup: vi.fn() as never,
    removeGroup: vi.fn() as never,
    renameGroup: vi.fn() as never,
    addBoardsToGroup: vi.fn() as never,
    addBoardsToGroupReflowed: vi.fn() as never,
    removeBoardFromGroup: vi.fn() as never,
    removeBoardFromAllGroups: vi.fn() as never,
    updateBoard: vi.fn() as never,
    resizeBoard: vi.fn() as never,
    tidyBoards: vi.fn() as never,
    tileBoards: vi.fn() as never,
    growBoardHeight: vi.fn() as never,
    setDiagramCache: vi.fn() as never,
    setViewport: vi.fn() as never,
    selectBoard: vi.fn() as never,
    setSelection: vi.fn() as never,
    setTool: vi.fn() as never,
    beginChange: vi.fn() as never,
    undo: vi.fn() as never,
    redo: vi.fn() as never,
    toObject: vi.fn() as never,
    loadObject: vi.fn() as never,
    setProjectLoading: vi.fn() as never,
    applyOpenResult: vi.fn() as never
  }
}

/** Minimal board shape (enough for position checks). */
function board(id: string, x = 0, y = 0): Board {
  return { id, type: 'terminal', x, y, w: 420, h: 340, title: '' } as Board
}

/** Build a NamedGroup. */
function group(id: string, name: string, boardIds: string[]): NamedGroup {
  return { id, name, boardIds }
}

// ---------------------------------------------------------------------------
// Harness state + fake set/get
// ---------------------------------------------------------------------------

let state: CanvasState
let trackedChangeSpy: ReturnType<typeof vi.fn>
let idCounter: number

/** Fake `set`: calls the updater-fn form with `state` and shallow-merges the result. */
const fakeSet = (
  updater:
    | CanvasState
    | Partial<CanvasState>
    | ((s: CanvasState) => Partial<CanvasState> | CanvasState)
): void => {
  const result = typeof updater === 'function' ? updater(state) : updater
  Object.assign(state, result)
}

/** Fake `get`: returns the current mutable state. */
const fakeGet = (): CanvasState => state

/** Deterministic newId: 'g1', 'g2', … */
const fakeNewId = (): string => `g${++idCounter}`

beforeEach(() => {
  idCounter = 0
  trackedChangeSpy = vi.fn((s: CanvasState, next, _opts) => ({
    ...s,
    ...(next ?? {})
  })) as unknown as ReturnType<typeof vi.fn>
  state = makeState()
})

function makeSlice() {
  return createGroupSlice(fakeSet as never, fakeGet, {
    trackedChange: trackedChangeSpy as unknown as TrackedChange,
    newId: fakeNewId
  })
}

// ---------------------------------------------------------------------------
// addGroup
// ---------------------------------------------------------------------------

describe('createGroupSlice — addGroup', () => {
  it('mints a new id, stores the group, and returns the id', () => {
    const slice = makeSlice()
    const id = slice.addGroup('Auth', ['b1', 'b2'])

    expect(id).toBe('g1')
    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups).toHaveLength(1)
    expect(next.groups[0]).toEqual({ id: 'g1', name: 'Auth', boardIds: ['b1', 'b2'] })
  })

  it('deduplicates boardIds via Set', () => {
    const slice = makeSlice()
    slice.addGroup('Auth', ['b1', 'b1', 'b2', 'b1'])

    const [, next] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      unknown
    ]
    expect(next.groups[0].boardIds).toEqual(['b1', 'b2'])
  })

  it('appends to existing groups (prev + new)', () => {
    state = makeState([], [group('g0', 'Existing', ['b0'])])
    const slice = makeSlice()
    slice.addGroup('New', ['b1'])

    const [, next] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      unknown
    ]
    expect(next.groups).toHaveLength(2)
    expect(next.groups[0].id).toBe('g0')
    expect(next.groups[1].id).toBe('g1')
  })

  it('passes reflectPresent:false', () => {
    const slice = makeSlice()
    slice.addGroup('X', [])

    const [, , opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      unknown,
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// removeGroup
// ---------------------------------------------------------------------------

describe('createGroupSlice — removeGroup', () => {
  it('unknown id: early return, trackedChange NOT called', () => {
    state = makeState([], [group('g0', 'Auth', ['b1'])])
    const slice = makeSlice()
    slice.removeGroup('nope')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('known id: filters the group and calls trackedChange with reflectPresent:false', () => {
    state = makeState([], [group('g0', 'Auth', ['b1']), group('g2', 'API', ['b2'])])
    const slice = makeSlice()
    slice.removeGroup('g0')

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups).toHaveLength(1)
    expect(next.groups[0].id).toBe('g2')
  })
})

// ---------------------------------------------------------------------------
// renameGroup
// ---------------------------------------------------------------------------

describe('createGroupSlice — renameGroup', () => {
  it('unknown id: early return, trackedChange NOT called', () => {
    const slice = makeSlice()
    slice.renameGroup('nope', 'NewName')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('same name: early return, trackedChange NOT called', () => {
    state = makeState([], [group('g0', 'Auth', [])])
    const slice = makeSlice()
    slice.renameGroup('g0', 'Auth')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('different name: updates name and calls trackedChange with reflectPresent:false', () => {
    state = makeState([], [group('g0', 'Auth', ['b1'])])
    const slice = makeSlice()
    slice.renameGroup('g0', 'API')

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups[0].name).toBe('API')
  })
})

// ---------------------------------------------------------------------------
// addBoardsToGroup
// ---------------------------------------------------------------------------

describe('createGroupSlice — addBoardsToGroup', () => {
  it('unknown group id: early return, trackedChange NOT called', () => {
    const slice = makeSlice()
    slice.addBoardsToGroup('nope', ['b1'])

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('all boards already members: early return, trackedChange NOT called', () => {
    state = makeState([], [group('g0', 'Auth', ['b1', 'b2'])])
    const slice = makeSlice()
    slice.addBoardsToGroup('g0', ['b1', 'b2'])

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('new members: merges (deduped) and calls trackedChange with reflectPresent:false', () => {
    state = makeState([], [group('g0', 'Auth', ['b1'])])
    const slice = makeSlice()
    slice.addBoardsToGroup('g0', ['b1', 'b2', 'b3'])

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups[0].boardIds).toEqual(['b1', 'b2', 'b3'])
  })
})

// ---------------------------------------------------------------------------
// addBoardsToGroupReflowed
// ---------------------------------------------------------------------------

describe('createGroupSlice — addBoardsToGroupReflowed', () => {
  it('unknown group id: early return, trackedChange NOT called', () => {
    const slice = makeSlice()
    slice.addBoardsToGroupReflowed('nope', ['b1'], [{ id: 'b1', x: 10, y: 20 }])

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('no-op when membership AND positions are both unchanged', () => {
    const bA = board('a', 10, 20)
    const bB = board('b', 50, 60)
    state = makeState([bA, bB], [group('g0', 'Auth', ['a', 'b'])])
    const slice = makeSlice()
    // Same membership, same positions → no-op
    slice.addBoardsToGroupReflowed(
      'g0',
      ['a'],
      [
        { id: 'a', x: 10, y: 20 },
        { id: 'b', x: 50, y: 60 }
      ]
    )

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('membership + move in ONE call: next has BOTH boards and groups changed', () => {
    const bA = board('a', 0, 0)
    const bB = board('b', 100, 100)
    state = makeState([bA, bB], [group('g0', 'Auth', ['a'])])
    const slice = makeSlice()
    slice.addBoardsToGroupReflowed(
      'g0',
      ['b'],
      [
        { id: 'a', x: 10, y: 20 },
        { id: 'b', x: 30, y: 40 }
      ]
    )

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { boards: Board[]; groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    // membership updated
    expect(next.groups[0].boardIds).toEqual(['a', 'b'])
    // board positions updated
    const a = next.boards.find((b) => b.id === 'a')
    const b2 = next.boards.find((b) => b.id === 'b')
    expect(a).toMatchObject({ x: 10, y: 20 })
    expect(b2).toMatchObject({ x: 30, y: 40 })
  })

  it('non-member placement is ignored (does not move unrelated boards)', () => {
    const bA = board('a', 0, 0)
    const bOther = board('other', 200, 200)
    state = makeState([bA, bOther], [group('g0', 'Auth', ['a'])])
    const slice = makeSlice()
    // 'other' is not a member; its placement must be filtered out
    slice.addBoardsToGroupReflowed(
      'g0',
      [],
      [
        { id: 'a', x: 5, y: 5 },
        { id: 'other', x: 999, y: 999 }
      ]
    )

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next] = trackedChangeSpy.mock.calls[0] as [CanvasState, { boards: Board[] }, unknown]
    const other = next.boards.find((b) => b.id === 'other')
    // 'other' must NOT have been moved
    expect(other).toMatchObject({ x: 200, y: 200 })
  })

  it('only position changed (no new members): still calls trackedChange once', () => {
    const bA = board('a', 0, 0)
    state = makeState([bA], [group('g0', 'Auth', ['a'])])
    const slice = makeSlice()
    slice.addBoardsToGroupReflowed('g0', [], [{ id: 'a', x: 50, y: 50 }])

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { boards: Board[]; groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.boards.find((b) => b.id === 'a')).toMatchObject({ x: 50, y: 50 })
    // groups ref must be s.groups (unchanged membership → same reference via ternary)
    expect(next.groups).toBe(state.groups)
  })
})

// ---------------------------------------------------------------------------
// removeBoardFromGroup
// ---------------------------------------------------------------------------

describe('createGroupSlice — removeBoardFromGroup', () => {
  it('unknown group id: early return, trackedChange NOT called', () => {
    const slice = makeSlice()
    slice.removeBoardFromGroup('nope', 'b1')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('board is not a member: early return, trackedChange NOT called', () => {
    state = makeState([], [group('g0', 'Auth', ['b1'])])
    const slice = makeSlice()
    slice.removeBoardFromGroup('g0', 'zzz')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('member board: filters it out and calls trackedChange with reflectPresent:false', () => {
    state = makeState([], [group('g0', 'Auth', ['b1', 'b2'])])
    const slice = makeSlice()
    slice.removeBoardFromGroup('g0', 'b1')

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups[0].boardIds).toEqual(['b2'])
  })
})

// ---------------------------------------------------------------------------
// removeBoardFromAllGroups
// ---------------------------------------------------------------------------

describe('createGroupSlice — removeBoardFromAllGroups', () => {
  it('board belongs to no group: early return, trackedChange NOT called', () => {
    state = makeState([], [group('g0', 'Auth', ['b1', 'b2'])])
    const slice = makeSlice()
    slice.removeBoardFromAllGroups('zzz')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('board in one group: removes it and calls trackedChange with reflectPresent:false', () => {
    state = makeState([], [group('g0', 'Auth', ['b1', 'b2'])])
    const slice = makeSlice()
    slice.removeBoardFromAllGroups('b1')

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups[0].boardIds).toEqual(['b2'])
  })

  it('board in multiple groups: stripped from ALL in ONE call (one trackedChange)', () => {
    state = makeState([], [group('g1', 'Auth', ['b1', 'b2']), group('g2', 'API', ['b1', 'b3'])])
    const slice = makeSlice()
    slice.removeBoardFromAllGroups('b1')

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.groups.find((g) => g.id === 'g1')?.boardIds).toEqual(['b2'])
    expect(next.groups.find((g) => g.id === 'g2')?.boardIds).toEqual(['b3'])
  })

  it('groups that did NOT contain the board keep their original ref (no unnecessary re-alloc)', () => {
    const unchanged = group('g2', 'API', ['b3'])
    state = makeState([], [group('g1', 'Auth', ['b1']), unchanged])
    const slice = makeSlice()
    slice.removeBoardFromAllGroups('b1')

    const [, next] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { groups: NamedGroup[] },
      unknown
    ]
    // The group that DID NOT contain b1 should be the exact same object (ref stable)
    expect(next.groups.find((g) => g.id === 'g2')).toBe(unchanged)
  })
})

// ---------------------------------------------------------------------------
// pruneBoardFromGroups (pure exported helper)
// ---------------------------------------------------------------------------

describe('pruneBoardFromGroups', () => {
  it('board in NO group → returns null (ref-stable signal)', () => {
    const groups = [group('g1', 'Auth', ['b1', 'b2']), group('g2', 'API', ['b3'])]
    const result = pruneBoardFromGroups(groups, 'zzz')
    expect(result).toBeNull()
  })

  it('board in ONE group → returns a new array with that board stripped; other groups untouched', () => {
    const g1 = group('g1', 'Auth', ['b1', 'b2'])
    const g2 = group('g2', 'API', ['b3'])
    const groups = [g1, g2]
    const result = pruneBoardFromGroups(groups, 'b1')
    expect(result).not.toBeNull()
    expect(result!.find((g) => g.id === 'g1')?.boardIds).toEqual(['b2'])
    // g2 was not affected — it must be the same object reference
    expect(result!.find((g) => g.id === 'g2')).toBe(g2)
  })

  it('board in MULTIPLE groups → stripped from every group in the returned array', () => {
    const groups = [group('g1', 'Auth', ['b1', 'b2']), group('g2', 'API', ['b1', 'b3'])]
    const result = pruneBoardFromGroups(groups, 'b1')
    expect(result).not.toBeNull()
    expect(result!.find((g) => g.id === 'g1')?.boardIds).toEqual(['b2'])
    expect(result!.find((g) => g.id === 'g2')?.boardIds).toEqual(['b3'])
  })

  it('returned array is a new reference (not the input) on change', () => {
    const groups = [group('g1', 'Auth', ['b1', 'b2'])]
    const result = pruneBoardFromGroups(groups, 'b1')
    expect(result).not.toBeNull()
    expect(result).not.toBe(groups)
  })

  it('input array is NOT mutated', () => {
    const g1 = group('g1', 'Auth', ['b1', 'b2'])
    const groups = [g1]
    pruneBoardFromGroups(groups, 'b1')
    // original group object and array must be unchanged
    expect(groups).toHaveLength(1)
    expect(groups[0].boardIds).toEqual(['b1', 'b2'])
  })
})
