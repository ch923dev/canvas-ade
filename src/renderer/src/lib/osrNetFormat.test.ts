import { describe, it, expect } from 'vitest'
import {
  formatSize,
  formatDuration,
  urlName,
  statusLabel,
  sizeLabel,
  isErrorRow,
  blockedTag,
  filterRecords,
  parseFilterTokens,
  matchesType,
  matchesAnyType,
  filterByType,
  applyNetFilter,
  initiatorLabel,
  timingPhases,
  ttfbMs,
  waterfallWindow,
  waterfallBar,
  sortRecords,
  summaryStats,
  queryParams,
  requestCookies,
  responseCookies,
  hasPayload,
  hasCookies,
  netPanelResizeFraction,
  NET_PANEL_MIN_FRAC,
  NET_PANEL_MAX_FRAC,
  assetRecords,
  downloadPct,
  prettyBody
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
  it('shows (unknown) for a preserved in-flight request, but keeps a completed code', () => {
    expect(statusLabel(rec({ preserved: true }))).toBe('(unknown)')
    expect(statusLabel(rec({ preserved: true, status: 200 }))).toBe('200')
  })
})

describe('sizeLabel', () => {
  it('shows cache / ServiceWorker labels', () => {
    expect(sizeLabel(rec({ cacheSource: 'disk' }))).toBe('(disk cache)')
    expect(sizeLabel(rec({ cacheSource: 'memory' }))).toBe('(memory cache)')
    expect(sizeLabel(rec({ cacheSource: 'sw' }))).toBe('(ServiceWorker)')
  })
  it('falls back to transferred bytes', () => {
    expect(sizeLabel(rec({ encodedDataLength: 2048 }))).toBe('2 kB')
    expect(sizeLabel(rec({}))).toBe('—')
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

describe('applyNetFilter (type pills + text/regex + invert)', () => {
  const list = [
    rec({ requestId: 'a', url: 'http://x/app.js', type: 'script' }),
    rec({ requestId: 'b', url: 'http://x/vendor.js', type: 'script' }),
    rec({ requestId: 'c', url: 'http://x/style.css', type: 'stylesheet' }),
    rec({ requestId: 'd', url: 'http://x/data.json', type: 'fetch' })
  ]
  const ids = (rows: NetRecord[]): string[] => rows.map((x) => x.requestId)

  it('ANDs the type pill with the text filter', () => {
    expect(ids(applyNetFilter(list, { types: ['js'], query: 'vendor' }).rows)).toEqual(['b'])
  })
  it('ORs multiple active pills', () => {
    expect(ids(applyNetFilter(list, { types: ['css', 'xhr'], query: '' }).rows)).toEqual(['c', 'd'])
  })
  it('regex mode matches the URL', () => {
    expect(
      ids(applyNetFilter(list, { types: ['all'], query: '\\.js$', regex: true }).rows)
    ).toEqual(['a', 'b'])
  })
  it('flags an invalid regex + falls back to the type set', () => {
    const res = applyNetFilter(list, { types: ['js'], query: '(', regex: true })
    expect(res.regexError).toBe(true)
    expect(ids(res.rows)).toEqual(['a', 'b'])
  })
  it('invert flips the text match but keeps the type pill', () => {
    expect(ids(applyNetFilter(list, { types: ['js'], query: 'app', invert: true }).rows)).toEqual([
      'b'
    ])
  })
  it('invert + empty query hides everything', () => {
    expect(applyNetFilter(list, { types: ['all'], query: '', invert: true }).rows).toEqual([])
  })
  it('empty query passes the type set', () => {
    expect(ids(applyNetFilter(list, { types: ['js'], query: '' }).rows)).toEqual(['a', 'b'])
  })
})

describe('matchesAnyType (multi-select pills)', () => {
  const js = rec({ type: 'script' })
  const css = rec({ type: 'stylesheet' })
  it('empty or all passes everything', () => {
    expect(matchesAnyType(js, [])).toBe(true)
    expect(matchesAnyType(js, ['all'])).toBe(true)
  })
  it('ORs the active pills', () => {
    expect(matchesAnyType(js, ['css', 'js'])).toBe(true)
    expect(matchesAnyType(css, ['js'])).toBe(false)
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
    rec({ requestId: 'mani', type: 'manifest' }),
    rec({ requestId: 'misc', type: 'eventsource' })
  ]
  it('all passes everything', () => {
    expect(list.every((r) => matchesType(r, 'all'))).toBe(true)
  })
  it('the Manifest pill claims the manifest type (not Other)', () => {
    expect(filterByType(list, 'manifest', '').map((r) => r.requestId)).toEqual(['mani'])
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

describe('timingPhases / ttfbMs', () => {
  const withTiming = (over: Partial<NetRecord['timing'] & object> = {}): NetRecord =>
    rec({
      finishMono: 100.05, // 50ms after requestTime
      timing: {
        requestTime: 100,
        dnsStart: 2,
        dnsEnd: 6,
        connectStart: 6,
        connectEnd: 10,
        sslStart: 7,
        sslEnd: 10,
        sendStart: 10,
        sendEnd: 12,
        receiveHeadersEnd: 30,
        ...over
      }
    })
  it('returns [] without timing', () => {
    expect(timingPhases(rec({}))).toEqual([])
  })
  it('builds the phase set incl. Stalled + Content Download', () => {
    const labels = timingPhases(withTiming()).map((p) => p.label)
    expect(labels).toEqual([
      'Stalled',
      'DNS Lookup',
      'Initial connection',
      'SSL',
      'Request sent',
      'Waiting (TTFB)',
      'Content Download'
    ])
  })
  it('Content Download runs from receiveHeadersEnd to the finish offset (ms)', () => {
    const cd = timingPhases(withTiming()).find((p) => p.label === 'Content Download')
    expect(cd?.start).toBe(30)
    expect(cd?.end).toBeCloseTo(50, 3) // (finishMono - requestTime) * 1000, modulo float error
  })
  it('ttfbMs is receiveHeadersEnd', () => {
    expect(ttfbMs(withTiming())).toBe(30)
    expect(ttfbMs(rec({}))).toBeUndefined()
  })
})

describe('waterfallWindow / waterfallBar', () => {
  it('spans the earliest start to the latest end (pending contributes only its start)', () => {
    const rows = [rec({ startTs: 100, endTs: 200 }), rec({ startTs: 150 })] // 2nd pending
    expect(waterfallWindow(rows)).toEqual({ min: 100, max: 200 })
  })
  it('handles an empty set + a zero span', () => {
    expect(waterfallWindow([])).toEqual({ min: 0, max: 1 })
    expect(waterfallWindow([rec({ startTs: 5, endTs: 5 })])).toEqual({ min: 5, max: 6 })
  })
  it('positions a bar as a percent of the window', () => {
    const win = { min: 100, max: 300 } // span 200
    const bar = waterfallBar(rec({ startTs: 150, endTs: 250 }), win)
    expect(bar.leftPct).toBeCloseTo(25) // (150-100)/200
    expect(bar.widthPct).toBeCloseTo(50) // (250-150)/200
  })
  it('extends a pending bar to the window max', () => {
    const win = { min: 100, max: 300 }
    const bar = waterfallBar(rec({ startTs: 200 }), win) // no endTs
    expect(bar.leftPct).toBeCloseTo(50)
    expect(bar.widthPct).toBeCloseTo(50) // (300-200)/200
  })
  it('derives the wait (TTFB) fraction from timing', () => {
    const win = { min: 0, max: 100 }
    const r = rec({
      startTs: 0,
      endTs: 100,
      timing: {
        requestTime: 0,
        dnsStart: -1,
        dnsEnd: -1,
        connectStart: -1,
        connectEnd: -1,
        sslStart: -1,
        sslEnd: -1,
        sendStart: 0,
        sendEnd: 5,
        receiveHeadersEnd: 60
      }
    })
    expect(waterfallBar(r, win).waitPct).toBeCloseTo(60) // 60ms of a 100ms bar
  })
})

describe('summaryStats', () => {
  it('sums transfer + decoded bytes and the finish span', () => {
    const s = summaryStats([
      rec({ startTs: 100, endTs: 160, encodedDataLength: 50, decodedLength: 200 }),
      rec({ startTs: 120, endTs: 300, encodedDataLength: 30, decodedLength: 90 })
    ])
    expect(s.transferred).toBe(80)
    expect(s.resources).toBe(290)
    expect(s.finishMs).toBe(200) // 300 - 100
  })
  it('is zeroed for an empty set', () => {
    expect(summaryStats([])).toEqual({ transferred: 0, resources: 0, finishMs: 0 })
  })
})

describe('sortRecords', () => {
  const list = [
    rec({ requestId: 'a', url: 'http://x/b.js', status: 200, encodedDataLength: 50, endTs: 30 }),
    rec({ requestId: 'b', url: 'http://x/a.js', status: 404, encodedDataLength: 200, endTs: 10 }),
    rec({ requestId: 'c', url: 'http://x/c.js', status: 200, encodedDataLength: 100, endTs: 20 })
  ]
  const ids = (s: Parameters<typeof sortRecords>[1]): string[] =>
    sortRecords(list, s).map((r) => r.requestId)

  it('null sort keeps insertion order', () => {
    expect(ids(null)).toEqual(['a', 'b', 'c'])
  })
  it('sorts by name asc + desc', () => {
    expect(ids({ col: 'name', dir: 'asc' })).toEqual(['b', 'a', 'c']) // a.js, b.js, c.js
    expect(ids({ col: 'name', dir: 'desc' })).toEqual(['c', 'a', 'b'])
  })
  it('sorts Size + Time numerically', () => {
    expect(ids({ col: 'size', dir: 'asc' })).toEqual(['a', 'c', 'b']) // 50,100,200
    expect(ids({ col: 'time', dir: 'desc' })).toEqual(['a', 'c', 'b']) // 30,20,10
  })
  it('is stable for equal keys', () => {
    expect(ids({ col: 'status', dir: 'asc' })).toEqual(['a', 'c', 'b']) // 200(a),200(c),404(b)
  })
})

describe('payload / cookies parsing (P2.8 detail tabs)', () => {
  it('queryParams decodes the query string', () => {
    expect(queryParams('http://x/s?q=hi%20there&page=2')).toEqual([
      { name: 'q', value: 'hi there' },
      { name: 'page', value: '2' }
    ])
    expect(queryParams('http://x/no-query')).toEqual([])
  })
  it('requestCookies parses the Cookie header', () => {
    expect(requestCookies([{ name: 'Cookie', value: 'a=1; b=two=2' }])).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'two=2' }
    ])
    expect(requestCookies([])).toEqual([])
  })
  it('responseCookies parses Set-Cookie (newline-joined), first pair only', () => {
    expect(
      responseCookies([
        { name: 'set-cookie', value: 'sid=abc; Path=/; HttpOnly\ntheme=dark; Path=/' }
      ])
    ).toEqual([
      { name: 'sid', value: 'abc' },
      { name: 'theme', value: 'dark' }
    ])
  })
  it('hasPayload: query string or a body method', () => {
    expect(hasPayload(rec({ url: 'http://x/a?b=1', method: 'GET' }))).toBe(true)
    expect(hasPayload(rec({ url: 'http://x/a', method: 'POST' }))).toBe(true)
    expect(hasPayload(rec({ url: 'http://x/a', method: 'GET' }))).toBe(false)
  })
  it('hasCookies: request or response cookies present', () => {
    expect(hasCookies(rec({ reqHeaders: [{ name: 'cookie', value: 'a=1' }] }))).toBe(true)
    expect(hasCookies(rec({ resHeaders: [{ name: 'set-cookie', value: 'a=1' }] }))).toBe(true)
    expect(hasCookies(rec({}))).toBe(false)
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

describe('netPanelResizeFraction', () => {
  const stage = { left: 100, top: 50, width: 1000, height: 800 }
  it('bottom dock: fraction is distance from the pointer up to the stage bottom', () => {
    // pointer at y=450 → (50+800-450)/800 = 400/800 = 0.5
    expect(netPanelResizeFraction('bottom', stage, 600, 450)).toBeCloseTo(0.5, 5)
    // pointer near the top → large panel, clamped to MAX
    expect(netPanelResizeFraction('bottom', stage, 600, 60)).toBe(NET_PANEL_MAX_FRAC)
    // pointer near the bottom → tiny panel, clamped to MIN
    expect(netPanelResizeFraction('bottom', stage, 600, 845)).toBe(NET_PANEL_MIN_FRAC)
  })
  it('right dock: fraction is distance from the pointer to the stage right edge', () => {
    // pointer at x=600 → (100+1000-600)/1000 = 500/1000 = 0.5
    expect(netPanelResizeFraction('right', stage, 600, 400)).toBeCloseTo(0.5, 5)
    expect(netPanelResizeFraction('right', stage, 150, 400)).toBe(NET_PANEL_MAX_FRAC)
    expect(netPanelResizeFraction('right', stage, 1090, 400)).toBe(NET_PANEL_MIN_FRAC)
  })
  it('uses the correct axis per dock (right ignores Y, bottom ignores X)', () => {
    expect(netPanelResizeFraction('right', stage, 600, 9999)).toBeCloseTo(0.5, 5)
    expect(netPanelResizeFraction('bottom', stage, 9999, 450)).toBeCloseTo(0.5, 5)
  })
  it('returns MIN for a zero-size stage (no divide-by-zero)', () => {
    expect(netPanelResizeFraction('right', { left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe(
      NET_PANEL_MIN_FRAC
    )
    expect(netPanelResizeFraction('bottom', { left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBe(
      NET_PANEL_MIN_FRAC
    )
  })
})

describe('assetRecords', () => {
  it('keeps only static asset types, preserving order', () => {
    const recs = [
      rec({ requestId: '1', type: 'document' }),
      rec({ requestId: '2', type: 'image' }),
      rec({ requestId: '3', type: 'xhr' }),
      rec({ requestId: '4', type: 'stylesheet' }),
      rec({ requestId: '5', type: 'script' }),
      rec({ requestId: '6', type: 'font' }),
      rec({ requestId: '7', type: 'fetch' }),
      rec({ requestId: '8', type: 'media' }),
      rec({ requestId: '9', type: 'websocket' }),
      rec({ requestId: '10', type: 'manifest' })
    ]
    expect(assetRecords(recs).map((r) => r.requestId)).toEqual(['2', '4', '5', '6', '8', '10'])
  })
  it('matches the capitalized CDP resourceType MAIN actually stores', () => {
    // Regression: MAIN stores raw CDP types ("Image"/"Script"/…), not lowercase — the lowercase
    // set must compare case-insensitively or the Assets tab shows 0.
    const recs = [
      rec({ requestId: 'a', type: 'Image' }),
      rec({ requestId: 'b', type: 'Script' }),
      rec({ requestId: 'c', type: 'Stylesheet' }),
      rec({ requestId: 'd', type: 'Document' })
    ]
    expect(assetRecords(recs).map((r) => r.requestId)).toEqual(['a', 'b', 'c'])
  })
  it('returns [] when there are no assets', () => {
    expect(assetRecords([rec({ type: 'document' }), rec({ type: 'xhr' })])).toEqual([])
  })
})

describe('prettyBody', () => {
  it('indents JSON when the mime is json', () => {
    expect(prettyBody('{"a":1,"b":[2,3]}', 'application/json')).toBe(
      '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}'
    )
  })
  it('indents JSON that merely looks like JSON (missing mime — e.g. request payloads)', () => {
    expect(prettyBody('  [1,2]', undefined)).toBe('[\n  1,\n  2\n]')
  })
  it('leaves non-JSON and invalid JSON untouched', () => {
    expect(prettyBody('hello world', 'text/plain')).toBe('hello world')
    expect(prettyBody('{not json', 'application/json')).toBe('{not json')
  })
  it('never reparses binary (base64) bodies', () => {
    expect(prettyBody('eyJhIjoxfQ==', 'application/json', true)).toBe('eyJhIjoxfQ==')
  })
})

describe('downloadPct', () => {
  it('computes a clamped integer percent', () => {
    expect(downloadPct(50, 100)).toBe(50)
    expect(downloadPct(0, 100)).toBe(0)
    expect(downloadPct(150, 100)).toBe(100) // clamped
    expect(downloadPct(1, 3)).toBe(33) // rounded
  })
  it('is undefined when the total is unknown or zero', () => {
    expect(downloadPct(50, undefined)).toBeUndefined()
    expect(downloadPct(50, 0)).toBeUndefined()
    expect(downloadPct(undefined, 100)).toBeUndefined()
  })
})
