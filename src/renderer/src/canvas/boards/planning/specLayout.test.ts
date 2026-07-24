import { describe, it, expect } from 'vitest'
import {
  specNodeBox,
  specToElkGraph,
  elkResultToLayout,
  specEdgePath,
  specEdgeLabelPoint,
  specHitTest,
  GROUP_PAD,
  type ElkNodeOut,
  type PositionedSpecNode
} from './specLayout'
import type { DiagramSpec } from '../../../lib/diagramSpec'

const spec = (over: Partial<DiagramSpec> = {}): DiagramSpec => ({
  version: 1,
  direction: 'right',
  nodes: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B', detail: 'sub' }
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b' }],
  ...over
})

describe('specNodeBox', () => {
  it('sizes by silhouette and grows one row for detail', () => {
    expect(specNodeBox({})).toEqual({ w: 168, h: 32 })
    expect(specNodeBox({ detail: 'x' })).toEqual({ w: 168, h: 49 })
    expect(specNodeBox({ kind: 'actor' })).toEqual({ w: 120, h: 32 })
    expect(specNodeBox({ kind: 'note' })).toEqual({ w: 200, h: 32 })
    expect(specNodeBox({ kind: 'decision' })).toEqual({ w: 168, h: 32 })
  })

  it('grows by member rows (Phase 5): rows*15 + 2, stacking with detail', () => {
    const rows = [{ left: 'id', right: 'uuid' }, { left: 'status' }]
    expect(specNodeBox({ rows })).toEqual({ w: 168, h: 32 + 2 * 15 + 2 })
    expect(specNodeBox({ detail: 'x', rows })).toEqual({ w: 168, h: 49 + 2 * 15 + 2 })
    expect(specNodeBox({ rows: [] })).toEqual({ w: 168, h: 32 })
  })
})

describe('specToElkGraph', () => {
  it('maps nodes/edges with namespaced ids and the layered algorithm', () => {
    const g = specToElkGraph(spec())
    expect(g.layoutOptions['elk.algorithm']).toBe('layered')
    expect(g.layoutOptions['elk.direction']).toBe('RIGHT')
    expect(g.children.map((c) => c.id)).toEqual(['n:a', 'n:b'])
    expect(g.children[0]).toMatchObject({ width: 168, height: 32 })
    expect(g.children[1]).toMatchObject({ width: 168, height: 49 })
    expect(g.edges).toEqual([{ id: 'e:e1', sources: ['n:a'], targets: ['n:b'] }])
  })

  it('maps direction down → DOWN', () => {
    expect(specToElkGraph(spec({ direction: 'down' })).layoutOptions['elk.direction']).toBe('DOWN')
  })

  it('nests grouped nodes as compound children with label padding', () => {
    const g = specToElkGraph(
      spec({
        groups: [{ id: 'g1', label: 'Build' }],
        nodes: [
          { id: 'a', label: 'A', group: 'g1' },
          { id: 'b', label: 'B' }
        ]
      })
    )
    expect(g.children.map((c) => c.id)).toEqual(['n:b', 'g:g1'])
    const grp = g.children.find((c) => c.id === 'g:g1')
    expect(grp?.children?.map((c) => c.id)).toEqual(['n:a'])
    expect(grp?.layoutOptions?.['elk.padding']).toContain(`top=${GROUP_PAD.top}`)
  })
})

describe('elkResultToLayout', () => {
  const elkOut: ElkNodeOut = {
    id: 'root',
    children: [
      { id: 'n:b', x: 240, y: 16, width: 168, height: 49 },
      {
        id: 'g:g1',
        x: 16,
        y: 16,
        width: 196,
        height: 100,
        children: [{ id: 'n:a', x: 14, y: 22, width: 168, height: 32 }]
      }
    ]
  }

  it('flattens compound children to absolute coordinates', () => {
    const s = spec({
      groups: [{ id: 'g1', label: 'Build' }],
      nodes: [
        { id: 'a', label: 'A', group: 'g1' },
        { id: 'b', label: 'B', detail: 'sub' }
      ]
    })
    const out = elkResultToLayout(s, elkOut)
    expect(out.byId.get('a')).toMatchObject({ x: 30, y: 38 }) // 16+14, 16+22
    expect(out.byId.get('b')).toMatchObject({ x: 240, y: 16 })
    expect(out.groups).toEqual([{ id: 'g1', x: 16, y: 16, w: 196, h: 100 }])
    // extent covers the furthest box + margin
    expect(out.width).toBe(240 + 168 + 16)
    expect(out.height).toBe(16 + 100 + 16)
  })

  it('lets a user pin override the engine position for that node only', () => {
    const s = spec({
      groups: [{ id: 'g1', label: 'Build' }],
      nodes: [
        { id: 'a', label: 'A', group: 'g1', pos: { x: 500, y: 400 } },
        { id: 'b', label: 'B', detail: 'sub' }
      ]
    })
    const out = elkResultToLayout(s, elkOut)
    expect(out.byId.get('a')).toMatchObject({ x: 500, y: 400 })
    expect(out.byId.get('b')).toMatchObject({ x: 240, y: 16 })
  })
})

