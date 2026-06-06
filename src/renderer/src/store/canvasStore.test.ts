import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useCanvasStore, isIdleOnMount, clearIdleOnMount } from './canvasStore'
import { SCHEMA_VERSION, toObject, createBoard, fromObject } from '../lib/boardSchema'
import { makeChecklist } from '../canvas/boards/planning/elements'

const get = () => useCanvasStore.getState()

beforeEach(() => {
  // Reset the singleton's data between tests; merge keeps the action functions.
  // past/future are cleared too so history state doesn't bleed between tests.
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    selectedId: null,
    tool: 'select',
    past: [],
    future: []
  })
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

  it('uses an injected id when provided (the MCP spawn_board path)', () => {
    // spawn_board mints the id in MAIN and passes it to the renderer so the tool
    // can return that exact id to the agent; the store must honour it verbatim.
    const id = get().addBoard('terminal', { x: 5, y: 5 }, { id: 'srv-issued-id' })
    expect(id).toBe('srv-issued-id')
    expect(get().boards.map((b) => b.id)).toContain('srv-issued-id')
  })

  it('an injected-id add is ONE undo step (rides the M2 tracked rail)', () => {
    get().addBoard('terminal', { x: 0, y: 0 }, { id: 'srv-1' })
    expect(get().past).toHaveLength(1)
    get().undo()
    expect(get().boards).toHaveLength(0)
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

  it('uses an explicit size when provided', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 }, { size: { w: 333, h: 222 } })
    const b = get().boards.find((x) => x.id === id)!
    expect(b).toMatchObject({ w: 333, h: 222 })
  })

  it('places exactly (skips freeSlot) when exact:true, even over an existing board', () => {
    get().addBoard('terminal', { x: 100, y: 100 }) // occupies the slot
    const id = get().addBoard(
      'browser',
      { x: 100, y: 100 },
      { size: { w: 240, h: 160 }, exact: true }
    )
    const b = get().boards.find((x) => x.id === id)!
    expect(b).toMatchObject({ x: 100, y: 100 }) // verbatim, NOT nudged off the overlap
  })

  it('still nudges off an overlap when exact is falsy (default click-spawn)', () => {
    get().addBoard('terminal', { x: 100, y: 100 })
    const id = get().addBoard('terminal', { x: 100, y: 100 })
    const b = get().boards.find((x) => x.id === id)!
    expect(b).not.toMatchObject({ x: 100, y: 100 }) // freeSlot moved it
  })

  it('honours an injected id and exact placement together (MCP spawn path)', () => {
    const id = get().addBoard('terminal', { x: 50, y: 50 }, { id: 'my-id', exact: true })
    expect(id).toBe('my-id')
    expect(get().boards.find((x) => x.id === 'my-id')).toMatchObject({ x: 50, y: 50 })
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

  // BUG-033: undo() must reclaim the idle flag for any board id that disappears from
  // the present snapshot, or idleOnMountIds grows with dead UUIDs across
  // duplicate+undo cycles.
  it('undo of duplicateBoard removes the clone UUID from idleOnMountIds (BUG-033)', () => {
    const src = get().addBoard('terminal', { x: 0, y: 0 })
    const cloneId = get().duplicateBoard(src)!
    // After duplicate: clone is in boards AND flagged idle.
    expect(get().boards.some((b) => b.id === cloneId)).toBe(true)
    expect(isIdleOnMount(cloneId)).toBe(true)
    // Undo removes the clone from boards — it MUST also remove it from idleOnMountIds.
    get().undo()
    expect(get().boards.some((b) => b.id === cloneId)).toBe(false)
    expect(isIdleOnMount(cloneId)).toBe(false) // was leaking before BUG-033 fix
  })

  it('repeated duplicate+undo cycles leave no stale UUIDs in idleOnMountIds (BUG-033)', () => {
    const src = get().addBoard('terminal', { x: 0, y: 0 })
    const cloneIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = get().duplicateBoard(src)!
      cloneIds.push(id)
      get().undo()
    }
    // Every cloned UUID that was undone must be reclaimed — no session-lifetime leak.
    for (const id of cloneIds) {
      expect(isIdleOnMount(id)).toBe(false)
    }
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

  it('removing an unknown id is a no-op: no boards change, no undo step (no phantom)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    get().addBoard('terminal', { x: 0, y: 0 })
    const before = get().boards
    const pastLen = get().past.length
    get().removeBoard('does-not-exist')
    expect(get().boards).toBe(before) // same reference — untouched
    expect(get().past.length).toBe(pastLen) // no dead undo step recorded
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

  it('updateBoard re-applying identical values preserves the armed redo branch (STATE-2)', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().updateBoard(id, { x: 50 })
    get().undo() // back to x=0, future = [x=50] armed
    expect(get().future).toHaveLength(1)
    const boardsRef = get().boards
    // A no-op patch (current x re-applied) must NOT clear redo or mint a new boards ref.
    get().updateBoard(id, { x: get().boards[0].x })
    expect(get().future).toHaveLength(1)
    expect(get().boards).toBe(boardsRef)
    get().redo()
    expect(get().boards[0].x).toBe(50)
  })

  it('resizeBoard with identical clamped w/h preserves the armed redo branch (STATE-2)', () => {
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange()
    get().resizeBoard(id, 500, 400)
    get().undo() // back to default size, future armed
    expect(get().future).toHaveLength(1)
    const boardsRef = get().boards
    const cur = get().boards[0]
    get().resizeBoard(id, cur.w, cur.h) // no-op
    expect(get().future).toHaveLength(1)
    expect(get().boards).toBe(boardsRef)
    get().redo()
    expect(get().boards[0]).toMatchObject({ w: 500, h: 400 })
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

// add/remove/duplicate are TRACKED but must NOT mark their new present as "already reflected"
// (no lastRecorded sync) — otherwise the next beginChange skips its checkpoint and a board's
// FIRST move coalesces into the add/remove/duplicate step (undo jumps past it). They keep the
// granular-move-undo invariant; their post-no-op phantom step is the TOLERATED edge a
// store-layer flag cannot close without breaking this (it needs a gesture-layer lazy
// checkpoint — see WB-1). tidy/tile DO sync (they accept that coalescing for a bulk op).
// These guard against a future "fix" that re-introduces the regression by syncing here.
describe('tracked actions keep a following move granularly undoable (no present-reflect)', () => {
  it('addBoard → move → undo returns to the add-position, not removal', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const id = get().addBoard('terminal', { x: 0, y: 0 })
    get().beginChange() // gesture start for a real move
    get().updateBoard(id, { x: 200 })
    get().undo()
    expect(get().boards).toHaveLength(1)
    expect(get().boards[0].x).toBe(0) // move undone granularly, board still present
    get().undo()
    expect(get().boards).toHaveLength(0) // second undo removes the board
  })

  it('duplicateBoard → move the copy → undo returns the copy to its duplicate-position', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const src = get().addBoard('planning', { x: 0, y: 0 })
    const copy = get().duplicateBoard(src)!
    const copyX = get().boards.find((b) => b.id === copy)!.x
    get().beginChange()
    get().updateBoard(copy, { x: copyX + 500 })
    get().undo()
    expect(get().boards.find((b) => b.id === copy)!.x).toBe(copyX) // copy stays, move undone
    get().undo()
    expect(get().boards.some((b) => b.id === copy)).toBe(false) // then the duplicate undoes
  })

  it('removeBoard → move another board → undo undoes the move, removed board stays gone', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const a = get().addBoard('terminal', { x: 0, y: 0 })
    const b = get().addBoard('browser', { x: 900, y: 0 })
    get().removeBoard(a)
    get().beginChange()
    get().updateBoard(b, { x: 1200 })
    get().undo()
    expect(get().boards.find((x) => x.id === b)!.x).toBe(900) // move undone granularly
    expect(get().boards.some((x) => x.id === a)).toBe(false) // removed board not resurrected
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
  // applyOpenResult is async and, on a deep-validation throw, calls
  // window.api.project.reopenFromBak over the (here non-existent) IPC bridge. Stub it per
  // test: default = no readable .bak so the corrupt/too-new cases land on status:'error'.
  const reopenFromBak = vi.fn(async () => ({ ok: false }) as { ok: false; error?: string })
  beforeEach(() => {
    reopenFromBak.mockReset()
    reopenFromBak.mockResolvedValue({ ok: false })
    vi.stubGlobal('window', { api: { project: { reopenFromBak } } })
    useCanvasStore.setState({
      boards: [],
      viewport: null,
      selectedId: null,
      past: [],
      future: [],
      project: { dir: null, name: null, status: 'welcome' }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals() // don't leak the stubbed `window` into later describes
  })

  it('defaults to welcome status', () => {
    expect(useCanvasStore.getState().project.status).toBe('welcome')
  })

  it('applyOpenResult(ok) loads the doc and marks open', async () => {
    await useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: { schemaVersion: 2, viewport: { x: 1, y: 2, zoom: 1 }, boards: [] }
    })
    const s = useCanvasStore.getState()
    expect(s.project).toEqual({ dir: 'C:/p', name: 'p', status: 'open' })
    expect(s.viewport).toEqual({ x: 1, y: 2, zoom: 1 })
    // A clean load never needs the .bak recovery probe.
    expect(reopenFromBak).not.toHaveBeenCalled()
  })

  it('applyOpenResult(error) sets error status without clobbering boards', async () => {
    useCanvasStore.setState({
      boards: [
        { id: 'x', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
      ] as never
    })
    await useCanvasStore.getState().applyOpenResult({ ok: false, error: 'bad' })
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.project.error).toBe('bad')
    expect(s.boards).toHaveLength(1) // untouched
  })

  // T4: an envelope-VALID but deep-corrupt doc (passes MAIN's envelope check, so MAIN's
  // .bak fallback never fires) must NOT throw out of applyOpenResult and blank the app —
  // route the fromObject throw to status:'error' and leave board state untouched. Here the
  // .bak retry (T5) also fails (default reopenFromBak stub → {ok:false}) so it lands error.
  it('applyOpenResult(ok) with a deep-corrupt doc (no .bak) → status:error, boards untouched', async () => {
    useCanvasStore.setState({
      boards: [
        { id: 'keep', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
      ] as never
    })
    const before = useCanvasStore.getState().boards
    // Envelope-valid (numeric schemaVersion + boards[]) but a board has a non-string id,
    // which assertBoard rejects → fromObject throws (verified: "board has a non-string id").
    await useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: {
        schemaVersion: 5,
        viewport: null,
        boards: [
          { id: 123, type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
        ]
      }
    })
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.boards).toBe(before) // boards untouched (same ref)
    expect(reopenFromBak).toHaveBeenCalledWith('C:/p') // tried the backup first
  })

  // T4: a doc whose schemaVersion is newer than we support also routes to status:error,
  // carrying migrate()'s "newer than supported" message (no .bak to recover from).
  it('applyOpenResult(ok) with a too-new schemaVersion (no .bak) → status:error (newer than supported)', async () => {
    await useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: { schemaVersion: 999, boards: [] }
    })
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.project.error).toMatch(/newer than supported/)
  })

  // T5: primary deep-corrupt, but the .bak is a GOOD doc → recover to status:'open' with
  // the recovered boards/viewport (and the dir/name of the project being opened).
  it('applyOpenResult(ok) deep-corrupt primary but a GOOD .bak → recovers to status:open', async () => {
    reopenFromBak.mockResolvedValue({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: {
        schemaVersion: 2,
        viewport: { x: 9, y: 9, zoom: 2 },
        boards: [
          {
            id: 'recovered',
            type: 'planning',
            x: 0,
            y: 0,
            w: 300,
            h: 200,
            title: 'R',
            elements: []
          }
        ]
      }
    } as never)
    await useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: {
        schemaVersion: 5,
        viewport: null,
        boards: [
          { id: 123, type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
        ]
      }
    })
    const s = useCanvasStore.getState()
    expect(s.project).toEqual({ dir: 'C:/p', name: 'p', status: 'open' })
    expect(s.boards).toHaveLength(1)
    expect(s.boards[0].id).toBe('recovered')
    expect(s.viewport).toEqual({ x: 9, y: 9, zoom: 2 })
  })

  // T5: primary deep-corrupt AND the .bak is also bad (returns a deep-corrupt doc that
  // fromObject rejects) → fall through to status:'error' carrying the ORIGINAL message.
  it('applyOpenResult(ok) deep-corrupt primary AND a deep-corrupt .bak → status:error', async () => {
    reopenFromBak.mockResolvedValue({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      // Envelope-valid but a board with a non-string id → fromObject throws on the .bak too.
      doc: { schemaVersion: 5, viewport: null, boards: [{ id: 456 }] }
    } as never)
    await useCanvasStore.getState().applyOpenResult({
      ok: true,
      dir: 'C:/p',
      name: 'p',
      doc: {
        schemaVersion: 5,
        viewport: null,
        boards: [
          { id: 123, type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
        ]
      }
    })
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    // The original primary-parse message is preserved (not the .bak's).
    expect(s.project.error).toMatch(/non-string id/)
  })

  // T4 (loadObject): envelope-valid but deep-corrupt doc must route the fromObject throw to
  // status:'error' and leave board state UNTOUCHED — loadObject has no .bak retry path.
  it('loadObject with a deep-corrupt doc → status:error, boards untouched', () => {
    useCanvasStore.setState({
      boards: [
        { id: 'keep', type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }
      ] as never
    })
    const before = useCanvasStore.getState().boards
    // Envelope-valid (numeric schemaVersion + boards[]) but a board has a non-string id,
    // which assertBoard rejects → fromObject throws (same corrupt shape used in applyOpenResult T4).
    useCanvasStore.getState().loadObject({
      schemaVersion: 5,
      viewport: null,
      boards: [{ id: 123, type: 'planning', x: 0, y: 0, w: 300, h: 200, title: 'P', elements: [] }]
    } as never)
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.project.error).toBeTruthy()
    expect(s.boards).toBe(before) // boards untouched (same ref)
  })

  // T4 (loadObject): a doc whose schemaVersion is newer than we support routes to
  // status:'error' carrying migrate()'s "newer than supported" message.
  it('loadObject with a too-new schemaVersion → status:error (newer than supported)', () => {
    useCanvasStore.getState().loadObject({ schemaVersion: 999, boards: [] } as never)
    const s = useCanvasStore.getState()
    expect(s.project.status).toBe('error')
    expect(s.project.error).toMatch(/newer than supported/)
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
      for (let j = i + 1; j < boards.length; j++) expect(overlaps(boards[i], boards[j])).toBe(false)
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

  // trackedChange OMITS selectedId for tidy/tile (reflectPresent:true, no selectedId opt) so
  // the current selection survives — it must NOT be written as `selectedId: undefined`, which
  // Zustand's shallow merge would clobber. Guards a "simplify by always spreading" regression.
  it('preserves the current selection (does not clobber selectedId)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    const a = st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 5, y: 5 }) // overlaps → tidy/tile move them
    get().selectBoard(a)
    get().tidyBoards('smart')
    expect(get().selectedId).toBe(a) // selection survives tidy
    get().tileBoards('cols-2', { x: 0, y: 0, w: 1600, h: 1000 })
    expect(get().selectedId).toBe(a) // selection survives tile
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

  it('smart mode groups a browser with the terminal that drives it (store passes type + link through)', () => {
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

  // Migrated from the e2e `tidy` probe (the horizontal-span-reduction assertion). The
  // probe's no-overlap / type-grouping checks are already covered above; this adds the
  // "smart tidy packs a wide spread into a tighter span" contract at the store tier.
  it('packs scattered boards into a tighter horizontal span (smart)', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const st = get()
    st.addBoard('terminal', { x: 0, y: 0 })
    st.addBoard('browser', { x: 3000, y: 0 })
    st.addBoard('browser', { x: 6000, y: 0 })
    const span = (): number => {
      const bs = get().boards
      return Math.max(...bs.map((b) => b.x + b.w)) - Math.min(...bs.map((b) => b.x))
    }
    const before = span()
    get().tidyBoards('smart')
    expect(span()).toBeLessThan(before)
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

describe('canvasStore — connectors (M2)', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [],
      connectors: [],
      selectedId: null,
      past: [],
      future: []
    })
  })

  // Seed two real boards and return their ids.
  const twoBoards = (): { a: string; b: string } => ({
    a: get().addBoard('terminal', { x: 0, y: 0 }),
    b: get().addBoard('browser', { x: 900, y: 0 })
  })

  it('addConnector links two boards, returns an id, and records exactly one undo step', () => {
    const { a, b } = twoBoards()
    const pastLen = get().past.length
    const id = get().addConnector(a, b, 'orchestration')
    expect(id).toBeTypeOf('string')
    expect(get().connectors).toEqual([{ id, sourceId: a, targetId: b, kind: 'orchestration' }])
    expect(get().past.length).toBe(pastLen + 1)
  })

  it('addConnector does not mint a new boards ref (a connector-only change leaves boards alone)', () => {
    const { a, b } = twoBoards()
    const boardsRef = get().boards
    get().addConnector(a, b, 'orchestration')
    expect(get().boards).toBe(boardsRef)
  })

  it('rejects a self-link (returns null, no undo step, no connector)', () => {
    const { a } = twoBoards()
    const pastLen = get().past.length
    expect(get().addConnector(a, a, 'orchestration')).toBeNull()
    expect(get().connectors).toEqual([])
    expect(get().past.length).toBe(pastLen)
  })

  it('rejects a connector to a missing board', () => {
    const { a } = twoBoards()
    expect(get().addConnector(a, 'ghost', 'orchestration')).toBeNull()
    expect(get().addConnector('ghost', a, 'orchestration')).toBeNull()
    expect(get().connectors).toEqual([])
  })

  it('dedupes an identical source+target+kind connector', () => {
    const { a, b } = twoBoards()
    const id = get().addConnector(a, b, 'orchestration')
    const pastLen = get().past.length
    expect(get().addConnector(a, b, 'orchestration')).toBeNull() // duplicate
    expect(get().connectors).toHaveLength(1)
    expect(get().connectors[0].id).toBe(id)
    expect(get().past.length).toBe(pastLen) // no step for the rejected dup
  })

  it('undo removes an added connector; redo re-adds it', () => {
    const { a, b } = twoBoards()
    get().addConnector(a, b, 'orchestration')
    expect(get().connectors).toHaveLength(1)
    get().undo()
    expect(get().connectors).toHaveLength(0)
    get().redo()
    expect(get().connectors).toHaveLength(1)
  })

  it('removeConnector deletes by id (one step); a no-op for an unknown id', () => {
    const { a, b } = twoBoards()
    const id = get().addConnector(a, b, 'orchestration')!
    const pastLen = get().past.length
    get().removeConnector('nope')
    expect(get().connectors).toHaveLength(1)
    expect(get().past.length).toBe(pastLen) // unknown id → no dead step
    get().removeConnector(id)
    expect(get().connectors).toEqual([])
    expect(get().past.length).toBe(pastLen + 1)
  })

  it('removeBoard drops incident connectors in the SAME step; undo restores board AND connectors', () => {
    const { a, b } = twoBoards()
    get().addConnector(a, b, 'orchestration')
    expect(get().connectors).toHaveLength(1)
    const pastLen = get().past.length
    get().removeBoard(b)
    // one tracked step removed the board AND its incident connector
    expect(get().boards.some((x) => x.id === b)).toBe(false)
    expect(get().connectors).toEqual([])
    expect(get().past.length).toBe(pastLen + 1)
    get().undo()
    expect(get().boards.some((x) => x.id === b)).toBe(true) // board back…
    expect(get().connectors).toHaveLength(1) // …and its cable, in one undo
  })

  it('duplicateBoard inherits NO orchestration connectors (Decision E)', () => {
    const { a, b } = twoBoards()
    get().addConnector(a, b, 'orchestration')
    const copy = get().duplicateBoard(b)!
    expect(copy).toBeTypeOf('string')
    // exactly the original cable survives; the clone is uncabled
    expect(get().connectors).toHaveLength(1)
    expect(get().connectors.some((c) => c.sourceId === copy || c.targetId === copy)).toBe(false)
  })

  it('toObject persists orchestration connectors AND re-derives preview connectors', () => {
    const { a, b } = twoBoards()
    get().addConnector(a, b, 'orchestration')
    // give the browser a preview link so toObject re-derives a preview connector too
    get().updateBoard(b, { previewSourceId: a } as never)
    const doc = get().toObject()
    expect(doc.connectors).toContainEqual({
      id: expect.any(String),
      sourceId: a,
      targetId: b,
      kind: 'orchestration'
    })
    expect(doc.connectors).toContainEqual({
      id: `preview-${b}`,
      sourceId: a,
      targetId: b,
      kind: 'preview'
    })
  })

  it('loadObject sets connectors (orchestration kept, preview folded into previewSourceId) and resets history', () => {
    const doc = toObject(
      [
        createBoard('terminal', { id: 't1', x: 0, y: 0 }),
        createBoard('browser', { id: 'b1', x: 900, y: 0 })
      ],
      null,
      [{ id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'orchestration' }]
    )
    get().loadObject(doc)
    expect(get().connectors).toEqual([
      { id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'orchestration' }
    ])
    expect(get().past).toEqual([])
    expect(get().future).toEqual([])
  })
})

describe('multi-select', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null, selectedIds: [] })
  })

  it('selectBoard sets a single-element selectedIds and the primary', () => {
    const { selectBoard } = useCanvasStore.getState()
    selectBoard('a')
    expect(useCanvasStore.getState().selectedIds).toEqual(['a'])
    expect(useCanvasStore.getState().selectedId).toBe('a')
    selectBoard(null)
    expect(useCanvasStore.getState().selectedIds).toEqual([])
    expect(useCanvasStore.getState().selectedId).toBeNull()
  })

  it('toggleSelect adds then removes, keeping selectedId as the last', () => {
    const { toggleSelect } = useCanvasStore.getState()
    toggleSelect('a')
    toggleSelect('b')
    expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b'])
    expect(useCanvasStore.getState().selectedId).toBe('b')
    toggleSelect('b')
    expect(useCanvasStore.getState().selectedIds).toEqual(['a'])
    expect(useCanvasStore.getState().selectedId).toBe('a')
  })

  it('setSelection replaces the set and derives the primary from the last id', () => {
    const { setSelection } = useCanvasStore.getState()
    setSelection(['a', 'b', 'c'])
    expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b', 'c'])
    expect(useCanvasStore.getState().selectedId).toBe('c')
    setSelection([])
    expect(useCanvasStore.getState().selectedId).toBeNull()
  })

  it('undo clears selectedIds (invariant holds after undo)', () => {
    // add two boards then undo → selection must be empty, not stale
    const { addBoard, undo } = useCanvasStore.getState()
    addBoard('terminal', { x: 0, y: 0 })
    addBoard('terminal', { x: 400, y: 0 })
    undo()
    expect(useCanvasStore.getState().selectedIds).toEqual([])
    expect(useCanvasStore.getState().selectedId).toBeNull()
  })

  it('setSelection dedupes and clears to [] on empty', () => {
    const { setSelection } = useCanvasStore.getState()
    setSelection(['a', 'a', 'b'])
    expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b'])
    setSelection([])
    expect(useCanvasStore.getState().selectedIds).toEqual([])
    expect(useCanvasStore.getState().selectedId).toBeNull()
  })

  it('addBoard collapses any prior multi-selection to the new board', () => {
    const { setSelection, addBoard } = useCanvasStore.getState()
    setSelection(['x', 'y'])
    const id = addBoard('terminal', { x: 0, y: 0 })
    expect(useCanvasStore.getState().selectedIds).toEqual([id])
    expect(useCanvasStore.getState().selectedId).toBe(id)
  })
})

