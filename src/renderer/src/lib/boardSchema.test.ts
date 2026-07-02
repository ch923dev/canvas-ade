import { describe, it, expect } from 'vitest'
import {
  SCHEMA_VERSION,
  MIN_READER_VERSION,
  MIN_BOARD_SIZE,
  DEFAULT_BOARD_SIZE,
  DEFAULT_BACKGROUND_DIM,
  DEFAULT_BACKGROUND_SATURATION,
  createBoard,
  toObject,
  fromObject,
  migrate,
  previewConnectorsFor,
  type Board,
  type BrowserViewport,
  type CanvasBackground,
  type Connector,
  type PlanningBoard,
  type TerminalBoard,
  type DataFlowBoard,
  type KanbanBoard,
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
    for (const type of ['terminal', 'browser', 'planning', 'command'] as const) {
      expect(createBoard(type, { id: type, x: 0, y: 0 }).title.length).toBeGreaterThan(0)
    }
  })

  it('creates a command board with type only (no per-type persisted fields)', () => {
    const b = createBoard('command', { id: 'c1', x: 5, y: 6 })
    expect(b.type).toBe('command')
    expect(b.title).toBe('Orchestrator')
    // The persisted shape is just BoardCommon — the queue is ephemeral commandStore state.
    expect(Object.keys(b).sort()).toEqual(['h', 'id', 'title', 'type', 'w', 'x', 'y'])
  })

  it('creates an unbound dataflow board with type only (inferred model is ephemeral)', () => {
    const b = createBoard('dataflow', { id: 'df1', x: 5, y: 6 })
    expect(b.type).toBe('dataflow')
    expect(b.title).toBe('Data Flow')
    // Unbound by default — just BoardCommon (no sourceBoardId key).
    expect(Object.keys(b).sort()).toEqual(['h', 'id', 'title', 'type', 'w', 'x', 'y'])
  })

  it('binds a dataflow board to a source Browser board via opts.sourceBoardId', () => {
    const b = createBoard('dataflow', { id: 'df2', x: 0, y: 0, sourceBoardId: 'b1' })
    expect(b).toMatchObject({ type: 'dataflow', sourceBoardId: 'b1' })
  })

  it('creates a kanban board with the four default columns and no cards at 900x520', () => {
    const b = createBoard('kanban', { id: 'k1', x: 5, y: 6 })
    expect(b.type).toBe('kanban')
    expect(b.title).toBe('Kanban')
    expect(b).toMatchObject({ w: 900, h: 520 })
    const k = b as KanbanBoard
    expect(k.columns.map((c) => c.id)).toEqual(['backlog', 'in-progress', 'review', 'done'])
    expect(k.cards).toEqual([])
  })
})

