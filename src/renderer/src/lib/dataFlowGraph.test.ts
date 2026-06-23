import { describe, it, expect } from 'vitest'
import { buildGraph, focusSubgraph, diffGraphs, type DfGraph } from './dataFlowGraph'
import type { TemplateGroup } from './routeTemplate'
import type { Entity, EntityModel } from './entityInfer'
import type { InferredField, ShapeType } from './schemaInfer'

const field = (
  key: string,
  types: ShapeType[],
  extra: Partial<InferredField> = {}
): InferredField => ({
  key,
  types,
  presentIn: 1,
  sampleCount: 1,
  required: true,
  ...extra
})
const entity = (e: Partial<Entity> & Pick<Entity, 'name' | 'kind'>): Entity => ({
  schemaKey: 'k',
  fields: [],
  fieldKeys: [],
  producedBy: [],
  consumedBy: [],
  fkFields: [],
  isLeaf: false,
  ...e
})
const grp = (
  method: string,
  origin: string,
  template: string,
  calls = 1,
  p50?: number
): TemplateGroup => ({
  key: `${method} ${origin}${template}`,
  tpl: { method, origin, template, segKinds: [] },
  records: [],
  examples: [],
  calls,
  statusMix: { c2xx: calls, c3xx: 0, c4xx: 0, c5xx: 0, other: 0 },
  p50Ms: p50
})

const ORIGIN = 'http://localhost:3000'

function relationalModel(): { groups: TemplateGroup[]; model: EntityModel } {
  const groups = [
    grp('GET', ORIGIN, '/api/users/{id}', 72, 28),
    grp('GET', ORIGIN, '/api/orders', 86, 34)
  ]
  const model: EntityModel = {
    entities: [
      entity({
        name: 'User',
        kind: 'entity',
        pk: 'id',
        producedBy: [groups[0].key],
        fields: [field('id', ['string'], { format: 'uuid' }), field('email', ['string'])],
        fieldKeys: ['id', 'email']
      }),
      entity({
        name: 'Order',
        kind: 'entity',
        pk: 'id',
        producedBy: [groups[1].key],
        fkFields: [{ via: 'customerId', target: 'user' }],
        fields: [field('id', ['string']), field('customerId', ['string'])],
        fieldKeys: ['id', 'customerId']
      })
    ],
    relationships: [
      { from: 'User', to: 'Order', via: 'customerId', kind: '1-*', confidence: 'name+type' }
    ]
  }
  return { groups, model }
}

describe('buildGraph', () => {
  const { groups, model } = relationalModel()
  const lineage = [
    {
      idName: 'userId',
      fromKey: groups[0].key,
      toKey: groups[1].key,
      location: 'path' as const,
      confidence: 'url-shared' as const
    }
  ]
  const g = buildGraph(groups, model, lineage)

  it('emits one page node per origin', () => {
    expect(g.nodes.filter((n) => n.kind === 'page')).toHaveLength(1)
    expect(g.nodes.find((n) => n.kind === 'page')?.id).toBe(`page:${ORIGIN}`)
  })

  it('emits an endpoint node per template with method + call count', () => {
    const ep = g.nodes.find((n) => n.id === groups[0].key)
    expect(ep).toMatchObject({ kind: 'endpoint', method: 'GET', label: '/api/users/{id}' })
    expect(ep?.sub).toContain('72 calls')
  })

  it('emits entity nodes with id-accented PK/FK fields', () => {
    const order = g.nodes.find((n) => n.id === 'ent:Order')
    expect(order?.kind).toBe('entity')
    expect(order?.fields).toContainEqual(
      expect.objectContaining({ key: 'customerId', idLike: true })
    )
  })

  it('wires call (page→endpoint), returns (endpoint→entity), rel (entity→entity) and lineage edges', () => {
    expect(g.edges.some((e) => e.kind === 'call' && e.to === groups[0].key)).toBe(true)
    expect(g.edges.some((e) => e.kind === 'returns' && e.to === 'ent:User')).toBe(true)
    expect(
      g.edges.some((e) => e.kind === 'rel' && e.from === 'ent:User' && e.to === 'ent:Order')
    ).toBe(true)
    expect(g.edges.some((e) => e.kind === 'lineage' && e.label === 'userId')).toBe(true)
  })

  it('dedupes the returns edge when one endpoint both produces AND consumes an entity', () => {
    // PUT /users/{id} both takes and returns the entity → its key lands in producedBy AND consumedBy.
    // Without dedup this emitted two identical `ret:` edges (same id) and React Flow drops one.
    const grps = [grp('PUT', ORIGIN, '/api/users/{id}', 5)]
    const m: EntityModel = {
      entities: [
        entity({
          name: 'User',
          kind: 'entity',
          producedBy: [grps[0].key],
          consumedBy: [grps[0].key],
          fields: [field('id', ['string'])],
          fieldKeys: ['id']
        })
      ],
      relationships: []
    }
    const built = buildGraph(grps, m, [])
    expect(built.edges.filter((e) => e.kind === 'returns' && e.to === 'ent:User')).toHaveLength(1)
    const ids = built.edges.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length) // all edge ids unique (React Flow keys on id)
  })
})

