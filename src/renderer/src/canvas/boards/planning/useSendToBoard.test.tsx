// @vitest-environment jsdom
/**
 * useSendToBoard — the cross-board transfer routing the picker drives (spec §3.A / §4.3). Runs
 * the hook against the REAL Zustand store (the Phase-1 `transferElements` engine + `addBoard`):
 * proves the centered+clamped placement, copy-leaves-source / move-removes-source, the single
 * coalesced undo step, the "+ New planning board" spawn, and the click-to-focus toast. The
 * `pick` callback is invoked off the returned panel's `onPick` prop (the same call the panel
 * fires), so the test exercises the production routing without portaling the popover.
 *
 * globals: false — import every vitest/testing-library helper explicitly.
 */
import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { useSendToBoard } from './useSendToBoard'
import { NEW_PLANNING_BOARD } from './SendToBoardPanel'
import { elementBBox } from './elementRegistry'
import { unionBBox } from './elements'
import { useCanvasStore } from '../../../store/canvasStore'
import { useToastStore } from '../../../store/toastStore'
import { DEFAULT_BOARD_SIZE } from '../../../lib/boardSchema'
import type { PlanningBoard as PlanningBoardData, PlanningElement } from '../../../lib/boardSchema'
import type { ReactElement } from 'react'

type Pick = (choice: { target: string; mode: 'copy' | 'move' }) => void

/** Two notes whose union bbox is {0,0,150,80} — known placement math. */
function notes(): PlanningElement[] {
  return [
    { id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 50, text: 'A', rotation: 0 } as PlanningElement,
    {
      id: 'b',
      kind: 'note',
      x: 50,
      y: 30,
      w: 100,
      h: 50,
      text: 'B',
      rotation: 0
    } as PlanningElement
  ]
}

function planning(id: string): PlanningBoardData {
  return useCanvasStore.getState().boards.find((b) => b.id === id) as PlanningBoardData
}

function elsOf(id: string): PlanningElement[] {
  return planning(id).elements
}

/** Render the hook for source board `srcId`, open it for `sel`, return its live `pick`. */
function openPick(srcId: string, sel: string[]): { pick: () => Pick } {
  const { result } = renderHook(() =>
    useSendToBoard({ board: planning(srcId), onFocusBoard: focus, menuAnchor: { x: 10, y: 10 } })
  )
  act(() => result.current.onOpenSendTo(new Set(sel)))
  return {
    pick: () => (result.current.sendToPanel as ReactElement<{ onPick: Pick }>).props.onPick
  }
}

let focus: Mock

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    past: [],
    future: [],
    selectedId: null,
    selectedIds: []
  })
  useToastStore.getState().clearToasts()
  focus = vi.fn()
})

describe('useSendToBoard — placement (§4.3)', () => {
  it('centers the payload in the target content box, top-left clamped ≥ 16', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const tgt = useCanvasStore.getState().addBoard('planning', { x: 900, y: 0 })
    useCanvasStore.getState().updateBoard(src, { elements: notes() })

    const p = openPick(src, ['a', 'b']).pick()
    act(() => p({ target: tgt, mode: 'copy' }))

    const moved = elsOf(tgt)
    expect(moved).toHaveLength(2)
    // Expected centered top-left from the SAME helpers the engine normalizes against.
    const union = unionBBox(notes().map((e) => elementBBox(e)))
    const { w, h } = planning(tgt)
    const at = { x: Math.max(16, w / 2 - union.w / 2), y: Math.max(16, h / 2 - union.h / 2) }
    expect(Math.min(...moved.map((e) => e.x))).toBe(at.x)
    expect(Math.min(...moved.map((e) => e.y))).toBe(at.y)
    // Relative layout preserved (B is +50,+30 from A).
    const a = moved.find((e) => e.x === at.x)!
    const b = moved.find((e) => e.x !== at.x)!
    expect({ dx: b.x - a.x, dy: b.y - a.y }).toEqual({ dx: 50, dy: 30 })
  })

  it('clamps a payload larger than the target to (16,16)', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const tgt = useCanvasStore.getState().addBoard('planning', { x: 900, y: 0 })
    // A 900-wide note dwarfs the 516-wide default board → both axes clamp.
    useCanvasStore.getState().updateBoard(src, {
      elements: [
        {
          id: 'big',
          kind: 'note',
          x: 0,
          y: 0,
          w: 900,
          h: 700,
          text: 'X',
          rotation: 0
        } as PlanningElement
      ]
    })

    const p = openPick(src, ['big']).pick()
    act(() => p({ target: tgt, mode: 'copy' }))

    const moved = elsOf(tgt)[0]
    expect({ x: moved.x, y: moved.y }).toEqual({ x: 16, y: 16 })
  })
})

