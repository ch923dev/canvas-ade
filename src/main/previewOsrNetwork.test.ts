import { describe, it, expect, vi } from 'vitest'
import {
  capText,
  capHeaders,
  eventTs,
  recordFromRequest,
  applyResponse,
  applyFinished,
  applyFailed,
  wsFrameFrom,
  ringPushRecord,
  ensureWs,
  pushWsFrame,
  clearNet,
  snapshotNet,
  flushNet,
  createNetState,
  URL_CAP,
  HEADER_VALUE_CAP,
  HEADER_COUNT_CAP,
  WS_PAYLOAD_CAP,
  MAX_RECORDS,
  MAX_WS_FRAMES,
  MAX_SOCKETS,
  type NetRecord,
  type OsrNetMsg
} from './previewOsrNetwork'

describe('capText', () => {
  it('caps a string at the boundary', () => {
    expect(capText('a'.repeat(100), 10)).toBe('a'.repeat(10))
  })
  it('collapses non-strings to empty', () => {
    expect(capText(undefined, 10)).toBe('')
    expect(capText(42, 10)).toBe('')
    expect(capText(null, 10)).toBe('')
  })
})

describe('capHeaders', () => {
  it('maps a header object to a bounded array, capping values', () => {
    const out = capHeaders({ 'content-type': 'text/html', big: 'x'.repeat(HEADER_VALUE_CAP + 50) })
    expect(out).toEqual([
      { name: 'content-type', value: 'text/html' },
      { name: 'big', value: 'x'.repeat(HEADER_VALUE_CAP) }
    ])
  })
  it('caps the header COUNT', () => {
    const raw: Record<string, string> = {}
    for (let i = 0; i < HEADER_COUNT_CAP + 25; i++) raw['h' + i] = String(i)
    expect(capHeaders(raw)?.length).toBe(HEADER_COUNT_CAP)
  })
  it('returns undefined for non-objects', () => {
    expect(capHeaders(undefined)).toBeUndefined()
    expect(capHeaders('nope')).toBeUndefined()
  })
})

describe('eventTs', () => {
  it('prefers wallTime (epoch seconds → ms)', () => {
    expect(eventTs({ wallTime: 1_700_000_000 }, 999)).toBe(1_700_000_000_000)
  })
  it('falls back to now when wallTime is missing/zero', () => {
    expect(eventTs({}, 999)).toBe(999)
    expect(eventTs({ wallTime: 0 }, 999)).toBe(999)
  })
})

describe('recordFromRequest', () => {
  it('normalizes + caps a requestWillBeSent', () => {
    const rec = recordFromRequest(
      {
        requestId: 'r1',
        type: 'XHR',
        frameId: 'F1',
        request: { url: 'http://x/' + 'q'.repeat(URL_CAP), method: 'POST', headers: { a: 'b' } }
      },
      undefined,
      1000
    )
    expect(rec.requestId).toBe('r1')
    expect(rec.method).toBe('POST')
    expect(rec.type).toBe('XHR')
    expect(rec.frameId).toBe('F1')
    expect(rec.url.length).toBe(URL_CAP)
    expect(rec.reqHeaders).toEqual([{ name: 'a', value: 'b' }])
    expect(rec.sessionId).toBeUndefined()
    expect(rec.crossOrigin).toBeUndefined()
  })
  it('tags a worker sub-target via sessionId + crossOrigin', () => {
    const rec = recordFromRequest(
      { requestId: 'r2', request: { url: 'http://x/', method: 'GET' } },
      'SID',
      1
    )
    expect(rec.sessionId).toBe('SID')
    expect(rec.crossOrigin).toBe(true)
  })
  it('defaults method/type when absent', () => {
    const rec = recordFromRequest({ requestId: 'r3', request: {} }, undefined, 1)
    expect(rec.method).toBe('GET')
    expect(rec.type).toBe('other')
  })
})

describe('applyResponse / applyFinished / applyFailed', () => {
  const base = (): NetRecord => ({
    requestId: 'r',
    url: 'u',
    method: 'GET',
    type: 'fetch',
    startTs: 0
  })
  it('merges a response', () => {
    const rec = base()
    applyResponse(rec, {
      response: {
        status: 200,
        statusText: 'OK',
        mimeType: 'application/json',
        fromDiskCache: true,
        headers: { etag: 'z' }
      }
    })
    expect(rec.status).toBe(200)
    expect(rec.mimeType).toBe('application/json')
    expect(rec.fromCache).toBe(true)
    expect(rec.resHeaders).toEqual([{ name: 'etag', value: 'z' }])
  })
  it('merges loadingFinished', () => {
    const rec = base()
    applyFinished(rec, { encodedDataLength: 4096, wallTime: 2 }, 50)
    expect(rec.endTs).toBe(2000)
    expect(rec.encodedDataLength).toBe(4096)
  })
  it('merges loadingFailed', () => {
    const rec = base()
    applyFailed(
      rec,
      { errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'other', canceled: false },
      70
    )
    expect(rec.endTs).toBe(70)
    expect(rec.failed).toEqual({
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'other',
      canceled: false
    })
  })
})

