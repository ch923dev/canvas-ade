import { describe, it, expect } from 'vitest'
import { formatSize, formatDuration, urlName, statusLabel, filterRecords } from './osrNetFormat'
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

describe('filterRecords', () => {
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
  it('matches url/method/type/status case-insensitively', () => {
    expect(filterRecords(list, 'API').map((r) => r.requestId)).toEqual(['a'])
    expect(filterRecords(list, 'post').map((r) => r.requestId)).toEqual(['c'])
    expect(filterRecords(list, 'script').map((r) => r.requestId)).toEqual(['b'])
    expect(filterRecords(list, 'failed').map((r) => r.requestId)).toEqual(['c'])
  })
})
