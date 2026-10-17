/**
 * Golden fixtures S1–S15 for the role-aware tidy (ROLE-LAYOUT.md §7, signed off 2026-10-16).
 * Each scenario asserts (a) the STRUCTURE its wireframe shows — hero side + share, rail / strip
 * order, co-heroes side by side, grid shape, rigid sizes untouched, readability, scene + heroes —
 * and (b) a FROZEN snapshot of the exact result as an explicit literal below. The frozen numbers
 * are the contract going forward: a change to them is a deliberate re-freeze, never a drive-by.
 *
 * Share tolerance: a hero's share is measured against its split's budget on the solved frame
 * (`frameAt(avail, targetZoom)` minus the in-split gaps) and must sit within ±1 percentage point
 * of the §4 figure (62 / 50 / 45 / 70 %) — whole-px slot rounding is the only slack. An
 * aspect-locked hero takes its device aspect instead of a share (§5), and a rigid hero wraps its
 * own size (S14), so those assert their own rule.
 */
import { describe, expect, test } from 'vitest'
import { FIT_UNIT_GAP } from './fitLayout'
import { DEFAULT_TERMINAL_FONT } from '../canvas/boards/terminal/terminalFont'
import { TITLEBAR_H } from './browserLayout'
import { MIN_BOARD_SIZE } from './boardDefaults'
import {
  roleLayout,
  type RoleLayoutOptions,
  type RoleLayoutPlacement,
  type RoleLayoutResult
} from './roleLayout'
import { availOf, frameAt } from './roleSizing'
import {
  BOARD_TITLEBAR_H,
  HERO_SHARE,
  ROLE_GAP,
  TERMINAL_CELL_H,
  TERMINAL_CELL_W,
  TERMINAL_FONT_PX,
  TERMINAL_MIN
} from './roleTemplates'
import {
  PANE_16_9,
  PANE_21_9,
  PANE_9_16,
  PANE_SMALL,
  s1,
  s10,
  s11,
  s12,
  s15,
  s2,
  s3,
  s4,
  s5,
  s6,
  s7,
  s8,
  s9,
  type Scenario
} from './roleLayout.scenarios'

const P = (id: string, x: number, y: number, w?: number, h?: number): RoleLayoutPlacement =>
  w === undefined ? { id, x, y } : { id, x, y, w, h }

const run = (sc: Scenario, opts: Partial<RoleLayoutOptions> = {}): RoleLayoutResult =>
  roleLayout(sc.boards, sc.roles, sc.units, { pane: PANE_16_9, ...opts })

const at = (res: RoleLayoutResult, id: string): Required<RoleLayoutPlacement> => {
  const p = res.placements.find((q) => q.id === id)
  if (!p) throw new Error(`no placement for ${id}`)
  return { w: NaN, h: NaN, ...p } as Required<RoleLayoutPlacement>
}

const SHARE_TOL = 0.01

/** `len` as a share of a 2-way split's budget along `axis` on the solved stage frame. */
function shareOf(
  res: RoleLayoutResult,
  pane: { w: number; h: number },
  len: number,
  axis: 'w' | 'h'
): number {
  const frame = frameAt(availOf(pane), res.targetZoom)
  return len / (frame[axis] - ROLE_GAP)
}

/** Every board of `ids` lies right of / below `edge` (strictly, by at least `gap`). */
const rightOf = (p: RoleLayoutPlacement, q: Required<RoleLayoutPlacement>): boolean =>
  p.x >= q.x + q.w
const below = (p: RoleLayoutPlacement, q: Required<RoleLayoutPlacement>): boolean =>
  p.y >= q.y + q.h

// ── Frozen results (generated from the signed-off engine; re-freeze deliberately) ──
const S1: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail',
      why: 'hero = lead #lead: cabled to 2 boards',
      boardIds: ['lead', 'w1', 'w2']
    }
  ],
  placements: [P('lead', 0, 0, 895, 772), P('w1', 923, 0, 549, 372), P('w2', 923, 400, 549, 372)]
}

const S2: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 0.7201,
  readable: true,
  camera: { x: 64.06, y: 64.03, zoom: 0.7201 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail/2-col',
      why: 'hero = lead #lead: cabled to 6 boards',
      boardIds: ['lead', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6']
    }
  ],
  placements: [
    P('lead', 0, 0, 1008, 1072),
    P('w1', 1036, 0, 490, 339),
    P('w2', 1554, 0, 490, 339),
    P('w3', 1036, 367, 490, 338),
    P('w4', 1554, 367, 490, 338),
    P('w5', 1036, 733, 490, 339),
    P('w6', 1554, 733, 490, 339)
  ]
}

const S2_SMALL: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 0.375,
  readable: false,
  camera: { x: 64, y: 64, zoom: 0.375 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail/2-col',
      why: 'hero = lead #lead: cabled to 6 boards',
      boardIds: ['lead', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6']
    }
  ],
  placements: [
    P('lead', 0, 0, 756, 992),
    P('w1', 784, 0, 490, 312),
    P('w2', 1302, 0, 490, 312),
    P('w3', 784, 340, 490, 312),
    P('w4', 1302, 340, 490, 312),
    P('w5', 784, 680, 490, 312),
    P('w6', 1302, 680, 490, 312)
  ]
}

