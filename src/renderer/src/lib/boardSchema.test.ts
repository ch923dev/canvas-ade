import { describe, it, expect } from 'vitest'
import {
  SCHEMA_VERSION,
  MIN_BOARD_SIZE,
  DEFAULT_BOARD_SIZE,
  createBoard,
  toObject,
  fromObject,
  migrate,
  previewConnectorsFor,
  type Board,
  type Connector,
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
      },
      { id: 'img1', kind: 'image', x: 30, y: 30, w: 120, h: 90, assetId: 'assets/sample.png' }
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

  it('toObject round-trips groups (deep-cloned)', () => {
    const groups = [{ id: 'g1', name: 'Auth', boardIds: ['b1'] }]
    const doc = toObject([], null, [], groups)
    expect(doc.groups).toEqual(groups)
    // deep clone: mutating the input must not change the doc
    groups[0].name = 'changed'
    expect(doc.groups?.[0].name).toBe('Auth')
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

  it('persists agentSessionId + agentTranscriptPath on a terminal board', () => {
    const boards: Board[] = [
      {
        id: 'b1',
        type: 'terminal',
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        title: 'T',
        agentSessionId: 's1',
        agentTranscriptPath: '/t/s1.jsonl'
      }
    ]
    const out = fromObject(toObject(boards, null))
    const t = out.boards[0] as unknown as Record<string, unknown>
    expect(t.agentSessionId).toBe('s1')
    expect(t.agentTranscriptPath).toBe('/t/s1.jsonl')
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
      migrate({ schemaVersion: SCHEMA_VERSION + 1, viewport: null, boards: [], connectors: [] })
    ).toThrow()
  })

  it('throws when schemaVersion is missing', () => {
    expect(() => migrate({ boards: [] } as never)).toThrow()
  })
})

describe('schema v2 — viewport', () => {
  const vp: CanvasViewport = { x: -120, y: 40, zoom: 0.75 }

  it('SCHEMA_VERSION is 8', () => {
    expect(SCHEMA_VERSION).toBe(8)
  })

  it('toObject embeds the viewport and version', () => {
    const doc = toObject([], vp)
    expect(doc).toEqual({ schemaVersion: 8, viewport: vp, boards: [], connectors: [], groups: [] })
  })

  it('toObject accepts a null viewport (fit-on-load)', () => {
    expect(toObject([], null).viewport).toBeNull()
  })

  it('migrates a v1 doc (no viewport) to v8 (via v2–v7) with viewport=null', () => {
    const v1 = { schemaVersion: 1, boards: [] } as unknown
    const out = fromObject(v1)
    expect(out.schemaVersion).toBe(8)
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
    const input: CanvasDoc = { schemaVersion: 2, viewport: { ...vp }, boards: [], connectors: [] }
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

describe('BrowserBoard.previewSourceId (preview link)', () => {
  it('round-trips a valid previewSourceId through toObject/fromObject', () => {
    const term = createBoard('terminal', { id: 't1', x: 0, y: 0 })
    const browser = { ...createBoard('browser', { id: 'b1', x: 800, y: 0 }), previewSourceId: 't1' }
    const doc = toObject([term, browser], null)
    const back = fromObject(doc)
    const b = back.boards.find((x) => x.id === 'b1')
    expect(b && b.type === 'browser' ? b.previewSourceId : 'MISSING').toBe('t1')
  })

  it('prunes a dangling previewSourceId (source board absent) on load', () => {
    const browser = { ...createBoard('browser', { id: 'b1', x: 0, y: 0 }), previewSourceId: 'gone' }
    const back = fromObject(toObject([browser], null))
    const b = back.boards.find((x) => x.id === 'b1')
    expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
  })

  it('rejects a non-string previewSourceId', () => {
    const bad = {
      schemaVersion: 2,
      viewport: null,
      boards: [{ ...createBoard('browser', { id: 'b1', x: 0, y: 0 }), previewSourceId: 7 }]
    }
    expect(() => fromObject(bad)).toThrow(/previewSourceId/)
  })
})

describe('W3 schema v3', () => {
  it('SCHEMA_VERSION is >= 3 (v3 was the W3 bump)', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(3)
  })

  it('migrates a v2 doc to current version without mutating elements', () => {
    const v2: CanvasDoc = {
      schemaVersion: 2,
      viewport: null,
      connectors: [],
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [
            { id: 'n1', kind: 'note', x: 10, y: 10, w: 156, h: 96, tint: 'yellow', text: '' }
          ]
        }
      ]
    }
    const out = migrate(structuredClone(v2))
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.boards[0]).toMatchObject({ type: 'planning' })
    const planning = out.boards[0]
    if (planning.type !== 'planning') throw new Error('expected planning')
    expect(planning.elements[0]).not.toHaveProperty('locked')
    expect(planning.elements[0]).not.toHaveProperty('groupId')
  })

  it('round-trips an element carrying locked + groupId', () => {
    const doc = {
      schemaVersion: 3,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [
            {
              id: 'n1',
              kind: 'note',
              x: 0,
              y: 0,
              w: 156,
              h: 96,
              tint: 'blue',
              text: '',
              locked: true,
              groupId: 'g1'
            }
          ]
        }
      ]
    }
    const out = fromObject(doc)
    const b = out.boards[0]
    if (b.type !== 'planning') throw new Error('expected planning')
    expect(b.elements[0]).toMatchObject({ locked: true, groupId: 'g1' })
  })

  it('rejects a non-boolean locked and a non-string groupId', () => {
    const bad = (extra: Record<string, unknown>): unknown => ({
      schemaVersion: 3,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [
            { id: 'n1', kind: 'note', x: 0, y: 0, w: 156, h: 96, tint: 'plain', text: '', ...extra }
          ]
        }
      ]
    })
    expect(() => fromObject(bad({ locked: 'yes' }))).toThrow(/locked/)
    expect(() => fromObject(bad({ groupId: 42 }))).toThrow(/groupId/)
  })
})

