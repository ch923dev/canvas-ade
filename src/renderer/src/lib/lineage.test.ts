import { describe, it, expect } from 'vitest'
import {
  extractUrlIds,
  urlSideLineage,
  liftEdgesToTemplates,
  mergeLineage,
  type LineageEdge,
  type RequestLineageEdge
} from './lineage'
import type { NetRecord } from '../../../preload'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

const rec = (requestId: string, url: string, startTs: number, method = 'GET'): NetRecord =>
  ({ requestId, url, method, type: 'xhr', startTs }) as NetRecord

describe('extractUrlIds', () => {
  it('names a numeric path id from the preceding static segment', () => {
    expect(extractUrlIds('http://localhost:3000/api/users/123')).toEqual([
      { token: '123', name: 'userId', location: 'path' }
    ])
  })

  it('captures a uuid path segment', () => {
    const ids = extractUrlIds(`http://localhost:3000/api/orders/${UUID}`)
    expect(ids).toEqual([{ token: UUID, name: 'orderId', location: 'path' }])
  })

  it('captures an id-shaped query value under its query key', () => {
    const ids = extractUrlIds(`http://x/api/items?ref=${UUID}`)
    expect(ids).toEqual([{ token: UUID, name: 'ref', location: 'query' }])
  })

  it('skips short query values (page/limit noise)', () => {
    expect(extractUrlIds('http://x/api/items?page=2&limit=20')).toEqual([])
  })

  it('does not flag version or slug path segments', () => {
    expect(extractUrlIds('http://x/api/v2/products/winter-boots')).toEqual([])
  })

  it('returns [] for an unparseable / relative URL', () => {
    expect(extractUrlIds('/api/users/123')).toEqual([])
    expect(extractUrlIds('not a url')).toEqual([])
  })
})

describe('urlSideLineage', () => {
  it('draws an edge when an id is reused across two different templates (source = earliest)', () => {
    const records = [
      rec('a', `http://h/api/orders/${UUID}`, 100),
      rec('b', `http://h/api/orders/${UUID}/items`, 200)
    ]
    const edges = urlSideLineage(records)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      fromKey: `GET http://h/api/orders/{uuid}`,
      toKey: `GET http://h/api/orders/{uuid}/items`,
      location: 'path',
      confidence: 'url-shared'
    })
  })

  it('never invents an edge for a flat API (no shared ids)', () => {
    const records = [
      rec('a', 'http://h/api/weather', 1),
      rec('b', 'http://h/api/stocks', 2),
      rec('c', 'http://h/api/news', 3)
    ]
    expect(urlSideLineage(records)).toEqual([])
  })

  it('does not draw a same-template edge (id reused by the same route ≠ propagation)', () => {
    const records = [rec('a', 'http://h/api/users/123', 1), rec('b', 'http://h/api/users/123', 2)]
    expect(urlSideLineage(records)).toEqual([])
  })

  it('is deterministic regardless of record order (earliest ts is always the source)', () => {
    const a = rec('a', `http://h/api/session/${UUID}`, 50)
    const b = rec('b', `http://h/api/users/me?session=${UUID}`, 250)
    const fwd = urlSideLineage([a, b])
    const rev = urlSideLineage([b, a])
    expect(fwd).toEqual(rev)
    expect(fwd[0].fromKey).toContain('/api/session/{uuid}')
  })
})

describe('liftEdgesToTemplates', () => {
  const records = [
    rec('req-session', `http://h/api/session`, 10, 'POST'),
    rec('req-user', `http://h/api/users/${UUID}`, 20)
  ]
  const bodyEdge: RequestLineageEdge = {
    idName: 'sessionId',
    fromRequestId: 'req-session',
    toRequestId: 'req-user',
    location: 'body',
    confidence: 'body-match'
  }

  it('maps request ids to template keys', () => {
    const out = liftEdgesToTemplates([bodyEdge], records)
    expect(out).toEqual([
      {
        idName: 'sessionId',
        fromKey: 'POST http://h/api/session',
        toKey: `GET http://h/api/users/{uuid}`,
        location: 'body',
        confidence: 'body-match'
      }
    ])
  })

  it('drops an edge whose request id is no longer in the ring', () => {
    const out = liftEdgesToTemplates([{ ...bodyEdge, toRequestId: 'evicted' }], records)
    expect(out).toEqual([])
  })

  it('drops a self-template edge after lifting', () => {
    const same = [rec('r1', 'http://h/api/users/1', 1), rec('r2', 'http://h/api/users/2', 2)]
    const out = liftEdgesToTemplates(
      [
        {
          idName: 'id',
          fromRequestId: 'r1',
          toRequestId: 'r2',
          location: 'body',
          confidence: 'body-match'
        }
      ],
      same
    )
    expect(out).toEqual([])
  })
})

describe('mergeLineage', () => {
  const body: LineageEdge = {
    idName: 'sessionId',
    fromKey: 'A',
    toKey: 'B',
    location: 'body',
    confidence: 'body-match'
  }
  const url: LineageEdge = { ...body, confidence: 'url-shared' }

  it('dedups by (from,to,idName,location) with the earlier list winning', () => {
    const merged = mergeLineage([body], [url])
    expect(merged).toEqual([body]) // body-match shadows the weaker url-shared duplicate
  })

  it('keeps distinct edges', () => {
    const other: LineageEdge = { ...url, toKey: 'C' }
    expect(mergeLineage([url], [other])).toHaveLength(2)
  })
})
