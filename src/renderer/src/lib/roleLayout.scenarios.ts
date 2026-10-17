/**
 * TEST FIXTURES for `roleLayout` — the ROLE-LAYOUT.md §7 scenario canvases (S1–S15), shared by
 * the golden test (`roleLayout.golden.test.ts`) and usable by I2's dev-check script. Each
 * scenario runs the REAL C9 pipeline (`deriveRoles` + `buildRoleUnits`) over a seeded canvas, so
 * the goldens pin the integration, not a hand-built unit list. Not imported by app code.
 */
import {
  buildRoleUnits,
  deriveRoles,
  type BoardRoleInfo,
  type RoleBoardInput,
  type RoleUnit
} from '../../../shared/boardRoles'

type Connectors = Parameters<typeof deriveRoles>[1]
type Groups = Parameters<typeof buildRoleUnits>[2]
type Contexts = Parameters<typeof buildRoleUnits>[3]

/** 16:9 — the default pane of every scenario (§7: "a 16:9 pane unless it says otherwise"). */
export const PANE_16_9 = { w: 1600, h: 900 }
/** S13 portrait 9:16. */
export const PANE_9_16 = { w: 900, h: 1600 }
/** S13 ultrawide 21:9. */
export const PANE_21_9 = { w: 2520, h: 1080 }
/** S2's "small pane". */
export const PANE_SMALL = { w: 800, h: 500 }

export const term = (
  id: string,
  x: number,
  y: number,
  extra: Partial<RoleBoardInput> = {}
): RoleBoardInput => ({ id, type: 'terminal', x, y, w: 420, h: 340, ...extra })
export const agent = (id: string, x: number, y: number, extra: Partial<RoleBoardInput> = {}) =>
  term(id, x, y, { agent: true, ...extra })
/** A desktop-preset browser board: 1280 × 800 device + 64 px of chrome. */
export const desktop = (
  id: string,
  x: number,
  y: number,
  extra: Partial<RoleBoardInput> = {}
): RoleBoardInput => ({ id, type: 'browser', x, y, w: 1280, h: 864, ...extra })
/** A mobile-preset browser board (390 × 844 device in a 430-wide frame + chrome). */
export const mobile = (
  id: string,
  x: number,
  y: number,
  extra: Partial<RoleBoardInput> = {}
): RoleBoardInput => ({ id, type: 'browser', x, y, w: 430, h: 908, ...extra })
export const plan = (id: string, x: number, y: number): RoleBoardInput => ({
  id,
  type: 'planning',
  x,
  y,
  w: 516,
  h: 366
})
export const kanban = (id: string, x: number, y: number): RoleBoardInput => ({
  id,
  type: 'kanban',
  x,
  y,
  w: 900,
  h: 520
})

const cable = (sourceId: string, targetId: string) => ({
  sourceId,
  targetId,
  kind: 'orchestration' as const
})
const ctxOf = (key: string, boardIds: string[]): Contexts[number] => ({
  key,
  suggestedName: key,
  boardIds: [...boardIds].sort(),
  signals: ['preview'],
  confidence: 'high'
})

export interface Scenario {
  boards: RoleBoardInput[]
  roles: Map<string, BoardRoleInfo>
  units: RoleUnit[]
}

function build(
  boards: RoleBoardInput[],
  o: { connectors?: Connectors; groups?: Groups; contexts?: Contexts; lead?: string } = {}
): Scenario {
  const connectors = o.connectors ?? []
  const roles = deriveRoles(boards, connectors, { leadBoardId: o.lead ?? null })
  const units = buildRoleUnits(boards, connectors, o.groups ?? [], o.contexts ?? [], roles)
  return { boards, roles, units }
}

/** S1 · lead + 2 workers (a TEAM unit). */
export function s1(): Scenario {
  return build([term('lead', 0, 0), agent('w1', 480, 0), agent('w2', 480, 380)], {
    connectors: [cable('lead', 'w1'), cable('lead', 'w2')],
    lead: 'lead'
  })
}

/** S2 · lead + 6 workers (2-column rail, hero 50 %). */
export function s2(): Scenario {
  const ws = Array.from({ length: 6 }, (_, i) =>
    agent(`w${i + 1}`, 480 + (i % 2) * 460, Math.floor(i / 2) * 380)
  )
  return build([term('lead', 0, 0), ...ws], {
    connectors: ws.map((w) => cable('lead', w.id)),
    lead: 'lead'
  })
}

/** S3 · dev stack: browser + web server (its preview source) + api server (port link, D10). */
export function s3(): Scenario {
  return build(
    [
      desktop('br', 0, 0, { previewSourceId: 'web', callsPorts: [3000] }),
      term('api', 1320, 400, { ports: [3000] }),
      term('web', 1320, 0, { ports: [5173] })
    ],
    { contexts: [ctxOf('ctx:app', ['br', 'web', 'api'])] }
  )
}

