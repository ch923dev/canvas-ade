/**
 * ROLE-LAYOUT.md §8 guarantees as seeded property tests (no fast-check in deps — a tiny
 * mulberry32 PRNG; every failure message carries its seed). Each property runs ≥ 200 random
 * canvases through the REAL C9 pipeline (`deriveRoles` + `buildRoleUnits`), sometimes with
 * deliberately corrupted units (duplicates, stale ids, missing boards), docked workers, random
 * scopes / primaries / selections, every overflow mode, `resize:false`, `implicit`, and
 * degenerate panes.
 */
import { describe, expect, test } from 'vitest'
import {
  buildRoleUnits,
  deriveRoles,
  type BoardRoleInfo,
  type RoleBoardInput,
  type RoleUnit
} from '../../../shared/boardRoles'
import {
  FIT_MAX_ZOOM,
  FIT_MIN_ZOOM,
  rectsIntersect,
  type Rect
} from '../../../shared/spatialGeometry'
import { MIN_BOARD_SIZE } from './boardDefaults'
import { GROUP_BOX_PAD } from '../canvas/GroupBoxLayer'
import { roleLayout, type RoleLayoutOptions, type RoleLayoutResult } from './roleLayout'
import { roleMinimum, sizeClassOf, sizeOf } from './roleSizing'

/** mulberry32 — a tiny seeded PRNG so every failing case is reproducible from its seed. */
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

interface Case {
  boards: RoleBoardInput[]
  roles: Map<string, BoardRoleInfo>
  units: RoleUnit[]
  opts: RoleLayoutOptions
}

const TYPES = [
  'terminal',
  'terminal',
  'terminal',
  'terminal',
  'browser',
  'browser',
  'planning',
  'kanban',
  'file',
  'dataflow',
  'swarm',
  'command',
  'mystery'
]
const OVERFLOWS: ReadonlyArray<RoleLayoutOptions['overflow']> = [
  undefined,
  'report',
  'pages',
  'shrink'
]

type Connectors = Array<Parameters<typeof deriveRoles>[1][number]>
type Contexts = Parameters<typeof buildRoleUnits>[3]

function genCase(seed: number): Case {
  const rnd = mulberry32(seed)
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const subset = (xs: readonly string[], p: number): string[] => xs.filter(() => rnd() < p)
  const n = int(0, 22)
  const boards: RoleBoardInput[] = []
  for (let i = 0; i < n; i++) {
    const c = rnd()
    const [w, h] =
      c < 0.1
        ? [int(8, 239), int(8, 159)]
        : c < 0.9
          ? [int(240, 1300), int(160, 900)]
          : [int(1500, 5000), int(1000, 3500)]
    boards.push({
      id: `${pick(['a', 'k', 'z'])}${i}`,
      type: pick(TYPES),
      x: int(-3000, 3000),
      y: int(-3000, 3000),
      w,
      h
    })
  }
  const ofType = (t: string): string[] => boards.filter((b) => b.type === t).map((b) => b.id)
  const terms = ofType('terminal')
  const browsers = ofType('browser')
  const hosts = [...ofType('swarm'), 'ghost-host']
  for (const b of boards) {
    if (rnd() < 0.3) b.lastFocusedAt = int(1, 50)
    if (b.type === 'terminal') {
      if (rnd() < 0.4) b.agent = true
      if (rnd() < 0.35) b.ports = [int(3000, 3004)]
      if (rnd() < 0.12) b.dockedIn = pick(hosts)
    } else if (b.type === 'browser') {
      if (terms.length > 0 && rnd() < 0.6) b.previewSourceId = pick(terms)
      if (rnd() < 0.35) b.callsPorts = [int(3000, 3004)]
    } else if (b.type === 'dataflow' && browsers.length > 0 && rnd() < 0.7) {
      b.sourceBoardId = pick(browsers)
    }
  }
  const ids = boards.map((b) => b.id)
  const connectors: Connectors = []
  for (let k = int(0, 6); k > 0 && ids.length > 1; k--) {
    connectors.push({
      sourceId: pick(ids),
      targetId: pick(ids),
      kind: pick(['orchestration', 'preview'] as const)
    })
  }
  const groups = Array.from({ length: int(0, 3) }, (_, g) => ({
    id: `g${g}`,
    name: `G${g}`,
    boardIds: [...subset(ids, 0.25), ...(rnd() < 0.2 ? ['ghost'] : [])]
  }))
  const contexts: Contexts = Array.from({ length: int(0, 3) }, (_, c) => ({
    key: `ctx${c}`,
    suggestedName: `C${c}`,
    boardIds: subset(ids, 0.3).sort(),
    signals: ['cwd'],
    confidence: 'medium'
  }))
  const lead = terms.length > 0 && rnd() < 0.4 ? pick(terms) : null
  const roles = deriveRoles(boards, connectors, { leadBoardId: lead })
  let units = buildRoleUnits(boards, connectors, groups, contexts, roles)
  if (rnd() < 0.2 && ids.length > 0) {
    // Corrupt the units: a duplicate claim, a stale id, and a dropped unit.
    units = [
      ...units.slice(1),
      {
        key: 'bogus',
        boardIds: [...subset(ids, 0.3), 'ghost'],
        source: 'context',
        scene: 'peers',
        heroIds: []
      }
    ]
  }
  const opts: RoleLayoutOptions = {
    pane:
      rnd() < 0.05 ? { w: int(1, 200), h: int(1, 200) } : { w: int(320, 3840), h: int(240, 2160) },
    overflow: pick(OVERFLOWS)
  }
  if (rnd() < 0.2 && ids.length > 0) opts.primary = rnd() < 0.8 ? pick(ids) : 'ghost'
  if (rnd() < 0.25) opts.scope = { boardIds: [...subset(ids, 0.5), 'ghost'] }
  if (rnd() < 0.15) opts.resize = false
  if (rnd() < 0.3) opts.implicit = true
  if (rnd() < 0.3) opts.selectedIds = subset(ids, 0.2)
  if (rnd() < 0.1) opts.readableZoom = Math.round((0.2 + rnd() * 0.6) * 1e6) / 1e6
  return { boards, roles, units, opts }
}