const S2_SMALL_SHRINK: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 0.4,
  readable: true,
  camera: { x: 64, y: 64, zoom: 0.4 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail/2-col',
      why: 'hero = lead #lead: cabled to 6 boards',
      boardIds: ['lead', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6']
    }
  ],
  placements: [
    P('lead', 0, 0, 826, 930),
    P('w1', 854, 0, 399, 291),
    P('w2', 1281, 0, 399, 291),
    P('w3', 854, 319, 399, 292),
    P('w4', 1281, 319, 399, 292),
    P('w5', 854, 639, 399, 291),
    P('w6', 1281, 639, 399, 291)
  ]
}

const S3: RoleLayoutResult = {
  stageKey: 'ctx:app',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'ctx:app',
      scene: 'stack',
      heroIds: ['br'],
      template: 'hero-rail',
      why: 'hero = browser #br: preview of :5173, calls :3000',
      boardIds: ['api', 'br', 'web']
    }
  ],
  placements: [P('api', 982, 400, 490, 372), P('br', 0, 0, 954, 644), P('web', 982, 0, 490, 372)]
}

const S4: RoleLayoutResult = {
  stageKey: 'ctx:app',
  targetZoom: 0.7228,
  readable: true,
  camera: { x: 64.19, y: 64.02, zoom: 0.7228 },
  units: [
    {
      key: 'ctx:app',
      scene: 'pair',
      heroIds: ['agent', 'br'],
      template: 'duo-strip',
      why: 'co-heroes = agent #agent + browser #br: preview of :5173, calls :3000',
      boardIds: ['agent', 'api', 'br', 'web']
    }
  ],
  placements: [
    P('agent', 0, 0, 929, 728),
    P('api', 1032, 756, 1004, 312),
    P('br', 957, 0, 1079, 728),
    P('web', 0, 756, 1004, 312)
  ]
}

const S5: RoleLayoutResult = {
  stageKey: 'ctx:app',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'ctx:app',
      scene: 'stack',
      heroIds: ['desk', 'mob'],
      template: 'duo-rail',
      why: 'co-heroes = browser #desk + browser #mob: preview of :5173',
      boardIds: ['desk', 'mob', 'web']
    }
  ],
  placements: [P('desk', 0, 0, 686, 463), P('mob', 714, 0, 240, 507), P('web', 982, 0, 490, 772)]
}

const S6: RoleLayoutResult = {
  stageKey: 'ctx:appA',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'ctx:appA',
      scene: 'stack',
      heroIds: ['brA'],
      template: 'hero-rail',
      why: 'hero = browser #brA: preview of :5173, calls :3000',
      boardIds: ['apiA', 'brA', 'webA']
    },
    {
      key: 'ctx:appB',
      scene: 'stack',
      heroIds: ['brB'],
      template: 'hero-rail',
      why: 'hero = browser #brB: preview of :5174, calls :3001',
      boardIds: ['apiB', 'brB', 'webB']
    }
  ],
  placements: [
    P('apiA', 982, 400, 490, 372),
    P('apiB', 2321, 340, 490, 312),
    P('brA', 0, 0, 954, 644),
    P('brB', 1568, 0, 725, 489),
    P('webA', 982, 0, 490, 372),
    P('webB', 2321, 0, 490, 312)
  ]
}

const S6_SELECT_B: RoleLayoutResult = {
  stageKey: 'ctx:appB',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'ctx:appB',
      scene: 'stack',
      heroIds: ['brB'],
      template: 'hero-rail',
      why: 'hero = browser #brB: preview of :5174, calls :3001',
      boardIds: ['apiB', 'brB', 'webB']
    },
    {
      key: 'ctx:appA',
      scene: 'stack',
      heroIds: ['brA'],
      template: 'hero-rail',
      why: 'hero = browser #brA: preview of :5173, calls :3000',
      boardIds: ['apiA', 'brA', 'webA']
    }
  ],
  placements: [
    P('apiA', 2321, 340, 490, 312),
    P('apiB', 982, 400, 490, 372),
    P('brA', 1568, 0, 725, 489),
    P('brB', 0, 0, 954, 644),
    P('webA', 2321, 0, 490, 312),
    P('webB', 982, 0, 490, 372)
  ]
}

const S7: RoleLayoutResult = {
  stageKey: 'g:docs',
  targetZoom: 0.8446,
  readable: true,
  camera: { x: 122.63, y: 64.02, zoom: 0.8446 },
  units: [
    {
      key: 'g:docs',
      scene: 'docs',
      heroIds: [],
      template: 'shelf',
      why: 'docs: 4 boards in reading order, sizes kept',
      boardIds: ['kb', 'plan1', 'plan2', 'plan3']
    }
  ],
  placements: [P('kb', 0, 394), P('plan1', 0, 0), P('plan2', 544, 0), P('plan3', 1088, 0)]
}