describe('groups — undo snapshot', () => {
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
  })

  it('initializes groups to an empty array', () => {
    expect(useCanvasStore.getState().groups).toEqual([])
  })

  it('captures groups in the undo snapshot (undo restores prior groups)', () => {
    const { addGroup, undo } = useCanvasStore.getState()
    const gid = addGroup('Auth', [])
    expect(useCanvasStore.getState().groups.map((g) => g.id)).toContain(gid)
    undo()
    expect(useCanvasStore.getState().groups).toEqual([])
  })
})

describe('group CRUD', () => {
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
  })

  it('addGroup mints an id, stores name + boardIds, returns the id', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1', 'b2'])
    const g = useCanvasStore.getState().groups.find((x) => x.id === id)
    expect(g).toEqual({ id, name: 'Auth', boardIds: ['b1', 'b2'] })
  })

  it('renameGroup changes the name only', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().renameGroup(id, 'API')
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.name).toBe('API')
  })

  it('removeGroup drops the record (boards untouched)', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().removeGroup(id)
    expect(useCanvasStore.getState().groups).toEqual([])
  })

  it('addBoardsToGroup unions ids (no duplicates); removeBoardFromGroup removes one', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().addBoardsToGroup(id, ['b1', 'b2'])
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual([
      'b1',
      'b2'
    ])
    useCanvasStore.getState().removeBoardFromGroup(id, 'b1')
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual(['b2'])
  })

  it('each CRUD op is one undo step', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().renameGroup(id, 'API')
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.name).toBe('Auth')
  })

  it('removeGroup / addBoardsToGroup / removeBoardFromGroup are each one undo step', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1', 'b2'])
    const lenAfterAdd = useCanvasStore.getState().past.length

    // removeGroup — one step
    useCanvasStore.getState().removeGroup(id)
    expect(useCanvasStore.getState().groups).toHaveLength(0)
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)).toBeDefined()
    expect(useCanvasStore.getState().past.length).toBe(lenAfterAdd)

    // addBoardsToGroup — one step
    useCanvasStore.getState().addBoardsToGroup(id, ['b3'])
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual([
      'b1',
      'b2',
      'b3'
    ])
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual([
      'b1',
      'b2'
    ])

    // removeBoardFromGroup — one step
    useCanvasStore.getState().removeBoardFromGroup(id, 'b1')
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual(['b2'])
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual([
      'b1',
      'b2'
    ])
  })

  it('renameGroup to the same name does not push an undo step', () => {
    const id = useCanvasStore.getState().addGroup('Auth', [])
    const len = useCanvasStore.getState().past.length
    useCanvasStore.getState().renameGroup(id, 'Auth')
    expect(useCanvasStore.getState().past.length).toBe(len)
  })

  it('removeGroup on an unknown id does not push an undo step', () => {
    const len = useCanvasStore.getState().past.length
    useCanvasStore.getState().removeGroup('nope')
    expect(useCanvasStore.getState().past.length).toBe(len)
  })

  it('addBoardsToGroup with only already-present ids does not push an undo step', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1', 'b2'])
    const len = useCanvasStore.getState().past.length
    useCanvasStore.getState().addBoardsToGroup(id, ['b1'])
    expect(useCanvasStore.getState().past.length).toBe(len)
  })

  it('removeBoardFromGroup on a non-member does not push an undo step', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    const len = useCanvasStore.getState().past.length
    useCanvasStore.getState().removeBoardFromGroup(id, 'zzz')
    expect(useCanvasStore.getState().past.length).toBe(len)
  })

  it('addBoardsToGroupReflowed adds membership AND moves members in ONE undo step', () => {
    const s = useCanvasStore.getState()
    // Two real boards (the reflow moves positions, so they must exist in the store).
    const a = s.addBoard('planning', { x: 0, y: 0 }, { exact: true })
    const b = s.addBoard('planning', { x: 1000, y: 0 }, { exact: true })
    const gid = s.addGroup('Auth', [a])
    const oldB = useCanvasStore.getState().boards.find((x) => x.id === b)!
    const pastLen = useCanvasStore.getState().past.length

    // Add b to the group AND move BOTH members to a packed cluster.
    useCanvasStore.getState().addBoardsToGroupReflowed(
      gid,
      [b],
      [
        { id: a, x: 0, y: 0 },
        { id: b, x: 140, y: 0 }
      ]
    )

    // Exactly one checkpoint for membership + reposition together.
    expect(useCanvasStore.getState().past.length).toBe(pastLen + 1)
    expect(useCanvasStore.getState().groups.find((x) => x.id === gid)?.boardIds).toEqual([a, b])
    expect(useCanvasStore.getState().boards.find((x) => x.id === b)?.x).toBe(140)

    // One undo restores BOTH the old membership AND the old position.
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((x) => x.id === gid)?.boardIds).toEqual([a])
    expect(useCanvasStore.getState().boards.find((x) => x.id === b)?.x).toBe(oldB.x)
  })

  it('addBoardsToGroupReflowed is a no-op (no undo step) when membership + positions are unchanged', () => {
    const s = useCanvasStore.getState()
    const a = s.addBoard('planning', { x: 0, y: 0 }, { exact: true })
    const b = s.addBoard('planning', { x: 200, y: 0 }, { exact: true })
    const gid = s.addGroup('Auth', [a, b])
    const len = useCanvasStore.getState().past.length
    // Already members, identical positions → nothing changes.
    useCanvasStore.getState().addBoardsToGroupReflowed(
      gid,
      [a, b],
      [
        { id: a, x: 0, y: 0 },
        { id: b, x: 200, y: 0 }
      ]
    )
    expect(useCanvasStore.getState().past.length).toBe(len)
  })
})

