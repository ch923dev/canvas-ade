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
  type PlanningBoard,
  type CanvasDoc,
  type CanvasViewport
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
    const doc = toObject(sampleBoards(), null)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.boards).toHaveLength(3)
  })

  it('deep-clones boards so mutating the doc does not touch the source', () => {
    const boards = sampleBoards()
    const doc = toObject(boards, null)
    doc.boards[0].x = 9999
    expect(boards[0].x).toBe(0)
  })
})

describe('round-trip', () => {
  it('fromObject(toObject(boards)) preserves every board and element', () => {
    const boards = sampleBoards()
    expect(fromObject(toObject(boards, null)).boards).toEqual(boards)
  })

  it('survives a JSON serialize/parse cycle unchanged (serialization-ready)', () => {
    const boards = sampleBoards()
    const wire = JSON.parse(JSON.stringify(toObject(boards, null)))
    expect(fromObject(wire).boards).toEqual(boards)
  })
})

describe('fromObject', () => {
  it('throws on non-doc input', () => {
    expect(() => fromObject(null)).toThrow()
    expect(() => fromObject({ boards: [] })).toThrow()
  })
})

// ── Deep per-type validation (fix #5) ──────────────────────────────────────────
// A parseable envelope (schemaVersion + boards[]) is NOT enough — a corrupt board
// or element must throw so the Phase-3 persistence layer falls back to the .bak.
// `wrap` builds a minimal valid doc around an arbitrary board to exercise one path.
function wrap(board: unknown): unknown {
  return { schemaVersion: SCHEMA_VERSION, boards: [board] }
}

describe('fromObject deep validation', () => {
  it('still round-trips a fully-valid populated doc', () => {
    const boards = sampleBoards()
    expect(fromObject(toObject(boards, null)).boards).toEqual(boards)
  })

  it('throws when a board is missing required common fields', () => {
    expect(() => fromObject(wrap({ id: 't', type: 'terminal', x: 0, y: 0, w: 1, h: 1 }))).toThrow()
  })

  it('throws on a non-string id or title', () => {
    const base = { type: 'terminal', x: 0, y: 0, w: 1, h: 1, title: 'ok' }
    expect(() => fromObject(wrap({ ...base, id: 42 }))).toThrow()
    expect(() =>
      fromObject(wrap({ id: 't', type: 'terminal', x: 0, y: 0, w: 1, h: 1, title: 9 }))
    ).toThrow()
  })

  it('throws on NaN / Infinity geometry', () => {
    const ok = { id: 't', type: 'terminal', title: 'ok', x: 0, y: 0, w: 1, h: 1 }
    expect(() => fromObject(wrap({ ...ok, x: NaN }))).toThrow()
    expect(() => fromObject(wrap({ ...ok, y: Infinity }))).toThrow()
    expect(() => fromObject(wrap({ ...ok, w: -Infinity }))).toThrow()
    expect(() => fromObject(wrap({ ...ok, h: 'big' }))).toThrow()
  })

  it('throws on an unknown board type', () => {
    expect(() =>
      fromObject(wrap({ id: 'x', type: 'sticky', title: 'x', x: 0, y: 0, w: 1, h: 1 }))
    ).toThrow()
  })

  it('throws when a browser board is missing its url', () => {
    expect(() =>
      fromObject(
        wrap({ id: 'b', type: 'browser', title: 'B', x: 0, y: 0, w: 1, h: 1, viewport: 'desktop' })
      )
    ).toThrow()
  })

  it('throws when a browser board has an invalid viewport', () => {
    expect(() =>
      fromObject(
        wrap({
          id: 'b',
          type: 'browser',
          title: 'B',
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          url: 'http://x',
          viewport: 'watch'
        })
      )
    ).toThrow()
  })

  it('accepts valid optional terminal fields but throws on wrong-typed ones', () => {
    const base = { id: 't', type: 'terminal', title: 'T', x: 0, y: 0, w: 1, h: 1 }
    expect(() => fromObject(wrap({ ...base, port: 5173, shell: 'pwsh' }))).not.toThrow()
    expect(() => fromObject(wrap({ ...base, port: 'http' }))).toThrow()
    expect(() => fromObject(wrap({ ...base, launchCommand: 7 }))).toThrow()
  })

  it('throws when planning.elements is not an array', () => {
    expect(() =>
      fromObject(
        wrap({ id: 'p', type: 'planning', title: 'P', x: 0, y: 0, w: 1, h: 1, elements: {} })
      )
    ).toThrow()
  })

  it('throws on a malformed checklist item', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [
        {
          id: 'c1',
          kind: 'checklist',
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          title: 'Tasks',
          items: [{ id: 'i1', label: 'ok', done: 'yes' }]
        }
      ]
    }
    expect(() => fromObject(wrap(planning))).toThrow()
  })

  it('throws on an odd-length stroke points array', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [{ id: 's1', kind: 'stroke', x: 0, y: 0, points: [0, 0, 4] }]
    }
    expect(() => fromObject(wrap(planning))).toThrow()
  })

  it('throws on a stroke points entry that is not finite', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [{ id: 's1', kind: 'stroke', x: 0, y: 0, points: [0, NaN] }]
    }
    expect(() => fromObject(wrap(planning))).toThrow()
  })

  it('throws on an arrow with non-finite end points', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [{ id: 'a1', kind: 'arrow', x: 0, y: 0, x2: 10, y2: Infinity }]
    }
    expect(() => fromObject(wrap(planning))).toThrow()
  })

  it('throws on an unknown planning element kind', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [{ id: 'e1', kind: 'doodle', x: 0, y: 0 }]
    }
    expect(() => fromObject(wrap(planning))).toThrow()
  })

  it('throws on a note element with a bad tint or missing text', () => {
    const mk = (note: unknown): unknown => ({
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [note]
    })
    expect(() =>
      fromObject(
        wrap(mk({ id: 'n', kind: 'note', x: 0, y: 0, w: 1, h: 1, text: 'hi', tint: 'red' }))
      )
    ).toThrow()
    expect(() =>
      fromObject(wrap(mk({ id: 'n', kind: 'note', x: 0, y: 0, w: 1, h: 1, tint: 'yellow' })))
    ).toThrow()
  })

  it('throws on a text element missing its content', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      elements: [{ id: 'x1', kind: 'text', x: 0, y: 0 }]
    }
    expect(() => fromObject(wrap(planning))).toThrow()
  })
})

