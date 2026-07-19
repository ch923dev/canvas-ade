import { describe, it, expect } from 'vitest'
import {
  specNodeBox,
  specToElkGraph,
  elkResultToLayout,
  specEdgePath,
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
