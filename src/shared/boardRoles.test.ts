/**
 * The C9 role model (spatial-awareness). One describe per question the layout engine asks:
 * what is each board (roles + links + why), who is the hero (rank), how is a unit arranged
 * (scenes), and which boards travel together (units, Named Group > TEAM > context > single).
 * Rules: docs/specs/spatial-awareness/ROLE-LAYOUT.md §1–§3.
 */
import { describe, expect, it } from 'vitest'
import {
  ROLE_WEIGHT,
  buildRoleUnits,
  classifyScene,
  deriveRoles,
  rankBoards,
  type RoleBoardInput,
  type RoleUnit
} from './boardRoles'

// The C3 shapes ride on the signatures (the stub is module-private until L6's file lands).
type Conn = Parameters<typeof deriveRoles>[1][number]
type Group = Parameters<typeof buildRoleUnits>[2][number]
type Ctx = Parameters<typeof buildRoleUnits>[3][number]

const board = (id: string, type: string, extra: Partial<RoleBoardInput> = {}): RoleBoardInput => ({
  id,
  type,
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  ...extra
})
const term = (id: string, extra: Partial<RoleBoardInput> = {}): RoleBoardInput =>
  board(id, 'terminal', extra)
const agent = (id: string, extra: Partial<RoleBoardInput> = {}): RoleBoardInput =>
  term(id, { agent: true, ...extra })
const server = (id: string, port: number, extra: Partial<RoleBoardInput> = {}): RoleBoardInput =>
  term(id, { ports: [port], ...extra })
const browser = (id: string, extra: Partial<RoleBoardInput> = {}): RoleBoardInput =>
  board(id, 'browser', extra)
const cable = (from: string, to: string): Conn => ({
  sourceId: from,
  targetId: to,
  kind: 'orchestration'
})
const group = (id: string, boardIds: string[]): Group => ({ id, name: id, boardIds })
const ctx = (key: string, boardIds: string[], extra: Partial<Ctx> = {}): Ctx => ({
  key,
  suggestedName: key,
  boardIds: [...boardIds].sort(),
  signals: ['preview'],
  confidence: 'high',
  ...extra
})

function unitsFor(
  boards: RoleBoardInput[],
  opts: { connectors?: Conn[]; groups?: Group[]; contexts?: Ctx[]; lead?: string } = {}
): RoleUnit[] {
  const connectors = opts.connectors ?? []
  const roles = deriveRoles(boards, connectors, { leadBoardId: opts.lead })
  return buildRoleUnits(boards, connectors, opts.groups ?? [], opts.contexts ?? [], roles)
}
const unitOf = (units: RoleUnit[], id: string): RoleUnit | undefined =>
  units.find((u) => u.boardIds.includes(id))
const sceneOf = (
  boards: RoleBoardInput[],
  connectors: Conn[] = [],
  lead?: string
): ReturnType<typeof classifyScene> =>
  classifyScene(
    boards.map((b) => b.id),
    boards,
    deriveRoles(boards, connectors, { leadBoardId: lead })
  )

/** mulberry32 — a tiny seeded PRNG so the shuffle test is reproducible (no fast-check in deps). */
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
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