describe('kanban board (v17)', () => {
  it('round-trips columns + cards (tag / assignee / ref) through toObject/fromObject', () => {
    const k: KanbanBoard = {
      id: 'k2',
      type: 'kanban',
      x: 0,
      y: 0,
      w: 900,
      h: 520,
      title: 'Plan',
      columns: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B', wip: 3 }
      ],
      cards: [
        { id: 'c1', columnId: 'a', title: 'one', tag: 'feature', assignee: 'claude', ref: 'PR #1' },
        { id: 'c2', columnId: 'b', title: 'two' }
      ]
    }
    expect(fromObject(toObject([k], null)).boards[0]).toEqual(k)
  })

  it('DROPS a card whose columnId matches no column (stale ref), keeping the board', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      viewport: null,
      boards: [
        {
          id: 'k3',
          type: 'kanban',
          x: 0,
          y: 0,
          w: 900,
          h: 520,
          title: 'Plan',
          columns: [{ id: 'a', title: 'A' }],
          cards: [
            { id: 'ok', columnId: 'a', title: 'kept' },
            { id: 'gone', columnId: 'ghost', title: 'dropped' }
          ]
        }
      ]
    }
    const out = fromObject(doc as unknown as CanvasDoc).boards[0] as KanbanBoard
    expect(out.cards.map((c) => c.id)).toEqual(['ok'])
  })

  it('rejects a card with a non-string columnId (deep validation)', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      viewport: null,
      boards: [
        {
          id: 'k4',
          type: 'kanban',
          x: 0,
          y: 0,
          w: 900,
          h: 520,
          title: 'Plan',
          columns: [{ id: 'a', title: 'A' }],
          cards: [{ id: 'bad', columnId: 5, title: 'x' }]
        }
      ]
    }
    expect(() => fromObject(doc as unknown as CanvasDoc)).toThrow(/columnId/)
  })

  it('rejects a column with a non-positive wip (0 / negative — a hand-edited doc), matching the setColumnWip write-path range', () => {
    const withWip = (wip: number): unknown => ({
      schemaVersion: SCHEMA_VERSION,
      minReaderVersion: MIN_READER_VERSION,
      viewport: null,
      boards: [
        {
          id: 'k6',
          type: 'kanban',
          x: 0,
          y: 0,
          w: 900,
          h: 520,
          title: 'Plan',
          columns: [{ id: 'a', title: 'A', wip }],
          cards: []
        }
      ]
    })
    expect(() => fromObject(withWip(0) as unknown as CanvasDoc)).toThrow(/wip/)
    expect(() => fromObject(withWip(-1) as unknown as CanvasDoc)).toThrow(/wip/)
  })

  it('migrate bumps a v16 doc to v17 (identity — the type only appears on new boards)', () => {
    const migrated = migrate({
      schemaVersion: 16,
      viewport: null,
      boards: []
    } as unknown as CanvasDoc)
    expect(migrated.schemaVersion).toBe(17)
  })

  it('stamps the breaking reader floor (minReaderVersion 17) on write', () => {
    const doc = toObject([createBoard('kanban', { id: 'k5', x: 0, y: 0 })], null)
    expect(doc.minReaderVersion).toBe(17)
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
      planning: { w: 516, h: 366 },
      command: { w: 760, h: 440 },
      file: { w: 520, h: 380 },
      dataflow: { w: 760, h: 520 },
      kanban: { w: 900, h: 520 }
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
  const kanban: KanbanBoard = {
    id: 'k1',
    type: 'kanban',
    x: 1500,
    y: 0,
    w: 900,
    h: 520,
    title: 'Roadmap',
    columns: [
      { id: 'todo', title: 'To Do' },
      { id: 'doing', title: 'Doing', wip: 2 }
    ],
    cards: [
      {
        id: 'ka',
        columnId: 'todo',
        title: 'Design schema',
        tag: 'feature',
        assignee: 'claude',
        ref: 'PR #268'
      },
      { id: 'kb', columnId: 'doing', title: 'Render board' }
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
    planning,
    kanban
  ]
}

describe('toObject', () => {
  it('wraps boards with the current schemaVersion', () => {
    const doc = toObject(sampleBoards(), null)
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
    expect(doc.boards).toHaveLength(4)
  })

  // PERSIST-01: toObject no longer deep-clones — it ALIASES boards/connectors/groups/
  // background by reference (zero deep passes; the IPC save boundary and fromObject own
  // the isolation). These tests pin that contract so a future "defensive clone" can't
  // silently re-add the per-save deep pass the audit removed. The doc is read-only by
  // contract; callers must never mutate it.
  it('aliases boards by reference (no deep clone — the deep pass is the audit regression)', () => {
    const boards = sampleBoards()
    const doc = toObject(boards, null)
    expect(doc.boards).toBe(boards)
    expect(doc.boards[0]).toBe(boards[0])
  })

  it('aliases connectors / groups / background by reference (no deep clone)', () => {
    const connectors = [{ id: 'preview-b', sourceId: 't', targetId: 'b', kind: 'preview' as const }]
    const groups = [{ id: 'g1', name: 'Auth', boardIds: ['b1'] }]
    const background = {
      kind: 'none' as const,
      dim: 0.25,
      saturation: 0.7,
      gridDots: false
    }
    const doc = toObject([], null, connectors, groups, background)
    expect(doc.connectors).toBe(connectors)
    expect(doc.groups).toBe(groups)
    expect(doc.background).toBe(background)
  })

  // The camera object is the one exception: it stays a shallow copy (O(1), not a deep
  // pass) so the live viewport object never aliases into a persisted doc.
  it('shallow-copies the viewport (does not alias the camera object)', () => {
    const vp = { x: 1, y: 2, zoom: 0.5 }
    const doc = toObject([], vp)
    expect(doc.viewport).toEqual(vp)
    expect(doc.viewport).not.toBe(vp)
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

  it('round-trips a valid command board (common fields only)', () => {
    const cmd = createBoard('command', { id: 'c1', x: 12, y: 34 })
    expect(fromObject(toObject([cmd], null)).boards).toEqual([cmd])
  })

  it('throws when a browser board is missing its url', () => {
    expect(() =>
      fromObject(
        wrap({ id: 'b', type: 'browser', title: 'B', x: 0, y: 0, w: 1, h: 1, viewport: 'desktop' })
      )
    ).toThrow()
  })

  it('coerces an UNRECOGNIZED browser viewport to desktop (v15 forward-compat, not a throw)', () => {
    // A preset value from a NEWER app rides in additively (floor stays 15); fromObject must
    // degrade-not-reject it to `desktop` rather than failing the whole document.
    const out = fromObject(
      wrap({
        id: 'b',
        type: 'browser',
        title: 'B',
        x: 0,
        y: 0,
        w: 700,
        h: 500,
        url: 'http://x',
        viewport: 'watch'
      })
    )
    expect((out.boards[0] as { viewport: BrowserViewport }).viewport).toBe('desktop')
  })

  it('round-trips the wide-desktop viewports (qhd / uhd) unchanged (v15)', () => {
    for (const viewport of ['qhd', 'uhd'] as const) {
      const out = fromObject(
        wrap({
          id: `b-${viewport}`,
          type: 'browser',
          title: 'B',
          x: 0,
          y: 0,
          w: 700,
          h: 500,
          url: 'http://x',
          viewport
        })
      )
      expect((out.boards[0] as { viewport: BrowserViewport }).viewport).toBe(viewport)
    }
  })

  it('accepts valid optional terminal fields but throws on wrong-typed ones', () => {
    const base = { id: 't', type: 'terminal', title: 'T', x: 0, y: 0, w: 1, h: 1 }
    expect(() => fromObject(wrap({ ...base, port: 5173, shell: 'pwsh' }))).not.toThrow()
    expect(() => fromObject(wrap({ ...base, port: 'http' }))).toThrow()
    expect(() => fromObject(wrap({ ...base, launchCommand: 7 }))).toThrow()
    // v16 theming: a string themeId/fontFamilyId is accepted; a non-string throws.
    expect(() =>
      fromObject(wrap({ ...base, themeId: 'dracula', fontFamilyId: 'geist' }))
    ).not.toThrow()
    expect(() => fromObject(wrap({ ...base, themeId: 7 }))).toThrow()
    expect(() => fromObject(wrap({ ...base, fontFamilyId: false }))).toThrow()
  })

  it('PRESERVES an unknown themeId/fontFamilyId verbatim (forward-compat — degrade is at render)', () => {
    // A doc written by a NEWER build carries a theme id this build doesn't know. assertBoard must
    // NOT reject it (no closed-enum check), and fromObject must NOT rewrite it — else an older app
    // would destroy the user's choice on a save round-trip (ADR 0007, mirrors background.scene).
    const board = {
      id: 't',
      type: 'terminal',
      title: 'T',
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      themeId: 'some-future-theme',
      fontFamilyId: 'some-future-font'
    }
    const out = fromObject(wrap(board)).boards[0] as {
      themeId?: string
      fontFamilyId?: string
    }
    expect(out.themeId).toBe('some-future-theme')
    expect(out.fontFamilyId).toBe('some-future-font')
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

  // v11/S4 diagram element validation.
  const mkDiagram = (diagram: unknown): unknown => ({
    id: 'p',
    type: 'planning',
    title: 'P',
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    elements: [diagram]
  })
  const okDiagram = {
    id: 'd1',
    kind: 'diagram',
    x: 0,
    y: 0,
    w: 280,
    h: 200,
    source: 'graph TD\n A-->B',
    engine: 'mermaid'
  }

  it('accepts a valid diagram element (svgCache optional)', () => {
    expect(() => fromObject(wrap(mkDiagram(okDiagram)))).not.toThrow()
    expect(() =>
      fromObject(wrap(mkDiagram({ ...okDiagram, svgCache: 'assets/abc.svg' })))
    ).not.toThrow()
  })

  it('throws on a diagram with a non-string source, bad engine, non-positive size, or empty svgCache', () => {
    expect(() => fromObject(wrap(mkDiagram({ ...okDiagram, source: 42 })))).toThrow()
    expect(() => fromObject(wrap(mkDiagram({ ...okDiagram, engine: 'graphviz' })))).toThrow()
    expect(() => fromObject(wrap(mkDiagram({ ...okDiagram, w: 0 })))).toThrow()
    expect(() => fromObject(wrap(mkDiagram({ ...okDiagram, svgCache: '' })))).toThrow()
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

  // v11/S4 (diagram kind), v12 (command board type), v13 (file board + fileref element), v14
  // (dataflow board type) and v15 (qhd/uhd viewport presets) are all breaking → SCHEMA_VERSION and
  // the compat floor moved with each. migrate() always brings a doc to the CURRENT version (15).
  it('migrates a v10 doc forward to the current version without touching existing elements', () => {
    const note = { id: 'n', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'hi', tint: 'yellow' }
    const v10 = {
      schemaVersion: 10,
      viewport: null,
      connectors: [],
      boards: [
        { id: 'p', type: 'planning', title: 'P', x: 0, y: 0, w: 300, h: 200, elements: [note] }
      ]
    }
    const out = migrate(structuredClone(v10) as never) as CanvasDoc
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(17)
    expect(MIN_READER_VERSION).toBe(17)
    expect((out.boards[0] as { elements: unknown[] }).elements).toEqual([note])
  })

  // v13/file-tree S1: the `file` board type + `fileref` element kind are breaking → both
  // SCHEMA_VERSION and the compat floor move to 13. migrate() brings a v11 doc all the way to the
  // current version; the bump is identity (the new type/kind only appear on newly-authored content),
  // so an existing planning board rides through untouched.
  it('migrates a v11 doc to the current version without touching existing boards', () => {
    const note = { id: 'n', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: 'hi', tint: 'yellow' }
    const v11 = {
      schemaVersion: 11,
      minReaderVersion: 11,
      viewport: null,
      connectors: [],
      boards: [
        { id: 'p', type: 'planning', title: 'P', x: 0, y: 0, w: 300, h: 200, elements: [note] }
      ]
    }
    const out = migrate(structuredClone(v11) as never) as CanvasDoc
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect((out.boards[0] as { elements: unknown[] }).elements).toEqual([note])
  })

  // v12: a NEW BOARD TYPE is breaking (a pre-12 assertBoard throws on the unknown type), so both
  // SCHEMA_VERSION and the floor move to 12. The migration is identity — `command` only appears on
  // newly-authored boards, so a v11 doc has nothing to backfill.
  it('migrates a v11 doc (command type bump) to the current version as an identity bump', () => {
    const v11 = {
      schemaVersion: 11,
      minReaderVersion: 11,
      viewport: null,
      connectors: [],
      groups: [],
      boards: [{ id: 't', type: 'terminal', title: 'T', x: 0, y: 0, w: 300, h: 200 }]
    }
    const out = migrate(structuredClone(v11) as never) as CanvasDoc
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.boards).toEqual(v11.boards)
  })

  // v14: a NEW BOARD TYPE (`dataflow`) is breaking — both SCHEMA_VERSION and the floor move to 14.
  // The migration is identity (the type only appears on newly-authored boards), so a v13 doc has
  // nothing to backfill.
  it('migrates a v13 doc (dataflow type bump) to the current version as an identity bump', () => {
    const v13 = {
      schemaVersion: 13,
      minReaderVersion: 13,
      viewport: null,
      connectors: [],
      groups: [],
      boards: [{ id: 't', type: 'terminal', title: 'T', x: 0, y: 0, w: 300, h: 200 }]
    }
    const out = migrate(structuredClone(v13) as never) as CanvasDoc
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.boards).toEqual(v13.boards)
  })

  // v15: the `qhd`/`uhd` BrowserBoard viewport presets are breaking — both SCHEMA_VERSION and the
  // floor move to 15. The migration is identity (the values only appear on newly-selected boards),
  // so a v14 doc with an existing `desktop` browser board has nothing to backfill.
  it('migrates a v14 doc (viewport-preset bump) to the current version as an identity bump', () => {
    const v14 = {
      schemaVersion: 14,
      minReaderVersion: 14,
      viewport: null,
      connectors: [],
      groups: [],
      boards: [
        {
          id: 'b',
          type: 'browser',
          title: 'B',
          x: 0,
          y: 0,
          w: 700,
          h: 500,
          url: 'http://x',
          viewport: 'desktop'
        }
      ]
    }
    const out = migrate(structuredClone(v14) as never) as CanvasDoc
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.boards).toEqual(v14.boards)
  })

  // v16 (terminal themeId + fontFamilyId, Lane B) was ADDITIVE; v17 (the `kanban` board type) is the
  // next breaking bump. migrate() composes every step forward to the CURRENT version — each step here
  // is an identity migration (the new fields/type only appear on new content), so a v15 doc with an
  // existing un-themed terminal rides through untouched to the current version.
  it('migrates a v15 doc forward to the current version, preserving the un-themed terminal (identity)', () => {
    const v15 = {
      schemaVersion: 15,
      minReaderVersion: 15,
      viewport: null,
      connectors: [],
      groups: [],
      boards: [{ id: 't', type: 'terminal', title: 'T', x: 0, y: 0, w: 300, h: 200 }]
    }
    const out = migrate(structuredClone(v15) as never) as CanvasDoc
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.boards).toEqual(v15.boards)
  })

  // v16 round-trip: a themed terminal survives toObject → wire → fromObject byte-for-byte.
  it('round-trips a themed terminal board byte-for-byte', () => {
    const boards: Board[] = [
      {
        id: 't',
        type: 'terminal',
        x: 0,
        y: 0,
        w: 300,
        h: 200,
        title: 'T',
        themeId: 'dracula',
        fontFamilyId: 'geist'
      }
    ]
    const wire = JSON.parse(JSON.stringify(toObject(boards, null)))
    expect(fromObject(wire).boards).toEqual(boards)
  })

  // v14 round-trip: a Data-Flow board (bound + unbound) survives toObject → wire → fromObject.
  it('round-trips a dataflow board (bound + unbound) byte-for-byte', () => {
    const boards: Board[] = [
      {
        id: 'b1',
        type: 'browser',
        x: 0,
        y: 0,
        w: 700,
        h: 500,
        title: 'App',
        url: 'http://x',
        viewport: 'desktop'
      },
      {
        id: 'df1',
        type: 'dataflow',
        x: 800,
        y: 0,
        w: 760,
        h: 520,
        title: 'Data Flow',
        sourceBoardId: 'b1'
      },
      { id: 'df2', type: 'dataflow', x: 800, y: 600, w: 760, h: 520, title: 'Data Flow' }
    ]
    const wire = JSON.parse(JSON.stringify(toObject(boards, null)))
    expect(fromObject(wire).boards).toEqual(boards)
  })

  // The sourceBoardId binding mirrors previewSourceId: a dangling / non-Browser source is dropped
  // on load (the board reopens unbound), never failing the document.
  it('drops a dataflow sourceBoardId pointing at a missing or non-Browser board', () => {
    const boards: Board[] = [
      { id: 't1', type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: 'T' },
      {
        id: 'dfGone',
        type: 'dataflow',
        x: 0,
        y: 0,
        w: 760,
        h: 520,
        title: 'DF',
        sourceBoardId: 'ghost'
      },
      {
        id: 'dfTerm',
        type: 'dataflow',
        x: 0,
        y: 0,
        w: 760,
        h: 520,
        title: 'DF',
        sourceBoardId: 't1'
      }
    ]
    const out = fromObject(JSON.parse(JSON.stringify(toObject(boards, null))))
    const dfGone = out.boards.find((b) => b.id === 'dfGone') as DataFlowBoard
    const dfTerm = out.boards.find((b) => b.id === 'dfTerm') as DataFlowBoard
    expect(dfGone.sourceBoardId).toBeUndefined() // source board does not exist
    expect(dfTerm.sourceBoardId).toBeUndefined() // source is a terminal, not a browser
  })

  // A dataflow board with a non-string sourceBoardId is rejected by deep validation (→ .bak fallback).
  it('rejects a dataflow board with a non-string sourceBoardId', () => {
    expect(() =>
      fromObject(
        wrap({
          id: 'df',
          type: 'dataflow',
          x: 0,
          y: 0,
          w: 760,
          h: 520,
          title: 'DF',
          sourceBoardId: 7
        })
      )
    ).toThrow()
  })

  it('throws when a newer doc has NO minReaderVersion (pre-floor strict behavior)', () => {
    expect(() =>
      migrate({ schemaVersion: SCHEMA_VERSION + 1, viewport: null, boards: [], connectors: [] })
    ).toThrow(/newer than supported/)
  })

  // ADR 0007: an additive bump (writer kept the compat floor at/below us) opens as-is.
  it('opens a NEWER doc as-is when minReaderVersion ≤ SCHEMA_VERSION (additive bump)', () => {
    const newer: CanvasDoc = {
      schemaVersion: SCHEMA_VERSION + 3,
      minReaderVersion: SCHEMA_VERSION,
      viewport: null,
      boards: [],
      connectors: []
    }
    expect(migrate(newer)).toEqual(newer)
  })

  it('refuses a newer doc whose minReaderVersion is above us (breaking change)', () => {
    expect(() =>
      migrate({
        schemaVersion: SCHEMA_VERSION + 3,
        minReaderVersion: SCHEMA_VERSION + 2,
        viewport: null,
        boards: [],
        connectors: []
      })
    ).toThrow(/newer than supported.*update the app/s)
  })

  it('toObject stamps minReaderVersion = MIN_READER_VERSION (≤ SCHEMA_VERSION)', () => {
    const doc = toObject([], null)
    expect(doc.minReaderVersion).toBe(MIN_READER_VERSION)
    expect(MIN_READER_VERSION).toBeLessThanOrEqual(SCHEMA_VERSION)
  })

  // The data-preservation claim behind ADR 0007: unknown OPTIONAL board fields from a
  // newer schema ride through fromObject (structuredClone passthrough) so an old
  // reader's save round-trip does not strip them.
  it('fromObject preserves unknown optional board fields from a newer additive schema', () => {
    const doc = toObject(sampleBoards(), null) as CanvasDoc & {
      boards: (Board & { futureOptional?: string })[]
    }
    doc.schemaVersion = SCHEMA_VERSION + 1
    doc.minReaderVersion = MIN_READER_VERSION
    doc.boards[0].futureOptional = 'kept'
    const out = fromObject(doc)
    expect((out.boards[0] as Board & { futureOptional?: string }).futureOptional).toBe('kept')
  })

  it('throws when schemaVersion is missing', () => {
    expect(() => migrate({ boards: [] } as never)).toThrow()
  })

  // #134 review r1: a breaking-change doc usually carries a NEW BOARD TYPE — the floor
  // refuse must fire BEFORE deep validation in fromObject, or the user gets assertBoard's
  // "unknown type" instead of the actionable update-the-app message.
  it('fromObject surfaces the update-the-app message for an above-floor doc with an unknown board type', () => {
    const futuristic = {
      schemaVersion: SCHEMA_VERSION + 2,
      minReaderVersion: SCHEMA_VERSION + 2,
      viewport: null,
      boards: [{ id: 'q1', type: 'quantum', x: 0, y: 0, w: 300, h: 200, title: 'Q' }],
      connectors: []
    }
    expect(() => fromObject(futuristic)).toThrow(/newer than supported.*update the app/s)
  })
})

describe('schema v2 — viewport', () => {
  const vp: CanvasViewport = { x: -120, y: 40, zoom: 0.75 }

  it('SCHEMA_VERSION is 17', () => {
    expect(SCHEMA_VERSION).toBe(17)
  })

  it('toObject embeds the viewport and version', () => {
    const doc = toObject([], vp)
    expect(doc).toEqual({
      schemaVersion: 17,
      minReaderVersion: 17,
      viewport: vp,
      boards: [],
      connectors: [],
      groups: []
    })
  })

  it('toObject accepts a null viewport (fit-on-load)', () => {
    expect(toObject([], null).viewport).toBeNull()
  })

  it('migrates a v1 doc (no viewport) to v8 (via v2–v7) with viewport=null', () => {
    const v1 = { schemaVersion: 1, boards: [] } as unknown
    const out = fromObject(v1)
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
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

  it('SCHEMA_VERSION is 17', () => {
    expect(SCHEMA_VERSION).toBe(17)
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
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION)
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
  it('SCHEMA_VERSION is 17', () => {
    expect(SCHEMA_VERSION).toBe(17)
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

  it('toObject serializes the connectors it is given (aliased, not cloned)', () => {
    const orch: Connector = { id: 'o1', sourceId: 't1', targetId: 'b1', kind: 'orchestration' }
    const conns = [orch]
    const doc = toObject([term(), browser()], null, conns)
    expect(doc.connectors).toEqual([orch])
    // PERSIST-01: aliases the given array by reference (no deep clone — the IPC save
    // boundary / fromObject own the isolation; the doc is read-only by contract).
    expect(doc.connectors).toBe(conns)
    expect(doc.connectors[0]).toBe(orch)
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
    expect(migrate(v7 as never).schemaVersion).toBe(SCHEMA_VERSION)
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
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
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

describe('terminal fontSize (zero-migration optional field)', () => {
  it('round-trips a terminal fontSize (integer)', () => {
    const board = {
      ...createBoard('terminal', { id: 't1', x: 0, y: 0 }),
      fontSize: 11
    } as TerminalBoard
    const restored = fromObject(toObject([board], null))
    expect((restored.boards[0] as TerminalBoard).fontSize).toBe(11)
  })
  it('round-trips a terminal fontSize (float 12.5 — the actual default)', () => {
    const board = {
      ...createBoard('terminal', { id: 't1', x: 0, y: 0 }),
      fontSize: 12.5
    } as TerminalBoard
    const restored = fromObject(toObject([board], null))
    expect((restored.boards[0] as TerminalBoard).fontSize).toBe(12.5)
  })
  it('an old terminal without fontSize still parses (field absent)', () => {
    const board = createBoard('terminal', { id: 't1', x: 0, y: 0 })
    const restored = fromObject(toObject([board], null))
    expect((restored.boards[0] as TerminalBoard).fontSize).toBeUndefined()
  })
  it('rejects a non-numeric terminal fontSize', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      viewport: null,
      boards: [{ ...createBoard('terminal', { id: 't1', x: 0, y: 0 }), fontSize: 'big' }],
      connectors: [],
      groups: []
    }
    expect(() => fromObject(doc)).toThrow(/fontSize/)
  })
  it('rejects a zero or negative terminal fontSize', () => {
    const mk = (fs: number) => ({
      schemaVersion: SCHEMA_VERSION,
      viewport: null,
      boards: [{ ...createBoard('terminal', { id: 't1', x: 0, y: 0 }), fontSize: fs }],
      connectors: [],
      groups: []
    })
    expect(() => fromObject(mk(0))).toThrow(/fontSize/)
    expect(() => fromObject(mk(-5))).toThrow(/fontSize/)
  })
  it('clamps an out-of-band but positive fontSize into the [MIN,MAX] band on load', () => {
    const mk = (fs: number) => ({
      schemaVersion: SCHEMA_VERSION,
      viewport: null,
      boards: [{ ...createBoard('terminal', { id: 't1', x: 0, y: 0 }), fontSize: fs }],
      connectors: [],
      groups: []
    })
    // a hand-edited canvas.json with a tiny/huge positive value normalizes to the
    // band so the stored value matches what renders (was: passes validation, snaps at use)
    expect((fromObject(mk(0.001)).boards[0] as TerminalBoard).fontSize).toBe(8)
    expect((fromObject(mk(999)).boards[0] as TerminalBoard).fontSize).toBe(22)
    // an in-band value is left untouched
    expect((fromObject(mk(14)).boards[0] as TerminalBoard).fontSize).toBe(14)
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

// ── Canvas backdrop (schema v9) ─────────────────────────────────────────────────
// Optional root `background` (wallpaper/scene + dim/saturation/grid). Settings-class:
// degrade-don't-reject on load — a malformed backdrop must never send the document to
// .bak recovery (boards always win). See reconcileBackground in boardSchema.ts.
describe('schema v9 — canvas backdrop', () => {
  const v8doc = (background?: unknown): unknown => ({
    schemaVersion: 8,
    viewport: null,
    boards: [],
    connectors: [],
    groups: [],
    ...(background !== undefined ? { background } : {})
  })
  const valid: CanvasBackground = {
    kind: 'scene',
    scene: 'blossom-river',
    dim: 0.25,
    saturation: 0.7,
    gridDots: false
  }

  it('migrates a v8 doc to current with no background (identity bump)', () => {
    const migrated = migrate(v8doc() as never)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
    expect(migrated.background).toBeUndefined()
  })

  it('toObject omits the background key when unset (backdrop-less save is byte-identical)', () => {
    expect('background' in toObject([], null)).toBe(false)
    expect('background' in toObject([], null, [], [], null)).toBe(false)
  })

  it('toObject embeds the background it is given (aliased, not cloned)', () => {
    const doc = toObject([], null, [], [], valid)
    expect(doc.background).toEqual(valid)
    // PERSIST-01: aliases by reference (no deep clone); see the connectors test above.
    expect(doc.background).toBe(valid)
  })

  it('round-trips a valid scene background through JSON', () => {
    const doc = toObject([], null, [], [], valid)
    const back = fromObject(JSON.parse(JSON.stringify(doc)))
    expect(back.background).toEqual(valid)
  })

  it('round-trips a file background with sceneVariant-free shape', () => {
    const bg: CanvasBackground = {
      kind: 'file',
      assetId: 'assets/' + 'a'.repeat(40) + '.png',
      dim: 0.5,
      saturation: 1,
      gridDots: true,
      gridStyle: 'cross'
    }
    const back = fromObject(toObject([], null, [], [], bg))
    expect(back.background).toEqual(bg)
  })

  it('preserves an unrecognized scene id verbatim (forward-compat with newer preset packs)', () => {
    const back = fromObject(v8doc({ ...valid, scene: 'not-shipped-yet' }))
    expect(back.background?.scene).toBe('not-shipped-yet')
  })

  it('preserves sceneVariant only on a scene background', () => {
    const back = fromObject(v8doc({ ...valid, sceneVariant: 'dusk' }))
    expect(back.background?.sceneVariant).toBe('dusk')
  })

  it('clamps out-of-band dim and saturation', () => {
    const back = fromObject(v8doc({ ...valid, dim: 2, saturation: 0 }))
    expect(back.background?.dim).toBe(0.85)
    expect(back.background?.saturation).toBe(0.2)
  })

  it('defaults non-finite dim/saturation and non-boolean gridDots', () => {
    const back = fromObject(v8doc({ ...valid, dim: 'x', saturation: NaN, gridDots: 'yes' }))
    expect(back.background?.dim).toBe(DEFAULT_BACKGROUND_DIM)
    expect(back.background?.saturation).toBe(DEFAULT_BACKGROUND_SATURATION)
    expect(back.background?.gridDots).toBe(false)
  })

  it('drops an out-of-union gridStyle (reads as dots)', () => {
    const back = fromObject(v8doc({ ...valid, gridStyle: 'hex' }))
    expect(back.background?.gridStyle).toBeUndefined()
  })

  it('degrades kind file without an assetId to none (no document rejection)', () => {
    const back = fromObject(v8doc({ kind: 'file', dim: 0.3, saturation: 1, gridDots: false }))
    expect(back.background?.kind).toBe('none')
    expect(back.background?.assetId).toBeUndefined()
  })

  it('degrades kind scene without a scene id to none', () => {
    const back = fromObject(v8doc({ kind: 'scene', dim: 0.3, saturation: 1, gridDots: false }))
    expect(back.background?.kind).toBe('none')
  })

  it('drops a non-record background entirely (renders as none)', () => {
    for (const bad of ['wallpaper', 7, true, null]) {
      const back = fromObject(v8doc(bad))
      expect(back.background).toBeUndefined()
    }
  })

  it('drops a background with an unknown kind entirely', () => {
    const back = fromObject(v8doc({ ...valid, kind: 'video-wall' }))
    expect(back.background).toBeUndefined()
  })

  it('never lets a malformed background reject a document that has boards', () => {
    const board = createBoard('terminal', { id: 't1', x: 0, y: 0 })
    const doc = {
      schemaVersion: 8,
      viewport: null,
      boards: [board],
      connectors: [],
      groups: [],
      background: { kind: 'file' } // malformed: no assetId, no numbers
    }
    const back = fromObject(doc)
    expect(back.boards).toHaveLength(1)
    expect(back.background?.kind).toBe('none')
  })
})

// ── Terminal agent presets (schema v10) ──────────────────────────────────────────
// Optional TerminalBoard `agentKind` + `monitorActivity`. All-optional → ADDITIVE:
// the writer bumps to 10 but MIN_READER_VERSION stays 9 (an older app opens v10 docs).
describe('schema v10 — terminal agentKind + monitorActivity', () => {
  const v9doc = (terminal?: Record<string, unknown>): unknown => ({
    schemaVersion: 9,
    minReaderVersion: 9,
    viewport: null,
    boards: terminal
      ? [{ id: 't1', type: 'terminal', x: 0, y: 0, w: 420, h: 340, title: 'T', ...terminal }]
      : [],
    connectors: [],
    groups: []
  })

  it('migrates a v9 doc to current (identity bump, fields absent)', () => {
    const migrated = migrate(v9doc() as never)
    expect(migrated.schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('v10 was additive (no floor move of its own) — the current writer stamps the CURRENT floor (17)', () => {
    // v10 (agentKind/monitorActivity) was additive; the compat floor moved with the breaking v11
    // `diagram` element kind, the v12 `command` board type, the v13 `file` board + `fileref` element
    // kinds, the v14 `dataflow` board type, the v15 `qhd`/`uhd` viewport presets, and the v17 `kanban`
    // board type (v16 theming was additive). toObject stamps the CURRENT floor (MIN_READER_VERSION = 17).
    expect(toObject([], null).minReaderVersion).toBe(17)
    expect(MIN_READER_VERSION).toBe(17)
  })

  it('round-trips agentKind + monitorActivity', () => {
    const back = fromObject(v9doc({ agentKind: 'claude', monitorActivity: false }))
    const t = back.boards[0]
    expect(t.type).toBe('terminal')
    if (t.type === 'terminal') {
      expect(t.agentKind).toBe('claude')
      expect(t.monitorActivity).toBe(false)
    }
  })

  it('accepts a terminal with neither field (absent ⇒ monitor on, no preset)', () => {
    const back = fromObject(v9doc({}))
    const t = back.boards[0]
    if (t.type === 'terminal') {
      expect(t.agentKind).toBeUndefined()
      expect(t.monitorActivity).toBeUndefined()
    }
  })

  it('rejects a non-string agentKind', () => {
    expect(() => fromObject(v9doc({ agentKind: 42 }))).toThrow(/agentKind is not a string/)
  })

  it('rejects a non-boolean monitorActivity', () => {
    expect(() => fromObject(v9doc({ monitorActivity: 'yes' }))).toThrow(
      /monitorActivity is not a boolean/
    )
  })
})

// ── File-tree foundation (schema v13): `file` board type + `fileref` element kind ─────
describe('schema v13 — file board + fileref element', () => {
  const fileBoard = (extra: Record<string, unknown>): unknown => ({
    schemaVersion: 13,
    minReaderVersion: 13,
    viewport: null,
    connectors: [],
    boards: [{ id: 'f1', type: 'file', title: 'File', x: 0, y: 0, w: 520, h: 380, ...extra }]
  })
  const filerefDoc = (el: Record<string, unknown>): unknown => ({
    schemaVersion: 13,
    minReaderVersion: 13,
    viewport: null,
    connectors: [],
    boards: [{ id: 'p1', type: 'planning', title: 'P', x: 0, y: 0, w: 300, h: 200, elements: [el] }]
  })
  const goodFileref = {
    id: 'r1',
    kind: 'fileref',
    x: 5,
    y: 6,
    path: 'src/index.ts',
    label: 'index.ts',
    w: 200,
    h: 56
  }

  it('createBoard makes an UNBOUND file board (no path) by default', () => {
    const b = createBoard('file', { id: 'f1', x: 1, y: 2 })
    expect(b).toMatchObject({ id: 'f1', type: 'file', x: 1, y: 2, w: 520, h: 380 })
    expect(b).not.toHaveProperty('path')
  })

  it('createBoard binds opts.path when provided', () => {
    const b = createBoard('file', { id: 'f1', x: 0, y: 0, path: 'README.md' })
    expect(b.type).toBe('file')
    if (b.type === 'file') expect(b.path).toBe('README.md')
  })

  it('round-trips a bound, read-only file board', () => {
    const back = fromObject(fileBoard({ path: 'src/a.ts', readOnly: true }))
    const b = back.boards[0]
    expect(b.type).toBe('file')
    if (b.type === 'file') {
      expect(b.path).toBe('src/a.ts')
      expect(b.readOnly).toBe(true)
    }
  })

  it('accepts an unbound file board (no path / no readOnly)', () => {
    const back = fromObject(fileBoard({}))
    const b = back.boards[0]
    if (b.type === 'file') {
      expect(b.path).toBeUndefined()
      expect(b.readOnly).toBeUndefined()
    }
  })

  it('rejects a non-string file board path', () => {
    expect(() => fromObject(fileBoard({ path: 42 }))).toThrow(/file board path is not a string/)
  })

  it('rejects a non-boolean file board readOnly', () => {
    expect(() => fromObject(fileBoard({ readOnly: 'yes' }))).toThrow(
      /file board readOnly is not a boolean/
    )
  })

  it('round-trips a fileref element', () => {
    const back = fromObject(filerefDoc(goodFileref))
    const p = back.boards[0]
    expect(p.type).toBe('planning')
    if (p.type === 'planning') expect(p.elements[0]).toEqual(goodFileref)
  })

  it('rejects a fileref with an empty path', () => {
    expect(() => fromObject(filerefDoc({ ...goodFileref, path: '' }))).toThrow(
      /fileref element has an empty\/non-string path/
    )
  })

  it('rejects a fileref with a missing label', () => {
    const { label: _label, ...noLabel } = goodFileref
    void _label
    expect(() => fromObject(filerefDoc(noLabel))).toThrow(
      /fileref element has an empty\/non-string label/
    )
  })

  it('rejects a fileref with non-positive w/h', () => {
    expect(() => fromObject(filerefDoc({ ...goodFileref, w: 0 }))).toThrow(
      /fileref element has non-positive w\/h/
    )
  })
})