describe('W4 image element', () => {
  const imageBoard = (assetId: unknown, extra: Record<string, unknown> = {}) => ({
    schemaVersion: SCHEMA_VERSION,
    viewport: null,
    boards: [
      {
        id: 'p1',
        type: 'planning',
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        title: 'P',
        elements: [{ id: 'i1', kind: 'image', x: 10, y: 20, w: 120, h: 90, assetId, ...extra }]
      }
    ]
  })

  it('SCHEMA_VERSION is 8', () => {
    expect(SCHEMA_VERSION).toBe(8)
  })

  it('round-trips a valid image element', () => {
    const doc = fromObject(imageBoard('assets/' + 'a'.repeat(40) + '.png'))
    const el = (doc.boards[0] as { elements: Array<{ kind: string; assetId: string }> }).elements[0]
    expect(el.kind).toBe('image')
    expect(el.assetId).toBe('assets/' + 'a'.repeat(40) + '.png')
  })

  it('rejects an empty assetId', () => {
    expect(() => fromObject(imageBoard(''))).toThrow(/assetId/)
  })

  it('rejects a non-string assetId', () => {
    expect(() => fromObject(imageBoard(123))).toThrow(/assetId/)
  })

  it('rejects non-positive w/h', () => {
    expect(() => fromObject(imageBoard('assets/x.png', { w: 0 }))).toThrow(/non-positive/)
  })

  it('migrates a v3 doc (with an image element) to the current version', () => {
    const v3 = {
      schemaVersion: 3,
      viewport: null,
      boards: [
        {
          id: 'p1',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [{ id: 'i1', kind: 'image', x: 1, y: 2, w: 50, h: 50, assetId: 'assets/y.png' }]
        }
      ]
    }
    const doc = fromObject(v3)
    expect(doc.schemaVersion).toBe(8)
    const el = (doc.boards[0] as { elements: Array<{ assetId: string; w: number }> }).elements[0]
    expect(el.assetId).toBe('assets/y.png')
    expect(el.w).toBe(50)
  })

  it('rejects a negative h', () => {
    expect(() => fromObject(imageBoard('assets/x.png', { h: -1 }))).toThrow(/non-positive/)
  })
})

// ── Named Board Groups (schema v6) ────────────────────────────────────────────
describe('schema v6 — board groups', () => {
  it('SCHEMA_VERSION is 8', () => {
    expect(SCHEMA_VERSION).toBe(8)
  })

  it('migrates a v5 doc to current (groups backfilled at the v5→v6 step)', () => {
    const v5 = { schemaVersion: 5, viewport: null, boards: [], connectors: [] }
    const migrated = migrate(v5 as never)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.groups).toEqual([])
  })

  it('preserves existing groups when migrating a v6 doc forward (6→7)', () => {
    const v6 = {
      schemaVersion: 6,
      viewport: null,
      boards: [],
      connectors: [],
      groups: [{ id: 'g1', name: 'Auth', boardIds: [] }]
    }
    const migrated = migrate(v6 as never)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.groups).toEqual([{ id: 'g1', name: 'Auth', boardIds: [] }])
  })
})