describe('deriveRoles — signal → role (ROLE-LAYOUT §2)', () => {
  it('ROLE_WEIGHT is §2 exactly (lead 100 … shell 10) and frozen', () => {
    expect(ROLE_WEIGHT).toEqual({
      lead: 100,
      swarm: 80,
      command: 70,
      agent: 60,
      preview: 50,
      plan: 40,
      tracker: 35,
      dataflow: 30,
      file: 25,
      server: 20,
      shell: 10
    })
    expect(Object.isFrozen(ROLE_WEIGHT)).toBe(true)
  })

  it('maps every board type to its role and weight', () => {
    const roles = deriveRoles(
      [
        agent('a'),
        server('srv', 3000),
        term('sh'),
        browser('br'),
        board('pl', 'planning'),
        board('kb', 'kanban'),
        board('df', 'dataflow'),
        board('fi', 'file'),
        board('sw', 'swarm'),
        board('cm', 'command')
      ],
      [],
      {}
    )
    const got = Object.fromEntries([...roles].map(([id, r]) => [id, [r.role, r.weight]]))
    expect(got).toEqual({
      a: ['agent', 60],
      srv: ['server', 20],
      sh: ['shell', 10],
      br: ['preview', 50],
      pl: ['plan', 40],
      kb: ['tracker', 35],
      df: ['dataflow', 30],
      fi: ['file', 25],
      sw: ['swarm', 80],
      cm: ['command', 70]
    })
  })

  it('lead comes ONLY from opts.leadBoardId — never inferred from a board type', () => {
    const boards = [agent('a'), board('cm', 'command'), board('sw', 'swarm'), term('sh')]
    for (const leadBoardId of [undefined, null]) {
      const roles = deriveRoles(boards, [], { leadBoardId })
      expect([...roles.values()].some((r) => r.role === 'lead')).toBe(false)
    }
    const roles = deriveRoles(boards, [], { leadBoardId: 'sh' })
    expect(roles.get('sh')).toMatchObject({ role: 'lead', weight: 100 })
    expect(roles.get('a')?.role).toBe('agent') // the lead overrides only its own board
    // An unknown or docked lead id names no lead at all.
    expect(
      [...deriveRoles(boards, [], { leadBoardId: 'ghost' }).values()].map((r) => r.role)
    ).not.toContain('lead')
    const docked = deriveRoles([...boards, term('dl', { dockedIn: 'sw' })], [], {
      leadBoardId: 'dl'
    })
    expect([...docked.values()].map((r) => r.role)).not.toContain('lead')
  })

  it('agent is the input boolean; server = ports + not agent; shell = any other terminal', () => {
    const roles = deriveRoles(
      [
        agent('agentWithPort', { ports: [5173] }),
        term('notAgent', { agent: false, ports: [3000] }),
        term('quiet', { ports: [] }),
        browser('agentFlagIgnored', { agent: true })
      ],
      [],
      {}
    )
    expect(roles.get('agentWithPort')?.role).toBe('agent')
    expect(roles.get('notAgent')?.role).toBe('server')
    expect(roles.get('quiet')?.role).toBe('shell')
    expect(roles.get('agentFlagIgnored')?.role).toBe('preview') // agent only classifies terminals
  })

  it('invalid ports (0, > 65535, fractional, NaN) carry no server signal', () => {
    const roles = deriveRoles([term('t', { ports: [0, 70000, 3000.5, Number.NaN] })], [], {})
    expect(roles.get('t')?.role).toBe('shell')
  })

  it('an unknown board type is an inert rigid `file`, never dropped', () => {
    const roles = deriveRoles([board('x', 'hologram')], [], {})
    expect(roles.get('x')).toMatchObject({ role: 'file', weight: 25 })
    expect(roles.get('x')?.why).toBe('Unrecognized board type, kept as-is')
  })

  it('docked boards are excluded from the role map and from every link', () => {
    const boards = [
      board('sw', 'swarm'),
      term('dw', { dockedIn: 'sw', ports: [4000] }),
      browser('br', { previewSourceId: 'dw', callsPorts: [4000] })
    ]
    const roles = deriveRoles(boards, [cable('sw', 'dw')], {})
    expect(roles.has('dw')).toBe(false)
    expect(roles.get('br')?.links).toEqual([])
    expect(roles.get('sw')?.links).toEqual([])
  })
})

