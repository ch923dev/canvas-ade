/**
 * C3 `deriveContexts` — one named block per contract rule (SPEC §3 C3, rules 1-9), plus the D10
 * `port` edge, the dataflow edge, the hub rule and a seeded shuffle that pins determinism. The
 * `DEFAULT_TITLE` parity test lives in `src/renderer/src/lib/deriveContexts.parity.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  contextKey,
  deriveContexts,
  HUB_MIN_CABLES,
  MAX_CONTEXTS,
  normalizeContextPath,
  type ContextBoardInput,
  type ContextConnectorInput,
  type ContextGroupInput,
  type ContextSignal,
  type DerivedContext
} from './deriveContexts'
import { GROUP_NAME_MAX } from './groupName'

type Board = ContextBoardInput
const term = (id: string, extra: Partial<Board> = {}): Board => ({
  id,
  type: 'terminal',
  title: 'Terminal',
  ...extra
})
const browser = (id: string, extra: Partial<Board> = {}): Board => ({
  id,
  type: 'browser',
  title: 'Browser',
  ...extra
})
const plan = (id: string, extra: Partial<Board> = {}): Board => ({
  id,
  type: 'planning',
  title: 'Planning',
  ...extra
})
const file = (id: string, path: string): Board => ({ id, type: 'file', title: 'File', path })
const dataflow = (id: string, sourceBoardId: string): Board => ({
  id,
  type: 'dataflow',
  title: 'Data Flow',
  sourceBoardId
})
const orch = (sourceId: string, targetId: string): ContextConnectorInput => ({
  sourceId,
  targetId,
  kind: 'orchestration'
})
const previewCable = (sourceId: string, targetId: string): ContextConnectorInput => ({
  sourceId,
  targetId,
  kind: 'preview'
})
const group = (id: string, boardIds: string[], name = id): ContextGroupInput => ({
  id,
  name,
  boardIds
})
const sets = (contexts: DerivedContext[]): string[][] => contexts.map((c) => c.boardIds)
const only = (contexts: DerivedContext[]): DerivedContext => {
  expect(contexts).toHaveLength(1)
  return contexts[0]
}

describe('rule 1 · docked terminals are excluded', () => {
  it('a docked worker joins no context, even when it shares a cwd', () => {
    const boards = [
      term('t1', { cwd: '/r/web' }),
      term('w1', { cwd: '/r/web', dockedIn: 'sw' }),
      { id: 'sw', type: 'swarm', title: 'Swarm' }
    ]
    expect(deriveContexts(boards, [], [])).toEqual([])
    const withPeer = deriveContexts([...boards, term('t2', { cwd: '/r/web' })], [], [])
    expect(sets(withPeer)).toEqual([['t1', 't2']])
  })

  it('a docked board is dropped from its Named Group and carries no preview link', () => {
    const boards = [
      term('t1'),
      term('w1', { dockedIn: 'sw' }),
      browser('b1', { previewSourceId: 'w1' })
    ]
    const ctx = only(deriveContexts(boards, [], [group('g', ['t1', 'w1'])]))
    expect(ctx.boardIds).toEqual(['t1'])
    expect(ctx.addBoardIds).toBeUndefined()
  })
})

describe('rule 2 · Named Groups are authoritative', () => {
  it('emits each group as-is: existingGroupId, signals [group], high, its own name', () => {
    const ctx = only(
      deriveContexts([term('t1'), plan('p1')], [], [group('g1', ['t1', 'p1'], ' Auth \n flow ')])
    )
    expect(ctx).toEqual({
      key: contextKey(['p1', 't1']),
      suggestedName: 'Auth flow',
      boardIds: ['p1', 't1'],
      signals: ['group'],
      confidence: 'high',
      existingGroupId: 'g1'
    })
  })

  it('signals never split a group: members with unrelated cwds stay one context', () => {
    const boards = [term('a', { cwd: '/r/web' }), term('b', { cwd: '/r/api' })]
    expect(sets(deriveContexts(boards, [], [group('g', ['a', 'b'])]))).toEqual([['a', 'b']])
  })

  it('signals never merge groups, and a cwd shared with a member pulls in no stray', () => {
    const boards = [
      term('a', { cwd: '/r/web' }),
      term('b', { cwd: '/r/web' }),
      term('c', { cwd: '/r/web' })
    ]
    const out = deriveContexts(boards, [orch('a', 'b')], [group('g1', ['a']), group('g2', ['b'])])
    expect(sets(out)).toEqual([['a'], ['b']])
    expect(out.map((c) => c.existingGroupId)).toEqual(['g1', 'g2'])
    expect(out.every((c) => c.addBoardIds === undefined)).toBe(true)
  })

  it('a board in two groups appears in both (multi-membership)', () => {
    const out = deriveContexts(
      [term('a'), term('b'), term('c')],
      [],
      [group('g1', ['a', 'b']), group('g2', ['b', 'c'])]
    )
    expect(sets(out)).toEqual([
      ['a', 'b'],
      ['b', 'c']
    ])
  })

  it('drops unknown member ids and skips a group with no live member', () => {
    const out = deriveContexts(
      [term('a'), term('w', { dockedIn: 'sw' })],
      [],
      [group('g1', ['a', 'ghost', 'a']), group('g2', ['ghost', 'w'])]
    )
    expect(sets(out)).toEqual([['a']])
    expect(out[0].existingGroupId).toBe('g1')
  })

  it('a group whose name sanitizes to nothing takes a member-derived name', () => {
    const out = deriveContexts(
      [plan('p', { title: 'Release plan' }), term('t')],
      [],
      [group('g', ['p', 't'], '\u202e \u200b')]
    )
    expect(only(out).suggestedName).toBe('Release plan')
  })
})

describe('rule 3 · absorb whole stray components into exactly one group', () => {
  it('absorbs an ungrouped browser that previews a group member', () => {
    const ctx = only(
      deriveContexts(
        [term('t1'), browser('b1', { previewSourceId: 't1' })],
        [],
        [group('g', ['t1'])]
      )
    )
    expect(ctx.boardIds).toEqual(['t1'])
    expect(ctx.addBoardIds).toEqual(['b1'])
    expect(ctx.signals).toEqual(['group', 'preview'])
    expect(ctx.confidence).toBe('high')
  })

  it('absorbs over a non-hub orchestration cable, in either direction', () => {
    const boards = [term('lead'), term('w1'), term('src')]
    const ctx = only(
      deriveContexts(boards, [orch('lead', 'w1'), orch('src', 'lead')], [group('g', ['lead'])])
    )
    expect(ctx.addBoardIds).toEqual(['src', 'w1'])
    expect(ctx.signals).toEqual(['group', 'orchestration'])
  })

  it('an api terminal joins via port (D10)', () => {
    const boards = [
      term('web', { ports: [5173] }),
      browser('b', { previewSourceId: 'web', callsPorts: [5173, 3000] }),
      term('api', { ports: [3000] })
    ]
    const ctx = only(deriveContexts(boards, [], [group('g', ['web', 'b'])]))
    expect(ctx.addBoardIds).toEqual(['api'])
    expect(ctx.signals).toEqual(['group', 'port'])
  })

  it('a dataflow board joins via its browser', () => {
    const boards = [term('t'), browser('b', { previewSourceId: 't' }), dataflow('df', 'b')]
    const ctx = only(deriveContexts(boards, [], [group('g', ['t', 'b'])]))
    expect(ctx.addBoardIds).toEqual(['df'])
    expect(ctx.signals).toEqual(['group', 'dataflow'])
  })

  it('a browser previewing an absorbed worker is absorbed too (it rides along)', () => {
    const boards = [term('lead'), term('w'), browser('b', { previewSourceId: 'w' })]
    const ctx = only(deriveContexts(boards, [orch('lead', 'w')], [group('g', ['lead'])]))
    expect(ctx.addBoardIds).toEqual(['b', 'w'])
    expect(ctx.signals).toEqual(['group', 'preview', 'orchestration'])
  })

  it('does not absorb over cables from a hub', () => {
    const boards = [term('lead'), term('w1'), term('w2'), term('w3')]
    const cables = [orch('lead', 'w1'), orch('lead', 'w2'), orch('lead', 'w3')]
    const ctx = only(deriveContexts(boards, cables, [group('g', ['lead'])]))
    expect(ctx.addBoardIds).toBeUndefined()
  })

  it('a component that touches two groups is not absorbed and still forms a rule-4 context', () => {
    // w is cabled from g1's lead; its browser b also previews t2 in g2. The component {b, w}
    // reaches two groups, so none of it is absorbed, and its own preview edge still clusters it.
    const boards = [term('lead'), term('t2'), term('w'), browser('b', { previewSourceId: 'w' })]
    const out = deriveContexts(
      boards,
      [orch('lead', 'w'), previewCable('t2', 'b')],
      [group('g1', ['lead']), group('g2', ['t2'])]
    )
    expect(out.every((c) => c.addBoardIds === undefined)).toBe(true)
    const derived = out.filter((c) => c.existingGroupId === undefined)
    expect(sets(derived)).toEqual([['b', 'w']])
    expect(derived[0].signals).toEqual(['preview'])
  })

  it('a single board linked to two groups is ambiguous too', () => {
    const boards = [
      term('t1'),
      term('t2'),
      browser('b', { previewSourceId: 't1', callsPorts: [3000] }),
      term('api', { ports: [3000] })
    ]
    const out = deriveContexts(
      boards,
      [previewCable('b', 't2')],
      [group('g1', ['t1']), group('g2', ['t2'])]
    )
    expect(out.every((c) => c.addBoardIds === undefined)).toBe(true)
    const derived = out.find((c) => c.existingGroupId === undefined)
    expect(derived?.boardIds).toEqual(['api', 'b'])
    expect(derived?.signals).toEqual(['port'])
  })

  it('a link to a member of two groups is ambiguous', () => {
    const out = deriveContexts(
      [term('t1'), browser('b', { previewSourceId: 't1' })],
      [],
      [group('g1', ['t1']), group('g2', ['t1'])]
    )
    expect(out.every((c) => c.addBoardIds === undefined)).toBe(true)
  })

  it('weak signals (cwd, fileRef) never absorb', () => {
    const boards = [
      term('t1', { cwd: '/r/web' }),
      term('t2', { cwd: '/r/web' }),
      plan('p', { fileRefs: [{ path: 'a.ts' }] }),
      file('f', 'a.ts')
    ]
    const out = deriveContexts(boards, [], [group('g', ['t1', 'f'])])
    expect(out.every((c) => c.addBoardIds === undefined)).toBe(true)
    expect(sets(out)).toEqual([['f', 't1']])
  })
})

describe('rule 4 · union-find edges among the remaining boards', () => {
  it('preview: previewSourceId links a browser to its terminal', () => {
    const ctx = only(deriveContexts([term('t'), browser('b', { previewSourceId: 't' })], [], []))
    expect(ctx.boardIds).toEqual(['b', 't'])
    expect(ctx.signals).toEqual(['preview'])
  })

  it("preview: any kind:'preview' connector links too", () => {
    const ctx = only(deriveContexts([term('t'), browser('b')], [previewCable('t', 'b')], []))
    expect(ctx.signals).toEqual(['preview'])
  })

  it('orchestration: non-hub cables link, transitively', () => {
    const boards = [term('a'), term('b'), term('c')]
    const ctx = only(deriveContexts(boards, [orch('a', 'b'), orch('b', 'c')], []))
    expect(ctx.boardIds).toEqual(['a', 'b', 'c'])
    expect(ctx.signals).toEqual(['orchestration'])
  })

  it(`hub: a source with ${HUB_MIN_CABLES} cables contributes no edges (C9's TEAM unit keeps the lead)`, () => {
    const boards = [term('lead'), term('w1'), term('w2'), term('w3')]
    const three = [orch('lead', 'w1'), orch('lead', 'w2'), orch('lead', 'w3')]
    expect(deriveContexts(boards, three, [])).toEqual([])
    // Exactly HUB_MIN_CABLES - 1 cables is not a hub: the lead and its workers fuse.
    expect(sets(deriveContexts(boards, three.slice(0, 2), []))).toEqual([['lead', 'w1', 'w2']])
  })

  it("hub: the workers still cluster on their own signals; the hub's incoming cables still count", () => {
    const boards = [
      term('lead'),
      term('boss'),
      term('w1', { cwd: '/r/shop' }),
      term('w2', { cwd: '/r/shop' }),
      term('w3')
    ]
    const cables = [
      orch('lead', 'w1'),
      orch('lead', 'w2'),
      orch('lead', 'w3'),
      orch('boss', 'lead')
    ]
    expect(sets(deriveContexts(boards, cables, []))).toEqual([
      ['boss', 'lead'],
      ['w1', 'w2']
    ])
  })

  it('hub: counts distinct existing targets, docked ones included', () => {
    const boards = [term('lead'), term('w1'), term('w2'), term('d', { dockedIn: 'sw' })]
    // Duplicate cables to one worker count once: 2 distinct targets, not a hub.
    const dupes = [
      orch('lead', 'w1'),
      orch('lead', 'w1'),
      orch('lead', 'w2'),
      orch('lead', 'ghost')
    ]
    expect(sets(deriveContexts(boards, dupes, []))).toEqual([['lead', 'w1', 'w2']])
    // A third, docked target makes it a hub: the cable count is the source's property.
    const docked = [orch('lead', 'w1'), orch('lead', 'w2'), orch('lead', 'd')]
    expect(deriveContexts(boards, docked, [])).toEqual([])
  })

  it("port (D10): a browser's callsPorts intersecting a terminal's ports links them", () => {
    const boards = [
      browser('b', { callsPorts: [5173, 3000] }),
      term('web', { ports: [5173] }),
      term('api', { ports: [3000, 9229] }),
      term('other', { ports: [8080] })
    ]
    const ctx = only(deriveContexts(boards, [], []))
    expect(ctx.boardIds).toEqual(['api', 'b', 'web'])
    expect(ctx.signals).toEqual(['port'])
    expect(ctx.confidence).toBe('high')
  })

  it('port: disjoint or invalid port numbers carry no edge', () => {
    const bad = [0, 70000, 3.5, -1, '3000'] as unknown as number[]
    const boards = [
      browser('b', { callsPorts: [...bad, 4000] }),
      term('t', { ports: [...bad, 5000] })
    ]
    expect(deriveContexts(boards, [], [])).toEqual([])
  })

  it("dataflow: a data-flow board's sourceBoardId links it to that browser (high)", () => {
    const ctx = only(deriveContexts([browser('b'), dataflow('df', 'b')], [], []))
    expect(ctx.boardIds).toEqual(['b', 'df'])
    expect(ctx.signals).toEqual(['dataflow'])
    expect(ctx.confidence).toBe('high')
  })

  it('cwd: the same cwd across case, separators and a trailing slash links (medium)', () => {
    const boards = [
      term('a', { cwd: 'C:\\Repo\\Apps\\Web\\' }),
      term('b', { cwd: 'c:/repo/apps/web' }),
      term('c', { cwd: 'C://Repo//Apps//Web' })
    ]
    const ctx = only(deriveContexts(boards, [], []))
    expect(ctx.boardIds).toEqual(['a', 'b', 'c'])
    expect(ctx.signals).toEqual(['cwd'])
    expect(ctx.confidence).toBe('medium')
  })

  it('cwd: a cwd equal to projectRoot, or empty, carries no signal', () => {
    const boards = [
      term('a', { cwd: 'C:\\Repo' }),
      term('b', { cwd: 'c:/repo/' }),
      term('c', { cwd: '' }),
      term('d', { cwd: '   ' })
    ]
    expect(deriveContexts(boards, [], [], { projectRoot: 'C:/Repo' })).toEqual([])
    // Without a projectRoot the shared root is an ordinary cwd signal.
    expect(sets(deriveContexts(boards, [], []))).toEqual([['a', 'b']])
  })

  it("cwd: pathCase 'sensitive' keeps case-distinct cwds apart", () => {
    const boards = [term('a', { cwd: '/srv/App' }), term('b', { cwd: '/srv/app' })]
    expect(deriveContexts(boards, [], [], { pathCase: 'sensitive' })).toEqual([])
    expect(sets(deriveContexts(boards, [], []))).toEqual([['a', 'b']])
  })

  it("fileRef: a planning ref equal to a file board's path links them (medium)", () => {
    const boards = [plan('p', { fileRefs: [{ path: './src/Auth.ts' }] }), file('f', 'src\\auth.ts')]
    const ctx = only(deriveContexts(boards, [], []))
    expect(ctx.boardIds).toEqual(['f', 'p'])
    expect(ctx.signals).toEqual(['fileRef'])
    expect(ctx.confidence).toBe('medium')
  })

  it('fileRef: two planning boards sharing a ref link; two file boards alone do not', () => {
    const plans = [
      plan('p1', { fileRefs: [{ path: 'docs/spec.md' }, { path: 'x.md' }] }),
      plan('p2', { fileRefs: [{ path: 'docs/spec.md' }] })
    ]
    expect(sets(deriveContexts(plans, [], []))).toEqual([['p1', 'p2']])
    expect(deriveContexts([file('f1', 'a.ts'), file('f2', 'a.ts')], [], [])).toEqual([])
  })

  it('title: off by default', () => {
    const boards = [term('a', { title: 'auth api' }), term('b', { title: 'auth' })]
    expect(deriveContexts(boards, [], [])).toEqual([])
  })

  it('title (opt-in): token Jaccard >= 0.5 sharing a non-stopword links (low)', () => {
    const boards = [term('a', { title: 'auth api' }), term('b', { title: 'Auth' })]
    const ctx = only(deriveContexts(boards, [], [], { titleSignal: true }))
    expect(ctx.signals).toEqual(['title'])
    expect(ctx.confidence).toBe('low')
  })

  it('title (opt-in): below 0.5, or a stopword-only overlap, carries no edge', () => {
    const below = [term('a', { title: 'auth api server' }), term('b', { title: 'auth web' })]
    expect(deriveContexts(below, [], [], { titleSignal: true })).toEqual([])
    const stop = [
      term('a'),
      term('b'),
      plan('c', { title: 'the plan' }),
      plan('d', { title: 'the' })
    ]
    expect(deriveContexts(stop, [], [], { titleSignal: true })).toEqual([])
  })
})

describe('rule 5 · singletons are never emitted', () => {
  it('a board with no edge is not a context', () => {
    expect(deriveContexts([term('a'), term('b'), browser('c')], [], [])).toEqual([])
    const out = deriveContexts(
      [term('a'), browser('b', { previewSourceId: 'a' }), term('loner')],
      [],
      []
    )
    expect(sets(out)).toEqual([['a', 'b']])
  })
})

describe('rule 6 · confidence', () => {
  it('high on group / preview / orchestration / port / dataflow, else medium on cwd / fileRef, else low', () => {
    const conf = (boards: Board[], cables: ContextConnectorInput[] = []): string =>
      only(deriveContexts(boards, cables, [], { titleSignal: true })).confidence
    expect(conf([term('a'), term('b')], [orch('a', 'b')])).toBe('high')
    expect(conf([browser('a', { callsPorts: [1] }), term('b', { ports: [1] })])).toBe('high')
    expect(conf([browser('a'), dataflow('b', 'a')])).toBe('high')
    expect(
      conf([term('a', { cwd: '/x', title: 'auth' }), term('b', { cwd: '/x', title: 'auth' })])
    ).toBe('medium')
    expect(conf([term('a', { title: 'auth' }), term('b', { title: 'auth' })])).toBe('low')
    // One strong edge anywhere in the cluster lifts the whole cluster.
    const mixed = [
      term('a', { cwd: '/x' }),
      term('b', { cwd: '/x' }),
      browser('c', { previewSourceId: 'b' })
    ]
    expect(conf(mixed)).toBe('high')
  })
})

describe('rule 7 · suggestedName', () => {
  it('prefers a planning title over a terminal title', () => {
    const boards = [
      term('t', { title: 'claude — auth' }),
      plan('p', { title: 'Auth plan' }),
      browser('b', { previewSourceId: 't' })
    ]
    const out = deriveContexts(boards, [orch('t', 'p')], [])
    expect(only(out).suggestedName).toBe('Auth plan')
  })

  it('falls back to a terminal title', () => {
    const boards = [term('t', { title: 'claude — auth' }), browser('b', { previewSourceId: 't' })]
    expect(only(deriveContexts(boards, [], [])).suggestedName).toBe('claude — auth')
  })

  it('skips the per-type default titles, then names by the common cwd basename', () => {
    const shared = [
      term('a', { cwd: 'C:\\Code\\Shop\\Web' }),
      plan('p'),
      term('b', { cwd: 'c:/code/shop/web' })
    ]
    expect(only(deriveContexts(shared, [orch('a', 'p')], [])).suggestedName).toBe('Web')
    const siblings = [term('a', { cwd: '/r/apps/web' }), term('b', { cwd: '/r/apps/api' })]
    expect(only(deriveContexts(siblings, [orch('a', 'b')], [])).suggestedName).toBe('apps')
  })

  it('a common cwd at or above projectRoot names nothing', () => {
    const boards = [term('a', { cwd: '/r/web' }), term('b', { cwd: '/r/api' })]
    const out = deriveContexts(boards, [orch('a', 'b')], [], { projectRoot: '/r' })
    expect(only(out).suggestedName).toBe('Context 1')
  })

  it('numbers the unnamed contexts in output order', () => {
    const boards = [term('a'), browser('b', { previewSourceId: 'a' }), term('c'), browser('d')]
    const out = deriveContexts(boards, [previewCable('c', 'd')], [])
    expect(out.map((c) => c.suggestedName)).toEqual(['Context 1', 'Context 2'])
  })

  it('sanitizes and clamps the name it picks', () => {
    const title = `Auth\u202e \n ${'x'.repeat(200)}`
    const boards = [plan('p', { title, fileRefs: [{ path: 'a.ts' }] }), file('f', 'a.ts')]
    const ctx = only(deriveContexts(boards, [], []))
    expect(ctx.suggestedName).toBe(`Auth ${'x'.repeat(GROUP_NAME_MAX - 5)}`)
    expect(ctx.suggestedName).toHaveLength(GROUP_NAME_MAX)
  })
})

describe('rule 9 · signals are read by board type only', () => {
  it('cwd: only a terminal carries it', () => {
    const boards = [
      plan('p', { cwd: '/r/web' }),
      browser('b', { cwd: '/r/web' }),
      term('t', { cwd: '/r/web' })
    ]
    expect(deriveContexts(boards, [], [])).toEqual([])
    expect(sets(deriveContexts([...boards, term('t2', { cwd: '/r/web' })], [], []))).toEqual([
      ['t', 't2']
    ])
  })

  it('ports: only a terminal carries them', () => {
    const caller = browser('b', { callsPorts: [3000] })
    const others = [plan('p', { ports: [3000] }), browser('b2', { ports: [3000] })]
    expect(deriveContexts([caller, ...others], [], [])).toEqual([])
    expect(sets(deriveContexts([caller, term('t', { ports: [3000] })], [], []))).toEqual([
      ['b', 't']
    ])
  })

  it('previewSourceId: only a browser carries it', () => {
    const boards = [
      term('t'),
      term('t2', { previewSourceId: 't' }),
      plan('p', { previewSourceId: 't' })
    ]
    expect(deriveContexts(boards, [], [])).toEqual([])
    expect(
      sets(deriveContexts([term('t'), browser('b', { previewSourceId: 't' })], [], []))
    ).toEqual([['b', 't']])
  })

  it('callsPorts: only a browser carries them', () => {
    const server = term('s', { ports: [3000] })
    const others = [
      term('t', { callsPorts: [3000] }),
      { ...dataflow('df', ''), callsPorts: [3000] }
    ]
    expect(deriveContexts([server, ...others], [], [])).toEqual([])
    expect(sets(deriveContexts([server, browser('b', { callsPorts: [3000] })], [], []))).toEqual([
      ['b', 's']
    ])
  })

  it('path: only a file board carries it', () => {
    const ref = plan('p', { fileRefs: [{ path: 'a.ts' }] })
    const others = [term('t', { path: 'a.ts' }), browser('b', { path: 'a.ts' })]
    expect(deriveContexts([ref, ...others], [], [])).toEqual([])
    expect(sets(deriveContexts([ref, file('f', 'a.ts')], [], []))).toEqual([['f', 'p']])
  })

  it('fileRefs: only a planning board carries them', () => {
    const refs = [{ path: 'a.ts' }]
    const others = [
      { id: 'k', type: 'kanban', title: 'Kanban', fileRefs: refs },
      term('t', { fileRefs: refs })
    ]
    expect(deriveContexts([file('f', 'a.ts'), ...others], [], [])).toEqual([])
    expect(
      sets(deriveContexts([file('f', 'a.ts'), plan('p', { fileRefs: refs })], [], []))
    ).toEqual([['f', 'p']])
  })

  it('sourceBoardId: only a data-flow board carries it', () => {
    const others = [term('t', { sourceBoardId: 'b' }), plan('p', { sourceBoardId: 'b' })]
    expect(deriveContexts([browser('b'), ...others], [], [])).toEqual([])
    expect(sets(deriveContexts([browser('b'), dataflow('df', 'b')], [], []))).toEqual([['b', 'df']])
  })

  it('dockedIn: only a terminal can be docked; a stray dockedIn on another type is ignored', () => {
    const boards = [term('t'), browser('b', { previewSourceId: 't', dockedIn: 'sw' })]
    expect(sets(deriveContexts(boards, [], []))).toEqual([['b', 't']])
  })
})

/** mulberry32: a tiny seeded PRNG, so the shuffle below is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Every rule at once: groups (multi-membership + absorb), a hub, port, dataflow, cwd, fileRef, title, docked. */
const RICH_BOARDS: Board[] = [
  plan('p1', { title: 'Auth plan', fileRefs: [{ path: 'src/auth.ts' }] }),
  term('t1', { title: 'claude — auth', cwd: 'C:/repo/apps/auth', ports: [3000] }),
  browser('b1', { previewSourceId: 't1' }),
  browser('b4', { callsPorts: [3000] }),
  term('t2', { cwd: 'C:/repo/apps/billing' }),
  term('t3'),
  { id: 'L', type: 'command', title: 'Orchestrator' },
  term('w1', { cwd: 'C:/repo/apps/shop' }),
  term('w2', { cwd: 'C:\\repo\\apps\\shop' }),
  term('w3', { cwd: 'C:/Repo/Apps/Shop/' }),
  term('d1', { cwd: 'C:/repo/apps/shop', dockedIn: 'sw' }),
  { id: 'sw', type: 'swarm', title: 'Swarm' },
  browser('b2', { callsPorts: [5173, 9999] }),
  term('t4', { title: 'web server', ports: [5173, 24678] }),
  plan('p2', { title: 'Docs', fileRefs: [{ path: 'docs/readme.md' }, { path: 'docs/x.md' }] }),
  file('f1', 'docs/README.md'),
  term('t5', { title: 'billing worker' }),
  term('t6', { title: 'billing worker 2' }),
  term('t7', { cwd: 'C:\\repo' }),
  term('t8', { cwd: 'c:/repo/' }),
  term('o1'),
  term('o2'),
  term('o3'),
  browser('b3'),
  term('t9'),
  dataflow('df1', 'b3')
]
const RICH_CABLES: ContextConnectorInput[] = [
  orch('L', 'w1'),
  orch('L', 'w2'),
  orch('L', 'w3'),
  orch('o1', 'o2'),
  orch('o2', 'o3'),
  previewCable('b3', 't9')
]
const RICH_GROUPS: ContextGroupInput[] = [
  group('g1', ['p1', 't1', 'ghost'], 'Auth'),
  group('g2', ['t2', 't3'], 'Billing'),
  group('g3', ['t3'], 'Billing core')
]
const RICH_OPTS = { projectRoot: 'C:\\repo', titleSignal: true }

