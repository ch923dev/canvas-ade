import { describe, it, expect } from 'vitest'
import {
  SCHEMA_VERSION,
  MIN_BOARD_SIZE,
  DEFAULT_BOARD_SIZE,
  createBoard,
  toObject,
  fromObject,
  migrate,
  type Board,
  type PlanningBoard
} from './boardSchema'

describe('createBoard', () => {
  it('makes a terminal board with the default size and no browser/planning props', () => {
    const b = createBoard('terminal', { id: 't1', x: 10, y: 20 })
    expect(b).toMatchObject({
      id: 't1',
      type: 'terminal',
      x: 10,
      y: 20,
      w: 420,
      h: 340
    })
    expect(b).not.toHaveProperty('url')
    expect(b).not.toHaveProperty('elements')
  })

  it('makes a browser board seeded with a url + desktop viewport at 700x500', () => {
    const b = createBoard('browser', { id: 'b1', x: 0, y: 0 })
    expect(b).toMatchObject({ type: 'browser', w: 700, h: 500, viewport: 'desktop' })
    expect(typeof (b as { url: string }).url).toBe('string')
  })

  it('makes a planning board with an empty elements array at 516x366', () => {
    const b = createBoard('planning', { id: 'p1', x: 0, y: 0 })
    expect(b).toMatchObject({ type: 'planning', w: 516, h: 366, elements: [] })
  })

  it('honors w/h/title/z overrides', () => {
    const b = createBoard('terminal', {
      id: 't2',
      x: 0,
      y: 0,
      w: 900,
      h: 600,
      title: 'Build',
      z: 3
    })
    expect(b).toMatchObject({ w: 900, h: 600, title: 'Build', z: 3 })
  })

  it('omits z when not supplied (optional field stays absent)', () => {
    const b = createBoard('terminal', { id: 't3', x: 0, y: 0 })
    expect(b).not.toHaveProperty('z')
  })

  it('gives each type a non-empty default title', () => {
    for (const type of ['terminal', 'browser', 'planning'] as const) {
      expect(createBoard(type, { id: type, x: 0, y: 0 }).title.length).toBeGreaterThan(0)
    }
  })
})

describe('size constants', () => {
  it('pins the minimum board size to 240x160', () => {
    expect(MIN_BOARD_SIZE).toEqual({ w: 240, h: 160 })
  })

  it('pins the per-type default add sizes', () => {
    expect(DEFAULT_BOARD_SIZE).toEqual({
      terminal: { w: 420, h: 340 },
      browser: { w: 700, h: 500 },
      planning: { w: 516, h: 366 }
    })
  })
})

// A fully-populated canvas exercising every board type and every planning element
// kind — the round-trip must preserve all of it byte-for-byte.
function sampleBoards(): Board[] {
  const planning: PlanningBoard = {
    id: 'p1',
    type: 'planning',
    x: 100,
    y: 50,
    w: 516,
    h: 366,
    title: 'Plan',
    elements: [
      {
        id: 'n1',
        kind: 'note',
        x: 8,
        y: 8,
        w: 160,
        h: 120,
        text: 'idea',
        tint: 'yellow',
        rotation: -2
      },
      { id: 'x1', kind: 'text', x: 12, y: 200, text: 'free text' },
      { id: 'a1', kind: 'arrow', x: 0, y: 0, x2: 120, y2: 90 },
      { id: 's1', kind: 'stroke', x: 0, y: 0, points: [0, 0, 4, 6, 12, 18] },
      {
        id: 'c1',
        kind: 'checklist',
        x: 200,
        y: 8,
        w: 220,
        h: 180,
        title: 'Tasks',
        items: [
          { id: 'i1', label: 'spawn shell', done: true },
          { id: 'i2', label: 'wire pty', done: false }
        ]
      }
    ]
  }
  return [
    {
      id: 't1',
      type: 'terminal',
      x: 0,
      y: 0,
      w: 420,
      h: 340,
      title: 'Term',
      launchCommand: 'claude',
      shell: 'pwsh',
      cwd: 'Z:/repo',
      port: 5173
    },
    {
      id: 'b1',
      type: 'browser',
      x: 700,
      y: 0,
      w: 700,
      h: 500,
      title: 'Preview',
      url: 'http://localhost:5173',
      viewport: 'mobile',
      z: 2
    },
    planning
  ]
}

describe('toObject', () => {
  it('wraps boards with the current schemaVersion', () => {
    const doc = toObject(sampleBoards())
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.boards).toHaveLength(3)
  })

  it('deep-clones boards so mutating the doc does not touch the source', () => {
    const boards = sampleBoards()
    const doc = toObject(boards)
    doc.boards[0].x = 9999
    expect(boards[0].x).toBe(0)
  })
})

describe('round-trip', () => {
  it('fromObject(toObject(boards)) preserves every board and element', () => {
    const boards = sampleBoards()
    expect(fromObject(toObject(boards)).boards).toEqual(boards)
  })

  it('survives a JSON serialize/parse cycle unchanged (serialization-ready)', () => {
    const boards = sampleBoards()
    const wire = JSON.parse(JSON.stringify(toObject(boards)))
    expect(fromObject(wire).boards).toEqual(boards)
  })
})

describe('fromObject', () => {
  it('throws on non-doc input', () => {
    expect(() => fromObject(null)).toThrow()
    expect(() => fromObject({ boards: [] })).toThrow()
  })
})

describe('migrate', () => {
  it('is a no-op at the current schemaVersion', () => {
    const doc = toObject(sampleBoards())
    expect(migrate(doc)).toEqual(doc)
  })

  it('throws when the doc is newer than the supported version', () => {
    expect(() => migrate({ schemaVersion: SCHEMA_VERSION + 1, boards: [] })).toThrow()
  })

  it('throws when schemaVersion is missing', () => {
    expect(() => migrate({ boards: [] } as never)).toThrow()
  })
})
