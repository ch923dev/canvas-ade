import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  SCHEMA_VERSION,
  MIN_READER_VERSION,
  createBoard,
  fromObject,
  migrate,
  toObject,
  type Board,
  type CanvasDoc,
  type Workspace
} from './boardSchema'
import { checkWorkspace, workspaceLoadNotices } from './workspaceSchema'

// v24 — Project Workspaces (docs/research/2026-11-02-project-workspaces §4.1): doc-level
// `workspaces[]` + `repoDefaults`, BoardCommon `workspaceId`, floor 24.

const API: Workspace = { id: 'ws-api', name: 'API', goal: 'build auth', color: 'blue', root: 'api' }
const UPLOADER: Workspace = {
  id: 'ws-up',
  name: 'Uploader',
  goal: 'enhance storage',
  color: 'green',
  root: 'uploader',
  worktrees: [
    {
      repoRoot: 'uploader',
      worktree: '.canvas/worktrees/uploader-storage',
      branch: 'ws/uploader-storage',
      baseRef: 'release',
      base: '0123456789abcdef0123456789abcdef01234567'
    }
  ],
  keepLayout: true
}

const term = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: 'terminal',
  title: id,
  x: 0,
  y: 0,
  w: 420,
  h: 340,
  ...extra
})

/** A v24 doc whose `workspaces` / boards the test controls. */
function v24(workspaces: unknown, boards: unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 24,
    minReaderVersion: 24,
    viewport: null,
    connectors: [],
    groups: [],
    boards,
    workspaces,
    ...extra
  }
}

describe('schema v24 — version + migration', () => {
  it('SCHEMA_VERSION and the compat floor are both 24 (a new doc-level key is breaking)', () => {
    expect(SCHEMA_VERSION).toBe(24)
    expect(MIN_READER_VERSION).toBe(24)
    expect(toObject([], null).minReaderVersion).toBe(24)
  })

  it('golden: a v23 doc migrates to exactly v24 + workspaces [] and nothing else', () => {
    const v23 = {
      schemaVersion: 23,
      minReaderVersion: 23,
      viewport: { x: 10, y: 20, zoom: 0.5 },
      connectors: [],
      groups: [{ id: 'g', name: 'Auth', boardIds: ['t1'] }],
      boards: [term('t1', { cwd: 'C:/p/api' }), { ...term('s1'), type: 'swarm', w: 1180, h: 660 }]
    }
    const out = migrate(structuredClone(v23) as never)
    expect(out).toEqual({ ...v23, schemaVersion: 24, workspaces: [] })
    // …and the load path then re-stamps the floor on the next save.
    const saved = toObject(fromObject(structuredClone(v23)).boards, null)
    expect(saved.schemaVersion).toBe(24)
    expect(saved.minReaderVersion).toBe(24)
    expect(saved.workspaces).toEqual([])
  })

  it('migration keeps a (hand-written) workspaces array a v23-stamped doc already carries', () => {
    const out = migrate({ ...v24([API]), schemaVersion: 23, minReaderVersion: 23 } as never)
    expect(out.workspaces).toEqual([API])
  })

  it('a pre-v24 doc loads with workspaces [] and no repoDefaults key', () => {
    const doc = fromObject({ schemaVersion: 22, viewport: null, connectors: [], boards: [] })
    expect(doc.workspaces).toEqual([])
    expect('repoDefaults' in doc).toBe(false)
  })
})

