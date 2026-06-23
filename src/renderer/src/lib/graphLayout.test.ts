import { describe, it, expect } from 'vitest'
import { layoutGraph, nodeHeight, edgePath } from './graphLayout'
import type { DfGraph } from './dataFlowGraph'

const graph: DfGraph = {
  nodes: [
    { id: 'page:o', kind: 'page', label: 'PAGE', sub: 'host' },
    { id: 'ep1', kind: 'endpoint', label: '/a', method: 'GET' },
    { id: 'ep2', kind: 'endpoint', label: '/b', method: 'GET' },
    { id: 'ent:E', kind: 'entity', label: 'E', fields: [{ key: 'id', type: 'uuid' }] }
  ],
  edges: [{ id: 'e', from: 'ep1', to: 'ent:E', kind: 'returns' }]
}

describe('layoutGraph', () => {
  const out = layoutGraph(graph)

  it('places nodes in columns by kind (page < endpoint < entity by x)', () => {
    const x = (id: string): number => out.byId.get(id)!.x
    expect(x('page:o')).toBeLessThan(x('ep1'))
    expect(x('ep1')).toBeLessThan(x('ent:E'))
  })

  it('stacks same-column nodes top-to-bottom (non-overlapping y)', () => {
    const a = out.byId.get('ep1')!
    const b = out.byId.get('ep2')!
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h)
  })

  it('returns a positive content size and a byId index', () => {
    expect(out.width).toBeGreaterThan(0)
    expect(out.height).toBeGreaterThan(0)
    expect(out.byId.size).toBe(4)
  })
})

describe('nodeHeight', () => {
  it('grows with the field count and the +N-more row', () => {
    const base = nodeHeight({ id: 'a', kind: 'entity', label: 'A' })
    const withFields = nodeHeight({
      id: 'b',
      kind: 'entity',
      label: 'B',
      fields: [{ key: 'id', type: 'uuid' }],
      moreFields: 3
    })
    expect(withFields).toBeGreaterThan(base)
  })
})

describe('edgePath', () => {
  it('builds a bezier from the source right edge to the target left edge', () => {
    const out = layoutGraph(graph)
    const p = edgePath(out.byId.get('ep1')!, out.byId.get('ent:E')!)
    expect(p).toMatch(/^M [\d.]+ [\d.]+ C /)
  })
})