describe('deriveRoles — links (ROLE-LAYOUT §2)', () => {
  it('preview → its source (previewSourceId) and → every terminal serving a port it calls', () => {
    const roles = deriveRoles(
      [
        browser('br', { previewSourceId: 'web', callsPorts: [3000, 9999] }),
        server('web', 5173),
        server('api', 3000, { y: 500 }),
        server('other', 8080)
      ],
      [],
      {}
    )
    expect(roles.get('br')?.links).toEqual(['web', 'api']) // reading order: web y0, api y500
    expect(roles.get('web')?.links).toEqual([]) // directed: the preview names the relation
  })

  it('a kind:"preview" connector links the browser to the other end, either direction', () => {
    const boards = [browser('br'), term('src'), browser('br2'), term('src2')]
    const roles = deriveRoles(
      boards,
      [
        { sourceId: 'src', targetId: 'br', kind: 'preview' }, // previewConnectorsFor's direction
        { sourceId: 'br2', targetId: 'src2', kind: 'preview' }
      ],
      {}
    )
    expect(roles.get('br')?.links).toEqual(['src'])
    expect(roles.get('br2')?.links).toEqual(['src2'])
  })

  it('lead / command / swarm → their orchestration-cable targets; a plain terminal cable links nothing', () => {
    const boards = [
      term('lead'),
      board('cm', 'command'),
      board('sw', 'swarm'),
      agent('w1', { x: 100 }),
      agent('w2', { x: 50 }),
      term('plain')
    ]
    const roles = deriveRoles(
      boards,
      [
        cable('lead', 'w1'),
        cable('lead', 'w2'),
        cable('lead', 'w2'), // duplicate cable → one link
        cable('cm', 'w1'),
        cable('sw', 'w2'),
        cable('plain', 'w1'),
        cable('lead', 'lead'), // self-cable ignored
        cable('lead', 'ghost') // dangling ignored
      ],
      { leadBoardId: 'lead' }
    )
    expect(roles.get('lead')?.links).toEqual(['w2', 'w1']) // reading order (x 50 before x 100)
    expect(roles.get('cm')?.links).toEqual(['w1'])
    expect(roles.get('sw')?.links).toEqual(['w2'])
    expect(roles.get('plain')?.links).toEqual([])
  })

  it('dataflow → its browser via sourceBoardId (dangling ids dropped)', () => {
    const roles = deriveRoles(
      [
        board('df', 'dataflow', { sourceBoardId: 'br' }),
        board('df2', 'dataflow', { sourceBoardId: 'gone' }),
        browser('br')
      ],
      [],
      {}
    )
    expect(roles.get('df')?.links).toEqual(['br'])
    expect(roles.get('df')?.why).toBe('Data-flow board bound to a browser')
    expect(roles.get('df2')?.links).toEqual([])
  })
})

describe('deriveRoles — why (D9)', () => {
  it('reads like a sentence and NEVER carries a raw path or launch line', () => {
    // Extra fields a careless caller might pass through from the board model.
    const leaky = (b: RoleBoardInput): RoleBoardInput & { cwd: string; launchCommand: string } => ({
      ...b,
      cwd: 'C:\\Users\\me\\secret-app',
      launchCommand: 'OPENAI_API_KEY=sk-live-123 claude --model opus'
    })
    const boards = [
      leaky(term('lead')),
      leaky(agent('a')),
      leaky(server('srv', 3000)),
      leaky(term('sh')),
      leaky(browser('br', { previewSourceId: 'srv', callsPorts: [3000, 1, 2, 3] })),
      leaky(board('fi', 'file'))
    ]
    const roles = deriveRoles(boards, [cable('lead', 'a')], { leadBoardId: 'lead' })
    for (const r of roles.values()) {
      expect(r.why).not.toMatch(/[\\/]|secret|sk-live|claude|OPENAI/)
      expect(r.why.length).toBeLessThanOrEqual(80)
    }
    expect(roles.get('lead')?.why).toBe('Designated lead, cabled to 1 board')
    expect(roles.get('srv')?.why).toBe('Terminal listening on :3000')
    expect(roles.get('br')?.why).toBe(
      'Browser preview of a linked terminal, calling :1, :2, :3 +1 more'
    )
    expect(roles.get('sh')?.why).toBe('Plain terminal: no agent, no listening port')
  })
})

describe('rankBoards — hero tie-break (ROLE-LAYOUT §2)', () => {
  it('weight, then newer lastFocusedAt, then larger area, then id', () => {
    const boards = [
      agent('old', { lastFocusedAt: 100 }),
      agent('new', { lastFocusedAt: 200 }),
      agent('neverBig', { w: 900, h: 900 }),
      agent('neverB'),
      agent('neverA'),
      browser('pv', { lastFocusedAt: 999 }),
      board('cm', 'command')
    ]
    const roles = deriveRoles(boards, [], {})
    expect(
      rankBoards(
        boards.map((b) => b.id),
        boards,
        roles
      )
    ).toEqual(['cm', 'new', 'old', 'neverBig', 'neverA', 'neverB', 'pv'])
  })
})

