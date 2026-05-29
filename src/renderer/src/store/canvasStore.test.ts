import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { SCHEMA_VERSION, toObject, createBoard } from '../lib/boardSchema'

const get = () => useCanvasStore.getState()

beforeEach(() => {
  // Reset the singleton's data between tests; merge keeps the action functions.
  useCanvasStore.setState({ boards: [], selectedId: null, tool: 'select' })
})

describe('initial state', () => {
  it('starts empty, unselected, on the select tool', () => {
    expect(get().boards).toEqual([])
    expect(get().selectedId).toBeNull()
    expect(get().tool).toBe('select')
  })
})

describe('addBoard', () => {
  it('appends a board of the type with its default size and returns the new id', () => {
    const id = get().addBoard('terminal', { x: 10, y: 20 })
    expect(get().boards).toHaveLength(1)
    const b = get().boards[0]
    expect(b).toMatchObject({ id, type: 'terminal', x: 10, y: 20, w: 420, h: 340 })
  })

  it('auto-selects the freshly added board', () => {
    const id = get().addBoard('planning', { x: 0, y: 0 })
    expect(get().selectedId).toBe(id)
  })

  it('seeds a browser board with a url + viewport', () => {
    get().addBoard('browser', { x: 0, y: 0 })
    expect(get().boards[0]).toMatchObject({ type: 'browser', viewport: 'desktop' })
    expect(typeof (get().boards[0] as { url: string }).url).toBe('string')
  })

  it('gives every board a distinct id', () => {
    const a = get().addBoard('terminal', { x: 0, y: 0 })
    const b = get().addBoard('terminal', { x: 0, y: 0 })
    expect(a).not.toBe(b)
  })
})

describe('removeBoard', () => {
  it('removes the board', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().removeBoard(id)
    expect(get().boards).toHaveLength(0)
  })

  it('clears the selection when the removed board was selected', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().removeBoard(id)
    expect(get().selectedId).toBeNull()
  })

  it('keeps the selection when a different board is removed', () => {
    const keep = get().addBoard('terminal', { x: 0, y: 0 })
    const drop = get().addBoard('browser', { x: 0, y: 0 })
    get().selectBoard(keep)
    get().removeBoard(drop)
    expect(get().selectedId).toBe(keep)
  })
})

describe('updateBoard', () => {
  it('shallow-merges the patch into the matching board', () => {
    const id = get().addBoard('browser', { x: 0, y: 0 })
    get().updateBoard(id, { title: 'Docs', url: 'http://localhost:3000' })
    expect(get().boards[0]).toMatchObject({ title: 'Docs', url: 'http://localhost:3000' })
  })

  it('leaves other boards untouched', () => {
    const a = get().addBoard('terminal', { x: 0, y: 0 })
    get().addBoard('terminal', { x: 0, y: 0 })
    get().updateBoard(a, { x: 500 })
    expect(get().boards[1].x).toBe(0)
  })
})

describe('resizeBoard', () => {
  it('clamps below the minimum board size', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().resizeBoard(id, 50, 30)
    expect(get().boards[0]).toMatchObject({ w: 240, h: 160 })
  })

  it('accepts sizes at or above the minimum', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().resizeBoard(id, 800, 600)
    expect(get().boards[0]).toMatchObject({ w: 800, h: 600 })
  })
})

describe('tool + selection', () => {
  it('sets the active tool', () => {
    get().setTool('browser')
    expect(get().tool).toBe('browser')
  })

  it('selects and clears', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().selectBoard(null)
    expect(get().selectedId).toBeNull()
    get().selectBoard(id)
    expect(get().selectedId).toBe(id)
  })
})

describe('serialization bridge', () => {
  it('toObject() reflects the current boards at the current version', () => {
    get().addBoard('terminal', { x: 0, y: 0 })
    const doc = get().toObject()
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.boards).toHaveLength(1)
  })

  it('loadObject() replaces boards and clears selection', () => {
    get().addBoard('terminal', { x: 0, y: 0 })
    get().selectBoard(get().boards[0].id)
    const incoming = toObject([createBoard('browser', { id: 'b1', x: 0, y: 0 })])
    get().loadObject(incoming)
    expect(get().boards).toHaveLength(1)
    expect(get().boards[0].id).toBe('b1')
    expect(get().selectedId).toBeNull()
  })
})
