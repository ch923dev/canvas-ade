import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore, isIdleOnMount, clearIdleOnMount } from './canvasStore'
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
    const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
    expect(overlap).toBe(false)
  })
})

describe('idle-on-mount registry (M-1: restored terminals stay idle)', () => {
  it('a freshly added terminal is NOT idle-on-mount → auto-spawns, and stays non-idle across reads', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    expect(isIdleOnMount(id)).toBe(false)
    // Non-consuming: a later remount / in-session respawn must still spawn (not flip idle).
    expect(isIdleOnMount(id)).toBe(false)
  })

  it('an id never seen this session is not idle-on-mount', () => {
    expect(isIdleOnMount('never-added')).toBe(false)
  })

  it('loadObject flags every restored terminal idle-on-mount', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    // Reload a document containing that same id → it is now a DISK-restored board.
    const doc = toObject([createBoard('terminal', { id, x: 0, y: 0 })], null)
    get().loadObject(doc)
    expect(isIdleOnMount(id)).toBe(true)
  })

  it('applyOpenResult flags every restored terminal idle-on-mount', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: toObject([createBoard('terminal', { id, x: 0, y: 0 })], null)
    })
    expect(isIdleOnMount(id)).toBe(true)
  })

  it('duplicateBoard flags the terminal clone idle-on-mount (no second agent spun up)', () => {
    const src = get().addBoard('terminal', { x: 0, y: 0 })
    const cloneId = get().duplicateBoard(src)!
    expect(isIdleOnMount(cloneId)).toBe(true)
  })

  it('clearIdleOnMount drops the flag so an explicit Start / later respawn spawns', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().loadObject(toObject([createBoard('terminal', { id, x: 0, y: 0 })], null))
    expect(isIdleOnMount(id)).toBe(true)
    clearIdleOnMount(id)
    expect(isIdleOnMount(id)).toBe(false)
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
    const incoming = toObject([createBoard('browser', { id: 'b1', x: 0, y: 0 })], null)
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
    const pastLen = get().past.length
    // A no-op gesture (zero-movement titlebar/resize click, degenerate arrow/pen tap)
    // fires beginChange at gesture-start but commits nothing — it must NOT discard the
    // armed redo branch, and (Bug M3) must NOT push a duplicate snapshot whose present
    // equals the post-undo boards.
    get().beginChange()
    expect(get().future).toHaveLength(1)
    // No phantom undo step recorded — the past stack must not have grown.
    expect(get().past.length).toBe(pastLen)
    // Redo still re-applies the undone move.
    get().redo()
    expect(get().boards[0].x).toBe(200)
  })

  it('a no-op beginChange after undo records no phantom step (Bug M3)', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 }) // checkpoint 1: boards = []
    get().beginChange() // snapshot [board@x=0]
    get().updateBoard(id, { x: 200 }) // boards = [board@x=200]
    get().undo() // back to [board@x=0]; past tail is now the pre-add []
    const pastLen = get().past.length
    // A no-op beginChange right after undo (boards unchanged) must not record a
    // duplicate snapshot — otherwise it would leave a phantom undo step.
    get().beginChange()
    expect(get().past.length).toBe(pastLen)
    // A single further undo must reach a GENUINELY different state (the empty canvas),
    // not a phantom identical [board@x=0] left by a duplicate snapshot.
    get().undo()
    expect(get().boards).toHaveLength(0)
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

