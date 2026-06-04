import { describe, it, expect } from 'vitest'
import { createBoard, type Board } from '../lib/boardSchema'
import { buildBoardNodes, type NodeFlags, type NodeCache } from './boardNodes'

const NO_FLAGS: NodeFlags = {
  selectedId: null,
  focusedId: null,
  fullViewId: null,
  cameraFullViewId: null
}

const board = (id: string, x = 0, y = 0): Board => createBoard('planning', { id, x, y })

describe('buildBoardNodes', () => {
  it('maps each board to a controlled React Flow node', () => {
    const boards = [board('a', 10, 20)]
    const nodes = buildBoardNodes(boards, NO_FLAGS, new Map())
    expect(nodes[0]).toMatchObject({
      id: 'a',
      type: 'board',
      position: { x: 10, y: 20 },
      dragHandle: '.board-titlebar',
      data: { board: boards[0], dimmed: false, fullView: false },
      selected: false
    })
  })

  it('reuses the SAME node + data object when a board and its flags are unchanged', () => {
    const boards = [board('a'), board('b')]
    const cache: NodeCache = new Map()
    const first = buildBoardNodes(boards, NO_FLAGS, cache)
    const second = buildBoardNodes(boards, NO_FLAGS, cache)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[0].data).toBe(first[0].data)
  })

  it('rebuilds only the board that changed, keeping others stable', () => {
    const a = board('a', 0, 0)
    const b = board('b', 200, 0)
    const cache: NodeCache = new Map()
    const first = buildBoardNodes([a, b], NO_FLAGS, cache)
    // Only `a` moves → new board ref for a, same ref for b.
    const aMoved = { ...a, x: 50 }
    const second = buildBoardNodes([aMoved, b], NO_FLAGS, cache)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].position).toEqual({ x: 50, y: 0 })
    expect(second[1]).toBe(first[1])
  })

  it('rebuilds only the nodes whose selection flips', () => {
    const a = board('a')
    const b = board('b')
    const cache: NodeCache = new Map()
    const first = buildBoardNodes([a, b], NO_FLAGS, cache)
    const second = buildBoardNodes([a, b], { ...NO_FLAGS, selectedId: 'a' }, cache)
    expect(second[0]).not.toBe(first[0])
    expect(second[0].selected).toBe(true)
    expect(second[1]).toBe(first[1])
  })

  it('dims every board except the focused one', () => {
    const nodes = buildBoardNodes(
      [board('a'), board('b')],
      { ...NO_FLAGS, focusedId: 'a' },
      new Map()
    )
    expect(nodes[0].data.dimmed).toBe(false)
    expect(nodes[1].data.dimmed).toBe(true)
  })

  it('marks the full-view board (camera or portal) and dims the rest', () => {
    const nodes = buildBoardNodes(
      [board('a'), board('b')],
      { ...NO_FLAGS, cameraFullViewId: 'b' },
      new Map()
    )
    expect(nodes[1].data.fullView).toBe(true)
    expect(nodes[0].data.fullView).toBe(false)
    expect(nodes[0].data.dimmed).toBe(true)
  })

  it('prunes cache entries for boards no longer present', () => {
    const a = board('a')
    const b = board('b')
    const cache: NodeCache = new Map()
    buildBoardNodes([a, b], NO_FLAGS, cache)
    expect(cache.size).toBe(2)
    buildBoardNodes([a], NO_FLAGS, cache)
    expect(cache.size).toBe(1)
    expect(cache.has('b')).toBe(false)
  })
})