describe('schema v24 — round-trip', () => {
  it('workspaces (worktree, keepLayout, archived) + board workspaceIds survive save → JSON → load', () => {
    const archived: Workspace = { ...API, id: 'ws-old', name: 'Old', root: '.', state: 'archived' }
    const boards = [
      { ...createBoard('terminal', { id: 't1', x: 0, y: 0 }), workspaceId: 'ws-api' },
      { ...createBoard('browser', { id: 'b1', x: 500, y: 0 }), workspaceId: 'ws-up' },
      createBoard('planning', { id: 'p1', x: 0, y: 500 }) // project-level
    ] as Board[]
    const doc = toObject(boards, null, [], [], null, {
      workspaces: [API, UPLOADER, archived],
      repoDefaults: { api: { base: 'release' }, '.': { base: 'main' } }
    })
    const back = fromObject(JSON.parse(JSON.stringify(doc)))
    expect(back.workspaces).toEqual([API, UPLOADER, archived])
    expect(back.repoDefaults).toEqual({ api: { base: 'release' }, '.': { base: 'main' } })
    expect(back.boards.map((b) => b.workspaceId)).toEqual(['ws-api', 'ws-up', undefined])
    expect('workspaceId' in back.boards[2]).toBe(false)
    expect(workspaceLoadNotices(back)).toEqual([])
  })

  it('serializes `"workspaces": []` always, and omits repoDefaults while empty', () => {
    const doc = toObject([], null)
    expect(JSON.parse(JSON.stringify(doc)).workspaces).toEqual([])
    expect('repoDefaults' in doc).toBe(false)
    expect(
      'repoDefaults' in toObject([], null, [], [], null, { workspaces: [], repoDefaults: {} })
    ).toBe(false)
  })

  it('preserves unknown keys on a workspace + worktree (an additive future field rides through)', () => {
    const future = {
      ...UPLOADER,
      icon: 'rocket',
      worktrees: [{ ...UPLOADER.worktrees![0], pushedAt: 7 }]
    }
    const back = fromObject(v24([future]))
    expect(back.workspaces).toEqual([future])
  })

  it('coerces an unknown colour token to the first token instead of failing (forward-compat)', () => {
    const back = fromObject(v24([{ ...API, color: 'chartreuse' }]))
    expect(back.workspaces![0].color).toBe('blue')
  })

  it('canonicalizes a stored root (hand-edit) rather than dropping it', () => {
    const back = fromObject(v24([{ ...API, root: './api//src/' }]))
    expect(back.workspaces![0].root).toBe('api/src')
  })
})

describe('schema v24 — reconcile', () => {
  it('clears a dangling board workspaceId (the board becomes project-level)', () => {
    const back = fromObject(
      v24([API], [term('t1', { workspaceId: 'ws-gone' }), term('t2', { workspaceId: 'ws-api' })])
    )
    expect('workspaceId' in back.boards[0]).toBe(false)
    expect(back.boards[1].workspaceId).toBe('ws-api')
  })

  it('KEEPS an empty workspace (unlike groups — a workspace is a folder + goal)', () => {
    const back = fromObject(v24([API, UPLOADER], []))
    expect(back.workspaces).toEqual([API, UPLOADER])
  })

  it.each([
    ['absolute', '/srv/api'],
    ['parent', '../uploader'],
    ['nested parent', 'api/../../x'],
    ['drive letter', 'C:/code/api'],
    ['UNC', '\\\\host\\share'],
    ['backslash', 'api\\x'],
    ['dots', '...']
  ])('DROPS a workspace whose root escapes (%s) and records a notice', (_label, root) => {
    const back = fromObject(
      v24([API, { ...UPLOADER, root }], [term('t1', { workspaceId: 'ws-up' })])
    )
    expect(back.workspaces).toEqual([API])
    expect('workspaceId' in back.boards[0]).toBe(false) // its board is project-level (O-8)
    expect(workspaceLoadNotices(back)).toEqual([
      'Workspace "Uploader" was removed: its folder is outside the project.'
    ])
  })

  it('DROPS a workspace whose worktree path escapes the project', () => {
    const wt = { ...UPLOADER.worktrees![0], worktree: '../elsewhere' }
    const back = fromObject(v24([{ ...UPLOADER, worktrees: [wt] }]))
    expect(back.workspaces).toEqual([])
    expect(workspaceLoadNotices(back)).toHaveLength(1)
  })

  it('DROPS a later duplicate id or (case-insensitive) name, with a notice', () => {
    const back = fromObject(
      v24([API, { ...UPLOADER, id: 'ws-api' }, { ...UPLOADER, id: 'ws-x', name: 'api' }])
    )
    expect(back.workspaces).toEqual([API])
    expect(workspaceLoadNotices(back)).toHaveLength(2)
  })

  it('a docked swarm worker inherits its swarm board workspaceId (and drops its own)', () => {
    const swarm = { ...term('s1'), type: 'swarm', w: 1180, h: 660, workspaceId: 'ws-api' }
    const bare = { ...term('s2'), type: 'swarm', w: 1180, h: 660 }
    const back = fromObject(
      v24(
        [API, UPLOADER],
        [
          swarm,
          bare,
          term('w1', { dockedIn: 's1', workspaceId: 'ws-up' }),
          term('w2', { dockedIn: 's1' }),
          term('w3', { dockedIn: 's2', workspaceId: 'ws-up' })
        ]
      )
    )
    const ws = Object.fromEntries(back.boards.map((b) => [b.id, b.workspaceId]))
    expect(ws).toMatchObject({ s1: 'ws-api', w1: 'ws-api', w2: 'ws-api', w3: undefined })
  })

  it('degrades repoDefaults: bad entries and escaping keys drop, the doc still loads', () => {
    const back = fromObject(
      v24([], [], {
        repoDefaults: {
          api: { base: 'release' },
          '../x': { base: 'main' },
          uploader: { base: '' },
          web: 'main',
          './ext/': { base: 'upgrade-manifest' }
        }
      })
    )
    expect(back.repoDefaults).toEqual({
      api: { base: 'release' },
      ext: { base: 'upgrade-manifest' }
    })
    expect('repoDefaults' in fromObject(v24([], [], { repoDefaults: ['nope'] }))).toBe(false)
  })
})