describe('fromObject — groups validation + reconciliation', () => {
  const base = (groups: unknown): unknown => ({
    schemaVersion: 6,
    viewport: null,
    boards: [
      { id: 'b1', type: 'terminal', x: 0, y: 0, w: 300, h: 200, title: 'T' },
      { id: 'b2', type: 'terminal', x: 0, y: 0, w: 300, h: 200, title: 'T' }
    ],
    connectors: [],
    groups
  })

  it('keeps a valid group and prunes boardIds that point at missing boards', () => {
    const doc = fromObject(base([{ id: 'g1', name: 'Auth', boardIds: ['b1', 'ghost'] }]))
    expect(doc.groups).toEqual([{ id: 'g1', name: 'Auth', boardIds: ['b1'] }])
  })

  it('keeps a group whose boards were all pruned (named-empty survives)', () => {
    const doc = fromObject(base([{ id: 'g1', name: 'Auth', boardIds: ['ghost'] }]))
    expect(doc.groups).toEqual([{ id: 'g1', name: 'Auth', boardIds: [] }])
  })

  it('throws on a malformed group (non-string-array boardIds)', () => {
    expect(() => fromObject(base([{ id: 'g1', name: 'Auth', boardIds: [5] }]))).toThrow(
      /fromObject/
    )
  })

  it('defaults a v6 doc with no groups field to an empty array', () => {
    const { groups: _omit, ...noGroups } = base([]) as Record<string, unknown>
    const doc = fromObject(noGroups)
    expect(doc.groups).toEqual([])
  })
})