const S8: RoleLayoutResult = {
  stageKey: 'ctx:peers',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'ctx:peers',
      scene: 'peers',
      heroIds: [],
      template: 'grid/2x2',
      why: 'peers: 4 terminals in a 2×2 grid',
      boardIds: ['agent1', 'agent2', 'agent3', 'agent4']
    }
  ],
  placements: [
    P('agent1', 0, 0, 722, 372),
    P('agent2', 750, 0, 722, 372),
    P('agent3', 0, 400, 722, 372),
    P('agent4', 750, 400, 722, 372)
  ]
}

const S8_FIVE: RoleLayoutResult = {
  stageKey: 'ctx:peers',
  targetZoom: 0.9646,
  readable: true,
  camera: { x: 64.01, y: 64.16, zoom: 0.9646 },
  units: [
    {
      key: 'ctx:peers',
      scene: 'peers',
      heroIds: [],
      template: 'grid/3x2',
      why: 'peers: 5 terminals in a 3×2 grid',
      boardIds: ['agent1', 'agent2', 'agent3', 'agent4', 'agent5']
    }
  ],
  placements: [
    P('agent1', 0, 0, 490, 386),
    P('agent2', 518, 0, 490, 386),
    P('agent3', 1036, 0, 490, 386),
    P('agent4', 259, 414, 490, 386),
    P('agent5', 777, 414, 490, 386)
  ]
}

const S9: RoleLayoutResult = {
  stageKey: 'g:swarm',
  targetZoom: 0.6141,
  readable: true,
  camera: { x: 64, y: 64.04, zoom: 0.6141 },
  units: [
    {
      key: 'g:swarm',
      scene: 'hub',
      heroIds: ['sw'],
      template: 'hero-rail',
      why: 'hero = swarm #sw: 2 docked workers inside',
      boardIds: ['kb', 'sw']
    }
  ],
  placements: [P('kb', 1497, 0), P('sw', 0, 0, 1469, 1257)]
}

const S10: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 0.7782,
  readable: true,
  camera: { x: 64.21, y: 64.01, zoom: 0.7782 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail',
      why: 'hero = lead #lead: cabled to 3 boards',
      boardIds: ['lead', 'w1', 'w2', 'w3']
    },
    {
      key: 'ctx:app',
      scene: 'stack',
      heroIds: ['br1', 'br2'],
      template: 'duo-rail',
      why: 'co-heroes = browser #br1 + browser #br2: preview of :5173, calls :3000',
      boardIds: ['api', 'br1', 'br2', 'web']
    },
    {
      key: 'g:docs',
      scene: 'docs',
      heroIds: [],
      template: 'shelf',
      why: 'docs: 3 boards in reading order, sizes kept',
      boardIds: ['kb', 'plan1', 'plan2']
    }
  ],
  placements: [
    P('api', 753, 1428, 490, 312),
    P('br1', 0, 1088, 457, 308),
    P('br2', 485, 1088, 240, 507),
    P('kb', 1339, 1482),
    P('lead', 0, 0, 1155, 992),
    P('plan1', 1339, 1088),
    P('plan2', 1883, 1088),
    P('w1', 1183, 0, 708, 312),
    P('w2', 1183, 340, 708, 312),
    P('w3', 1183, 680, 708, 312),
    P('web', 753, 1088, 490, 312)
  ]
}

const S10_PAGES: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 0.7782,
  readable: true,
  camera: { x: 64.21, y: 64.01, zoom: 0.7782 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail',
      why: 'hero = lead #lead: cabled to 3 boards',
      boardIds: ['lead', 'w1', 'w2', 'w3']
    },
    {
      key: 'ctx:app',
      scene: 'stack',
      heroIds: ['br1', 'br2'],
      template: 'duo-rail',
      why: 'co-heroes = browser #br1 + browser #br2: preview of :5173, calls :3000',
      boardIds: ['api', 'br1', 'br2', 'web']
    },
    {
      key: 'g:docs',
      scene: 'docs',
      heroIds: [],
      template: 'shelf',
      why: 'docs: 3 boards in reading order, sizes kept',
      boardIds: ['kb', 'plan1', 'plan2']
    }
  ],
  placements: [
    P('api', 2836, 340, 490, 312),
    P('br1', 2083, 0, 457, 308),
    P('br2', 2568, 0, 240, 507),
    P('kb', 3422, 394),
    P('lead', 0, 0, 1155, 992),
    P('plan1', 3422, 0),
    P('plan2', 3966, 0),
    P('w1', 1183, 0, 708, 312),
    P('w2', 1183, 340, 708, 312),
    P('w3', 1183, 680, 708, 312),
    P('web', 2836, 0, 490, 312)
  ],
  pages: [
    { index: 0, boardIds: ['lead', 'w1', 'w2', 'w3'], bbox: { x: 0, y: 0, w: 1891, h: 992 } },
    {
      index: 1,
      boardIds: ['api', 'br1', 'br2', 'kb', 'plan1', 'plan2', 'web'],
      bbox: { x: 2083, y: 0, w: 2399, h: 914 }
    }
  ]
}

