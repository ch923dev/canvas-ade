import { describe, expect, it } from 'vitest'
import { buildLayoutDigest } from './layoutModel'
import { READABLE_ZOOM, visibleWorld } from '../shared/spatialGeometry'
import type { CanvasView } from '../shared/spatialTypes'

/** A placed board at (x,y) sized w×h. */
const b = (id: string, x: number, y: number, w = 100, h = 80, type = 'terminal') => ({
  id,
  type,
  x,
  y,
  w,
  h
})

describe('buildLayoutDigest', () => {
  it('empty canvas → empty digest', () => {
    const d = buildLayoutDigest([])
    expect(d).toEqual({
      version: 2,
      count: 0,
      bbox: null,
      boards: [],
      overlaps: [],
      arrangement: 'empty',
      groups: [],
      screen: null,
      fit: { zoomToFitAll: null, readable: false, readableZoom: READABLE_ZOOM }
    })
  })

  it('a single placed board → single, bbox = that board', () => {
    const d = buildLayoutDigest([b('a', 10, 20, 200, 100)])
    expect(d.count).toBe(1)
    expect(d.arrangement).toBe('single')
    expect(d.bbox).toEqual({ x: 10, y: 20, w: 200, h: 100 })
    expect(d.overlaps).toEqual([])
  })

  it('drops boards without finite geometry (not placeable)', () => {
    const d = buildLayoutDigest([
      b('a', 0, 0),
      { id: 'noGeo', type: 'terminal' },
      { id: 'nan', type: 'terminal', x: NaN, y: 0, w: 100, h: 80 },
      { id: 'inf', type: 'terminal', x: 0, y: Infinity, w: 100, h: 80 }
    ])
    expect(d.count).toBe(1)
    expect(d.boards.map((bd) => bd.id)).toEqual(['a'])
  })

  it('three boards side by side (same y band) → row', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 140, 0), b('c', 280, 0)])
    expect(d.arrangement).toBe('row')
    expect(d.overlaps).toEqual([])
    expect(d.bbox).toEqual({ x: 0, y: 0, w: 380, h: 80 }) // 280 + 100
  })

  it('three boards stacked (same x band) → column', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 0, 120), b('c', 0, 240)])
    expect(d.arrangement).toBe('column')
  })

  it('a 2×2 non-overlapping block → grid', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 140, 0), b('c', 0, 120), b('d', 140, 120)])
    expect(d.arrangement).toBe('grid')
    expect(d.overlaps).toEqual([])
  })

  it('overlapping boards → scattered + the pair is reported (id-sorted, once)', () => {
    const d = buildLayoutDigest([b('z', 0, 0, 200, 200), b('a', 50, 50, 200, 200)])
    expect(d.arrangement).toBe('scattered')
    expect(d.overlaps).toEqual([{ a: 'a', b: 'z' }]) // sorted a<z, single pair
  })

  it('touching edges do NOT count as overlap (strict intersection)', () => {
    // b starts exactly where a ends on x → adjacent, not overlapping → a clean row.
    const d = buildLayoutDigest([b('a', 0, 0, 100, 80), b('b', 100, 0, 100, 80)])
    expect(d.overlaps).toEqual([])
    expect(d.arrangement).toBe('row')
  })

  it('joins the first Named Group membership as groupId; ungrouped boards omit it', () => {
    const d = buildLayoutDigest(
      [b('a', 0, 0), b('b', 140, 0), b('lone', 280, 0)],
      [{ id: 'g1', name: 'Auth zone', boardIds: ['a', 'b'] }]
    )
    const byId = Object.fromEntries(d.boards.map((bd) => [bd.id, bd]))
    expect(byId.a.groupId).toBe('g1')
    expect(byId.b.groupId).toBe('g1')
    expect('groupId' in byId.lone).toBe(false)
    expect(byId.lone.groupIds).toEqual([])
  })

  it('groupIds lists EVERY group a board belongs to; groupId stays the first (G8)', () => {
    const d = buildLayoutDigest(
      [b('a', 0, 0), b('b', 140, 0)],
      [
        { id: 'g1', name: 'Auth zone', boardIds: ['b'] },
        { id: 'g2', name: 'API', boardIds: ['a', 'b'] },
        { id: 'g3', name: 'Review', boardIds: ['b'] }
      ]
    )
    const byId = Object.fromEntries(d.boards.map((bd) => [bd.id, bd]))
    expect(byId.b.groupIds).toEqual(['g1', 'g2', 'g3']) // group input order
    expect(byId.b.groupId).toBe('g1') // v1 back-compat: the FIRST group
    expect(byId.a.groupIds).toEqual(['g2'])
    expect(byId.a.groupId).toBe('g2')
  })

  it('staggered-but-chained boards are ONE row (interval overlap is not transitive)', () => {
    // a–b share a y-band, b–c share a y-band, a–c do NOT — union-find must still make one row.
    const d = buildLayoutDigest([
      b('a', 0, 0, 100, 40),
      b('b', 140, 30, 100, 40), // overlaps a's band (0–40 vs 30–70) and c's (30–70 vs 60–100)
      b('c', 280, 60, 100, 40)
    ])
    expect(d.arrangement).toBe('row')
  })
})

