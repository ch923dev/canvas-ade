import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../canvasStore'

const get = () => useCanvasStore.getState()
const fileBoards = (): { id: string; path?: string }[] =>
  get().boards.filter((b) => b.type === 'file') as { id: string; path?: string }[]

beforeEach(() => {
  useCanvasStore.setState({
    boards: [],
    connectors: [],
    groups: [],
    selectedId: null,
    selectedIds: [],
    past: [],
    future: [],
    peekBoardId: null,
    viewport: { x: 0, y: 0, zoom: 1 }
  })
})

describe('peekFile — VS Code preview-tab discipline (one reusable board)', () => {
  it('first single-click spawns exactly one peek board and marks it', () => {
    get().peekFile('src/a.ts')
    const fb = fileBoards()
    expect(fb).toHaveLength(1)
    expect(fb[0].path).toBe('src/a.ts')
    expect(get().peekBoardId).toBe(fb[0].id)
    expect(get().selectedId).toBe(fb[0].id)
  })

  it('a second single-click REBINDS the same peek board — never spawns a second', () => {
    get().peekFile('src/a.ts')
    const firstId = get().peekBoardId
    get().peekFile('src/b.ts')
    const fb = fileBoards()
    expect(fb).toHaveLength(1) // still ONE board
    expect(fb[0].id).toBe(firstId) // the SAME board, rebound
    expect(fb[0].path).toBe('src/b.ts')
    expect(get().peekBoardId).toBe(firstId) // still the peek
  })

  it('rebinding while browsing records NO undo steps (only the spawn does)', () => {
    get().peekFile('src/a.ts')
    const afterSpawn = get().past.length
    get().peekFile('src/b.ts')
    get().peekFile('src/c.ts')
    expect(get().past.length).toBe(afterSpawn) // rebinds are non-recording
  })

  it('clicking a file already open in a PINNED board focuses it (no peek, no new board)', () => {
    const pinnedId = get().openFileBoard('src/pinned.ts') // pinned by construction (un-marked)
    expect(get().peekBoardId).toBeNull()
    get().peekFile('src/pinned.ts')
    expect(fileBoards()).toHaveLength(1)
    expect(get().selectedId).toBe(pinnedId)
    expect(get().peekBoardId).toBeNull() // never converted the pinned board into a peek
  })
})

describe('pinBoard / pinFile — promote the peek', () => {
  it('pinBoard clears peekBoardId when it matches; no-ops otherwise', () => {
    get().peekFile('src/a.ts')
    const id = get().peekBoardId as string
    get().pinBoard('not-the-peek')
    expect(get().peekBoardId).toBe(id)
    get().pinBoard(id)
    expect(get().peekBoardId).toBeNull()
    expect(fileBoards()).toHaveLength(1) // the board itself survives — it just got pinned
  })

  it('pinFile promotes the current peek (board stays, peek cleared)', () => {
    get().peekFile('src/a.ts')
    const id = get().peekBoardId as string
    get().pinFile('src/a.ts')
    expect(get().peekBoardId).toBeNull()
    expect(fileBoards().map((b) => b.id)).toEqual([id])
  })

  it('pinFile on a fresh path spawns a PINNED board (peekBoardId stays null)', () => {
    get().pinFile('src/fresh.ts')
    expect(fileBoards()).toHaveLength(1)
    expect(get().peekBoardId).toBeNull()
  })
})

describe('openFileBoards — multi-select → spawn a grid', () => {
  it('spawns one PINNED board per fresh file and selects the whole set', () => {
    get().openFileBoards(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    const fb = fileBoards()
    expect(fb.map((b) => b.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(get().peekBoardId).toBeNull() // grid boards are pinned, not peeks
    expect(get().selectedIds).toHaveLength(3) // the whole set is selected
  })

  it('lays boards out without overlapping (a tidy grid, not a stack)', () => {
    get().openFileBoards(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    const positions = get().boards.map((b) => `${b.x},${b.y}`)
    expect(new Set(positions).size).toBe(positions.length) // every board at a distinct slot
  })

  it('skips files that already have a board (no duplicates) and de-dupes the input', () => {
    const firstId = get().openFileBoard('a.ts') // pre-open one
    get().openFileBoards(['a.ts', 'a.ts', 'b.ts']) // dup input + an already-open file
    const fb = fileBoards()
    expect(fb).toHaveLength(2) // a.ts (reused) + b.ts (fresh) — never a 2nd a.ts
    expect(fb.some((b) => b.id === firstId && b.path === 'a.ts')).toBe(true)
  })
})