const S11: RoleLayoutResult = {
  stageKey: 'single:solo',
  targetZoom: 2,
  readable: true,
  camera: { x: 180, y: -290, zoom: 2 },
  units: [
    {
      key: 'single:solo',
      scene: 'single',
      heroIds: ['solo'],
      template: 'single',
      why: 'single: shell #solo kept at its size',
      boardIds: ['solo']
    }
  ],
  placements: [P('solo', 100, 200)]
}

const S12: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail',
      why: 'hero = lead #lead: cabled to 3 boards',
      boardIds: ['lead', 'w1', 'w2']
    }
  ],
  placements: [P('lead', 0, 0, 895, 772), P('w1', 923, 0, 549, 372), P('w2', 923, 400, 549, 372)]
}

const S13_PORTRAIT: RoleLayoutResult = {
  stageKey: 'ctx:app',
  targetZoom: 0.7658,
  readable: true,
  camera: { x: 64.04, y: 64.07, zoom: 0.7658 },
  units: [
    {
      key: 'ctx:app',
      scene: 'stack',
      heroIds: ['br'],
      template: 'hero-strip',
      why: 'hero = browser #br: preview of :5173, calls :3000',
      boardIds: ['api', 'br', 'web']
    }
  ],
  placements: [P('api', 518, 708, 490, 1214), P('br', 0, 0, 1007, 680), P('web', 0, 708, 490, 1214)]
}

const S13_ULTRAWIDE: RoleLayoutResult = {
  stageKey: 'ctx:app',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'ctx:app',
      scene: 'pair',
      heroIds: ['agent', 'br'],
      template: 'duo-rail',
      why: 'co-heroes = agent #agent + browser #br: preview of :5173, calls :3000',
      boardIds: ['agent', 'api', 'br', 'web']
    }
  ],
  placements: [
    P('agent', 0, 0, 490, 952),
    P('api', 1902, 490, 490, 462),
    P('br', 518, 0, 1356, 915),
    P('web', 1902, 0, 490, 462)
  ]
}

const S13_ULTRAWIDE_LEAD: RoleLayoutResult = {
  stageKey: 'team:lead',
  targetZoom: 1,
  readable: true,
  camera: { x: 64, y: 64, zoom: 1 },
  units: [
    {
      key: 'team:lead',
      scene: 'lead',
      heroIds: ['lead'],
      template: 'hero-rail/2-col',
      why: 'hero = lead #lead: cabled to 2 boards',
      boardIds: ['lead', 'w1', 'w2']
    }
  ],
  placements: [P('lead', 0, 0, 1064, 952), P('w1', 1092, 0, 636, 952), P('w2', 1756, 0, 636, 952)]
}

const S14: RoleLayoutResult = {
  stageKey: 'g:docs',
  targetZoom: 0.5902,
  readable: true,
  camera: { x: 373.88, y: 64.01, zoom: 0.5902 },
  units: [
    {
      key: 'g:docs',
      scene: 'docs',
      heroIds: ['plan1'],
      template: 'hero-rail',
      why: 'hero = plan #plan1: kept at its size (primary)',
      boardIds: ['kb', 'plan1', 'plan2', 'plan3']
    }
  ],
  placements: [P('kb', 544, 788), P('plan1', 0, 0), P('plan2', 544, 0), P('plan3', 544, 394)]
}

const S15_EXPLICIT: RoleLayoutResult = {
  stageKey: 'ctx:shells',
  targetZoom: 0.9646,
  readable: true,
  camera: { x: 64.01, y: 64.16, zoom: 0.9646 },
  units: [
    {
      key: 'ctx:shells',
      scene: 'peers',
      heroIds: [],
      template: 'grid/3x2',
      why: 'peers: 5 terminals in a 3×2 grid',
      boardIds: ['sh1', 'sh2', 'sh3', 'sh4', 'sh5']
    }
  ],
  placements: [
    P('sh1', 0, 0, 490, 386),
    P('sh2', 518, 0, 490, 386),
    P('sh3', 1036, 0, 490, 386),
    P('sh4', 259, 414, 490, 386),
    P('sh5', 777, 414, 490, 386)
  ]
}

const S15_IMPLICIT: RoleLayoutResult = {
  stageKey: 'ctx:shells',
  targetZoom: 0.6654,
  readable: true,
  camera: { x: 64.07, y: 336.88, zoom: 0.6654 },
  units: [
    {
      key: 'ctx:shells',
      scene: 'peers',
      heroIds: [],
      template: 'fit',
      why: 'plain shells: 5 terminals packed by position, sizes kept (implicit tidy)',
      boardIds: ['sh1', 'sh2', 'sh3', 'sh4', 'sh5']
    }
  ],
  placements: [
    P('sh1', 0, 0),
    P('sh2', 448, 0),
    P('sh3', 896, 0),
    P('sh4', 1344, 0),
    P('sh5', 1792, 0)
  ]
}