describe('scenes (ROLE-LAYOUT §3 — top to bottom, first match wins)', () => {
  it('lead: a unit holding the lead → hero is the lead, even beside a swarm, agent and preview', () => {
    const boards = [term('L'), board('sw', 'swarm'), agent('a'), browser('br')]
    expect(sceneOf(boards, [], 'L')).toEqual({ scene: 'lead', heroIds: ['L'] })
  })

  it('hub: a swarm or command board → the heaviest hub (swarm 80 beats command 70)', () => {
    const boards = [board('cm', 'command'), board('sw', 'swarm'), agent('a'), browser('br')]
    expect(sceneOf(boards)).toEqual({ scene: 'hub', heroIds: ['sw'] })
    expect(sceneOf([board('cm', 'command'), board('kb', 'kanban')])).toEqual({
      scene: 'hub',
      heroIds: ['cm']
    })
  })

  it('pair: agent + preview → co-heroes, the top agent + the preview LINKED to it', () => {
    const boards = [
      agent('ag'),
      browser('linked', { previewSourceId: 'ag' }),
      browser('louder', { lastFocusedAt: 999 }), // ranks first, but is not the agent's preview
      server('web', 5173)
    ]
    expect(sceneOf(boards)).toEqual({ scene: 'pair', heroIds: ['ag', 'linked'] })
  })

  it('pair: with no preview linked to the top agent → the top preview', () => {
    const boards = [agent('ag'), browser('p1', { lastFocusedAt: 5 }), browser('p2')]
    expect(sceneOf(boards)).toEqual({ scene: 'pair', heroIds: ['ag', 'p1'] })
  })

  it('stack: preview + server, no agent → the preview is the hero (S3)', () => {
    const boards = [
      browser('br', { previewSourceId: 'web', callsPorts: [3000] }),
      server('web', 5173),
      server('api', 3000)
    ]
    expect(sceneOf(boards)).toEqual({ scene: 'stack', heroIds: ['br'] })
  })

  it('stack: ≥ 2 previews of one source are all co-heroes (S5 mobile + desktop)', () => {
    const boards = [
      browser('mobile', { previewSourceId: 'web', w: 390, h: 844 }),
      browser('desktop', { previewSourceId: 'web', w: 1280, h: 800 }),
      browser('elsewhere', { previewSourceId: 'other', w: 10, h: 10 }),
      server('web', 5173)
    ]
    expect(sceneOf(boards)).toEqual({ scene: 'stack', heroIds: ['desktop', 'mobile'] })
  })

  it('peers: ≥ 2 terminals and nothing above → no hero (S8)', () => {
    expect(sceneOf([agent('a1'), agent('a2'), agent('a3'), agent('a4')])).toEqual({
      scene: 'peers',
      heroIds: []
    })
    expect(sceneOf([term('s1'), server('s2', 3000), board('pl', 'planning')]).scene).toBe('peers')
  })

  it('docs: only plan / tracker / file / dataflow → no hero (S7)', () => {
    const boards = [
      board('p1', 'planning'),
      board('p2', 'planning'),
      board('kb', 'kanban'),
      board('fi', 'file'),
      board('df', 'dataflow')
    ]
    expect(sceneOf(boards)).toEqual({ scene: 'docs', heroIds: [] })
  })

  it('single: a 1-board unit is `single` with that board as hero — even a lone lead or hub', () => {
    expect(sceneOf([term('sh')])).toEqual({ scene: 'single', heroIds: ['sh'] })
    expect(sceneOf([term('L')], [], 'L')).toEqual({ scene: 'single', heroIds: ['L'] })
    expect(sceneOf([board('sw', 'swarm')])).toEqual({ scene: 'single', heroIds: ['sw'] })
    expect(sceneOf([board('pl', 'planning')])).toEqual({ scene: 'single', heroIds: ['pl'] })
  })

  it('an unmatched mix (preview + port-less shell) falls back to docs: sizes kept, no hero', () => {
    expect(sceneOf([browser('br', { previewSourceId: 'sh' }), term('sh')])).toEqual({
      scene: 'docs',
      heroIds: []
    })
  })

  it('first match wins down the table: hub beats pair, pair beats stack, stack beats peers', () => {
    expect(sceneOf([board('cm', 'command'), agent('a'), browser('br')]).scene).toBe('hub')
    expect(sceneOf([agent('a'), browser('br'), server('web', 1)]).scene).toBe('pair')
    expect(sceneOf([browser('br'), server('w1', 1), term('sh')]).scene).toBe('stack')
  })
})

