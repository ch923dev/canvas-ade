// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { MIN_BOARD_SIZE } from '../../lib/boardSchema'
import { shouldFireBoardNavKey } from '../cameraShortcut'
import { cycleOrder, nextBoardId, useBoardKeyboardNav } from './useBoardKeyboardNav'

const get = (): ReturnType<typeof useCanvasStore.getState> => useCanvasStore.getState()

/** Seed a board at an exact position; clears the tracked add from history afterwards
 *  so undo-count asserts start from a clean rail. */
function seed(type: 'terminal' | 'browser' | 'planning', x: number, y: number): string {
  return get().addBoard(type, { x, y }, { exact: true })
}

function mockRf(over: Partial<ReactFlowInstance> = {}): ReactFlowInstance {
  return {
    fitView: vi.fn().mockResolvedValue(true),
    setCenter: vi.fn().mockResolvedValue(true),
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    // Identity world→screen mapping (zoom 1, no pan) — visibility math stays readable.
    flowToScreenPosition: vi.fn((p: { x: number; y: number }) => p),
    ...over
  } as unknown as ReactFlowInstance
}

/** A pane rect; default huge so every seeded board reads as fully visible. */
function pane(rect: Partial<DOMRect> = {}): React.RefObject<HTMLDivElement> {
  const r = { left: 0, top: 0, right: 100000, bottom: 100000, ...rect }
  return { current: { getBoundingClientRect: () => r } as unknown as HTMLDivElement }
}

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
    past: [],
    future: []
  })
})

describe('shouldFireBoardNavKey (whitelist guard)', () => {
  it('allows body / null / the RF pane surfaces', () => {
    expect(shouldFireBoardNavKey(null, false)).toBe(true)
    expect(shouldFireBoardNavKey(document.body, false)).toBe(true)
    const paneEl = document.createElement('div')
    paneEl.className = 'react-flow__pane'
    expect(shouldFireBoardNavKey(paneEl, false)).toBe(true)
  })

  it('blocks typing and ANY other focused element (traps, chrome, board content)', () => {
    expect(shouldFireBoardNavKey(document.body, true)).toBe(false)
    const button = document.createElement('button') // chrome / board action / menuitem
    expect(shouldFireBoardNavKey(button, false)).toBe(false)
    const well = document.createElement('div')
    well.className = 'pl-well' // planning well — D3-C owns arrows there
    expect(shouldFireBoardNavKey(well, false)).toBe(false)
  })
})

describe('cycleOrder / nextBoardId (pure)', () => {
  it('orders by y, then x, then id', () => {
    useCanvasStore.setState({ boards: [] })
    const a = seed('terminal', 100, 0)
    const b = seed('terminal', 0, 0)
    const c = seed('terminal', 0, 500)
    expect(cycleOrder(get().boards).map((x) => x.id)).toEqual([b, a, c])
  })

  it('enters at first (Tab) / last (Shift+Tab) with no selection; wraps both ways', () => {
    const a = seed('terminal', 0, 0)
    const b = seed('terminal', 500, 0)
    const boards = get().boards
    expect(nextBoardId(boards, null, 1)).toBe(a)
    expect(nextBoardId(boards, null, -1)).toBe(b)
    expect(nextBoardId(boards, b, 1)).toBe(a) // wrap forward
    expect(nextBoardId(boards, a, -1)).toBe(b) // wrap backward
    expect(nextBoardId([], null, 1)).toBeNull()
    // Stale selection id re-enters like the empty case.
    expect(nextBoardId(boards, 'gone', 1)).toBe(a)
  })
})