/** Fisher–Yates with its own seeded PRNG. */
function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed)
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const CASES = 200

function forAll(base: number, check: (c: Case, res: RoleLayoutResult, seed: string) => void): void {
  for (let i = 0; i < CASES; i++) {
    const seed = base + i
    const c = genCase(seed)
    check(c, roleLayout(c.boards, c.roles, c.units, c.opts), `seed=${seed}`)
  }
}

const liveById = (c: Case): Map<string, RoleBoardInput> => {
  const m = new Map<string, RoleBoardInput>()
  for (const b of c.boards) if (!b.dockedIn && !m.has(b.id)) m.set(b.id, b)
  return m
}

/** Final rects — a placement's w/h wins over the board's own (sanitized) size. */
const rectsOf = (c: Case, res: RoleLayoutResult): Map<string, Rect> => {
  const live = liveById(c)
  return new Map(
    res.placements.map((p) => {
      const size = sizeOf(live.get(p.id)!)
      return [p.id, { x: p.x, y: p.y, w: p.w ?? size.w, h: p.h ?? size.h }]
    })
  )
}

const pad = (r: Rect, p: number): Rect => ({
  x: r.x - p,
  y: r.y - p,
  w: r.w + 2 * p,
  h: r.h + 2 * p
})

const bounds = (rects: readonly Rect[]): Rect => {
  const x = rects.reduce((m, r) => Math.min(m, r.x), Infinity)
  const y = rects.reduce((m, r) => Math.min(m, r.y), Infinity)
  const right = rects.reduce((m, r) => Math.max(m, r.x + r.w), -Infinity)
  const bottom = rects.reduce((m, r) => Math.max(m, r.y + r.h), -Infinity)
  return { x, y, w: right - x, h: bottom - y }
}

