import { describe, it, expect } from 'vitest'
import {
  formatSize,
  formatDuration,
  urlName,
  statusLabel,
  filterRecords,
  parseFilterTokens,
  matchesType,
  filterByType,
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
  it('takes the last path segment', () => {
    expect(urlName('http://localhost:5173/api/big')).toBe('big')
    expect(urlName('http://localhost:5173/assets/main.js?v=2')).toBe('main.js')
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
  it('shows — while pending', () => {
    expect(statusLabel(rec({}))).toBe('—')
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