describe('useBoardKeyboardNav', () => {
  function setup(rf = mockRf(), paneRef = pane()) {
    const setFocusedId = vi.fn()
    const { result, unmount } = renderHook(() => useBoardKeyboardNav({ rf, paneRef, setFocusedId }))
    return { result, unmount, rf, setFocusedId }
  }

  it('cycleBoard selects the next board in reading order and returns true', () => {
    const a = seed('terminal', 0, 0)
    const b = seed('terminal', 500, 0)
    get().selectBoard(a)
    const { result } = setup()
    let acted = false
    act(() => {
      acted = result.current.cycleBoard(1)
    })
    expect(acted).toBe(true)
    expect(get().selectedId).toBe(b)
    expect(get().selectedIds).toEqual([b])
  })

  it('cycleBoard returns false on an empty canvas (key falls through natively)', () => {
    const { result } = setup()
    let acted = true
    act(() => {
      acted = result.current.cycleBoard(1)
    })
    expect(acted).toBe(false)
  })

  it('cycleBoard centers the camera only when the target is not fully visible', () => {
    const a = seed('terminal', 0, 0)
    seed('terminal', 5000, 0) // off the small pane below
    get().selectBoard(a)
    const rf = mockRf()
    const { result } = setup(rf, pane({ right: 800, bottom: 600 }))
    act(() => {
      result.current.cycleBoard(1)
    })
    expect(rf.setCenter).toHaveBeenCalledTimes(1)
    // Cycling back to the visible board must not move the camera.
    act(() => {
      result.current.cycleBoard(1)
    })
    expect(rf.setCenter).toHaveBeenCalledTimes(1)
  })

  it('an arrow burst coalesces into ONE undo step; keyup starts a fresh step', () => {
    const a = seed('terminal', 100, 100)
    get().selectBoard(a)
    useCanvasStore.setState({ past: [], future: [] })
    const { result } = setup()
    act(() => {
      result.current.moveSelectedBoards(1, 0)
      result.current.moveSelectedBoards(1, 0)
      result.current.moveSelectedBoards(0, 10)
    })
    const moved = get().boards.find((b) => b.id === a)!
    expect({ x: moved.x, y: moved.y }).toEqual({ x: 102, y: 110 })
    expect(get().past).toHaveLength(1)
    // ONE undo returns to the pre-burst position.
    act(() => {
      get().undo()
    })
    const back = get().boards.find((b) => b.id === a)!
    expect({ x: back.x, y: back.y }).toEqual({ x: 100, y: 100 })
    // Arrow keyup ends the burst → the next move is a NEW undo step. (undo/redo clear
    // the store selection by design, so re-select first — as a user would via Tab/click.)
    act(() => {
      get().redo()
      get().selectBoard(a)
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }))
      result.current.moveSelectedBoards(1, 0)
    })
    expect(get().past).toHaveLength(2)
  })

  it('a non-arrow keydown ends the burst (Ctrl+Z mid-hold gets a fresh checkpoint)', () => {
    const a = seed('terminal', 0, 0)
    get().selectBoard(a)
    useCanvasStore.setState({ past: [], future: [] })
    const { result } = setup()
    act(() => {
      result.current.moveSelectedBoards(1, 0)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }))
      result.current.moveSelectedBoards(1, 0)
    })
    expect(get().past).toHaveLength(2)
  })

  it('moveSelectedBoards moves every selected board; returns false on empty selection', () => {
    const a = seed('terminal', 0, 0)
    const b = seed('terminal', 500, 0)
    get().setSelection([a, b])
    const { result } = setup()
    act(() => {
      result.current.moveSelectedBoards(0, 10)
    })
    expect(get().boards.map((x) => x.y)).toEqual([10, 10])
    get().setSelection([])
    let acted = true
    act(() => {
      acted = result.current.moveSelectedBoards(1, 0)
    })
    expect(acted).toBe(false)
  })

  it('resizeSelectedBoards grows/shrinks with the store MIN clamp; clamped no-op pushes no undo step', () => {
    const a = seed('terminal', 0, 0)
    get().selectBoard(a)
    const before = get().boards[0]
    // Shrink far below the minimum → clamps at MIN.
    get().resizeBoard(a, MIN_BOARD_SIZE.w, MIN_BOARD_SIZE.h)
    useCanvasStore.setState({ past: [], future: [] })
    const { result } = setup()
    act(() => {
      result.current.resizeSelectedBoards(-10, -10)
    })
    const clamped = get().boards[0]
    expect({ w: clamped.w, h: clamped.h }).toEqual({ w: MIN_BOARD_SIZE.w, h: MIN_BOARD_SIZE.h })
    expect(get().past).toHaveLength(0) // pure no-op — lazy checkpoint never consumed
    act(() => {
      result.current.resizeSelectedBoards(10, 0)
    })
    expect(get().boards[0].w).toBe(MIN_BOARD_SIZE.w + 10)
    expect(get().past).toHaveLength(1)
    expect(before).toBeTruthy()
  })

  it('focusSelectedBoard runs the camera-fit path: raster capped at zoom 1, planning at Z_MAX', () => {
    const t = seed('terminal', 0, 0)
    get().selectBoard(t)
    const rf = mockRf()
    const { result, setFocusedId } = setup(rf)
    let acted = false
    act(() => {
      acted = result.current.focusSelectedBoard()
    })
    expect(acted).toBe(true)
    expect(setFocusedId).toHaveBeenCalledWith(t)
    expect(rf.fitView).toHaveBeenCalledWith(
      expect.objectContaining({ maxZoom: 1, nodes: [{ id: t }] })
    )
    const p = seed('planning', 600, 0)
    get().selectBoard(p)
    act(() => {
      result.current.focusSelectedBoard()
    })
    expect(rf.fitView).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxZoom: 2.5, nodes: [{ id: p }] })
    )
  })

  it('focusSelectedBoard returns false with nothing selected', () => {
    seed('terminal', 0, 0)
    get().selectBoard(null)
    const { result } = setup()
    let acted = true
    act(() => {
      acted = result.current.focusSelectedBoard()
    })
    expect(acted).toBe(false)
  })

  it('burst listeners unregister on unmount (no leak into later mounts)', () => {
    const a = seed('terminal', 0, 0)
    get().selectBoard(a)
    useCanvasStore.setState({ past: [], future: [] })
    const { result, unmount } = setup()
    act(() => {
      result.current.moveSelectedBoards(1, 0)
    })
    unmount()
    // Dispatch after unmount must not throw (listener removed).
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }))
    expect(get().past).toHaveLength(1)
  })
})