// ── M2 spatial connectors (schema v5) ──────────────────────────────────────────
// Connector {id,sourceId,targetId,kind} on CanvasDoc. The v4→v5 migration folds each
// linked Browser's previewSourceId into a `preview` connector with the STABLE id
// `preview-<browserId>`; `previewSourceId` stays the runtime source of truth (Decision
// B: dual-source), so fromObject folds the preview connector BACK into the board and
// keeps only `orchestration` connectors in the loaded doc. Orchestration connectors are
// user-drawn board↔board cables that round-trip verbatim.
describe('M2 connectors (schema v5)', () => {
  const term = (): Board => createBoard('terminal', { id: 't1', x: 0, y: 0 })
  const browser = (previewSourceId?: string): Board => ({
    ...createBoard('browser', { id: 'b1', x: 800, y: 0 }),
    ...(previewSourceId ? { previewSourceId } : {})
  })

  describe('previewConnectorsFor (pure preview-link derivation)', () => {
    it('emits one preview connector per linked Browser with the stable preview-<id> id', () => {
      expect(previewConnectorsFor([term(), browser('t1')])).toEqual([
        { id: 'preview-b1', sourceId: 't1', targetId: 'b1', kind: 'preview' }
      ])
    })

    it('skips a Browser with no previewSourceId and one whose source is absent', () => {
      const dangling = {
        ...createBoard('browser', { id: 'b2', x: 1600, y: 0 }),
        previewSourceId: 'gone'
      }
      expect(previewConnectorsFor([term(), browser(), dangling])).toEqual([])
    })
  })

  describe('migration 4→5→6', () => {
    it('backfills an empty connectors array on a doc with no preview links', () => {
      const v4 = { schemaVersion: 4, viewport: null, boards: [term()] } as unknown as CanvasDoc
      const out = migrate(structuredClone(v4))
      expect(out.schemaVersion).toBe(SCHEMA_VERSION)
      expect(out.connectors).toEqual([])
    })

    it('folds a present + valid previewSourceId into a preview connector', () => {
      const v4 = {
        schemaVersion: 4,
        viewport: null,
        boards: [term(), browser('t1')]
      } as unknown as CanvasDoc
      const out = migrate(structuredClone(v4))
      expect(out.schemaVersion).toBe(SCHEMA_VERSION)
      expect(out.connectors).toEqual([
        { id: 'preview-b1', sourceId: 't1', targetId: 'b1', kind: 'preview' }
      ])
    })

    it('folds nothing for a dangling previewSourceId (source board absent)', () => {
      const v4 = {
        schemaVersion: 4,
        viewport: null,
        boards: [browser('gone')]
      } as unknown as CanvasDoc
      const out = migrate(structuredClone(v4))
      expect(out.connectors).toEqual([])
    })
  })

  describe('fromObject — dual-source reconciliation', () => {
    it('folds a preview connector BACK into previewSourceId and drops it from in-memory connectors', () => {
      const v4 = {
        schemaVersion: 4,
        viewport: null,
        boards: [term(), browser('t1')]
      } as unknown as CanvasDoc
      const back = fromObject(v4)
      // previewSourceId stays the runtime SoT…
      const b = back.boards.find((x) => x.id === 'b1')
      expect(b && b.type === 'browser' ? b.previewSourceId : 'MISSING').toBe('t1')
      // …and the preview connector is NOT retained in the loaded connectors array.
      expect(back.connectors).toEqual([])
    })

    it('round-trips an orchestration connector verbatim', () => {
      const orch: Connector = { id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'orchestration' }
      const back = fromObject(toObject([term(), browser()], null, [orch]))
      expect(back.connectors).toEqual([orch])
    })

    it('strips a dangling orchestration connector (an endpoint board is absent)', () => {
      const orch: Connector = { id: 'o2', sourceId: 't1', targetId: 'gone', kind: 'orchestration' }
      const back = fromObject(toObject([term(), browser()], null, [orch]))
      expect(back.connectors).toEqual([])
    })

    it('is idempotent across a re-serialized round-trip', () => {
      const orch: Connector = { id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'orchestration' }
      const once = fromObject(toObject([term(), browser('t1')], null, [orch]))
      const twice = fromObject(toObject(once.boards, once.viewport, once.connectors))
      expect(twice.connectors).toEqual(once.connectors)
      expect(twice.boards).toEqual(once.boards)
    })

    it('rejects a connector missing targetId', () => {
      const bad = {
        schemaVersion: 5,
        viewport: null,
        boards: [term(), browser()],
        connectors: [{ id: 'o1', sourceId: 't1', kind: 'orchestration' }]
      }
      expect(() => fromObject(bad)).toThrow(/connector/)
    })

    it('rejects a connector with an unknown kind', () => {
      const bad = {
        schemaVersion: 5,
        viewport: null,
        boards: [term(), browser()],
        connectors: [{ id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'wormhole' }]
      }
      expect(() => fromObject(bad)).toThrow(/connector/)
    })
  })

  it('toObject serializes the connectors it is given (deep-cloned)', () => {
    const orch: Connector = { id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'orchestration' }
    const doc = toObject([term(), browser()], null, [orch])
    expect(doc.connectors).toEqual([orch])
    expect(doc.connectors[0]).not.toBe(orch) // owns its data
  })

  // BUG-022: non-terminal previewSourceId must be pruned on load
  describe('BUG-022 — non-terminal previewSourceId pruning', () => {
    const planningBoard = (): Board => createBoard('planning', { id: 'p1', x: 0, y: 0 })
    const browserBoard = (id: string, srcId?: string): Board => ({
      ...createBoard('browser', { id, x: 800, y: 0 }),
      ...(srcId ? { previewSourceId: srcId } : {})
    })

    it('fromObject prunes previewSourceId when it points to a planning board (BUG-022)', () => {
      // planning board 'p1' EXISTS in the board set — the old code only pruned absent IDs
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        viewport: null,
        boards: [planningBoard(), browserBoard('b1', 'p1')],
        connectors: []
      }
      const out = fromObject(doc)
      const b = out.boards.find((x) => x.id === 'b1')
      // After fix: previewSourceId pointing to a non-terminal must be cleared
      expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
    })

    it('fromObject prunes previewSourceId when it points to another browser board (BUG-022)', () => {
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        viewport: null,
        boards: [browserBoard('b2'), browserBoard('b1', 'b2')],
        connectors: []
      }
      const out = fromObject(doc)
      const b = out.boards.find((x) => x.id === 'b1')
      expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
    })

    it('reconcileConnectors does NOT fold a preview connector whose sourceId is a planning board (BUG-022)', () => {
      // A preview connector with a planning board as source should be dropped
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        viewport: null,
        boards: [planningBoard(), browserBoard('b1')],
        connectors: [{ id: 'preview-b1', sourceId: 'p1', targetId: 'b1', kind: 'preview' }]
      }
      const out = fromObject(doc)
      const b = out.boards.find((x) => x.id === 'b1')
      // The fold-back must NOT set previewSourceId because the source is not a terminal
      expect(b && b.type === 'browser' ? b.previewSourceId : 'X').toBeUndefined()
    })

    it('still round-trips a valid terminal→browser previewSourceId after the fix (BUG-022 regression guard)', () => {
      const doc = {
        schemaVersion: SCHEMA_VERSION,
        viewport: null,
        boards: [term(), browser('t1')],
        connectors: []
      }
      const out = fromObject(doc)
      const b = out.boards.find((x) => x.id === 'b1')
      // The valid terminal source must still be preserved
      expect(b && b.type === 'browser' ? b.previewSourceId : 'MISSING').toBe('t1')
    })
  })
})

