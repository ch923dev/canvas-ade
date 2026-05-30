import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { SCHEMA_VERSION, toObject, createBoard } from '../lib/boardSchema'

const get = () => useCanvasStore.getState()

beforeEach(() => {
  // Reset the singleton's data between tests; merge keeps the action functions.
  // past/future are cleared too so history state doesn't bleed between tests.
  useCanvasStore.setState({ boards: [], selectedId: null, tool: 'select', past: [], future: [] })
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

  it('cascades a board added at an already-occupied position so they do not fully stack', () => {
    get().addBoard('terminal', { x: 100, y: 100 })
    get().addBoard('terminal', { x: 100, y: 100 })
    const [a, b] = get().boards
    // The second board must not land at the exact same top-left as the first.
    expect(b.x === a.x && b.y === a.y).toBe(false)
  })

  it('does not cascade a board added at a clear position', () => {
    get().addBoard('terminal', { x: 100, y: 100 })
    get().addBoard('terminal', { x: 900, y: 900 })
    expect(get().boards[1]).toMatchObject({ x: 900, y: 900 })
  })

  it('cascades repeated co-located adds to distinct positions', () => {
    get().addBoard('terminal', { x: 0, y: 0 })
    get().addBoard('terminal', { x: 0, y: 0 })
    get().addBoard('terminal', { x: 0, y: 0 })
    const positions = get().boards.map((b) => `${b.x},${b.y}`)
    expect(new Set(positions).size).toBe(3)
  })

  it('places a co-located add in free space so it never overlaps an existing board', () => {
    get().addBoard('browser', { x: 0, y: 0 })
    get().addBoard('browser', { x: 0, y: 0 }) // dropped on the same spot
    const [a, b] = get().boards
    const overlap =
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    expect(overlap).toBe(false)
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
    get().addBoard('terminal', { x: 900, y: 900 })
    get().updateBoard(a, { x: 500 })
    expect(get().boards[1].x).toBe(900)
  })

  it('ignores id/type in the patch — a patch can never re-identify or re-type a board', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    // A stray id/type in the patch must not create a cross-type hybrid or steal the id.
    get().updateBoard(id, {
      id: 'spoofed',
      type: 'browser',
      url: 'http://evil',
      title: 'x'
    } as never)
    const b = get().boards[0]
    expect(b.id).toBe(id)
    expect(b.type).toBe('terminal')
    // The off-type `url` field must not have leaked onto the terminal board.
    expect((b as unknown as Record<string, unknown>).url).toBeUndefined()
    // The legitimate part of the patch still applies.
    expect(b.title).toBe('x')
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

describe('undo/redo history', () => {
  it('undo reverts an add; redo re-applies it', () => {
    get().addBoard('terminal', { x: 0, y: 0 })
    expect(get().boards).toHaveLength(1)
    get().undo()
    expect(get().boards).toHaveLength(0)
    get().redo()
    expect(get().boards).toHaveLength(1)
  })

  it('beginChange snapshots so a subsequent move can be undone', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().updateBoard(id, { x: 200 })
    expect(get().boards[0].x).toBe(200)
    get().undo()
    expect(get().boards[0].x).toBe(0)
  })

  it('updateBoard after an undo discards the redo branch (no stale redo)', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().updateBoard(id, { x: 200 }) // checkpoint A → x=200, redo branch armed by undo below
    get().undo() // back to x=0, future = [x=200]
    expect(get().boards[0].x).toBe(0)
    // A fresh edit must invalidate the stale redo branch — redo must NOT clobber it.
    get().updateBoard(id, { x: 333 })
    expect(get().boards[0].x).toBe(333)
    get().redo() // future was cleared → no-op, the post-undo edit survives
    expect(get().boards[0].x).toBe(333)
  })

  it('resizeBoard after an undo discards the redo branch (no stale redo)', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().resizeBoard(id, 800, 600)
    get().undo() // back to default size, future armed
    get().resizeBoard(id, 500, 400)
    expect(get().boards[0]).toMatchObject({ w: 500, h: 400 })
    get().redo() // future cleared → no-op
    expect(get().boards[0]).toMatchObject({ w: 500, h: 400 })
  })

  it('updateBoard with no matching board leaves an armed redo branch intact', () => {
    get().addBoard('terminal', { x: 0, y: 0 })
    get().undo() // remove the board; future = [the add]
    get().updateBoard('does-not-exist', { x: 9 }) // no board changed → keep redo
    get().redo()
    expect(get().boards).toHaveLength(1)
  })

  it('a bare beginChange() after an undo does not wipe the armed redo branch (Bug #7)', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().updateBoard(id, { x: 200 }) // checkpoint → x=200
    get().undo() // back to x=0, future = [x=200] armed
    expect(get().boards[0].x).toBe(0)
    expect(get().future).toHaveLength(1)
    // A no-op gesture (zero-movement titlebar/resize click, degenerate arrow/pen tap)
    // fires beginChange at gesture-start but commits nothing — it must NOT discard the
    // armed redo branch.
    get().beginChange()
    expect(get().future).toHaveLength(1)
    // Redo still re-applies the undone move.
    get().redo()
    expect(get().boards[0].x).toBe(200)
  })

  // The Canvas-side focus-clear on undo/redo (#30 / #38) relies on undo/redo
  // nulling selectedId; lock that contract so a refactor can't silently break it.
  it('undo and redo clear the selection', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().updateBoard(id, { x: 200 })
    get().selectBoard(id)
    get().undo()
    expect(get().selectedId).toBeNull()
    get().selectBoard(id)
    get().redo()
    expect(get().selectedId).toBeNull()
  })
})