describe('buildRoleUnits — Named Group > TEAM > context > single', () => {
  it('TEAM: a lead with ≥ 3 cables groups all its workers even though C3 dropped those edges', () => {
    const boards = [term('L'), agent('w1'), agent('w2'), agent('w3'), agent('w4')]
    const units = unitsFor(boards, {
      connectors: ['w1', 'w2', 'w3', 'w4'].map((w) => cable('L', w)),
      contexts: [], // C3's hub rule: a ≥ 3-cable source contributes no edges → no context
      lead: 'L'
    })
    expect(units).toEqual([
      {
        key: 'team:L',
        boardIds: ['L', 'w1', 'w2', 'w3', 'w4'],
        source: 'team',
        scene: 'lead',
        heroIds: ['L']
      }
    ])
  })

  it('TEAM: a command or swarm hub heads one too → scene hub', () => {
    const units = unitsFor([board('cm', 'command'), agent('w1'), agent('w2')], {
      connectors: [cable('cm', 'w1'), cable('cm', 'w2')]
    })
    expect(units).toEqual([
      {
        key: 'team:cm',
        boardIds: ['cm', 'w1', 'w2'],
        source: 'team',
        scene: 'hub',
        heroIds: ['cm']
      }
    ])
  })

  it('Named Group > TEAM: a grouped worker stays in its group and leaves the team', () => {
    const units = unitsFor([term('L'), agent('w1'), agent('w2'), browser('br')], {
      connectors: [cable('L', 'w1'), cable('L', 'w2')],
      groups: [group('g-app', ['w2', 'br'])],
      lead: 'L'
    })
    expect(unitOf(units, 'w2')).toMatchObject({ key: 'g-app', source: 'group', scene: 'pair' })
    expect(unitOf(units, 'L')).toMatchObject({ key: 'team:L', boardIds: ['L', 'w1'] })
  })

  it('a grouped hub heads no team: its ungrouped workers fall through to contexts / singles', () => {
    const units = unitsFor([term('L'), term('note'), agent('w1'), agent('w2'), agent('w3')], {
      connectors: [cable('L', 'w1'), cable('L', 'w2'), cable('L', 'w3')],
      groups: [group('g-lead', ['L', 'note'])],
      contexts: [ctx('ctx-w12', ['w1', 'w2'])],
      lead: 'L'
    })
    expect(unitOf(units, 'L')).toMatchObject({ key: 'g-lead', source: 'group', scene: 'lead' })
    expect(unitOf(units, 'w1')).toMatchObject({ key: 'ctx-w12', source: 'context' })
    expect(unitOf(units, 'w3')).toMatchObject({ key: 'single:w3', source: 'single' })
    expect(units.some((u) => u.source === 'team')).toBe(false)
  })

  it('a board in several Named Groups goes to the smallest (fewest members), id tie-break', () => {
    const boards = ['a', 'b', 'c', 'd'].map((id) => term(id))
    const units = unitsFor(boards, {
      groups: [group('big', ['a', 'b', 'c']), group('small', ['a', 'b']), group('also', ['c', 'd'])]
    })
    expect(unitOf(units, 'a')?.key).toBe('small')
    expect(unitOf(units, 'b')?.key).toBe('small')
    // c sits in 'big' (3) and 'also' (2) → also. 'big' keeps nobody → no unit at all.
    expect(unitOf(units, 'c')?.key).toBe('also')
    expect(units.map((u) => u.key).sort()).toEqual(['also', 'small'])
    // Equal sizes → the smaller group id wins.
    const tie = unitsFor(boards, {
      groups: [group('zeta', ['a', 'b']), group('alpha', ['a', 'c'])]
    })
    expect(unitOf(tie, 'a')?.key).toBe('alpha')
    // A Named Group of one stays a group unit — the user named it.
    expect(unitOf(tie, 'b')).toMatchObject({ key: 'zeta', source: 'group', scene: 'single' })
  })

  it('a worker cabled by two hubs goes to the heavier hub, id tie-break between equals', () => {
    const boards = [term('L'), board('cm', 'command'), agent('shared'), agent('own')]
    const units = unitsFor(boards, {
      connectors: [cable('cm', 'shared'), cable('L', 'shared'), cable('cm', 'own')],
      lead: 'L'
    })
    expect(unitOf(units, 'shared')?.key).toBe('team:L') // lead 100 > command 70
    expect(unitOf(units, 'own')?.key).toBe('team:cm')
    const tie = unitsFor([board('swB', 'swarm'), board('swA', 'swarm'), agent('w')], {
      connectors: [cable('swB', 'w'), cable('swA', 'w')]
    })
    expect(unitOf(tie, 'w')?.key).toBe('team:swA')
    expect(unitOf(tie, 'swB')?.key).toBe('single:swB') // no claimable target → no team
  })

  it('hubs head their own teams: a hub cabled by another hub is never its worker', () => {
    const boards = [term('L'), board('cm', 'command'), agent('w1'), agent('w2')]
    const cables = [cable('L', 'cm'), cable('L', 'w1'), cable('cm', 'w2')]
    // Both cable orders: a hub-as-worker bug only shows when the hub→hub cable is read last.
    for (const connectors of [cables, [...cables].reverse()]) {
      const units = unitsFor(boards, { connectors, lead: 'L' })
      expect(unitOf(units, 'L')?.boardIds).toEqual(['L', 'w1'])
      expect(unitOf(units, 'cm')?.boardIds).toEqual(['cm', 'w2'])
    }
    // Nor does a worker-less hub RIDE into another team over a preview link.
    const riding = unitsFor(
      [term('L'), board('cm', 'command'), browser('br', { previewSourceId: 'L' })],
      {
        connectors: [cable('cm', 'br')],
        lead: 'L'
      }
    )
    expect(unitOf(riding, 'br')?.key).toBe('team:cm')
    expect(unitOf(riding, 'L')?.key).toBe('single:L')
  })

  it('TEAM > context: claimed boards leave their context; a remainder ≥ 2 stays a context', () => {
    const boards = [
      term('L'),
      agent('w1'),
      agent('w2'),
      agent('w3'),
      term('s1'),
      term('s2'),
      term('s3')
    ]
    const units = unitsFor(boards, {
      connectors: [cable('L', 'w1'), cable('L', 'w2'), cable('L', 'w3')],
      contexts: [
        ctx('ctx-a', ['w1', 's1', 's2'], { signals: ['cwd'], confidence: 'medium' }),
        ctx('ctx-b', ['w2', 's3'], { signals: ['cwd'], confidence: 'medium' })
      ],
      lead: 'L'
    })
    expect(unitOf(units, 'w1')?.key).toBe('team:L')
    expect(unitOf(units, 's1')).toMatchObject({
      key: 'ctx-a',
      source: 'context',
      boardIds: ['s1', 's2'],
      scene: 'peers'
    })
    // ctx-b minus w2 leaves one board → a single, not a 1-board context.
    expect(unitOf(units, 's3')).toMatchObject({ key: 'single:s3', source: 'single' })
  })

  it("riders: a worker's browser rides with its worker's team (via a context or none at all)", () => {
    const boards = [
      term('L'),
      agent('w1'),
      agent('w2', { ports: [4000] }), // an agent serving its own dev server
      agent('w3'),
      browser('b1', { previewSourceId: 'w1' }), // preview edge to a worker
      browser('b2', { callsPorts: [4000] }), // port link to w2
      browser('b3') // linked to nobody
    ]
    const connectors = [cable('L', 'w1'), cable('L', 'w2'), cable('L', 'w3')]
    for (const contexts of [[ctx('ctx-w1', ['w1', 'b1'])], []]) {
      const units = unitsFor(boards, { connectors, contexts, lead: 'L' })
      expect(unitOf(units, 'L')?.boardIds).toEqual(['L', 'b1', 'b2', 'w1', 'w2', 'w3'])
      expect(unitOf(units, 'b3')?.key).toBe('single:b3')
    }
  })

  it('riders never pull a grouped board out of its Named Group', () => {
    const units = unitsFor(
      [term('L'), agent('w1'), agent('w2'), browser('b1', { previewSourceId: 'w1' }), term('n')],
      {
        connectors: [cable('L', 'w1'), cable('L', 'w2')],
        groups: [group('g', ['b1', 'n'])],
        lead: 'L'
      }
    )
    expect(unitOf(units, 'b1')?.key).toBe('g')
    expect(unitOf(units, 'L')?.boardIds).toEqual(['L', 'w1', 'w2'])
  })

  it("riders resolve to a fixed point: worker → its browser → that browser's data-flow board", () => {
    const boards = [
      term('L'),
      agent('w1'),
      agent('w2'),
      browser('b1', { previewSourceId: 'w1' }), // round 1: preview link to w1
      board('df', 'dataflow', { sourceBoardId: 'b1' }), // round 2: dataflow link to b1
      board('stray', 'dataflow', { sourceBoardId: 'b9' }), // bound to a browser in no team
      browser('b9')
    ]
    const connectors = [cable('L', 'w1'), cable('L', 'w2')]
    // With C3's dataflow-aware context, and with no contexts at all.
    for (const contexts of [[ctx('ctx-w1', ['w1', 'b1', 'df'])], []]) {
      const units = unitsFor(boards, { connectors, contexts, lead: 'L' })
      expect(unitOf(units, 'L')?.boardIds).toEqual(['L', 'b1', 'df', 'w1', 'w2'])
      expect(unitOf(units, 'stray')?.source).not.toBe('team')
    }
  })

  it('a server called by browsers of two teams goes to the heavier hub (id tie-break)', () => {
    const team = (hub: RoleBoardInput): RoleBoardInput[] => [
      hub,
      agent(`${hub.id}-w`),
      browser(`${hub.id}-b`, { previewSourceId: `${hub.id}-w`, callsPorts: [3000] })
    ]
    // Round 1 claims each team's browser; round 2 finds the shared api server linked to both.
    const mixed = [...team(term('L')), ...team(board('cm', 'command'))]
    const units = unitsFor([...mixed, server('api', 3000)], {
      connectors: [cable('L', 'L-w'), cable('cm', 'cm-w')],
      lead: 'L'
    })
    expect(unitOf(units, 'api')?.key).toBe('team:L') // lead 100 > command 70
    expect(unitOf(units, 'cm-b')?.key).toBe('team:cm')
    const twins = [...team(board('swB', 'swarm')), ...team(board('swA', 'swarm'))]
    const tie = unitsFor([...twins, server('api', 3000)], {
      connectors: [cable('swB', 'swB-w'), cable('swA', 'swA-w')]
    })
    expect(unitOf(tie, 'api')?.key).toBe('team:swA')
  })

  it('a C3 group context (existingGroupId) is skipped: its addBoardIds are proposals, not a unit', () => {
    const boards = [
      browser('br', { callsPorts: [3000, 5432] }),
      server('web', 5173),
      server('api', 3000),
      server('db', 5432)
    ]
    const units = unitsFor(boards, {
      groups: [group('g-app', ['br', 'web'])],
      contexts: [
        ctx('ctx-g', ['api', 'br', 'db', 'web'], {
          signals: ['group'],
          existingGroupId: 'g-app',
          addBoardIds: ['api', 'db']
        })
      ]
    })
    // Not merged into the group (it would sit under the group's outline) …
    expect(unitOf(units, 'br')).toMatchObject({ key: 'g-app', boardIds: ['br', 'web'] })
    // … and the two proposals are not fused into a unit of their own either.
    expect(unitOf(units, 'api')?.key).toBe('single:api')
    expect(unitOf(units, 'db')?.key).toBe('single:db')
  })

  it('every live board lands in exactly one unit; docked boards and unknown ids in none', () => {
    const boards = [
      board('sw', 'swarm'),
      term('dw', { dockedIn: 'sw' }),
      term('a'),
      term('b'),
      browser('c')
    ]
    const units = unitsFor(boards, {
      connectors: [cable('sw', 'dw')],
      groups: [group('g', ['a', 'dw', 'ghost'])],
      contexts: [ctx('ctx', ['b', 'c', 'dw', 'ghost'])]
    })
    const all = units.flatMap((u) => u.boardIds).sort()
    expect(all).toEqual(['a', 'b', 'c', 'sw'])
    expect(unitOf(units, 'a')).toMatchObject({ key: 'g', boardIds: ['a'] })
    expect(unitOf(units, 'sw')).toMatchObject({ key: 'single:sw', scene: 'single' })
  })

  it('units come out in reading order of their top-left, then key', () => {
    const units = unitsFor([
      term('low', { x: 0, y: 900 }),
      term('right', { x: 800, y: 0 }),
      term('left', { x: 0, y: 0 }),
      term('twinB', { x: 400, y: 400 }),
      term('twinA', { x: 400, y: 400 })
    ])
    expect(units.map((u) => u.key)).toEqual([
      'single:left',
      'single:right',
      'single:twinA',
      'single:twinB',
      'single:low'
    ])
  })
})