/** A sanitized C1 view: pane w×h, camera at (x, y) zoom z, visibleWorld derived. */
const view = (w: number, h: number, x = 0, y = 0, zoom = 1): CanvasView => {
  const pane = { w, h }
  const camera = { x, y, zoom }
  return { pane, dpr: 1, camera, visibleWorld: visibleWorld(pane, camera) }
}

describe('buildLayoutDigest v2 (spatial awareness C2)', () => {
  it('keeps every v1 field and reports version 2', () => {
    const d = buildLayoutDigest([b('a', 0, 0), b('b', 140, 0)])
    expect(d.version).toBe(2)
    expect(d.count).toBe(2)
    expect(d.bbox).toEqual({ x: 0, y: 0, w: 240, h: 80 })
    expect(d.overlaps).toEqual([])
    expect(d.arrangement).toBe('row')
    expect(d.boards[0]).toEqual({
      id: 'a',
      type: 'terminal',
      x: 0,
      y: 0,
      w: 100,
      h: 80,
      groupIds: [],
      onScreen: false,
      role: 'shell' // C9 (L11): a terminal with no agent / port signal
    })
  })

  it('without a view: screen null, zoomToFitAll null, readable false, nothing on screen', () => {
    const d = buildLayoutDigest([b('a', 0, 0)])
    expect(d.screen).toBeNull()
    expect(d.fit).toEqual({ zoomToFitAll: null, readable: false, readableZoom: 0.4 })
    expect(d.boards.every((bd) => bd.onScreen === false)).toBe(true)
    // An explicit null view/display reads the same.
    expect(buildLayoutDigest([b('a', 0, 0)], [], { view: null, display: null }).screen).toBeNull()
  })

  it('onScreen = intersects the visible world rect', () => {
    // Pane 1000×500 at zoom 1, camera at (0,0) → visible world x∈[0,1000), y∈[0,500).
    const d = buildLayoutDigest(
      [b('in', 100, 100), b('edge', 950, 450), b('right', 1200, 0), b('above', 0, -300)],
      [],
      { view: view(1000, 500) }
    )
    const on = Object.fromEntries(d.boards.map((bd) => [bd.id, bd.onScreen]))
    expect(on).toEqual({ in: true, edge: true, right: false, above: false })
    // Pan the camera left by 1200 screen px → the right-hand board comes on screen.
    const panned = buildLayoutDigest([b('right', 1200, 0)], [], { view: view(1000, 500, -1200) })
    expect(panned.boards[0].onScreen).toBe(true)
  })

  it('screen = the view + the display when MAIN read one', () => {
    const display = {
      workArea: { x: 0, y: 0, w: 2560, h: 1400 },
      scaleFactor: 1.5,
      maximized: true,
      fullscreen: false
    }
    const v = view(1000, 500, -10, 20, 0.5)
    expect(buildLayoutDigest([], [], { view: v, display }).screen).toEqual({ ...v, display })
    expect(buildLayoutDigest([], [], { view: v }).screen).toEqual(v) // no display key at all
  })

  it('groups: every group with the bbox of its PLACED members; multi-membership in groupIds', () => {
    const d = buildLayoutDigest(
      [b('a', 0, 0), b('b', 200, 100), b('c', 500, 0), { id: 'noGeo', type: 'planning' }],
      [
        { id: 'g1', name: 'API', boardIds: ['a', 'b'] },
        { id: 'g2', name: 'Review', boardIds: ['b', 'c', 'noGeo'] },
        { id: 'g3', name: 'Ghosts', boardIds: ['noGeo', 'gone'] }
      ]
    )
    expect(d.groups).toEqual([
      { id: 'g1', name: 'API', boardIds: ['a', 'b'], bbox: { x: 0, y: 0, w: 300, h: 180 } },
      {
        id: 'g2',
        name: 'Review',
        boardIds: ['b', 'c', 'noGeo'],
        bbox: { x: 200, y: 0, w: 400, h: 180 }
      },
      { id: 'g3', name: 'Ghosts', boardIds: ['noGeo', 'gone'], bbox: null }
    ])
    const bById = Object.fromEntries(d.boards.map((bd) => [bd.id, bd]))
    expect(bById.b.groupIds).toEqual(['g1', 'g2'])
    expect(bById.b.groupId).toBe('g1') // v1 field: still the FIRST group
  })

  it('fit.readable flips exactly at READABLE_ZOOM (0.4)', () => {
    // fitZoom = min((pane.w − 128) / bbox.w, (pane.h − 128) / bbox.h) → 400 / 1000 = 0.4 exactly.
    const at = buildLayoutDigest([b('a', 0, 0, 1000, 1000)], [], { view: view(528, 528) })
    expect(at.fit.zoomToFitAll).toBeCloseTo(0.4, 10)
    expect(at.fit.readable).toBe(true)
    const below = buildLayoutDigest([b('a', 0, 0, 1001, 1000)], [], { view: view(528, 528) })
    expect(below.fit.zoomToFitAll).toBeLessThan(0.4)
    expect(below.fit.readable).toBe(false)
  })

  it('fit.zoomToFitAll is clamped to the FIT_FRAME max zoom for a tiny canvas', () => {
    const d = buildLayoutDigest([b('a', 0, 0, 100, 80)], [], { view: view(1920, 1080) })
    expect(d.fit).toEqual({ zoomToFitAll: 2, readable: true, readableZoom: 0.4 })
  })

  it('a view with no placed boards: screen present, nothing to fit', () => {
    const d = buildLayoutDigest([], [], { view: view(1000, 500) })
    expect(d.screen).not.toBeNull()
    expect(d.fit.zoomToFitAll).toBeNull()
    expect(d.fit.readable).toBe(false)
  })

  it('a worker docked in a swarm is not geometry — dropped from boards, bbox, overlaps, fit', () => {
    const d = buildLayoutDigest(
      [b('swarm', 0, 0, 600, 400, 'swarm'), { ...b('worker', 100, 100), dockedIn: 'swarm' }],
      [{ id: 'g', name: 'Team', boardIds: ['swarm', 'worker'] }]
    )
    expect(d.count).toBe(1)
    expect(d.boards.map((bd) => bd.id)).toEqual(['swarm'])
    expect(d.overlaps).toEqual([]) // its stale parking rect no longer reads as an overlap
    expect(d.groups[0].bbox).toEqual({ x: 0, y: 0, w: 600, h: 400 })
  })
})