describe('useSendToBoard — copy / move / undo', () => {
  it('Copy leaves the source intact and adds to the target', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const tgt = useCanvasStore.getState().addBoard('planning', { x: 900, y: 0 })
    useCanvasStore.getState().updateBoard(src, { elements: notes() })

    const p = openPick(src, ['a', 'b']).pick()
    act(() => p({ target: tgt, mode: 'copy' }))

    expect(elsOf(src)).toHaveLength(2)
    expect(elsOf(tgt)).toHaveLength(2)
  })

  it('Move removes from the source, and ONE undo restores both boards', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const tgt = useCanvasStore.getState().addBoard('planning', { x: 900, y: 0 })
    useCanvasStore.getState().updateBoard(src, { elements: notes() })

    const p = openPick(src, ['a', 'b']).pick()
    act(() => p({ target: tgt, mode: 'move' }))
    expect(elsOf(src)).toHaveLength(0)
    expect(elsOf(tgt)).toHaveLength(2)

    act(() => useCanvasStore.getState().undo())
    expect(elsOf(src)).toHaveLength(2)
    expect(elsOf(tgt)).toHaveLength(0)
  })
})

describe('useSendToBoard — "+ New planning board"', () => {
  it('spawns a fresh planning board holding the elements (source intact on copy)', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    useCanvasStore.getState().updateBoard(src, { elements: notes() })
    const before = useCanvasStore.getState().boards.length

    const p = openPick(src, ['a', 'b']).pick()
    act(() => p({ target: NEW_PLANNING_BOARD, mode: 'copy' }))

    const boards = useCanvasStore.getState().boards
    expect(boards).toHaveLength(before + 1)
    const fresh = boards.find((b) => b.id !== src && b.type === 'planning')!
    expect(fresh.type === 'planning' && fresh.elements).toHaveLength(2)
    expect(elsOf(src)).toHaveLength(2) // copy → source untouched
    // Centered in the NEW board's default content box.
    const union = unionBBox(notes().map((e) => elementBBox(e)))
    const d = DEFAULT_BOARD_SIZE.planning
    const atX = Math.max(16, d.w / 2 - union.w / 2)
    expect(Math.min(...(fresh as PlanningBoardData).elements.map((e) => e.x))).toBe(atX)
  })
})

describe('useSendToBoard — confirmation toast (Q3)', () => {
  it('raises a click-to-focus toast whose action runs focusBoardById on the target', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const tgt = useCanvasStore.getState().addBoard('planning', { x: 900, y: 0 })
    useCanvasStore.getState().updateBoard(src, { elements: notes() })

    const p = openPick(src, ['a', 'b']).pick()
    act(() => p({ target: tgt, mode: 'move' }))

    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('Moved 2 items to ' + planning(tgt).title)
    expect(toasts[0].action?.label).toBe('Focus')
    act(() => toasts[0].action?.run())
    expect(focus).toHaveBeenCalledWith(tgt)
  })

  it('a no-op transfer (all-locked move) raises no toast', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    const tgt = useCanvasStore.getState().addBoard('planning', { x: 900, y: 0 })
    useCanvasStore.getState().updateBoard(src, {
      elements: [
        {
          id: 'lk',
          kind: 'note',
          x: 0,
          y: 0,
          w: 100,
          h: 50,
          text: 'L',
          rotation: 0,
          locked: true
        } as PlanningElement
      ]
    })

    const p = openPick(src, ['lk']).pick()
    act(() => p({ target: tgt, mode: 'move' }))

    expect(elsOf(tgt)).toHaveLength(0)
    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
