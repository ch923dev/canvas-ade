import { describe, it, expect } from 'vitest'
import { dfGraphToSpec } from './dfSpecAdapter'
import type { DfGraph, GraphDiff } from './dataFlowGraph'
import { assertDiagramSpec, SPEC_MAX_EDGES, SPEC_MAX_NODES, SPEC_MAX_ROWS } from './diagramSpec'

const NO_DIFF: GraphDiff = { added: new Set(), removed: new Set(), changed: new Set() }

const fail = (msg: string): never => {
  throw new Error(msg)
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The canonical sample: page → endpoints → entities + a rel + a lineage edge. */
function sample(): DfGraph {
  return {
    nodes: [
      { id: 'page:https://app.acme.dev', kind: 'page', label: 'app.acme.dev' },
      {
        id: 'GET /api/orders',
        kind: 'endpoint',
        label: '/api/orders',
        method: 'GET',
        sub: '63 calls · 34ms'
      },
      { id: 'GET /api/orders/{id}', kind: 'endpoint', label: '/api/orders/{id}', method: 'GET' },
      {
        id: 'ent:Order',
        kind: 'entity',
        label: 'Order',
        sub: '8 fields',
        fields: [
          { key: 'id', type: 'uuid', idLike: true },
          { key: 'status', type: 'string' }
        ],
        moreFields: 2
      },
      {
        id: 'ent:OrderList',
        kind: 'shape',
        label: 'OrderList',
        fields: [{ key: 'items', type: '[ ]' }]
      }
    ],
    edges: [
      {
        id: 'call:GET /api/orders',
        from: 'page:https://app.acme.dev',
        to: 'GET /api/orders',
        kind: 'call'
      },
      {
        id: 'ret:GET /api/orders:Order',
        from: 'GET /api/orders',
        to: 'ent:Order',
        kind: 'returns'
      },
      {
        id: 'rel:Order:Customer:customerId',
        from: 'ent:Order',
        to: 'ent:OrderList',
        kind: 'rel',
        label: 'customerId'
      },
      {
        id: 'lin:a:b:orderId',
        from: 'GET /api/orders',
        to: 'GET /api/orders/{id}',
        kind: 'lineage',
        label: 'orderId'
      }
    ]
  }
}

describe('dfGraphToSpec', () => {
  it('produces a spec that passes the real validator (slug ids, closed vocab)', () => {
    const { spec } = dfGraphToSpec(sample(), NO_DIFF)
    expect(() => assertDiagramSpec(spec, fail, isRecord, isFiniteNum)).not.toThrow()
    expect(spec.direction).toBe('right')
  })

  it('maps kinds: page→actor, endpoint→service, entity/shape→data (+shape muted)', () => {
    const { spec, toSlug } = dfGraphToSpec(sample(), NO_DIFF)
    const byId = new Map(spec.nodes.map((n) => [n.id, n]))
    expect(byId.get(toSlug.get('page:https://app.acme.dev')!)!.kind).toBe('actor')
    expect(byId.get(toSlug.get('GET /api/orders')!)!.kind).toBe('service')
    const shape = byId.get(toSlug.get('ent:OrderList')!)!
    expect(shape.kind).toBe('data')
    expect(shape.status).toBe('muted')
    expect(byId.get(toSlug.get('ent:Order')!)!.status).toBeUndefined()
  })

  it('maps edges: call→flow, returns→data, rel→dependency+label, lineage→dependency+active+label', () => {
    const { spec } = dfGraphToSpec(sample(), NO_DIFF)
    const kinds = spec.edges.map((e) => [e.kind, e.status, e.label])
    expect(kinds).toEqual([
      ['flow', undefined, undefined],
      ['data', undefined, undefined],
      ['dependency', undefined, 'customerId'],
      ['dependency', 'active', 'orderId']
    ])
  })

  it('bakes the regenerate diff into statuses: added→active, changed→warn (diff wins over muted)', () => {
    const diff: GraphDiff = {
      added: new Set(['GET /api/orders', 'ent:OrderList']),
      removed: new Set(),
      changed: new Set(['ent:Order'])
    }
    const { spec, toSlug } = dfGraphToSpec(sample(), diff)
    const byId = new Map(spec.nodes.map((n) => [n.id, n]))
    expect(byId.get(toSlug.get('GET /api/orders')!)!.status).toBe('active')
    expect(byId.get(toSlug.get('ent:Order')!)!.status).toBe('warn')
    expect(byId.get(toSlug.get('ent:OrderList')!)!.status).toBe('active')
  })

  it('maps entity fields to rows (id accent) and folds moreFields into a "+N more" row', () => {
    const { spec, toSlug } = dfGraphToSpec(sample(), NO_DIFF)
    const order = spec.nodes.find((n) => n.id === toSlug.get('ent:Order'))!
    expect(order.rows).toEqual([
      { left: 'id', right: 'uuid', accent: true },
      { left: 'status', right: 'string' },
      { left: '+2 more' }
    ])
    expect(order.detail).toBe('entity · 8 fields')
  })

  it('endpoint detail composes method + sub; page carries none', () => {
    const { spec, toSlug } = dfGraphToSpec(sample(), NO_DIFF)
    const byId = new Map(spec.nodes.map((n) => [n.id, n]))
    expect(byId.get(toSlug.get('GET /api/orders')!)!.detail).toBe('GET · 63 calls · 34ms')
    expect(byId.get(toSlug.get('GET /api/orders/{id}')!)!.detail).toBe('GET')
    expect(byId.get(toSlug.get('page:https://app.acme.dev')!)!.detail).toBeUndefined()
  })

  it('slugs deterministically and de-dupes collisions with a numeric suffix', () => {
    const graph: DfGraph = {
      nodes: [
        { id: 'GET /a/b', kind: 'endpoint', label: '/a/b' },
        { id: 'GET /a-b', kind: 'endpoint', label: '/a-b' },
        { id: 'GET /a b', kind: 'endpoint', label: '/a b' }
      ],
      edges: []
    }
    const one = dfGraphToSpec(graph, NO_DIFF)
    const two = dfGraphToSpec(graph, NO_DIFF)
    expect(one.spec.nodes.map((n) => n.id)).toEqual(two.spec.nodes.map((n) => n.id))
    expect(new Set(one.spec.nodes.map((n) => n.id)).size).toBe(3)
    for (const [df, slug] of one.toSlug) expect(one.fromSlug.get(slug)).toBe(df)
  })

  it('caps rows at SPEC_MAX_ROWS with the more-row folded in', () => {
    const graph: DfGraph = {
      nodes: [
        {
          id: 'ent:Big',
          kind: 'entity',
          label: 'Big',
          fields: Array.from({ length: SPEC_MAX_ROWS + 4 }, (_, i) => ({
            key: `f${i}`,
            type: 'string'
          })),
          moreFields: 9
        }
      ],
      edges: []
    }
    const { spec } = dfGraphToSpec(graph, NO_DIFF)
    const rows = spec.nodes[0].rows!
    expect(rows.length).toBeLessThanOrEqual(SPEC_MAX_ROWS)
    expect(rows[rows.length - 1]).toEqual({ left: '+9 more' })
    expect(() => assertDiagramSpec(spec, fail, isRecord, isFiniteNum)).not.toThrow()
  })

  it('truncates past the node/edge caps and drops edges into the void', () => {
    const nodes = Array.from({ length: SPEC_MAX_NODES + 10 }, (_, i) => ({
      id: `GET /r/${i}`,
      kind: 'endpoint' as const,
      label: `/r/${i}`
    }))
    const edges = Array.from({ length: SPEC_MAX_EDGES + 20 }, (_, i) => ({
      id: `call:${i}`,
      from: `GET /r/${i % (SPEC_MAX_NODES + 10)}`,
      to: `GET /r/${(i + 1) % (SPEC_MAX_NODES + 10)}`,
      kind: 'call' as const
    }))
    const { spec, truncated } = dfGraphToSpec({ nodes, edges }, NO_DIFF)
    expect(spec.nodes.length).toBe(SPEC_MAX_NODES)
    expect(spec.edges.length).toBeLessThanOrEqual(SPEC_MAX_EDGES)
    expect(truncated.nodes).toBe(10)
    expect(truncated.edges).toBeGreaterThan(0)
    expect(() => assertDiagramSpec(spec, fail, isRecord, isFiniteNum)).not.toThrow()
  })
})