describe('canvasStore — viewport', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], viewport: null, selectedId: null, past: [], future: [] })
  })

  it('setViewport stores the camera', () => {
    useCanvasStore.getState().setViewport({ x: 10, y: 20, zoom: 1.5 })
    expect(useCanvasStore.getState().viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
  })

  it('setViewport is untracked — does not push undo history', () => {
    const before = useCanvasStore.getState().past.length
    useCanvasStore.getState().setViewport({ x: 1, y: 2, zoom: 1 })
    expect(useCanvasStore.getState().past.length).toBe(before)
  })

  it('setViewport with equal values does not change state identity (Bug L2)', () => {
    useCanvasStore.getState().setViewport({ x: 10, y: 20, zoom: 1.5 })
    const after = useCanvasStore.getState()
    const vpRef = after.viewport
    let notified = 0
    const unsub = useCanvasStore.subscribe(() => {
      notified++
    })
    // A camera frame that reports the SAME x/y/zoom must be a no-op: no set(), no
    // subscriber notification, same viewport object reference.
    useCanvasStore.getState().setViewport({ x: 10, y: 20, zoom: 1.5 })
    expect(notified).toBe(0)
    expect(useCanvasStore.getState().viewport).toBe(vpRef)
    // A genuinely different value still updates and notifies.
    useCanvasStore.getState().setViewport({ x: 11, y: 20, zoom: 1.5 })
    expect(notified).toBe(1)
    expect(useCanvasStore.getState().viewport).toEqual({ x: 11, y: 20, zoom: 1.5 })
    unsub()
  })

  it('setViewport from null updates (Bug L2 guard handles no prior viewport)', () => {
    useCanvasStore.setState({ viewport: null })
    useCanvasStore.getState().setViewport({ x: 1, y: 2, zoom: 1 })
    expect(useCanvasStore.getState().viewport).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('toObject embeds the current viewport', () => {
    useCanvasStore.getState().setViewport({ x: 5, y: 6, zoom: 0.5 })
    expect(useCanvasStore.getState().toObject().viewport).toEqual({ x: 5, y: 6, zoom: 0.5 })
  })

  it('loadObject restores boards and viewport', () => {
    const doc = {
      schemaVersion: 2,
      viewport: { x: 7, y: 8, zoom: 2 },
      boards: [{ id: 'b1', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }]
    }
    useCanvasStore.getState().loadObject(doc)
    const s = useCanvasStore.getState()
    expect(s.boards).toHaveLength(1)
    expect(s.viewport).toEqual({ x: 7, y: 8, zoom: 2 })
  })
})

describe('canvasStore — duplicateBoard', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], viewport: null, selectedId: null, past: [], future: [] })
  })

  it('offsets +36, assigns a new id, selects the copy, one undo step', () => {
    const src = useCanvasStore.getState().addBoard('planning', { x: 100, y: 100 })
    const pastLen = useCanvasStore.getState().past.length
    const copyId = useCanvasStore.getState().duplicateBoard(src)
    const s = useCanvasStore.getState()
    expect(copyId).not.toBeNull()
    expect(copyId).not.toBe(src)
    const copy = s.boards.find((b) => b.id === copyId)!
    const orig = s.boards.find((b) => b.id === src)!
    expect(copy.x).toBe(orig.x + 36)
    expect(copy.y).toBe(orig.y + 36)
    expect(s.selectedId).toBe(copyId)
    expect(s.past.length).toBe(pastLen + 1)
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().boards.some((b) => b.id === copyId)).toBe(false)
  })

  it('browser copy advances to the next viewport preset', () => {
    const id = useCanvasStore.getState().addBoard('browser', { x: 0, y: 0 }) // default 'desktop'
    const copyId = useCanvasStore.getState().duplicateBoard(id)
    const copy = useCanvasStore.getState().boards.find((b) => b.id === copyId)!
    expect(copy.type === 'browser' && copy.viewport).toBe('mobile') // desktop → mobile
  })

  it('planning copy deep-clones elements with fresh ids', () => {
    const id = useCanvasStore.getState().addBoard('planning', { x: 0, y: 0 })
    useCanvasStore.getState().updateBoard(id, {
      elements: [{ id: 'e1', kind: 'text', x: 1, y: 1, text: 'hi' }]
    } as never)
    const copyId = useCanvasStore.getState().duplicateBoard(id)
    const s = useCanvasStore.getState()
    const orig = s.boards.find((b) => b.id === id)! as { elements: { id: string }[] }
    const copy = s.boards.find((b) => b.id === copyId)! as { elements: { id: string }[] }
    expect(copy.elements).toHaveLength(1)
    expect(copy.elements[0].id).not.toBe('e1')
    expect(copy.elements).not.toBe(orig.elements)
  })

  it('returns null for an unknown id and does not mutate', () => {
    const before = useCanvasStore.getState().boards
    expect(useCanvasStore.getState().duplicateBoard('nope')).toBeNull()
    expect(useCanvasStore.getState().boards).toBe(before)
  })
})

describe('canvasStore — project lifecycle', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [],
      viewport: null,
      selectedId: null,
      past: [],
      future: [],
      project: { dir: null, name: null, status: 'welcome' }
    })
  })

  it('defaults to welcome status', () => {
    expect(useCanvasStore.getState().project.status).toBe('welcome')
  })

  it('applyOpenResult(ok) loads the doc and marks open', () => {
    useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: { schemaVersion: 2, viewport: { x: 1, y: 2, zoom: 1 }, boards: [] }
    })
    const s = useCanvasStore.getState()
    expect(s.project).toEqual({ dir: 'C:/p', name: 'p', status: 'open' })
    expect(s.viewport).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('applyOpenResult(error) sets error status without clobbering boards', () => {
    useCanvasStore.setState({
      boards: [
        { id: 'x', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
      ] as never
    })
    useCanvasStore.getState().applyOpenResult({ ok: false, error: 'bad' })
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.project.error).toBe('bad')
    expect(s.boards).toHaveLength(1) // untouched
  })
})