const S3_NO_RESIZE: RoleLayoutResult = {
  stageKey: 'ctx:app',
  targetZoom: 0.6764,
  readable: true,
  camera: { x: 64.08, y: 157.8, zoom: 0.6764 },
  units: [
    {
      key: 'ctx:app',
      scene: 'stack',
      heroIds: ['br'],
      template: 'fit',
      why: 'hero = browser #br: preview of :5173, calls :3000; role order only, sizes kept (resize:false)',
      boardIds: ['api', 'br', 'web']
    }
  ],
  placements: [P('api', 1756, 0), P('br', 0, 0), P('web', 1308, 0)]
}

describe('terminal readable minimum (§5, measured)', () => {
  test('mirrors the live font + chrome constants', () => {
    expect(TERMINAL_FONT_PX).toBe(DEFAULT_TERMINAL_FONT)
    expect(BOARD_TITLEBAR_H).toBe(TITLEBAR_H)
  })
  test('60 cols × 14 rows at 12.5 px → 490 × 312 (the proposal said 480 × 300)', () => {
    expect(TERMINAL_CELL_W).toBe(7.5)
    expect(TERMINAL_CELL_H).toBe(18)
    expect(TERMINAL_MIN).toEqual({ w: 490, h: 312 })
    expect(TERMINAL_MIN.w).toBeGreaterThanOrEqual(MIN_BOARD_SIZE.w)
    expect(TERMINAL_MIN.h).toBeGreaterThanOrEqual(MIN_BOARD_SIZE.h)
  })
})

describe('S1 · lead + 2 workers', () => {
  const res = run(s1())
  test('structure: lead hero on the left at 62 %, workers stacked in the rail in reading order', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template, unit.heroIds]).toEqual(['lead', 'hero-rail', ['lead']])
    expect(res.readable).toBe(true)
    const [lead, w1, w2] = ['lead', 'w1', 'w2'].map((id) => at(res, id))
    expect(Math.abs(shareOf(res, PANE_16_9, lead.w, 'w') - HERO_SHARE.rail)).toBeLessThanOrEqual(
      SHARE_TOL
    )
    expect(rightOf(w1, lead) && rightOf(w2, lead)).toBe(true)
    expect(w1.x).toBe(w2.x)
    expect(below(w2, w1)).toBe(true)
    expect(lead.h).toBe(w2.y + w2.h - w1.y) // the hero spans the rail's full height
  })
  test('frozen', () => expect(res).toEqual(S1))
})

describe('S2 · lead + 6 workers', () => {
  const res = run(s2())
  test('structure: hero 50 %, 2-column rail filled row-major (w1 w2 / w3 w4 / w5 w6)', () => {
    expect(res.units[0].template).toBe('hero-rail/2-col')
    expect(res.readable).toBe(true)
    const lead = at(res, 'lead')
    expect(Math.abs(shareOf(res, PANE_16_9, lead.w, 'w') - HERO_SHARE.rail2)).toBeLessThanOrEqual(
      SHARE_TOL
    )
    const w = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => at(res, id))
    for (const [a, b] of [
      [0, 1],
      [2, 3],
      [4, 5]
    ]) {
      expect(w[a].y).toBe(w[b].y)
      expect(rightOf(w[b], w[a])).toBe(true)
    }
    expect(below(w[2], w[0]) && below(w[4], w[2])).toBe(true)
    for (const c of w) expect([c.w >= TERMINAL_MIN.w, c.h >= TERMINAL_MIN.h]).toEqual([true, true])
  })
  test('small pane: cells cannot reach 490 × 312 at z ≥ 0.4 → readable:false (report)', () => {
    const small = run(s2(), { pane: PANE_SMALL })
    expect(small.readable).toBe(false)
    expect(small.targetZoom).toBeLessThan(0.4)
    for (const p of small.placements) {
      expect([p.w! >= TERMINAL_MIN.w, p.h! >= TERMINAL_MIN.h]).toEqual([true, true])
    }
    expect(small).toEqual(S2_SMALL)
  })
  test('small pane + D4 shrink: the stage reaches 0.4 by dropping to the board minimum', () => {
    const shrunk = run(s2(), { pane: PANE_SMALL, overflow: 'shrink' })
    expect([shrunk.readable, shrunk.targetZoom]).toEqual([true, 0.4])
    expect(at(shrunk, 'w1').w).toBeLessThan(TERMINAL_MIN.w)
    for (const p of shrunk.placements) {
      expect([p.w! >= MIN_BOARD_SIZE.w, p.h! >= MIN_BOARD_SIZE.h]).toEqual([true, true])
    }
    expect(shrunk).toEqual(S2_SMALL_SHRINK)
  })
  test('frozen', () => expect(res).toEqual(S2))
})