describe('roleLayout — §8 guarantees (seeded random canvases)', () => {
  test('no two boards overlap', () => {
    forAll(10_000, (c, res, seed) => {
      const list = [...rectsOf(c, res)]
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          expect(
            rectsIntersect(list[i][1], list[j][1]),
            `${seed} ${list[i][0]}×${list[j][0]}`
          ).toBe(false)
        }
      }
    })
  })

  test('units never interleave (the padded bbox of A holds no board of B)', () => {
    forAll(20_000, (c, res, seed) => {
      const rects = rectsOf(c, res)
      for (const a of res.units) {
        const box = pad(bounds(a.boardIds.map((id) => rects.get(id)!)), GROUP_BOX_PAD)
        for (const b of res.units) {
          if (b === a) continue
          for (const id of b.boardIds) {
            expect(rectsIntersect(box, rects.get(id)!), `${seed} ${a.key} ∋ ${id} (${b.key})`).toBe(
              false
            )
          }
        }
      }
    })
  })

  test('rigid boards keep their exact w/h (never sized)', () => {
    forAll(30_000, (c, res, seed) => {
      for (const p of res.placements) {
        const b = liveById(c).get(p.id)!
        if (sizeClassOf(b.type, c.roles.get(p.id)?.role) !== 'rigid') continue
        expect(p.w === undefined && p.h === undefined, `${seed} ${p.id} (${b.type})`).toBe(true)
      }
    })
  })

  test('previews keep their w:h within ±1 px', () => {
    forAll(40_000, (c, res, seed) => {
      for (const p of res.placements) {
        if (p.w === undefined || p.h === undefined) continue
        const b = liveById(c).get(p.id)!
        if (b.type !== 'browser') continue
        const size = sizeOf(b)
        const r = size.w / size.h
        const err = Math.min(Math.abs(p.w - p.h * r), Math.abs(p.h - p.w / r))
        expect(err, `${seed} ${p.id} ${p.w}×${p.h} vs ${size.w}×${size.h}`).toBeLessThanOrEqual(1)
      }
    })
  })

  test('every flexible board it sizes is ≥ its role minimum (MIN_BOARD_SIZE under shrink)', () => {
    forAll(50_000, (c, res, seed) => {
      for (const p of res.placements) {
        if (p.w === undefined || p.h === undefined) continue
        const b = liveById(c).get(p.id)!
        if (sizeClassOf(b.type, c.roles.get(p.id)?.role) !== 'flexible') continue
        const min = c.opts.overflow === 'shrink' ? MIN_BOARD_SIZE : roleMinimum(b.type)
        expect(p.w, `${seed} ${p.id}.w`).toBeGreaterThanOrEqual(min.w)
        expect(p.h, `${seed} ${p.id}.h`).toBeGreaterThanOrEqual(min.h)
      }
    })
  })

  test('deterministic for any input order', () => {
    forAll(60_000, (c, res, seed) => {
      const s = Number(seed.slice(5))
      const boards = shuffled(c.boards, s + 1)
      const roles = new Map(shuffled([...c.roles], s + 2))
      const units = shuffled(c.units, s + 3).map((u, i) => ({
        ...u,
        boardIds: shuffled(u.boardIds, s + 10 + i)
      }))
      const opts: RoleLayoutOptions = {
        ...c.opts,
        ...(c.opts.selectedIds ? { selectedIds: shuffled(c.opts.selectedIds, s + 4) } : {}),
        ...(c.opts.scope && c.opts.scope !== 'all'
          ? { scope: { boardIds: shuffled(c.opts.scope.boardIds, s + 5) } }
          : {})
      }
      expect(roleLayout(boards, roles, units, opts), seed).toEqual(res)
    })
  })

  test('exactly one placement per arranged board; docked and out-of-scope boards get none', () => {
    forAll(70_000, (c, res, seed) => {
      const scope = c.opts.scope && c.opts.scope !== 'all' ? new Set(c.opts.scope.boardIds) : null
      const expected = [...liveById(c).keys()].filter((id) => !scope || scope.has(id)).sort()
      expect(
        res.placements.map((p) => p.id),
        seed
      ).toEqual(expected)
      // …and every placed board sits in exactly one reported unit.
      const inUnits = res.units.flatMap((u) => u.boardIds).sort()
      expect(inUnits, seed).toEqual(expected)
    })
  })

  test('the ack is coherent: finite camera, zoom in range, readable ⇔ zoom ≥ readableZoom', () => {
    forAll(80_000, (c, res, seed) => {
      for (const v of [res.camera.x, res.camera.y, res.camera.zoom, res.targetZoom]) {
        expect(Number.isFinite(v), seed).toBe(true)
      }
      for (const p of res.placements) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y), `${seed} ${p.id}`).toBe(true)
      }
      expect(res.camera.zoom, seed).toBe(res.targetZoom)
      if (res.placements.length === 0) return
      expect(res.targetZoom, seed).toBeGreaterThanOrEqual(FIT_MIN_ZOOM)
      expect(res.targetZoom, seed).toBeLessThanOrEqual(FIT_MAX_ZOOM)
      expect(res.readable, seed).toBe(res.targetZoom >= (c.opts.readableZoom ?? 0.4))
      expect(res.units[0].key, seed).toBe(res.stageKey)
      for (const u of res.units) expect(u.why.length, `${seed} ${u.key}`).toBeGreaterThan(0)
    })
  })
})