/**
 * S10 kitchen sink (ROLE-LAYOUT §7) plus a swarm with a docked worker and a named group:
 * lead + 3 workers (one with its own browser + data-flow board), an app (browser + web + api),
 * docs (2 plans + kanban), and the C3 contexts that canvas would produce (hub edges dropped).
 */
function kitchenSink(): {
  boards: RoleBoardInput[]
  connectors: Conn[]
  groups: Group[]
  contexts: Ctx[]
} {
  return {
    boards: [
      term('L', { w: 800, h: 600, lastFocusedAt: 50 }),
      agent('w1', { x: 2000 }),
      agent('w2', { x: 2000, y: 400 }),
      agent('w3', { x: 2000, y: 800 }),
      browser('b2', { x: 2600, previewSourceId: 'w1' }),
      board('df2', 'dataflow', { x: 3200, sourceBoardId: 'b2' }), // a round-2 rider
      browser('b1', { y: 2000, previewSourceId: 'web', callsPorts: [3000] }),
      server('web', 5173, { x: 900, y: 2000 }),
      server('api', 3000, { x: 900, y: 2400 }),
      board('p1', 'planning', { y: 4000 }),
      board('p2', 'planning', { x: 500, y: 4000 }),
      board('kb', 'kanban', { y: 4600, w: 1200 }),
      board('sw', 'swarm', { x: 4000 }),
      term('dw', { dockedIn: 'sw' }),
      term('x1', { x: 6000 }),
      term('x2', { x: 6500 })
    ],
    connectors: [
      cable('L', 'w1'),
      cable('L', 'w2'),
      cable('L', 'w3'),
      cable('L', 'sw'), // hub → hub: the swarm heads its own (empty) team, never the lead's
      cable('sw', 'dw') // to a docked worker: not canvas geometry
    ],
    groups: [group('g-ops', ['x1', 'x2'])],
    contexts: [
      ctx('ctx-w1', ['w1', 'b2']),
      ctx('ctx-app', ['b1', 'web', 'api'], { signals: ['preview', 'port'] }),
      ctx('ctx-docs', ['p1', 'p2', 'kb'], { signals: ['fileRef'], confidence: 'medium' }),
      ctx('ctx-ops', ['x1', 'x2'], { signals: ['group'], existingGroupId: 'g-ops' })
    ]
  }
}