// ── Schema v8 — TextElement.width (area-text wrap box) ───────────────────────
describe('schema v8 — TextElement.width', () => {
  it('migrates v7 → v8 as an identity bump (text without width passes through)', () => {
    const v7 = { schemaVersion: 7, viewport: null, boards: [], connectors: [], groups: [] }
    expect(migrate(v7 as never).schemaVersion).toBe(8)
  })

  it('a v7 text element with no width survives migration to v8 unchanged (point text)', () => {
    const doc = {
      schemaVersion: 7,
      viewport: null,
      connectors: [],
      groups: [],
      boards: [
        {
          id: 'p',
          type: 'planning',
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          title: 'P',
          elements: [{ id: 't', kind: 'text', x: 1, y: 2, text: 'hi' }]
        }
      ]
    }
    const out = migrate(doc as never)
    expect(out.schemaVersion).toBe(8)
    expect((out.boards[0] as never as { elements: unknown[] }).elements[0]).toEqual({
      id: 't',
      kind: 'text',
      x: 1,
      y: 2,
      text: 'hi'
    })
  })

  it('accepts a text element with a positive width', () => {
    expect(() =>
      fromObject({
        schemaVersion: 8,
        viewport: null,
        connectors: [],
        groups: [],
        boards: [
          {
            id: 'p',
            type: 'planning',
            x: 0,
            y: 0,
            w: 400,
            h: 300,
            title: 'P',
            elements: [{ id: 't', kind: 'text', x: 0, y: 0, text: 'a', width: 200 }]
          }
        ]
      })
    ).not.toThrow()
  })

  it('rejects a text element with a non-positive / non-finite width', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        fromObject({
          schemaVersion: 8,
          viewport: null,
          connectors: [],
          groups: [],
          boards: [
            {
              id: 'p',
              type: 'planning',
              x: 0,
              y: 0,
              w: 400,
              h: 300,
              title: 'P',
              elements: [{ id: 't', kind: 'text', x: 0, y: 0, text: 'a', width: bad }]
            }
          ]
        })
      ).toThrow(/width/)
    }
  })
})

describe('schema v7 — text typography fields', () => {
  const planBoard = (els: unknown[]): unknown => ({
    id: 'p',
    type: 'planning',
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    title: 'P',
    elements: els
  })

  it('migrates a v5 doc to current leaving text elements untouched', () => {
    const v5 = {
      schemaVersion: 5,
      viewport: null,
      connectors: [],
      boards: [planBoard([{ id: 't', kind: 'text', x: 1, y: 2, text: 'hi' }])]
    }
    const out = migrate(structuredClone(v5) as never)
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect((out.boards[0] as { elements: unknown[] }).elements[0]).toEqual({
      id: 't',
      kind: 'text',
      x: 1,
      y: 2,
      text: 'hi'
    })
  })

  it('accepts a text element carrying valid typography tokens', () => {
    const doc = {
      schemaVersion: 6,
      viewport: null,
      connectors: [],
      boards: [
        planBoard([
          {
            id: 't',
            kind: 'text',
            x: 0,
            y: 0,
            text: 'styled',
            fontFamily: 'mono',
            fontSize: 'XL',
            align: 'center',
            color: 'accent',
            bold: true
          }
        ])
      ]
    }
    expect(() => fromObject(doc)).not.toThrow()
  })

  it('rejects an out-of-set token', () => {
    const bad = (field: string, value: unknown): unknown => ({
      schemaVersion: 6,
      viewport: null,
      connectors: [],
      boards: [planBoard([{ id: 't', kind: 'text', x: 0, y: 0, text: 'x', [field]: value }])]
    })
    expect(() => fromObject(bad('fontSize', 'XXL'))).toThrow(/fontSize/)
    expect(() => fromObject(bad('fontFamily', 'comic'))).toThrow(/fontFamily/)
    expect(() => fromObject(bad('align', 'justify'))).toThrow(/align/)
    expect(() => fromObject(bad('color', '#fff'))).toThrow(/color/)
    expect(() => fromObject(bad('bold', 'yes'))).toThrow(/bold/)
  })

  it('round-trips the typography fields through toObject/fromObject', () => {
    const el = {
      id: 't',
      kind: 'text' as const,
      x: 5,
      y: 6,
      text: 'rt',
      fontFamily: 'serif' as const,
      fontSize: 'L' as const,
      align: 'right' as const,
      color: 'muted' as const,
      bold: true
    }
    const board = {
      id: 'p',
      type: 'planning' as const,
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      title: 'P',
      elements: [el]
    }
    const doc = toObject([board], null)
    const back = fromObject(JSON.parse(JSON.stringify(doc)))
    const got = (back.boards[0] as { elements: unknown[] }).elements[0]
    expect(got).toEqual(el)
  })
})