describe('rule 8 · deterministic', () => {
  const base = deriveContexts(RICH_BOARDS, RICH_CABLES, RICH_GROUPS, RICH_OPTS)

  it('derives the expected contexts from the every-rule fixture', () => {
    expect(
      base.map((c) => [c.boardIds.join(','), c.suggestedName, c.signals.join('+'), c.confidence])
    ).toEqual([
      ['b2,t4', 'web server', 'port', 'high'],
      ['b3,df1,t9', 'Context 1', 'preview+dataflow', 'high'],
      ['f1,p2', 'Docs', 'fileRef', 'medium'],
      ['o1,o2,o3', 'Context 2', 'orchestration', 'high'],
      ['p1,t1', 'Auth', 'group+preview+port', 'high'],
      ['t2,t3', 'Billing', 'group', 'high'],
      ['t3', 'Billing core', 'group', 'high'],
      ['t5,t6', 'billing worker', 'title', 'low'],
      ['w1,w2,w3', 'shop', 'cwd', 'medium']
    ])
    expect(base.find((c) => c.existingGroupId === 'g1')?.addBoardIds).toEqual(['b1', 'b4'])
  })

  it('board ids are sorted and the output is sorted by first board id', () => {
    for (const c of base) expect(c.boardIds).toEqual([...c.boardIds].sort())
    const firsts = base.map((c) => c.boardIds[0])
    expect(firsts).toEqual([...firsts].sort())
  })

  it('signals are the enum only: no raw path ever leaks', () => {
    const allowed: ContextSignal[] = [
      'group',
      'preview',
      'orchestration',
      'port',
      'dataflow',
      'cwd',
      'fileRef',
      'title'
    ]
    for (const c of base) for (const s of c.signals) expect(allowed).toContain(s)
    expect(JSON.stringify(base.map((c) => c.signals))).not.toMatch(/repo|docs|src/i)
  })

  it('any input order gives byte-identical output (seeded shuffles)', () => {
    const expected = JSON.stringify(base)
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(seed)
      const boards = shuffle(RICH_BOARDS, rnd).map((b) => ({
        ...b,
        ...(b.fileRefs ? { fileRefs: shuffle(b.fileRefs, rnd) } : {}),
        ...(b.ports ? { ports: shuffle(b.ports, rnd) } : {}),
        ...(b.callsPorts ? { callsPorts: shuffle(b.callsPorts, rnd) } : {})
      }))
      const groups = shuffle(RICH_GROUPS, rnd).map((g) => ({
        ...g,
        boardIds: shuffle(g.boardIds, rnd)
      }))
      const out = deriveContexts(boards, shuffle(RICH_CABLES, rnd), groups, RICH_OPTS)
      expect(JSON.stringify(out)).toBe(expected)
    }
  })

  it('keys: an order-independent hash of the sorted ids, unique across the output', () => {
    expect(contextKey(['b', 'a', 'c'])).toBe(contextKey(['c', 'b', 'a']))
    expect(contextKey(['a', 'b'])).not.toBe(contextKey(['a', 'c']))
    expect(contextKey(['ab'])).not.toBe(contextKey(['a', 'b']))
    expect(contextKey(['a'])).toMatch(/^ctx-[0-9a-z]{7}$/)
    for (const c of base.filter((c) => c.existingGroupId === undefined)) {
      expect(c.key).toBe(contextKey(c.boardIds))
    }
    // Two groups with the same live members still get distinct keys.
    const twins = deriveContexts(
      [term('a'), term('b')],
      [],
      [group('g1', ['a', 'b']), group('g2', ['b', 'a'])]
    )
    expect(twins.map((c) => c.key)).toEqual([contextKey(['a', 'b']), `${contextKey(['a', 'b'])}-2`])
  })

  it(`caps the output at MAX_CONTEXTS (${MAX_CONTEXTS}): groups first, then confidence`, () => {
    const boards: Board[] = []
    const groups: ContextGroupInput[] = []
    for (let i = 0; i < 40; i++) {
      const n = String(i).padStart(2, '0')
      boards.push(term(`a${n}`, { cwd: `/r/m${n}` }), term(`b${n}`, { cwd: `/r/m${n}` })) // medium
      boards.push(term(`c${n}`), browser(`d${n}`, { previewSourceId: `c${n}` })) // high
    }
    for (let i = 0; i < 3; i++) {
      boards.push(term(`z${i}`))
      groups.push(group(`zg${i}`, [`z${i}`]))
    }
    const out = deriveContexts(boards, [], groups)
    expect(out).toHaveLength(MAX_CONTEXTS)
    expect(out.filter((c) => c.existingGroupId !== undefined)).toHaveLength(3)
    expect(out.filter((c) => c.confidence === 'high' && !c.existingGroupId)).toHaveLength(40)
    expect(out.filter((c) => c.confidence === 'medium')).toHaveLength(MAX_CONTEXTS - 43)
    const firsts = out.map((c) => c.boardIds[0])
    expect(firsts).toEqual([...firsts].sort())
  })
})

describe('normalizeContextPath', () => {
  it('normalizes separators, duplicate and trailing slashes, a leading ./ and case', () => {
    expect(normalizeContextPath('C:\\Repo\\Web\\')).toBe('c:/repo/web')
    expect(normalizeContextPath('C:\\Repo\\Web\\', 'sensitive')).toBe('C:/Repo/Web')
    expect(normalizeContextPath('./src//a.ts')).toBe('src/a.ts')
    expect(normalizeContextPath('\\\\server\\share\\x\\')).toBe('//server/share/x')
    expect(normalizeContextPath('/')).toBe('/')
    expect(normalizeContextPath('  ')).toBe('')
    expect(normalizeContextPath(undefined)).toBe('')
  })
})
