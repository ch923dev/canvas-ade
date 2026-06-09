// @vitest-environment jsdom
/**
 * Unit tests for `createConnectorSlice` — tests the REAL export directly (not a
 * replica, not via the full store). The `canvasStore — connectors (M2)` describe in
 * canvasStore.test.ts is the behaviour-preservation gate; these tests lock the slice's
 * direct API contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CanvasState } from '../canvasStore'
import type { Board, Connector } from '../../lib/boardSchema'
import type { TrackedChange } from './sliceTypes'
import { createConnectorSlice } from './connectorSlice'

// ---------------------------------------------------------------------------
// Minimal harness
// ---------------------------------------------------------------------------

/** Build a minimal CanvasState with the fields the slice reads. */
function makeState(boards: Board[] = [], connectors: Connector[] = []): CanvasState {
  return {
    boards,
    connectors,
    groups: [],
    selectedId: null,
    selectedIds: [],
    tool: 'select',
    past: [],
    future: [],
    viewport: null,
    project: { dir: null, name: null, status: 'welcome' },
    // Action stubs — the slice never calls them; they just satisfy the type.
    addBoard: vi.fn() as never,
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

/** Minimal board shapes (enough for Set membership checks). */
function board(id: string): Board {
  return { id, type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: '' } as Board
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
  // Shallow-merge the returned partial (ignore `replace` overload — slice only uses updater-fn form).
  Object.assign(state, result)
}

/** Fake `get`: returns the current mutable state. */
const fakeGet = (): CanvasState => state

/** Deterministic newId: 'c1', 'c2', … */
const fakeNewId = (): string => `c${++idCounter}`

beforeEach(() => {
  idCounter = 0
  trackedChangeSpy = vi.fn((s: CanvasState, next, _opts) => ({
    ...s,
    ...(next ?? {})
  })) as unknown as ReturnType<typeof vi.fn>
  state = makeState()
})

function makeSlice() {
  return createConnectorSlice(fakeSet as never, fakeGet, {
    trackedChange: trackedChangeSpy as unknown as TrackedChange,
    newId: fakeNewId
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createConnectorSlice — addConnector', () => {
  it('rejects a self-link: returns null, trackedChange NOT called', () => {
    const bA = board('a')
    state = makeState([bA], [])
    const slice = makeSlice()

    const result = slice.addConnector('a', 'a', 'orchestration')

    expect(result).toBeNull()
    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('rejects a missing source: returns null, trackedChange NOT called', () => {
    const bB = board('b')
    state = makeState([bB], [])
    const slice = makeSlice()

    const result = slice.addConnector('ghost', 'b', 'orchestration')

    expect(result).toBeNull()
    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('rejects a missing target: returns null, trackedChange NOT called', () => {
    const bA = board('a')
    state = makeState([bA], [])
    const slice = makeSlice()

    const result = slice.addConnector('a', 'ghost', 'orchestration')

    expect(result).toBeNull()
    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('rejects an exact duplicate (same source+target+kind): returns null, trackedChange NOT called', () => {
    const bA = board('a')
    const bB = board('b')
    const existing: Connector = {
      id: 'existing',
      sourceId: 'a',
      targetId: 'b',
      kind: 'orchestration'
    }
    state = makeState([bA, bB], [existing])
    const slice = makeSlice()

    const result = slice.addConnector('a', 'b', 'orchestration')

    expect(result).toBeNull()
    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('success: returns the minted id and calls trackedChange exactly once with next.connectors = prev + new connector and reflectPresent:false', () => {
    const bA = board('a')
    const bB = board('b')
    state = makeState([bA, bB], [])
    const slice = makeSlice()

    const result = slice.addConnector('a', 'b', 'orchestration')

    expect(result).toBe('c1')
    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)

    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { connectors: Connector[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.connectors).toHaveLength(1)
    expect(next.connectors[0]).toEqual({
      id: 'c1',
      sourceId: 'a',
      targetId: 'b',
      kind: 'orchestration'
    })
  })

  it('success: does not include a selection key in opts (leaves selection untouched)', () => {
    const bA = board('a')
    const bB = board('b')
    state = makeState([bA, bB], [])
    const slice = makeSlice()

    slice.addConnector('a', 'b', 'orchestration')

    const [, , opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      unknown,
      { selection?: unknown }
    ]
    // Connector ops deliberately OMIT selection so the current selectedId is preserved.
    expect(opts.selection).toBeUndefined()
  })

  it('allows a different kind on the same source+target (not a duplicate)', () => {
    const bA = board('a')
    const bB = board('b')
    const existing: Connector = { id: 'e1', sourceId: 'a', targetId: 'b', kind: 'preview' }
    state = makeState([bA, bB], [existing])
    const slice = makeSlice()

    const result = slice.addConnector('a', 'b', 'orchestration')

    expect(result).toBe('c1')
    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { connectors: Connector[] },
      unknown
    ]
    // Both connectors in the next array.
    expect(next.connectors).toHaveLength(2)
  })
})

describe('createConnectorSlice — removeConnector', () => {
  it('unknown id: returns early without calling trackedChange', () => {
    const bA = board('a')
    state = makeState([bA], [])
    const slice = makeSlice()

    slice.removeConnector('nope')

    expect(trackedChangeSpy).not.toHaveBeenCalled()
  })

  it('known id: calls trackedChange with filtered connectors and reflectPresent:false', () => {
    const bA = board('a')
    const bB = board('b')
    const existing: Connector = {
      id: 'del-me',
      sourceId: 'a',
      targetId: 'b',
      kind: 'orchestration'
    }
    state = makeState([bA, bB], [existing])
    const slice = makeSlice()

    slice.removeConnector('del-me')

    expect(trackedChangeSpy).toHaveBeenCalledTimes(1)
    const [, next, opts] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { connectors: Connector[] },
      { reflectPresent: boolean }
    ]
    expect(opts.reflectPresent).toBe(false)
    expect(next.connectors).toHaveLength(0)
  })

  it('keeps unrelated connectors when removing one', () => {
    const bA = board('a')
    const bB = board('b')
    const bC = board('c')
    const keep: Connector = { id: 'keep', sourceId: 'a', targetId: 'c', kind: 'orchestration' }
    const remove: Connector = { id: 'remove', sourceId: 'a', targetId: 'b', kind: 'orchestration' }
    state = makeState([bA, bB, bC], [keep, remove])
    const slice = makeSlice()

    slice.removeConnector('remove')

    const [, next] = trackedChangeSpy.mock.calls[0] as [
      CanvasState,
      { connectors: Connector[] },
      unknown
    ]
    expect(next.connectors).toHaveLength(1)
    expect(next.connectors[0].id).toBe('keep')
  })
})