describe('S10 kitchen sink + determinism', () => {
  it('lays the canvas out as team · swarm · ops group · app · docs', () => {
    const { boards, connectors, groups, contexts } = kitchenSink()
    const roles = deriveRoles(boards, connectors, { leadBoardId: 'L' })
    expect(buildRoleUnits(boards, connectors, groups, contexts, roles)).toEqual([
      {
        key: 'team:L',
        boardIds: ['L', 'b2', 'df2', 'w1', 'w2', 'w3'],
        source: 'team',
        scene: 'lead',
        heroIds: ['L']
      },
      { key: 'single:sw', boardIds: ['sw'], source: 'single', scene: 'single', heroIds: ['sw'] },
      { key: 'g-ops', boardIds: ['x1', 'x2'], source: 'group', scene: 'peers', heroIds: [] },
      {
        key: 'ctx-app',
        boardIds: ['api', 'b1', 'web'],
        source: 'context',
        scene: 'stack',
        heroIds: ['b1']
      },
      {
        key: 'ctx-docs',
        boardIds: ['kb', 'p1', 'p2'],
        source: 'context',
        scene: 'docs',
        heroIds: []
      }
    ])
  })

  it('any input order — boards, connectors, groups, contexts and their members — gives identical output', () => {
    const base = kitchenSink()
    const baseRoles = deriveRoles(base.boards, base.connectors, { leadBoardId: 'L' })
    const baseUnits = buildRoleUnits(
      base.boards,
      base.connectors,
      base.groups,
      base.contexts,
      baseRoles
    )
    const rand = mulberry32(0xc9)
    for (let run = 0; run < 25; run++) {
      const boards = shuffle(base.boards, rand)
      const connectors = shuffle(base.connectors, rand)
      const groups = shuffle(base.groups, rand).map((g) => ({
        ...g,
        boardIds: shuffle(g.boardIds, rand)
      }))
      const contexts = shuffle(base.contexts, rand).map((c) => ({
        ...c,
        boardIds: shuffle(c.boardIds, rand)
      }))
      const roles = deriveRoles(boards, connectors, { leadBoardId: 'L' })
      expect([...roles.entries()]).toEqual([...baseRoles.entries()])
      expect(buildRoleUnits(boards, connectors, groups, contexts, roles)).toEqual(baseUnits)
    }
  })
})