describe('wsFrameFrom', () => {
  it('caps the payload + flags truncation', () => {
    const big = 'p'.repeat(WS_PAYLOAD_CAP + 10)
    const f = wsFrameFrom({ response: { opcode: 1, payloadData: big } }, 'recv', 123)
    expect(f.dir).toBe('recv')
    expect(f.opcode).toBe(1)
    expect(f.ts).toBe(123)
    expect(f.payload.length).toBe(WS_PAYLOAD_CAP)
    expect(f.truncated).toBe(true)
  })
  it('does not flag short payloads', () => {
    const f = wsFrameFrom({ response: { opcode: 2, payloadData: 'hi' } }, 'sent', 1)
    expect(f.truncated).toBe(false)
    expect(f.payload).toBe('hi')
  })
})

describe('ringPushRecord', () => {
  it('evicts oldest + counts dropped beyond MAX_RECORDS', () => {
    const s = createNetState()
    for (let i = 0; i < MAX_RECORDS + 5; i++) {
      ringPushRecord(s, { requestId: 'r' + i, url: 'u', method: 'GET', type: 'fetch', startTs: i })
    }
    expect(s.records.length).toBe(MAX_RECORDS)
    expect(s.dropped).toBe(5)
    // the 5 oldest are gone from both the array and the index
    expect(s.byId.has('r0')).toBe(false)
    expect(s.byId.has('r4')).toBe(false)
    expect(s.byId.has('r5')).toBe(true)
  })
})

describe('ensureWs / pushWsFrame', () => {
  it('reuses an existing socket and caps the socket ring', () => {
    const s = createNetState()
    const a = ensureWs(s, 'w1', 'ws://x', 0)
    const a2 = ensureWs(s, 'w1', 'ws://x', 0)
    expect(a).toBe(a2)
    for (let i = 0; i < MAX_SOCKETS + 3; i++) ensureWs(s, 'sock' + i, 'ws://y', i)
    expect(s.ws.size).toBe(MAX_SOCKETS)
    expect(s.ws.has('w1')).toBe(false) // oldest socket evicted
  })
  it('caps the per-socket frame ring', () => {
    const rec = ensureWs(createNetState(), 'w', 'ws://x', 0)
    for (let i = 0; i < MAX_WS_FRAMES + 10; i++) {
      pushWsFrame(rec, { dir: 'recv', opcode: 1, ts: i, payload: 'x', truncated: false })
    }
    expect(rec.frames.length).toBe(MAX_WS_FRAMES)
    // oldest dropped: the surviving first frame is the 11th pushed (ts 10)
    expect(rec.frames[0].ts).toBe(10)
  })
})

describe('clearNet', () => {
  it('drops all data but keeps subscription + preserve flags', () => {
    const s = createNetState()
    s.subscribed = true
    s.preserve = true
    ringPushRecord(s, { requestId: 'r', url: 'u', method: 'GET', type: 'fetch', startTs: 0 })
    ensureWs(s, 'w', 'ws://x', 0)
    s.dropped = 7
    clearNet(s)
    expect(s.records).toEqual([])
    expect(s.byId.size).toBe(0)
    expect(s.ws.size).toBe(0)
    expect(s.dropped).toBe(0)
    expect(s.subscribed).toBe(true)
    expect(s.preserve).toBe(true)
  })
})

describe('snapshotNet', () => {
  it('returns a replay snapshot (copies, not live refs)', () => {
    const s = createNetState()
    ringPushRecord(s, { requestId: 'r', url: 'u', method: 'GET', type: 'fetch', startTs: 0 })
    ensureWs(s, 'w', 'ws://x', 0)
    s.dropped = 2
    const snap = snapshotNet(s)
    expect(snap.kind).toBe('replay')
    expect(snap.records?.length).toBe(1)
    expect(snap.ws?.length).toBe(1)
    expect(snap.dropped).toBe(2)
    expect(snap.records).not.toBe(s.records) // copied array
  })
})

describe('flushNet (delta gating)', () => {
  it('emits nothing when not subscribed', () => {
    const s = createNetState()
    ringPushRecord(s, { requestId: 'r', url: 'u', method: 'GET', type: 'fetch', startTs: 0 })
    s.dirtyRecords.add('r')
    const emit = vi.fn()
    flushNet(s, emit)
    expect(emit).not.toHaveBeenCalled()
  })
  it('emits only the dirty records + clears the dirty set when subscribed', () => {
    const s = createNetState()
    s.subscribed = true
    ringPushRecord(s, { requestId: 'a', url: 'u', method: 'GET', type: 'fetch', startTs: 0 })
    ringPushRecord(s, { requestId: 'b', url: 'u', method: 'GET', type: 'fetch', startTs: 1 })
    s.dirtyRecords.add('b') // only b changed
    s.dropped = 3
    const seen: OsrNetMsg[] = []
    flushNet(s, (m) => seen.push(m))
    expect(seen.length).toBe(1)
    expect(seen[0].kind).toBe('delta')
    expect(seen[0].records?.map((r) => r.requestId)).toEqual(['b'])
    expect(seen[0].dropped).toBe(3)
    expect(s.dirtyRecords.size).toBe(0)
  })
  it('is a no-op when nothing is dirty', () => {
    const s = createNetState()
    s.subscribed = true
    const emit = vi.fn()
    flushNet(s, emit)
    expect(emit).not.toHaveBeenCalled()
  })
})