describe('specEdgePath', () => {
  const a: PositionedSpecNode = { id: 'a', x: 0, y: 0, w: 100, h: 40 }
  const b: PositionedSpecNode = { id: 'b', x: 200, y: 100, w: 100, h: 40 }

  it('anchors right-mid → left-mid for direction right', () => {
    expect(specEdgePath(a, b, 'right')).toBe('M 100 20 C 150 20, 150 120, 200 120')
  })

  it('anchors bottom-mid → top-mid for direction down', () => {
    expect(specEdgePath(a, b, 'down')).toBe('M 50 40 C 50 70, 250 70, 250 100')
  })
})

describe('specEdgeLabelPoint', () => {
  // Deliberately unequal boxes (actor-width source, detail-height target): the right- and
  // down-direction midpoints only coincide when both boxes match, so these pin the branch.
  const a: PositionedSpecNode = { id: 'a', x: 0, y: 0, w: 120, h: 32 }
  const b: PositionedSpecNode = { id: 'b', x: 40, y: 100, w: 168, h: 49 }

  it('midpoints the right-mid → left-mid anchors for direction right', () => {
    expect(specEdgeLabelPoint(a, b, 'right')).toEqual({ x: (120 + 40) / 2, y: (16 + 124.5) / 2 })
  })

  it('midpoints the bottom-mid → top-mid anchors for direction down (not the right formula)', () => {
    const down = specEdgeLabelPoint(a, b, 'down')
    expect(down).toEqual({ x: (60 + 124) / 2, y: (32 + 100) / 2 })
    expect(down).not.toEqual(specEdgeLabelPoint(a, b, 'right'))
  })
})

describe('specHitTest', () => {
  // 200×100 content fit-centred in a 400×300 view: fit = min(400/200, 300/100) = 2 — content
  // paints as 400×200 (visually y 50…250). Node n1 (10,10 40×20), n2 overlaps it (30,10 40×20,
  // later sibling paints on top), group g1 (0,0 100×60) underneath both.
  const layout = {
    nodes: [
      { id: 'n1', x: 10, y: 10, w: 40, h: 20 },
      { id: 'n2', x: 30, y: 10, w: 40, h: 20 }
    ],
    byId: new Map([
      ['n1', { id: 'n1', x: 10, y: 10, w: 40, h: 20 }],
      ['n2', { id: 'n2', x: 30, y: 10, w: 40, h: 20 }]
    ]),
    groups: [{ id: 'g1', x: 0, y: 0, w: 100, h: 60 }],
    width: 200,
    height: 100
  }
  const view = { w: 400, h: 300 }
  const noPan = { x: 0, y: 0 }
  // Layout point (lx,ly) → view point at zoom 1: (lx·2 + 0, ly·2 + 50).
  const at = (lx: number, ly: number): { x: number; y: number } => ({ x: lx * 2, y: ly * 2 + 50 })

  it('hits a node through the fit-centred transform at zoom 1', () => {
    expect(specHitTest(at(15, 15), view, noPan, 1, layout)).toEqual({ kind: 'node', id: 'n1' })
  })

  it('prefers the topmost (later) node where boxes overlap, and groups only under no node', () => {
    expect(specHitTest(at(40, 15), view, noPan, 1, layout)).toEqual({ kind: 'node', id: 'n2' })
    expect(specHitTest(at(5, 50), view, noPan, 1, layout)).toEqual({ kind: 'group', id: 'g1' })
  })

  it('misses empty canvas (inside the content extent but outside every box)', () => {
    expect(specHitTest(at(150, 90), view, noPan, 1, layout)).toBeNull()
  })

  it('inverts card zoom and pan (transform about the view centre, pan in view px)', () => {
    // zoom 2, pan (30,-10): view = centre + 2·fit·(l − layoutCentre) + pan.
    const v = (lx: number, ly: number): { x: number; y: number } => ({
      x: 200 + 4 * (lx - 100) + 30,
      y: 150 + 4 * (ly - 50) - 10
    })
    expect(specHitTest(v(15, 15), view, { x: 30, y: -10 }, 2, layout)).toEqual({
      kind: 'node',
      id: 'n1'
    })
    expect(specHitTest(v(150, 90), view, { x: 30, y: -10 }, 2, layout)).toBeNull()
  })

  it('returns null for a degenerate view or layout extent', () => {
    expect(specHitTest({ x: 0, y: 0 }, { w: 0, h: 300 }, noPan, 1, layout)).toBeNull()
    expect(specHitTest({ x: 0, y: 0 }, view, noPan, 1, { ...layout, width: 0 })).toBeNull()
  })
})
