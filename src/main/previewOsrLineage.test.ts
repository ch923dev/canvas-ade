import { describe, it, expect } from 'vitest'
import {
  extractIdValues,
  consumerTokens,
  sampleLineage,
  type LineageRec
} from './previewOsrLineage'

const UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('extractIdValues', () => {
  it('collects an id-shaped value under an id-like key', () => {
    expect(extractIdValues(`{"userId":"${UUID}","name":"Ada"}`)).toEqual([
      { name: 'userId', value: UUID }
    ])
  })

  it('collects a uuid value even under a plain key', () => {
    expect(extractIdValues(`{"ref":"${UUID}"}`)).toContainEqual({ name: 'ref', value: UUID })
  })

  it('skips short / non-id values', () => {
    expect(extractIdValues('{"name":"Ada","age":30,"ok":true}')).toEqual([])
  })

  it('excludes a value that scrubs to a secret (never correlate on a token)', () => {
    expect(extractIdValues('{"apiKey":"sk-abcdefghij1234567890"}')).toEqual([])
  })

  it('returns [] on parse failure', () => {
    expect(extractIdValues('{not json')).toEqual([])
  })

  it('dedups a value repeated across keys', () => {
    expect(extractIdValues(`{"a":"${UUID}","b":"${UUID}"}`)).toHaveLength(1)
  })
})

describe('consumerTokens', () => {
  it('splits a URL path + query and a post-data body into located tokens', () => {
    const t = consumerTokens(`http://h/api/users/${UUID}?ref=longvalue123`, `{"orderId":"${UUID}"}`)
    expect(t).toContainEqual({ token: UUID, location: 'path' })
    expect(t).toContainEqual({ token: 'longvalue123', location: 'query' })
    expect(t).toContainEqual({ token: UUID, location: 'body' })
  })

  it('tolerates a relative/unparseable URL (no URL tokens)', () => {
    expect(consumerTokens('/api/users/1')).toEqual([])
  })
})

type Send = (method: string, params: object, sessionId?: string) => Promise<unknown>
const capBody = (
  body: unknown,
  base64: boolean
): { body: string; base64: boolean; truncated: boolean } => ({
  body: String(body),
  base64,
  truncated: false
})

function mkSend(bodies: Record<string, string>, post: Record<string, string> = {}): Send {
  return async (method, params) => {
    const rid = (params as { requestId?: string }).requestId ?? ''
    if (method === 'Network.getResponseBody')
      return { body: bodies[rid] ?? '{}', base64Encoded: false }
    if (method === 'Network.getRequestPostData') return { postData: post[rid] }
    return {}
  }
}

describe('sampleLineage', () => {
  it('draws the body→url edge: a session id from a response reappears in a later request URL', async () => {
    const records: LineageRec[] = [
      {
        requestId: 'sess',
        url: 'http://h/api/session',
        method: 'POST',
        type: 'fetch',
        startTs: 10
      },
      {
        requestId: 'usr',
        url: `http://h/api/users/${UUID}`,
        method: 'GET',
        type: 'fetch',
        startTs: 20
      }
    ]
    const res = await sampleLineage(records, mkSend({ sess: `{"sessionId":"${UUID}"}` }), capBody)
    expect(res.edges).toEqual([
      {
        idName: 'sessionId',
        fromRequestId: 'sess',
        toRequestId: 'usr',
        location: 'path',
        confidence: 'body-match'
      }
    ])
  })

  it('finds an id propagated into a later request BODY', async () => {
    const records: LineageRec[] = [
      { requestId: 'a', url: 'http://h/api/cart', method: 'GET', type: 'fetch', startTs: 1 },
      { requestId: 'b', url: 'http://h/api/checkout', method: 'POST', type: 'fetch', startTs: 2 }
    ]
    const res = await sampleLineage(
      records,
      mkSend({ a: `{"cartId":"${UUID}"}` }, { b: `{"cartId":"${UUID}"}` }),
      capBody
    )
    expect(res.edges).toEqual([
      {
        idName: 'cartId',
        fromRequestId: 'a',
        toRequestId: 'b',
        location: 'body',
        confidence: 'body-match'
      }
    ])
  })

  it('never invents an edge for a flat API (no shared ids)', async () => {
    const records: LineageRec[] = [
      { requestId: 'a', url: 'http://h/api/weather', method: 'GET', type: 'fetch', startTs: 1 },
      { requestId: 'b', url: 'http://h/api/stocks', method: 'GET', type: 'fetch', startTs: 2 }
    ]
    const res = await sampleLineage(
      records,
      mkSend({ a: '{"tempC":12}', b: '{"price":99}' }),
      capBody
    )
    expect(res.edges).toEqual([])
    expect(res.valuesTracked).toBe(0)
  })

  it('does not correlate on a scrubbed secret value', async () => {
    const SECRET = 'sk-abcdefghij1234567890'
    const records: LineageRec[] = [
      { requestId: 'p', url: 'http://h/auth', method: 'POST', type: 'fetch', startTs: 1 },
      { requestId: 'c', url: `http://h/cb?key=${SECRET}`, method: 'GET', type: 'fetch', startTs: 2 }
    ]
    const res = await sampleLineage(records, mkSend({ p: `{"apiKey":"${SECRET}"}` }), capBody)
    expect(res.edges).toEqual([])
  })

  it('does not draw a backward edge (the consumer must be strictly later than the producer)', async () => {
    const records: LineageRec[] = [
      {
        requestId: 'early',
        url: `http://h/api/orders/${UUID}`,
        method: 'GET',
        type: 'fetch',
        startTs: 30
      },
      { requestId: 'src', url: 'http://h/api/session', method: 'POST', type: 'fetch', startTs: 50 }
    ]
    const res = await sampleLineage(records, mkSend({ src: `{"orderId":"${UUID}"}` }), capBody)
    expect(res.edges).toEqual([])
  })

  it('skips binary bodies (not a JSON id surface)', async () => {
    const records: LineageRec[] = [
      { requestId: 'img', url: 'http://h/logo.png', method: 'GET', type: 'image', startTs: 1 }
    ]
    const send: Send = async () => ({ body: 'AAAA', base64Encoded: true })
    const res = await sampleLineage(records, send, capBody)
    expect(res.edges).toEqual([])
    expect(res.producersScanned).toBe(0)
  })
})