describe('S3 · dev stack: browser + web server + api server', () => {
  const res = run(s3())
  test('structure: browser hero left at its device aspect, web (preview source) above api (port link)', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template, unit.heroIds]).toEqual(['stack', 'hero-rail', ['br']])
    const [br, web, api] = ['br', 'web', 'api'].map((id) => at(res, id))
    expect(Math.abs(br.w - br.h * (1280 / 864))).toBeLessThanOrEqual(1)
    // Aspect-locked: the hero takes its device aspect (≥ the 62 % share), the rail its minimum.
    expect(shareOf(res, PANE_16_9, br.w, 'w')).toBeGreaterThanOrEqual(HERO_SHARE.rail - SHARE_TOL)
    expect(web.w).toBe(TERMINAL_MIN.w)
    expect(rightOf(web, br) && rightOf(api, br)).toBe(true)
    expect(below(api, web)).toBe(true)
    expect(unit.why).toBe('hero = browser #br: preview of :5173, calls :3000')
  })
  test('frozen', () => expect(res).toEqual(S3))
})

describe('S4 · agent + browser + web + api', () => {
  const res = run(s4())
  test('structure: co-heroes side by side on the top 70 %, web | api in the strip below', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template, unit.heroIds]).toEqual([
      'pair',
      'duo-strip',
      ['agent', 'br']
    ])
    const [agent, br, web, api] = ['agent', 'br', 'web', 'api'].map((id) => at(res, id))
    expect([agent.y, br.y]).toEqual([0, 0])
    expect(rightOf(br, agent)).toBe(true)
    expect(Math.abs(shareOf(res, PANE_16_9, agent.h, 'h') - HERO_SHARE.duo)).toBeLessThanOrEqual(
      SHARE_TOL
    )
    expect(Math.abs(br.w - br.h * (1280 / 864))).toBeLessThanOrEqual(1)
    expect(web.y).toBe(api.y)
    expect(below(web, agent) && below(api, br)).toBe(true)
    expect(rightOf(api, web)).toBe(true)
  })
  test('frozen', () => expect(res).toEqual(S4))
})

describe('S5 · mobile + desktop previews of one source + web server', () => {
  const res = run(s5())
  test('structure: duo-rail — both previews are co-heroes side by side, aspects kept, rail right', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template]).toEqual(['stack', 'duo-rail'])
    expect([...unit.heroIds].sort()).toEqual(['desk', 'mob'])
    const [desk, mob, web] = ['desk', 'mob', 'web'].map((id) => at(res, id))
    expect([desk.y, mob.y, web.y]).toEqual([0, 0, 0])
    expect(rightOf(mob, desk) && rightOf(web, mob)).toBe(true)
    expect(Math.abs(desk.w - desk.h * (1280 / 864))).toBeLessThanOrEqual(1)
    expect(Math.abs(mob.w - mob.h * (430 / 908))).toBeLessThanOrEqual(1)
    expect(web.h).toBe(Math.max(desk.h, mob.h, web.h)) // the rail spans the full height
  })
  test('frozen', () => expect(res).toEqual(S5))
})

describe('S6 · two apps (two contexts)', () => {
  const res = run(s6())
  test('structure: the last-focused app is the stage; the other sits compact beside it', () => {
    expect(res.stageKey).toBe('ctx:appA')
    expect(res.units.map((u) => [u.key, u.template])).toEqual([
      ['ctx:appA', 'hero-rail'],
      ['ctx:appB', 'hero-rail']
    ])
    const rightA = Math.max(...['brA', 'webA', 'apiA'].map((id) => at(res, id).x + at(res, id).w))
    for (const id of ['brB', 'webB', 'apiB']) {
      expect(at(res, id).x).toBeGreaterThanOrEqual(rightA + FIT_UNIT_GAP)
    }
    expect(at(res, 'brB').w).toBeLessThan(at(res, 'brA').w) // compact
  })
  test('the selection outranks the last focus (stage rule 3 before 4)', () => {
    const sel = run(s6(), { selectedIds: ['apiB'] })
    expect(sel.stageKey).toBe('ctx:appB')
    expect(sel).toEqual(S6_SELECT_B)
  })
  test('frozen', () => expect(res).toEqual(S6))
})

describe('S7 · 3 planning boards + 1 kanban (docs)', () => {
  const res = run(s7())
  test('structure: plans in reading order on one row, the kanban on a full row below, sizes kept', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template, unit.heroIds]).toEqual(['docs', 'shelf', []])
    const [p1, p2, p3, kb] = ['plan1', 'plan2', 'plan3', 'kb'].map((id) => at(res, id))
    expect([p1.y, p2.y, p3.y]).toEqual([0, 0, 0])
    expect(p1.x < p2.x && p2.x < p3.x).toBe(true)
    expect(kb.x).toBe(0)
    expect(kb.y).toBe(366 + ROLE_GAP)
    for (const p of res.placements) expect([p.w, p.h]).toEqual([undefined, undefined])
  })
  test('frozen', () => expect(res).toEqual(S7))
})