describe('schema v24 — deep validation (as strict as groups)', () => {
  it.each([
    ['non-array workspaces', { not: 'an array' }],
    ['non-object entry', ['API']],
    ['missing id', [{ ...API, id: '' }]],
    ['non-string name', [{ ...API, name: 5 }]],
    ['blank name', [{ ...API, name: '' }]],
    ['unsanitized name (newline)', [{ ...API, name: 'A\nPI' }]],
    ['unsanitized name (padding)', [{ ...API, name: ' API ' }]],
    ['goal over 200', [{ ...API, goal: 'x'.repeat(201) }]],
    ['goal with a control char', [{ ...API, goal: 'two\nlines' }]],
    ['non-string colour', [{ ...API, color: 1 }]],
    ['non-string root', [{ ...API, root: null }]],
    ['unknown state', [{ ...API, state: 'deleted' }]],
    ['non-boolean keepLayout', [{ ...API, keepLayout: 'yes' }]],
    ['non-array worktrees', [{ ...UPLOADER, worktrees: {} }]],
    [
      'worktree missing a sha',
      [{ ...UPLOADER, worktrees: [{ ...UPLOADER.worktrees![0], base: '' }] }]
    ]
  ])('fails the doc on %s', (_label, workspaces) => {
    expect(() => fromObject(v24(workspaces))).toThrow(/fromObject/)
  })

  it('REJECTS more than one worktree (v1 backs a workspace with one repo, O-10)', () => {
    const two = { ...UPLOADER, worktrees: [UPLOADER.worktrees![0], UPLOADER.worktrees![0]] }
    expect(() => fromObject(v24([two]))).toThrow(/more than 1 worktree/)
    expect(checkWorkspace(two)).toMatchObject({ ok: false })
  })

  it('fails the doc on a non-string board workspaceId', () => {
    expect(() => fromObject(v24([API], [term('t1', { workspaceId: 7 })]))).toThrow(/workspaceId/)
  })
})

describe('schema v24 — an older (v23) app meets a v24 doc', () => {
  afterEach(() => {
    vi.doUnmock('./boardSchemaVersion')
    vi.resetModules()
  })

  it('the v23 reader path refuses it with the clean "update the app" message', async () => {
    const doc = JSON.parse(
      JSON.stringify(
        toObject([createBoard('terminal', { id: 't', x: 0, y: 0 })], null, [], [], null, {
          workspaces: [API]
        })
      )
    ) as CanvasDoc
    vi.resetModules()
    vi.doMock('./boardSchemaVersion', () => ({ SCHEMA_VERSION: 23, MIN_READER_VERSION: 23 }))
    const v23 = await import('./boardSchema')
    expect(v23.SCHEMA_VERSION).toBe(23)
    expect(() => v23.fromObject(doc)).toThrow(
      /requires reader ≥ 24.*saved by a newer version of the app; update the app to open it/
    )
  })
})