describe('preview link cleanup', () => {
  it('keeps previewSourceId through updateBoard, and clears it when the source terminal is removed', () => {
    const { addBoard, updateBoard, removeBoard } = useCanvasStore.getState()
    // reset
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const termId = addBoard('terminal', { x: 0, y: 0 })
    const browserId = addBoard('browser', { x: 800, y: 0 })
    updateBoard(browserId, { previewSourceId: termId } as never)
    let b = useCanvasStore.getState().boards.find((x) => x.id === browserId)
    expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBe(termId)

    removeBoard(termId)
    b = useCanvasStore.getState().boards.find((x) => x.id === browserId)
    expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
  })

  it('keeps the preview link when a linked Browser board is duplicated', () => {
    const { addBoard, updateBoard, duplicateBoard } = useCanvasStore.getState()
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const termId = addBoard('terminal', { x: 0, y: 0 })
    const browserId = addBoard('browser', { x: 800, y: 0 })
    updateBoard(browserId, { previewSourceId: termId } as never)
    const cloneId = duplicateBoard(browserId)!
    const clone = useCanvasStore.getState().boards.find((x) => x.id === cloneId)
    // The copy stays linked to the SAME terminal (e.g. a Desktop + Mobile preview pair).
    expect(clone && clone.type === 'browser' ? clone.previewSourceId : 'X').toBe(termId)
  })

  it('clears the duplicated link too when the shared source terminal is removed', () => {
    const { addBoard, updateBoard, duplicateBoard, removeBoard } = useCanvasStore.getState()
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const termId = addBoard('terminal', { x: 0, y: 0 })
    const browserId = addBoard('browser', { x: 800, y: 0 })
    updateBoard(browserId, { previewSourceId: termId } as never)
    const cloneId = duplicateBoard(browserId)!
    removeBoard(termId)
    const get = (bid: string): string | undefined => {
      const b = useCanvasStore.getState().boards.find((x) => x.id === bid)
      return b && b.type === 'browser' ? b.previewSourceId : 'X'
    }
    expect(get(browserId)).toBeUndefined()
    expect(get(cloneId)).toBeUndefined()
  })
})

describe('tidyBoards', () => {
  const overlaps = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number }
  ): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  it('repacks overlapping boards into a non-overlapping block', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    // Three boards stacked on the SAME spot — freeSlot would normally cascade, but
    // force the overlap to prove tidy resolves it. updateBoard moves them onto each other.
    const a = st.addBoard('terminal', { x: 0, y: 0 })
    const b = st.addBoard('terminal', { x: 0, y: 0 })
    const c = st.addBoard('terminal', { x: 0, y: 0 })
    get().updateBoard(b, { x: 10, y: 10 })
    get().updateBoard(c, { x: 20, y: 20 })

    get().tidyBoards('smart')
    const boards = get().boards
    for (let i = 0; i < boards.length; i++)
      for (let j = i + 1; j < boards.length; j++)
        expect(overlaps(boards[i], boards[j])).toBe(false)
    expect(boards.map((x) => x.id).sort()).toEqual([a, b, c].sort())
  })

  it('is a no-op for fewer than two boards (no undo step pushed)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    get().addBoard('terminal', { x: 5, y: 5 })
    const pastLen = get().past.length
    const before = get().boards
    get().tidyBoards('smart')
    expect(get().boards).toBe(before) // same reference — untouched
    expect(get().past.length).toBe(pastLen) // no phantom undo step
  })

  it('records ONE undo step that restores the pre-tidy positions', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    const a = st.addBoard('terminal', { x: 0, y: 0 })
    const b = st.addBoard('browser', { x: 5, y: 5 }) // overlaps a → tidy will move them
    const beforeA = { ...get().boards.find((x) => x.id === a)! }
    const beforeB = { ...get().boards.find((x) => x.id === b)! }
    const pastLen = get().past.length

    get().tidyBoards('smart')
    expect(get().past.length).toBe(pastLen + 1) // exactly one checkpoint

    get().undo()
    const afterA = get().boards.find((x) => x.id === a)!
    const afterB = get().boards.find((x) => x.id === b)!
    expect({ x: afterA.x, y: afterA.y }).toEqual({ x: beforeA.x, y: beforeA.y })
    expect({ x: afterB.x, y: afterB.y }).toEqual({ x: beforeB.x, y: beforeB.y })
  })

  it('a no-op gesture after tidy pushes no phantom undo step (lastRecorded synced)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 5, y: 5 }) // overlaps → tidy moves them
    get().tidyBoards('smart')
    const tidied = get().boards
    const pastLen = get().past.length
    // A gesture starts (titlebar/resize-handle click) but commits nothing. beginChange
    // must recognise the just-tidied present and NOT record a phantom snapshot — else a
    // zero-movement gesture leaves a no-op undo step, so Undo #1 does nothing and Undo #2
    // is needed to actually reverse the tidy (same defect class as #BUG M3 / Bug #7).
    get().beginChange()
    expect(get().past.length).toBe(pastLen) // no phantom step
    // A single undo reverses the tidy (it is NOT a no-op first).
    get().undo()
    expect(get().boards).not.toBe(tidied)
  })

  it('is a no-op when the boards are already tidy (no second undo step)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 5, y: 5 })
    get().tidyBoards('smart') // first tidy moves them
    const settled = get().boards
    const pastLen = get().past.length
    get().tidyBoards('smart') // second tidy: already packed → nothing changes
    expect(get().boards).toBe(settled) // same reference — no mutation
    expect(get().past.length).toBe(pastLen) // no phantom undo step
  })

  it("smart mode groups a browser with the terminal that drives it (store passes type + link through)", () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    const src = st.addBoard('terminal', { x: 0, y: 0 })
    const b1 = st.addBoard('browser', { x: 2000, y: 2000 })
    const b2 = st.addBoard('browser', { x: 4000, y: 4000 })
    // Link both browsers to the terminal (the previewSourceId graph smart reads).
    get().updateBoard(b1, { previewSourceId: src } as never)
    get().updateBoard(b2, { previewSourceId: src } as never)
    get().tidyBoards('smart')
    const at = (id: string): { x: number; y: number } => {
      const board = get().boards.find((x) => x.id === id)!
      return { x: board.x, y: board.y }
    }
    // Both linked browsers share one row; the source terminal sits on the row below.
    expect(at(b1).y).toBe(at(b2).y)
    expect(at(src).y).toBeGreaterThan(at(b1).y)
  })
})

