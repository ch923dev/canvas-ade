import { describe, it, expect, beforeEach } from 'vitest'
import { applyPlacements } from './layoutSlice'
import { useCanvasStore } from '../canvasStore'
import { createBoard, type Board, type BoardType } from '../../lib/boardSchema'
import { MIN_BOARD_SIZE } from '../../lib/boardDefaults'

const board = (type: BoardType, id: string, x = 0, y = 0, extra: Partial<Board> = {}): Board =>
  ({ ...createBoard(type, { id, x, y }), ...extra }) as Board

describe('applyPlacements (pure) — the tidy engine lands one arrangement', () => {
  const boards = [
    board('terminal', 'a', 0, 0),
    board('planning', 'p', 10, 10),
    board('terminal', 'dock', 0, 0, { dockedIn: 'swarm-1' })
  ]

  it('x/y always; w/h only where a placement carries them; counts what changed', () => {
    const { boards: next, moved } = applyPlacements(boards, [
      { id: 'a', x: 100, y: 50, w: 900, h: 600 },
      { id: 'p', x: 10, y: 10 } // unchanged
    ])
    expect(moved).toBe(1)
    expect(next!.find((b) => b.id === 'a')).toMatchObject({ x: 100, y: 50, w: 900, h: 600 })
    expect(next!.find((b) => b.id === 'p')).toBe(boards[1]) // identity kept
  })

  it('docked workers and unknown ids are never touched; non-finite x/y skip the placement', () => {
    const { boards: next, moved } = applyPlacements(boards, [
      { id: 'dock', x: 500, y: 500 },
      { id: 'ghost', x: 1, y: 1 },
      { id: 'a', x: Number.NaN, y: 0 }
    ])
    expect(moved).toBe(0)
    expect(next).toBeNull() // nothing changed ⇒ no undo step
  })

  it('a non-finite / non-positive size keeps the board’s own; a tiny one clamps to the minimum', () => {
    const a = boards[0]
    const keep = applyPlacements(boards, [{ id: 'a', x: 5, y: 5, w: Number.NaN, h: -1 }])
    expect(keep.boards!.find((b) => b.id === 'a')).toMatchObject({ w: a.w, h: a.h })
    const tiny = applyPlacements(boards, [{ id: 'a', x: 5, y: 5, w: 1, h: 1 }])
    expect(tiny.boards!.find((b) => b.id === 'a')).toMatchObject(MIN_BOARD_SIZE)
  })
})

describe('applyLayout (store) — ONE undo step per tidy', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [board('terminal', 'a'), board('terminal', 'b', 2000, 0)],
      connectors: [],
      groups: [],
      past: [],
      future: []
    })
  })

  it('moves land as one step; undo restores every board at once', () => {
    const moved = useCanvasStore.getState().applyLayout([
      { id: 'a', x: 300, y: 0 },
      { id: 'b', x: 900, y: 0 }
    ])
    expect(moved).toBe(2)
    expect(useCanvasStore.getState().past).toHaveLength(1)
    useCanvasStore.getState().undo()
    const xs = useCanvasStore.getState().boards.map((b) => b.x)
    expect(xs).toEqual([0, 2000])
  })

  it('an already-tidy layout records no step', () => {
    expect(useCanvasStore.getState().applyLayout([{ id: 'a', x: 0, y: 0 }])).toBe(0)
    expect(useCanvasStore.getState().past).toHaveLength(0)
  })
})
