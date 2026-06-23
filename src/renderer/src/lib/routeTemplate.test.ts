import { describe, it, expect } from 'vitest'
import { classifySeg, routeTemplate, groupByTemplate } from './routeTemplate'
import type { NetRecord } from '../../../preload'

let seq = 0
const rec = (p: Partial<NetRecord>): NetRecord => ({
  requestId: `r${seq++}`,
  url: 'http://x/',
  method: 'GET',
  type: 'fetch',
  startTs: 0,
  ...p
})

describe('classifySeg', () => {
  it('classifies numeric / uuid / version / opaque / word segments', () => {
    expect(classifySeg('123')).toBe('id')
    expect(classifySeg('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid')
    expect(classifySeg('v2')).toBe('static') // version guardrail
    expect(classifySeg('users')).toBe('static')
    expect(classifySeg('shoes')).toBe('static') // a word slug is NOT an id
    expect(classifySeg('a1b2c3d4e5f6a7b8c9d0e1f2')).toBe('id') // long hex → opaque token
    expect(classifySeg('V1StGXR8Z5jdHi6Bmyt')).toBe('id') // nanoid-style mixed token
  })
})

describe('routeTemplate', () => {
  it('collapses id/uuid segments and drops the query string', () => {
    expect(routeTemplate('http://h/api/v2/users/123?x=1', 'get').template).toBe(
      '/api/v2/users/{id}'
    )
    expect(
      routeTemplate('http://h/api/orders/550e8400-e29b-41d4-a716-446655440000', 'GET').template
    ).toBe('/api/orders/{uuid}')
    expect(routeTemplate('http://h/api/v2/users/123', 'GET').origin).toBe('http://h')
  })
})

describe('groupByTemplate', () => {
  it('collapses repeated /users/{id} calls into one row', () => {
    const groups = groupByTemplate([
      rec({ url: 'http://h/api/v2/users/1', status: 200, endTs: 10 }),
      rec({ url: 'http://h/api/v2/users/2', status: 200, endTs: 30 }),
      rec({ url: 'http://h/api/v2/users/3', status: 404, endTs: 20 })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].tpl.template).toBe('/api/v2/users/{id}')
    expect(groups[0].calls).toBe(3)
    expect(groups[0].statusMix.c2xx).toBe(2)
    expect(groups[0].statusMix.c4xx).toBe(1)
  })

  it('keeps /v1 and /v2 distinct (version guardrail, never under-collapse)', () => {
    const groups = groupByTemplate([
      rec({ url: 'http://h/api/v1/x/1' }),
      rec({ url: 'http://h/api/v2/x/2' })
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.tpl.template).sort()).toEqual(['/api/v1/x/{id}', '/api/v2/x/{id}'])
  })

  it('keeps a small category set distinct (no over-collapse of words)', () => {
    const groups = groupByTemplate([
      rec({ url: 'http://h/products/shoes' }),
      rec({ url: 'http://h/products/hats' }),
      rec({ url: 'http://h/products/socks' })
    ])
    expect(groups).toHaveLength(3)
  })

  it('promotes a high-cardinality word position to {param}', () => {
    const recs = Array.from({ length: 12 }, (_, i) =>
      rec({ url: `http://h/items/slug-${String.fromCharCode(97 + i)}` })
    )
    const groups = groupByTemplate(recs)
    expect(groups).toHaveLength(1)
    expect(groups[0].tpl.template).toBe('/items/{param}')
  })

  it('collapses 1000 distinct ids into one template with a capped example set', () => {
    const recs = Array.from({ length: 1000 }, (_, i) => rec({ url: `http://h/api/u/${i}` }))
    const groups = groupByTemplate(recs)
    expect(groups).toHaveLength(1)
    expect(groups[0].tpl.template).toBe('/api/u/{id}')
    expect(groups[0].calls).toBe(1000)
    expect(groups[0].examples.length).toBeLessThanOrEqual(5)
  })

  it('never merges across different origins', () => {
    const groups = groupByTemplate([
      rec({ url: 'http://a/api/x/1' }),
      rec({ url: 'http://b/api/x/2' })
    ])
    expect(groups).toHaveLength(2)
  })

  it('groups websocket records under WS', () => {
    const groups = groupByTemplate([
      rec({ url: 'http://h/realtime', type: 'websocket', method: 'GET' })
    ])
    expect(groups[0].tpl.method).toBe('WS')
  })

  it('computes p50/p95 from completed durations', () => {
    const recs = [10, 20, 30, 40, 100].map((d) =>
      rec({ url: 'http://h/api/u/1', status: 200, startTs: 0, endTs: d })
    )
    const groups = groupByTemplate(recs)
    expect(groups[0].p50Ms).toBe(30)
    expect(groups[0].p95Ms).toBe(100)
  })
})