describe('S8 · peer agents, no lead (grid)', () => {
  const res = run(s8())
  test('structure: 4 agents → 2 × 2 equal cells', () => {
    expect(res.units[0].template).toBe('grid/2x2')
    const cells = ['agent1', 'agent2', 'agent3', 'agent4'].map((id) => at(res, id))
    expect(new Set(cells.map((c) => `${c.w}×${c.h}`)).size).toBe(1)
    expect(cells[0].y).toBe(cells[1].y)
    expect(cells[2].y).toBe(cells[3].y)
    expect(cells[0].x).toBe(cells[2].x)
  })
  test('5 agents → 3 + 2 with the last row centred', () => {
    const five = run(s8(5))
    expect(five.units[0].template).toBe('grid/3x2')
    const c = ['agent1', 'agent2', 'agent3', 'agent4', 'agent5'].map((id) => at(five, id))
    expect(c[0].y === c[1].y && c[1].y === c[2].y).toBe(true)
    expect(c[3].y).toBe(c[4].y)
    const left = c[3].x - c[0].x
    const right = c[2].x + c[2].w - (c[4].x + c[4].w)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
    expect(five).toEqual(S8_FIVE)
  })
  test('frozen', () => expect(res).toEqual(S8))
})

describe('S9 · swarm board (docked workers) + its kanban', () => {
  const res = run(s9())
  test('structure: swarm hero left at 62 %, the kanban rigid in the rail, docked workers untouched', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template, unit.heroIds]).toEqual(['hub', 'hero-rail', ['sw']])
    const [sw, kb] = ['sw', 'kb'].map((id) => at(res, id))
    expect(Math.abs(shareOf(res, PANE_16_9, sw.w, 'w') - HERO_SHARE.rail)).toBeLessThanOrEqual(
      SHARE_TOL
    )
    expect(rightOf(kb, sw)).toBe(true)
    expect([
      res.placements.find((p) => p.id === 'kb')!.w,
      res.placements.find((p) => p.id === 'kb')!.h
    ]).toEqual([undefined, undefined])
    expect(res.placements.map((p) => p.id)).toEqual(['kb', 'sw'])
    expect(unit.why).toBe('hero = swarm #sw: 2 docked workers inside')
  })
  test('frozen', () => expect(res).toEqual(S9))
})

describe('S10 · kitchen sink', () => {
  const res = run(s10())
  test('structure: the team is the stage; App and Docs are compact off-stage units', () => {
    expect(res.stageKey).toBe('team:lead')
    expect(res.units.map((u) => [u.key, u.scene, u.template])).toEqual([
      ['team:lead', 'lead', 'hero-rail'],
      ['ctx:app', 'stack', 'duo-rail'],
      ['g:docs', 'docs', 'shelf']
    ])
    expect(res.readable).toBe(true)
    const lead = at(res, 'lead')
    expect(Math.abs(shareOf(res, PANE_16_9, lead.w, 'w') - HERO_SHARE.rail)).toBeLessThanOrEqual(
      SHARE_TOL
    )
    // The camera frames the stage: its bbox centre maps to the pane centre.
    const stage = ['lead', 'w1', 'w2', 'w3'].map((id) => at(res, id))
    const cx = (Math.min(...stage.map((s) => s.x)) + Math.max(...stage.map((s) => s.x + s.w))) / 2
    expect(Math.abs(cx * res.camera.zoom + res.camera.x - PANE_16_9.w / 2)).toBeLessThan(0.01)
  })
  test('overflow:pages puts the off-stage units on page 1, right of the stage', () => {
    const paged = run(s10(), { overflow: 'pages' })
    expect(paged.pages?.map((p) => p.index)).toEqual([0, 1])
    expect(paged.pages?.[0].boardIds).toEqual(['lead', 'w1', 'w2', 'w3'])
    expect(paged).toEqual(S10_PAGES)
  })
  test('frozen', () => expect(res).toEqual(S10))
})

describe('S11 · single board', () => {
  const res = run(s11())
  test('structure: centred, size and position unchanged, camera fit capped at FIT_MAX_ZOOM', () => {
    expect(res.placements).toEqual([P('solo', 100, 200)])
    expect(res.targetZoom).toBe(2)
    expect(res.camera.x + (100 + 210) * 2).toBe(PANE_16_9.w / 2)
    expect(res.camera.y + (200 + 170) * 2).toBe(PANE_16_9.h / 2)
  })
  test('frozen', () => expect(res).toEqual(S11))
})

describe('S12 · selection scope (3 of 12 boards)', () => {
  const sc = s12()
  const res = run(sc, { scope: { boardIds: ['lead', 'w1', 'w2'] } })
  test('structure: only the selection is arranged, anchored at ITS top-left, everything else stays put', () => {
    expect(sc.boards).toHaveLength(12)
    expect(res.placements.map((p) => p.id)).toEqual(['lead', 'w1', 'w2'])
    expect(at(res, 'lead')).toMatchObject({ x: 0, y: 0 }) // the selection's corner, not the cluster's (-600, 0)
    expect(res.units.map((u) => [u.key, u.scene, u.template])).toEqual([
      ['team:lead', 'lead', 'hero-rail']
    ])
  })
  test('frozen', () => expect(res).toEqual(S12))
})