/** S4 · agent + browser + web + api (co-heroes over a strip). */
export function s4(): Scenario {
  return build(
    [
      agent('agent', 0, 0),
      desktop('br', 460, 0, { previewSourceId: 'web', callsPorts: [3000] }),
      term('web', 0, 900, { ports: [5173] }),
      term('api', 460, 900, { ports: [3000] })
    ],
    { contexts: [ctxOf('ctx:app', ['agent', 'br', 'web', 'api'])] }
  )
}

/** S5 · mobile + desktop previews of ONE source + its web server (`duo-rail`). */
export function s5(): Scenario {
  return build(
    [
      mobile('mob', 0, 0, { previewSourceId: 'web' }),
      desktop('desk', 470, 0, { previewSourceId: 'web' }),
      term('web', 1790, 0, { ports: [5173] })
    ],
    { contexts: [ctxOf('ctx:app', ['mob', 'desk', 'web'])] }
  )
}

/** S6 · two apps (two contexts) — the stage is the one holding the last focus. */
export function s6(): Scenario {
  return build(
    [
      desktop('brA', 0, 0, { previewSourceId: 'webA', callsPorts: [3000], lastFocusedAt: 200 }),
      term('webA', 1320, 0, { ports: [5173] }),
      term('apiA', 1320, 400, { ports: [3000] }),
      desktop('brB', 2000, 0, { previewSourceId: 'webB', callsPorts: [3001], lastFocusedAt: 100 }),
      term('webB', 3320, 0, { ports: [5174] }),
      term('apiB', 3320, 400, { ports: [3001] })
    ],
    {
      contexts: [
        ctxOf('ctx:appA', ['brA', 'webA', 'apiA']),
        ctxOf('ctx:appB', ['brB', 'webB', 'apiB'])
      ]
    }
  )
}

/** S7 · 3 planning boards + 1 kanban in a Named Group (docs → shelf). */
export function s7(): Scenario {
  return build(
    [plan('plan1', 0, 0), plan('plan2', 560, 0), plan('plan3', 1120, 0), kanban('kb', 0, 420)],
    { groups: [{ id: 'g:docs', name: 'Docs', boardIds: ['plan1', 'plan2', 'plan3', 'kb'] }] }
  )
}

/** S8 · `n` peer agents, no lead (grid). */
export function s8(n = 4): Scenario {
  const ids = Array.from({ length: n }, (_, i) => `agent${i + 1}`)
  return build(
    ids.map((id, i) => agent(id, (i % 3) * 460, Math.floor(i / 3) * 380)),
    { contexts: [ctxOf('ctx:peers', ids)] }
  )
}

/** S9 · swarm board (two docked workers inside it) + its kanban, grouped. */
export function s9(): Scenario {
  return build(
    [
      { id: 'sw', type: 'swarm', x: 0, y: 0, w: 1180, h: 660 },
      term('d1', 0, 0, { dockedIn: 'sw', agent: true }),
      term('d2', 0, 0, { dockedIn: 'sw', agent: true }),
      kanban('kb', 1220, 0)
    ],
    { groups: [{ id: 'g:swarm', name: 'Swarm', boardIds: ['sw', 'kb', 'd1', 'd2'] }] }
  )
}

/** S10 · kitchen sink: team (lead + 3) · App (2 browsers + 2 servers) · Docs (2 plans + kanban). */
export function s10(): Scenario {
  return build(
    [
      term('lead', 0, 0),
      agent('w1', 480, 0),
      agent('w2', 480, 380),
      agent('w3', 480, 760),
      desktop('br1', 1400, 0, { previewSourceId: 'web', callsPorts: [3000] }),
      mobile('br2', 2720, 0, { previewSourceId: 'web' }),
      term('web', 1400, 900, { ports: [5173] }),
      term('api', 1860, 900, { ports: [3000] }),
      plan('plan1', 0, 1300),
      plan('plan2', 560, 1300),
      kanban('kb', 1120, 1300)
    ],
    {
      connectors: [cable('lead', 'w1'), cable('lead', 'w2'), cable('lead', 'w3')],
      groups: [{ id: 'g:docs', name: 'Docs', boardIds: ['plan1', 'plan2', 'kb'] }],
      contexts: [ctxOf('ctx:app', ['br1', 'br2', 'web', 'api'])],
      lead: 'lead'
    }
  )
}

/** S11 · a single board. */
export function s11(): Scenario {
  return build([term('solo', 100, 200)])
}

/** S12 · 12 boards; the selection scope is the lead + 2 of its workers. */
export function s12(): Scenario {
  const sink = s10()
  return build([...sink.boards, term('extra', -600, 0)], {
    connectors: [cable('lead', 'w1'), cable('lead', 'w2'), cable('lead', 'w3')],
    groups: [{ id: 'g:docs', name: 'Docs', boardIds: ['plan1', 'plan2', 'kb'] }],
    contexts: [ctxOf('ctx:app', ['br1', 'br2', 'web', 'api'])],
    lead: 'lead'
  })
}

/** S15 · five plain shells (no agent, no port) in one context. */
export function s15(): Scenario {
  const ids = ['sh1', 'sh2', 'sh3', 'sh4', 'sh5']
  return build(
    ids.map((id, i) => term(id, i * 460, 0)),
    { contexts: [ctxOf('ctx:shells', ids)] }
  )
}