describe('buildLayoutDigest — C9 `role` on placed boards (L11)', () => {
  const at = (
    id: string,
    x: number,
    y: number,
    type: string,
    extra: Record<string, unknown> = {}
  ) => ({
    ...b(id, x, y, 200, 150, type),
    ...extra
  })
  const roleById = (d: ReturnType<typeof buildLayoutDigest>): Record<string, string> =>
    Object.fromEntries(d.boards.map((bd) => [bd.id, bd.role]))

  it('lead · agent · server · shell · preview · plan', () => {
    const d = buildLayoutDigest(
      [
        at('lead', 0, 0, 'terminal', { agent: true }),
        at('agent', 300, 0, 'terminal', { agent: true }),
        at('server', 600, 0, 'terminal', { ports: [3000] }),
        at('shell', 900, 0, 'terminal'),
        at('preview', 0, 300, 'browser', { previewSourceId: 'server', callsPorts: [3000] }),
        at('plan', 300, 300, 'planning')
      ],
      [],
      {},
      { leadBoardId: 'lead' }
    )
    expect(roleById(d)).toEqual({
      lead: 'lead',
      agent: 'agent',
      server: 'server',
      shell: 'shell',
      preview: 'preview',
      plan: 'plan'
    })
  })

  it('the lead comes ONLY from the MAIN lead input — no lead ⇒ the board keeps its own role', () => {
    const boards = [at('t', 0, 0, 'terminal', { agent: true })]
    expect(buildLayoutDigest(boards).boards[0].role).toBe('agent')
    expect(buildLayoutDigest(boards, [], {}, { leadBoardId: null }).boards[0].role).toBe('agent')
    expect(buildLayoutDigest(boards, [], {}, { leadBoardId: 't' }).boards[0].role).toBe('lead')
  })

  it('every other board type maps to its role; signals on the wrong type are ignored', () => {
    const d = buildLayoutDigest([
      at('k', 0, 0, 'kanban'),
      at('df', 300, 0, 'dataflow', { sourceBoardId: 'br' }),
      at('f', 600, 0, 'file'),
      at('sw', 900, 0, 'swarm'),
      at('cmd', 1200, 0, 'command'),
      at('br', 0, 300, 'browser', { agent: true, ports: [80] }) // terminal-only signals
    ])
    expect(roleById(d)).toEqual({
      k: 'tracker',
      df: 'dataflow',
      f: 'file',
      sw: 'swarm',
      cmd: 'command',
      br: 'preview'
    })
  })

  it('absent when there is no geometry (unplaced) or the board is docked — even the lead', () => {
    const d = buildLayoutDigest(
      [
        { id: 'noGeo', type: 'terminal', agent: true },
        at('docked', 0, 0, 'terminal', { dockedIn: 'sw' }),
        at('placed', 300, 0, 'terminal')
      ],
      [],
      {},
      { leadBoardId: 'noGeo' }
    )
    expect(d.boards.map((bd) => [bd.id, bd.role])).toEqual([['placed', 'shell']])
  })

  it('connectors: only preview / orchestration edges are read; anything else is dropped', () => {
    const boards = [at('lead', 0, 0, 'terminal'), at('w', 300, 0, 'terminal', { agent: true })]
    const d = buildLayoutDigest(
      boards,
      [],
      {},
      {
        leadBoardId: 'lead',
        connectors: [
          { sourceId: 'lead', targetId: 'w', kind: 'orchestration' },
          { sourceId: 'w', targetId: 'lead', kind: 'bogus' }
        ]
      }
    )
    expect(roleById(d)).toEqual({ lead: 'lead', w: 'agent' })
  })

  it('🔒 D9: the digest carries the role only — no signal, title or launch line is echoed', () => {
    const d = buildLayoutDigest([
      at('t', 0, 0, 'terminal', {
        agent: true,
        ports: [3000],
        title: 'secret-title',
        launchCommand: 'KEY=sk-secret claude'
      })
    ])
    expect(Object.keys(d.boards[0]).sort()).toEqual(
      ['groupIds', 'h', 'id', 'onScreen', 'role', 'type', 'w', 'x', 'y'].sort()
    )
    expect(JSON.stringify(d)).not.toMatch(/sk-secret|secret-title|3000/)
  })
})