describe('tileBoards (resize-to-fill)', () => {
  const AREA = { x: 0, y: 0, w: 1600, h: 1000 }

  it('resizes + repositions boards to fill the area (2 columns), one undo step', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 5000, y: 5000 })
    const pastLen = get().past.length
    get().tileBoards('cols-2', AREA)
    const boards = get().boards
    expect(get().past.length).toBe(pastLen + 1) // exactly one checkpoint
    // Union bounding box fills the area edge-to-edge.
    const minX = Math.min(...boards.map((b) => b.x))
    const minY = Math.min(...boards.map((b) => b.y))
    const maxX = Math.max(...boards.map((b) => b.x + b.w))
    const maxY = Math.max(...boards.map((b) => b.y + b.h))
    expect(minX).toBe(0)
    expect(minY).toBe(0)
    expect(maxX).toBeCloseTo(1600, 0)
    expect(maxY).toBeCloseTo(1000, 0)
    // Boards were genuinely resized (not just moved).
    expect(boards.every((b) => b.w > 240 && b.h > 160)).toBe(true)
  })

  it('clamps a tiny zone to the board minimum size', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    for (let i = 0; i < 6; i++) st.addBoard('terminal', { x: i * 600, y: 0 })
    get().tileBoards('grid', { x: 0, y: 0, w: 300, h: 200 }) // tiny area → zones below min
    expect(get().boards.every((b) => b.w >= 240 && b.h >= 160)).toBe(true)
  })

  it('record=false reflow changes geometry but pushes NO undo step (live window-resize path)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 900, y: 0 })
    get().tileBoards('cols-2', AREA) // tracked apply (1 step)
    const pastLen = get().past.length
    const tiled = get().boards
    // Simulate a window resize → reflow into a taller area, untracked.
    get().tileBoards('cols-2', { x: 0, y: 0, w: 1000, h: 1400 }, false)
    expect(get().past.length).toBe(pastLen) // NO new undo step
    expect(get().boards).not.toBe(tiled) // geometry actually changed
    // The new heights reflect the taller area (reflowed, not the original).
    const heights = get().boards.map((b) => b.h)
    expect(Math.max(...heights)).toBeGreaterThan(Math.max(...tiled.map((b) => b.h)))
  })

  it('undo restores the pre-tile geometry; re-tiling the same area is a no-op', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    const id = st.addBoard('terminal', { x: 10, y: 20 })
    st.addBoard('browser', { x: 900, y: 0 })
    const before = { ...get().boards.find((b) => b.id === id)! }
    get().tileBoards('cols-2', AREA)
    const settled = get().boards
    const pastLen = get().past.length
    get().tileBoards('cols-2', AREA) // already tiled → nothing changes
    expect(get().boards).toBe(settled)
    expect(get().past.length).toBe(pastLen)
    get().undo()
    const after = get().boards.find((b) => b.id === id)!
    expect({ x: after.x, y: after.y, w: after.w, h: after.h }).toEqual({
      x: before.x,
      y: before.y,
      w: before.w,
      h: before.h
    })
  })
})