describe('S13 · screen shapes', () => {
  test('portrait 9:16 (S3): browser on top full-width, web | api in the strip below', () => {
    const res = run(s3(), { pane: PANE_9_16 })
    expect(res.units[0].template).toBe('hero-strip')
    const [br, web, api] = ['br', 'web', 'api'].map((id) => at(res, id))
    const frame = frameAt(availOf(PANE_9_16), res.targetZoom)
    // An aspect-locked desktop preview cannot fill 65 % of a 9:16 pane: it spans the full width
    // at its device aspect and the strip takes the leftover height (§5, no letterbox gap).
    expect(Math.abs(br.w - frame.w)).toBeLessThanOrEqual(1)
    expect(Math.abs(br.w - br.h * (1280 / 864))).toBeLessThanOrEqual(1)
    expect(below(web, br) && below(api, br)).toBe(true)
    expect(web.y).toBe(api.y)
    expect(rightOf(api, web)).toBe(true)
    expect(res).toEqual(S13_PORTRAIT)
  })
  test('ultrawide 21:9 (S4): agent | browser | web / api', () => {
    const res = run(s4(), { pane: PANE_21_9 })
    expect(res.units[0].template).toBe('duo-rail')
    const [agent, br, web, api] = ['agent', 'br', 'web', 'api'].map((id) => at(res, id))
    expect(rightOf(br, agent) && rightOf(web, br)).toBe(true)
    expect(web.x).toBe(api.x)
    expect(below(api, web)).toBe(true)
    expect(res).toEqual(S13_ULTRAWIDE)
  })
  test('ultrawide 21:9 (S1): hero-rail with the hero at 45 % and a 2-column rail', () => {
    const res = run(s1(), { pane: PANE_21_9 })
    expect(res.units[0].template).toBe('hero-rail/2-col')
    const [lead, w1, w2] = ['lead', 'w1', 'w2'].map((id) => at(res, id))
    expect(
      Math.abs(shareOf(res, PANE_21_9, lead.w, 'w') - HERO_SHARE.ultrawide)
    ).toBeLessThanOrEqual(SHARE_TOL)
    expect(w1.y).toBe(w2.y)
    expect(rightOf(w2, w1)).toBe(true)
    expect(res).toEqual(S13_ULTRAWIDE_LEAD)
  })
})

describe('S14 · user override `primary` (a planning board as hero)', () => {
  const res = run(s7(), { primary: 'plan1' })
  test('structure: the rigid hero wraps its size at the anchor; the rest fill the rail beside it', () => {
    const unit = res.units[0]
    expect([unit.scene, unit.template, unit.heroIds]).toEqual(['docs', 'hero-rail', ['plan1']])
    expect(at(res, 'plan1')).toMatchObject({ x: 0, y: 0 })
    for (const p of res.placements) expect([p.w, p.h]).toEqual([undefined, undefined]) // all rigid
    for (const id of ['plan2', 'plan3', 'kb'])
      expect(at(res, id).x).toBeGreaterThanOrEqual(516 + ROLE_GAP)
    expect(unit.why).toBe('hero = plan #plan1: kept at its size (primary)')
  })
  test('frozen', () => expect(res).toEqual(S14))
})

describe('S15 · 5 plain shells, no roles (D8 a)', () => {
  test('explicit mode:roles → peers → grid 3 + 2, resized (≥ the terminal minimum)', () => {
    const res = run(s15())
    expect([res.units[0].scene, res.units[0].template]).toEqual(['peers', 'grid/3x2'])
    for (const p of res.placements) {
      expect([p.w! >= TERMINAL_MIN.w, p.h! >= TERMINAL_MIN.h]).toEqual([true, true])
    }
    expect(res).toEqual(S15_EXPLICIT)
  })
  test('implicit (`t` key / omitted mode) → fit behaviour: position only, sizes kept', () => {
    const res = run(s15(), { implicit: true })
    expect(res.units[0].template).toBe('fit')
    for (const p of res.placements) expect([p.w, p.h]).toEqual([undefined, undefined])
    expect(res).toEqual(S15_IMPLICIT)
  })
})

describe('resize:false keeps the role ORDER only (D7)', () => {
  test('S3 without resizing: hero first, then its source, then the port link — no w/h', () => {
    const res = run(s3(), { resize: false })
    expect(res.units[0].template).toBe('fit')
    const [br, web, api] = ['br', 'web', 'api'].map((id) => at(res, id))
    expect(br.x < web.x && web.x < api.x).toBe(true)
    for (const p of res.placements) expect([p.w, p.h]).toEqual([undefined, undefined])
    expect(res).toEqual(S3_NO_RESIZE)
  })
})