// ── Degenerate geometry + load-floor clamp (BUG-025) ───────────────────────────
describe('fromObject geometry validation', () => {
  const okBoard = { id: 't', type: 'terminal', title: 'T', x: 0, y: 0, w: 300, h: 200 }

  it('rejects a finite but non-positive board width (w: 0)', () => {
    expect(() => fromObject(wrap({ ...okBoard, w: 0 }))).toThrow()
  })

  it('rejects a finite but negative board height (h: -50)', () => {
    expect(() => fromObject(wrap({ ...okBoard, h: -50 }))).toThrow()
  })

  it('clamps a valid below-minimum board size (w: 5) up to MIN_BOARD_SIZE instead of dropping it', () => {
    const out = fromObject(wrap({ ...okBoard, w: 5, h: 5 }))
    expect(out.boards[0].w).toBe(MIN_BOARD_SIZE.w)
    expect(out.boards[0].h).toBe(MIN_BOARD_SIZE.h)
  })

  it('rejects a note element with non-positive w/h', () => {
    const mk = (note: unknown): unknown => ({
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      elements: [note]
    })
    expect(() =>
      fromObject(
        wrap(mk({ id: 'n', kind: 'note', x: 0, y: 0, w: -10, h: 0, text: 'hi', tint: 'yellow' }))
      )
    ).toThrow()
  })

  it('accepts a checklist element with the legitimately-seeded h: 0 (height is content-driven)', () => {
    const planning = {
      id: 'p',
      type: 'planning',
      title: 'P',
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      elements: [
        { id: 'c1', kind: 'checklist', x: 0, y: 0, w: 220, h: 0, title: 'Tasks', items: [] }
      ]
    }
    expect(() => fromObject(wrap(planning))).not.toThrow()
  })
})

// ── Load-path ownership: input doc is deep-cloned (BUG-027) ─────────────────────
describe('fromObject load-path clone', () => {
  it('deep-clones boards so mutating the input doc does not touch the returned boards', () => {
    const doc = toObject(sampleBoards(), null) // a fresh, valid current-version doc
    const out = fromObject(doc)
    doc.boards[0].x = 9999
    expect(out.boards[0].x).toBe(0)
  })
})

describe('migrate', () => {
  it('is a no-op at the current schemaVersion', () => {
    const doc = toObject(sampleBoards(), null)
    expect(migrate(doc)).toEqual(doc)
  })

  it('throws when the doc is newer than the supported version', () => {
    expect(() =>
      migrate({ schemaVersion: SCHEMA_VERSION + 1, viewport: null, boards: [] })
    ).toThrow()
  })

  it('throws when schemaVersion is missing', () => {
    expect(() => migrate({ boards: [] } as never)).toThrow()
  })
})

describe('schema v2 — viewport', () => {
  const vp: CanvasViewport = { x: -120, y: 40, zoom: 0.75 }

  it('SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2)
  })

  it('toObject embeds the viewport and version', () => {
    const doc = toObject([], vp)
    expect(doc).toEqual({ schemaVersion: 2, viewport: vp, boards: [] })
  })

  it('toObject accepts a null viewport (fit-on-load)', () => {
    expect(toObject([], null).viewport).toBeNull()
  })

  it('migrates a v1 doc (no viewport) to v2 with viewport=null', () => {
    const v1 = { schemaVersion: 1, boards: [] } as unknown
    const out = fromObject(v1)
    expect(out.schemaVersion).toBe(2)
    expect(out.viewport).toBeNull()
  })

  it('coerces an invalid viewport to null rather than throwing', () => {
    const bad = { schemaVersion: 2, viewport: { x: 0, y: 0, zoom: 0 }, boards: [] } as unknown
    expect(fromObject(bad).viewport).toBeNull()
    const nan = { schemaVersion: 2, viewport: { x: NaN, y: 0, zoom: 1 }, boards: [] } as unknown
    expect(fromObject(nan).viewport).toBeNull()
  })

  it('round-trips a valid viewport', () => {
    const doc = toObject([], vp)
    const back = fromObject(JSON.parse(JSON.stringify(doc)))
    expect(back.viewport).toEqual(vp)
  })

  it('fromObject deep-clones — returned doc never aliases input (BUG-027)', () => {
    const input: CanvasDoc = { schemaVersion: 2, viewport: { ...vp }, boards: [] }
    const out = fromObject(input)
    expect(out).not.toBe(input)
    expect(out.viewport).not.toBe(input.viewport)
  })

  it('migrate result is a fresh object, not the input ref (BUG-027)', () => {
    const input = { schemaVersion: 1, boards: [] } as unknown as CanvasDoc
    const out = fromObject(input)
    expect(out).not.toBe(input)
  })
})