describe('removeBoard sweeps groups', () => {
  it('removeBoard removes the deleted id from every group in one undo step', () => {
    useCanvasStore.setState({
      boards: [],
      connectors: [],
      groups: [],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const gid = useCanvasStore.getState().addGroup('Auth', [id])
    useCanvasStore.getState().removeBoard(id)
    expect(useCanvasStore.getState().groups.find((g) => g.id === gid)?.boardIds).toEqual([])
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((g) => g.id === gid)?.boardIds).toEqual([id])
  })

  it('removeBoard on a board in no group leaves groups ref-stable (no extra undo step)', () => {
    useCanvasStore.setState({
      boards: [],
      connectors: [],
      groups: [],
      past: [],
      future: [],
      selectedId: null,
      selectedIds: []
    })
    const a = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
    const b = useCanvasStore.getState().addBoard('terminal', { x: 400, y: 0 })
    useCanvasStore.getState().addGroup('Auth', [a]) // group does NOT contain b
    const groupsRef = useCanvasStore.getState().groups
    useCanvasStore.getState().removeBoard(b)
    expect(useCanvasStore.getState().groups).toBe(groupsRef) // same ref — sweep no-op'd
  })
})

describe('planning board — addChecklist + schema round-trip (migrated from e2e planning)', () => {
  it('appends a checklist element and the whole canvas still round-trips', () => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null })
    const id = get().addBoard('planning', { x: 0, y: 0 })
    const b = get().boards.find((x) => x.id === id)!
    if (b.type !== 'planning') throw new Error('expected planning board')
    const cl = makeChecklist(crypto.randomUUID(), crypto.randomUUID(), { x: 60, y: 60 })
    get().updateBoard(id, { elements: [...b.elements, cl] } as never)

    const after = get().boards.find((x) => x.id === id)!
    const kinds = after.type === 'planning' ? after.elements.map((e) => e.kind) : []
    expect(kinds).toContain('checklist')
    expect(() => fromObject(get().toObject())).not.toThrow()
  })
})