describe('buildGraph — flat API graceful degradation', () => {
  it('draws zero entity→entity and zero lineage edges when none are inferred', () => {
    const groups = [grp('GET', ORIGIN, '/api/weather', 48), grp('GET', ORIGIN, '/api/stocks', 52)]
    const model: EntityModel = {
      entities: [
        entity({
          name: 'Weather',
          kind: 'shape',
          producedBy: [groups[0].key],
          fields: [field('tempC', ['number'])],
          fieldKeys: ['tempC']
        }),
        entity({
          name: 'Stock',
          kind: 'shape',
          producedBy: [groups[1].key],
          fields: [field('price', ['number'])],
          fieldKeys: ['price']
        })
      ],
      relationships: []
    }
    const g = buildGraph(groups, model, [])
    expect(g.edges.some((e) => e.kind === 'rel')).toBe(false)
    expect(g.edges.some((e) => e.kind === 'lineage')).toBe(false)
    expect(g.nodes.filter((n) => n.kind === 'shape')).toHaveLength(2)
    // still has the page→endpoint→shape backbone
    expect(g.edges.filter((e) => e.kind === 'call')).toHaveLength(2)
    expect(g.edges.filter((e) => e.kind === 'returns')).toHaveLength(2)
  })
})

describe('focusSubgraph', () => {
  const { groups, model } = relationalModel()
  const g = buildGraph(groups, model, [])

  it('returns the focused node + its direct neighbors', () => {
    const bright = focusSubgraph(g, groups[0].key, 1)
    expect(bright.has(groups[0].key)).toBe(true)
    expect(bright.has(`page:${ORIGIN}`)).toBe(true) // call neighbor
    expect(bright.has('ent:User')).toBe(true) // returns neighbor
    expect(bright.has('ent:Order')).toBe(false) // 2 hops away — dimmed
  })

  it('returns every node when the focus is unknown/empty', () => {
    expect(focusSubgraph(g, undefined).size).toBe(g.nodes.length)
    expect(focusSubgraph(g, 'nope').size).toBe(g.nodes.length)
  })
})

describe('diffGraphs', () => {
  const a: DfGraph = {
    nodes: [
      { id: 'x', kind: 'endpoint', label: '/x' },
      { id: 'e', kind: 'entity', label: 'E', fields: [{ key: 'id', type: 'uuid' }] }
    ],
    edges: []
  }
  it('flags added / removed / changed nodes against a baseline', () => {
    const b: DfGraph = {
      nodes: [
        {
          id: 'e',
          kind: 'entity',
          label: 'E',
          fields: [
            { key: 'id', type: 'uuid' },
            { key: 'name', type: 'string' }
          ]
        },
        { id: 'y', kind: 'endpoint', label: '/y' }
      ],
      edges: []
    }
    const d = diffGraphs(a, b)
    expect([...d.added]).toEqual(['y'])
    expect([...d.removed]).toEqual(['x'])
    expect([...d.changed]).toEqual(['e']) // gained a field
  })

  it('reports nothing changed when regenerated over identical captures (idempotent)', () => {
    const d = diffGraphs(a, a)
    expect(d.added.size + d.removed.size + d.changed.size).toBe(0)
  })

  it('treats no baseline as no diff', () => {
    const d = diffGraphs(undefined, a)
    expect(d.added.size + d.removed.size + d.changed.size).toBe(0)
  })
})
