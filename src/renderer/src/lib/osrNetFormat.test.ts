import { describe, it, expect } from 'vitest'
import {
  formatSize,
  formatDuration,
  urlName,
  statusLabel,
  isErrorRow,
  blockedTag,
  filterRecords,
  parseFilterTokens,
  matchesType,
  filterByType,
  applyNetFilter,
  initiatorLabel
} from './osrNetFormat'
import type { NetRecord } from '../../../preload'

const rec = (p: Partial<NetRecord>): NetRecord => ({
  requestId: 'r',
  url: 'http://x/',
  method: 'GET',
  type: 'fetch',
  startTs: 0,
  ...p
})

describe('formatSize', () => {
  it('formats bytes/kB/MB base-1000', () => {
    expect(formatSize(35)).toBe('35 B')
    expect(formatSize(88_000)).toBe('88 kB')
    expect(formatSize(4_000_000)).toBe('4.0 MB')
  })
  it('returns — for missing/negative', () => {
    expect(formatSize(undefined)).toBe('—')
    expect(formatSize(-1)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('ms then seconds', () => {
    expect(formatDuration(0, 6)).toBe('6 ms')
    expect(formatDuration(100, 1300)).toBe('1.2 s')
  })
  it('— when no/invalid end', () => {
    expect(formatDuration(0, undefined)).toBe('—')
    expect(formatDuration(10, 5)).toBe('—')
  })
})

describe('urlName', () => {
  it('takes the last path segment + the query string', () => {
    expect(urlName('http://localhost:5173/api/big')).toBe('big')
    expect(urlName('http://localhost:5173/assets/main.js?v=2')).toBe('main.js?v=2')
    expect(urlName('http://x/search?q=foo')).toBe('search?q=foo')
  })
  it('preserves a trailing slash', () => {
    expect(urlName('http://x/v1/items/')).toBe('items/')
  })
  it('falls back to host for a root path', () => {
    expect(urlName('http://localhost:5173/')).toBe('localhost:5173')
  })
  it('handles non-URLs without throwing', () => {
    expect(urlName('')).toBe('(empty)')
    expect(urlName('blob:abc/xyz')).toBe('xyz')
  })
})

describe('statusLabel', () => {
  it('shows the status code', () => {
    expect(statusLabel(rec({ status: 200 }))).toBe('200')
  })
  it('shows failed / canceled', () => {
    expect(statusLabel(rec({ failed: { errorText: 'x' } }))).toBe('(failed)')
    expect(statusLabel(rec({ failed: { errorText: 'x', canceled: true } }))).toBe('(canceled)')
  })
  it('maps blockedReason to a (blocked:*) tag', () => {
    expect(statusLabel(rec({ failed: { errorText: 'x', blockedReason: 'csp' } }))).toBe(
      '(blocked:csp)'
    )
    expect(
      statusLabel(rec({ failed: { errorText: 'x', blockedReason: 'coep-frame-resource' } }))
    ).toBe('(blocked:coep)')
  })
  it('shows (pending) for an in-flight request', () => {
    expect(statusLabel(rec({}))).toBe('(pending)')
  })
})

describe('blockedTag', () => {
  it('normalizes the common reasons', () => {
    expect(blockedTag('csp')).toBe('blocked:csp')
    expect(blockedTag('mixed-content')).toBe('blocked:mixed-content')
    expect(blockedTag('corp-not-same-origin')).toBe('blocked:origin')
    expect(blockedTag('weird-thing')).toBe('blocked:weird-thing')
  })
})

describe('isErrorRow', () => {
  it('is true for HTTP ≥400 and any failure', () => {
    expect(isErrorRow(rec({ status: 404 }))).toBe(true)
    expect(isErrorRow(rec({ status: 500 }))).toBe(true)
    expect(isErrorRow(rec({ failed: { errorText: 'x' } }))).toBe(true)
  })
  it('is false for 2xx/3xx and pending', () => {
    expect(isErrorRow(rec({ status: 200 }))).toBe(false)
    expect(isErrorRow(rec({ status: 304 }))).toBe(false)
    expect(isErrorRow(rec({}))).toBe(false)
  })
})

describe('filterRecords (tokenized · URL-only · AND + negation)', () => {
  const list = [
    rec({ requestId: 'a', url: 'http://x/api/users', method: 'GET', type: 'xhr', status: 200 }),
    rec({ requestId: 'b', url: 'http://x/main.js', method: 'GET', type: 'script', status: 200 }),
    rec({
      requestId: 'c',
      url: 'http://x/login',
      method: 'POST',
      type: 'fetch',
      failed: { errorText: 'e' }
    })
  ]
  it('passes all on empty query', () => {
    expect(filterRecords(list, '   ').length).toBe(3)
  })
  it('matches the URL case-insensitively', () => {
    expect(filterRecords(list, 'API').map((r) => r.requestId)).toEqual(['a'])
    expect(filterRecords(list, 'main.js').map((r) => r.requestId)).toEqual(['b'])
  })
  it('plain tokens match the URL only — not method/type/status', () => {
    expect(filterRecords(list, 'post')).toEqual([]) // POST is a method, not in any URL
    expect(filterRecords(list, 'script')).toEqual([]) // script is a type, not in any URL
    expect(filterRecords(list, 'failed')).toEqual([]) // (failed) is a status, not in any URL
  })
  it('AND-composes space-separated tokens', () => {
    expect(filterRecords(list, 'http login').map((r) => r.requestId)).toEqual(['c'])
    expect(filterRecords(list, 'api login')).toEqual([])
  })
  it('negates a token with a leading dash', () => {
    expect(filterRecords(list, '-login').map((r) => r.requestId)).toEqual(['a', 'b'])
    expect(filterRecords(list, 'http -api -login').map((r) => r.requestId)).toEqual(['b'])
  })
  it('drops a lone dash', () => {
    expect(filterRecords(list, '-').length).toBe(3)
  })
})

describe('parseFilterTokens', () => {
  it('splits key:value into key + value', () => {
    const [t] = parseFilterTokens('method:POST')
    expect(t).toEqual({ neg: false, key: 'method', text: 'post' })
  })
  it('negates a property token', () => {
    const [t] = parseFilterTokens('-status-code:404')
    expect(t).toEqual({ neg: true, key: 'status-code', text: '404' })
  })
  it('treats a leading-colon token as plain text', () => {
    expect(parseFilterTokens(':foo')).toEqual([{ neg: false, text: ':foo' }])
  })
})

describe('filterRecords — property filters (key:value)', () => {
  const list = [
    rec({
      requestId: 'a',
      url: 'https://api.example.com/v1/users',
      method: 'GET',
      type: 'xhr',
      status: 200,
      mimeType: 'application/json',
      encodedDataLength: 2000,
      endTs: 3,
      resHeaders: [{ name: 'Cache-Control', value: 'no-cache' }]
    }),
    rec({
      requestId: 'b',
      url: 'http://cdn.example.com/app.js',
      method: 'GET',
      type: 'script',
      status: 404,
      mimeType: 'text/javascript; charset=utf-8',
      encodedDataLength: 50,
      endTs: 1,
      fromCache: true
    }),
    rec({ requestId: 'c', url: 'wss://live.other.com/socket', method: 'GET', type: 'websocket' }), // pending
    rec({
      requestId: 'd',
      url: 'http://x/upload',
      method: 'POST',
      type: 'fetch',
      status: 200,
      endTs: 5
    })
  ]
  const ids = (q: string): string[] => filterRecords(list, q).map((r) => r.requestId)

  it('method: is exact + case-insensitive', () => {
    expect(ids('method:post')).toEqual(['d'])
    expect(ids('method:GET').sort()).toEqual(['a', 'b', 'c'])
  })
  it('scheme:', () => {
    expect(ids('scheme:wss')).toEqual(['c'])
    expect(ids('scheme:https')).toEqual(['a'])
  })
  it('status-code: is a substring that excludes pending', () => {
    expect(ids('status-code:404')).toEqual(['b'])
    expect(ids('status-code:200').sort()).toEqual(['a', 'd'])
  })
  it('mime-type: matches the type before the semicolon', () => {
    expect(ids('mime-type:text/javascript')).toEqual(['b'])
    expect(ids('mime-type:json')).toEqual(['a'])
  })
  it('resource-type: splits fetch vs xhr', () => {
    expect(ids('resource-type:xhr')).toEqual(['a'])
    expect(ids('resource-type:fetch')).toEqual(['d'])
  })
  it('domain: exact + subdomain + *. wildcard', () => {
    expect(ids('domain:example.com').sort()).toEqual(['a', 'b'])
    expect(ids('domain:*.example.com').sort()).toEqual(['a', 'b'])
    expect(ids('domain:other.com')).toEqual(['c'])
  })
  it('larger-than: bytes + k suffix (transfer size)', () => {
    expect(ids('larger-than:1k')).toEqual(['a'])
    expect(ids('larger-than:100')).toEqual(['a'])
  })
  it('has-response-header:', () => {
    expect(ids('has-response-header:cache-control')).toEqual(['a'])
  })
  it('is:running / is:from-cache', () => {
    expect(ids('is:running')).toEqual(['c'])
    expect(ids('is:from-cache')).toEqual(['b'])
  })
  it('unknown key falls back to a URL substring; plain token stays URL-only', () => {
    expect(ids('foo:users')).toEqual([]) // literal "foo:users" is in no URL
    expect(ids('socket')).toEqual(['c'])
  })
  it('AND-composes property + plain tokens', () => {
    expect(ids('domain:example.com method:get larger-than:1k')).toEqual(['a'])
    expect(ids('example.com -method:get')).toEqual([]) // both example.com rows are GET
  })
})

describe('applyNetFilter (type pill + text/regex + invert)', () => {
  const list = [
    rec({ requestId: 'a', url: 'http://x/app.js', type: 'script' }),
    rec({ requestId: 'b', url: 'http://x/vendor.js', type: 'script' }),
    rec({ requestId: 'c', url: 'http://x/style.css', type: 'stylesheet' }),
    rec({ requestId: 'd', url: 'http://x/data.json', type: 'fetch' })
  ]
  const ids = (rows: NetRecord[]): string[] => rows.map((x) => x.requestId)

  it('ANDs the type pill with the text filter', () => {
    expect(ids(applyNetFilter(list, { type: 'js', query: 'vendor' }).rows)).toEqual(['b'])
  })
  it('regex mode matches the URL', () => {
    expect(ids(applyNetFilter(list, { type: 'all', query: '\\.js$', regex: true }).rows)).toEqual([
      'a',
      'b'
    ])
  })
  it('flags an invalid regex + falls back to the type set', () => {
    const res = applyNetFilter(list, { type: 'js', query: '(', regex: true })
    expect(res.regexError).toBe(true)
    expect(ids(res.rows)).toEqual(['a', 'b'])
  })
  it('invert flips the text match but keeps the type pill', () => {
    expect(ids(applyNetFilter(list, { type: 'js', query: 'app', invert: true }).rows)).toEqual([
      'b'
    ])
  })
  it('invert + empty query hides everything', () => {
    expect(applyNetFilter(list, { type: 'all', query: '', invert: true }).rows).toEqual([])
  })
  it('empty query passes the type set', () => {
    expect(ids(applyNetFilter(list, { type: 'js', query: '' }).rows)).toEqual(['a', 'b'])
  })
})

describe('matchesType / filterByType (DevTools resource-type pills)', () => {
  const list = [
    rec({ requestId: 'doc', type: 'document' }),
    rec({ requestId: 'xhr', type: 'xhr' }),
    rec({ requestId: 'fetch', type: 'fetch' }),
    rec({ requestId: 'js', type: 'script' }),
    rec({ requestId: 'css', type: 'stylesheet' }),
    rec({ requestId: 'ws', type: 'websocket' }),
    rec({ requestId: 'png', type: 'image' }),
    rec({ requestId: 'misc', type: 'eventsource' })
  ]
  it('all passes everything', () => {
    expect(list.every((r) => matchesType(r, 'all'))).toBe(true)
  })
  it('xhr pill claims both xhr + fetch', () => {
    expect(filterByType(list, 'xhr', '').map((r) => r.requestId)).toEqual(['xhr', 'fetch'])
  })
  it('doc/css/js/ws/img map to their resourceType', () => {
    expect(filterByType(list, 'doc', '').map((r) => r.requestId)).toEqual(['doc'])
    expect(filterByType(list, 'css', '').map((r) => r.requestId)).toEqual(['css'])
    expect(filterByType(list, 'js', '').map((r) => r.requestId)).toEqual(['js'])
    expect(filterByType(list, 'ws', '').map((r) => r.requestId)).toEqual(['ws'])
    expect(filterByType(list, 'img', '').map((r) => r.requestId)).toEqual(['png'])
  })
  it('other is the catch-all for unclaimed types', () => {
    expect(filterByType(list, 'other', '').map((r) => r.requestId)).toEqual(['misc'])
  })
  it('type pill composes with the text filter', () => {
    const l2 = [
      rec({ requestId: 'a', type: 'script', url: 'http://x/app.js' }),
      rec({ requestId: 'b', type: 'script', url: 'http://x/vendor.js' })
    ]
    expect(filterByType(l2, 'js', 'vendor').map((r) => r.requestId)).toEqual(['b'])
  })
})

describe('initiatorLabel', () => {
  it('shows the script file name for a url initiator', () => {
    expect(initiatorLabel('http://x/assets/app.js')).toBe('app.js')
  })
  it('shows the bare type word otherwise', () => {
    expect(initiatorLabel('parser')).toBe('parser')
    expect(initiatorLabel(undefined)).toBe('other')
  })
})
