/**
 * previewOriginPorts — the D10 loopback origin-port observer (L11). A fake session/webRequest
 * proves: the filter lists ONLY loopback patterns, only the PORT survives a request, the 8-port cap
 * holds (most recent wins), emission happens only when the set changes, and dispose drops state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LOOPBACK_URL_PATTERNS,
  MAX_ORIGIN_PORTS,
  ORIGIN_PORTS_EMIT_MS,
  loopbackPort,
  observeOriginPorts,
  type OriginPortsSession
} from './previewOriginPorts'

type Listener = ((details: { url: string }) => void) | null

/** A fake Electron session: ONE `onCompleted` listener per session, like the real thing. */
function fakeSession(opts: { throwOnRegister?: boolean } = {}): {
  session: OriginPortsSession
  fire: (url: string) => void
  filters: Array<{ urls: string[] }>
  listener: () => Listener
} {
  let current: Listener = null
  const filters: Array<{ urls: string[] }> = []
  const webRequest = {
    onCompleted(a: { urls: string[] } | null, b?: Listener): void {
      if (a === null) {
        current = null
        return
      }
      if (opts.throwOnRegister) throw new Error('Invalid url pattern')
      filters.push(a)
      current = b ?? null
    }
  } as OriginPortsSession['webRequest']
  return {
    session: { webRequest },
    // The filter is Chromium's job; the fake delivers whatever it is handed so the in-module
    // host re-check is exercised too.
    fire: (url) => current?.({ url }),
    filters,
    listener: () => current
  }
}

const SECRET = 'tok_SECRET_123'

describe('loopbackPort', () => {
  it('explicit port, else the scheme default (80 / 443)', () => {
    expect(loopbackPort(`http://localhost:5173/src/main.ts?t=${SECRET}`)).toBe(5173)
    expect(loopbackPort('http://127.0.0.1:3000/api')).toBe(3000)
    expect(loopbackPort('http://[::1]:8080/x')).toBe(8080)
    expect(loopbackPort('http://localhost/')).toBe(80)
    expect(loopbackPort('https://localhost/')).toBe(443)
    expect(loopbackPort('ws://127.0.0.1/socket')).toBe(80)
    expect(loopbackPort('wss://[::1]/socket')).toBe(443)
    expect(loopbackPort('http://LOCALHOST:4000/')).toBe(4000)
  })

  it('null for non-loopback hosts, garbage and unknown schemes', () => {
    expect(loopbackPort('https://example.com:3000/')).toBeNull()
    expect(loopbackPort('http://127.0.0.2:3000/')).toBeNull()
    expect(loopbackPort('http://localhost.evil.com:3000/')).toBeNull()
    expect(loopbackPort('not a url')).toBeNull()
    expect(loopbackPort('ftp://localhost/')).toBeNull()
  })
})

describe('observeOriginPorts', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const settle = (): void => {
    vi.advanceTimersByTime(ORIGIN_PORTS_EMIT_MS)
  }

  it('registers onCompleted with ONLY the loopback patterns', () => {
    const fake = fakeSession()
    observeOriginPorts(fake.session, () => {})
    expect(fake.filters).toHaveLength(1)
    expect(fake.filters[0].urls).toEqual([...LOOPBACK_URL_PATTERNS])
    for (const pattern of fake.filters[0].urls) {
      expect(pattern).toMatch(/^\*:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\*)?\/\*$/)
    }
  })

  it('keeps ONLY the port — no URL, host, path or query ever reaches the emit', () => {
    const fake = fakeSession()
    const emit = vi.fn()
    const obs = observeOriginPorts(fake.session, emit)
    fake.fire(`http://localhost:5173/login?token=${SECRET}#frag`)
    fake.fire(`http://127.0.0.1:3000/api/users/${SECRET}`)
    settle()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith([3000, 5173])
    const everything = JSON.stringify([emit.mock.calls, obs.ports()])
    for (const leak of [SECRET, 'localhost', '127.0.0.1', 'login', 'api', 'http']) {
      expect(everything).not.toContain(leak)
    }
  })

  it('ignores a non-loopback request even if one slips past the filter (defence in depth)', () => {
    const fake = fakeSession()
    const emit = vi.fn()
    const obs = observeOriginPorts(fake.session, emit)
    fake.fire('https://api.example.com:3000/v1')
    fake.fire('http://127.0.0.2:3000/')
    settle()
    expect(emit).not.toHaveBeenCalled()
    expect(obs.ports()).toEqual([])
  })

  it('caps at 8 ports — the most recent win', () => {
    const fake = fakeSession()
    const emit = vi.fn()
    const obs = observeOriginPorts(fake.session, emit)
    for (let p = 3001; p <= 3010; p++) fake.fire(`http://localhost:${p}/`)
    settle()
    expect(MAX_ORIGIN_PORTS).toBe(8)
    expect(obs.ports()).toEqual([3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010])
    expect(emit).toHaveBeenLastCalledWith([3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010])
  })

  it('a re-requested port refreshes its recency, so it survives eviction', () => {
    const fake = fakeSession()
    const obs = observeOriginPorts(fake.session, () => {})
    for (let p = 3001; p <= 3008; p++) fake.fire(`http://localhost:${p}/`)
    fake.fire('http://localhost:3001/') // 3001 is now the most recent
    fake.fire('http://localhost:3009/') // evicts the least recent: 3002
    expect(obs.ports()).toEqual([3001, 3003, 3004, 3005, 3006, 3007, 3008, 3009])
  })

  it('emits only when the SET changes — repeats and reorders are silent; bursts coalesce', () => {
    const fake = fakeSession()
    const emit = vi.fn()
    observeOriginPorts(fake.session, emit)
    fake.fire('http://localhost:5173/')
    fake.fire('http://localhost:5173/app.js')
    fake.fire('http://localhost:3000/api')
    expect(emit).not.toHaveBeenCalled() // still inside the coalesce window
    settle()
    expect(emit).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 20; i++) {
      fake.fire('http://localhost:3000/api')
      fake.fire('http://localhost:5173/x')
    }
    settle()
    expect(emit).toHaveBeenCalledTimes(1)
    fake.fire('http://[::1]:8080/')
    settle()
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith([3000, 5173, 8080])
  })

  it('dispose drops the state, cancels a pending emit and removes the listener', () => {
    const fake = fakeSession()
    const emit = vi.fn()
    const obs = observeOriginPorts(fake.session, emit)
    fake.fire('http://localhost:5173/')
    obs.dispose()
    settle()
    expect(emit).not.toHaveBeenCalled()
    expect(obs.ports()).toEqual([])
    expect(fake.listener()).toBeNull()
    obs.dispose() // idempotent
  })

  it("a stale observer's dispose never removes a NEWER observer's listener on the same session", () => {
    const fake = fakeSession()
    const old = observeOriginPorts(fake.session, () => {})
    const emit = vi.fn()
    observeOriginPorts(fake.session, emit) // re-open on the same partition replaces the listener
    old.dispose()
    expect(fake.listener()).not.toBeNull()
    fake.fire('http://localhost:3000/')
    settle()
    expect(emit).toHaveBeenCalledWith([3000])
  })

  it('a rejected filter yields an inert observer — the preview still opens', () => {
    const fake = fakeSession({ throwOnRegister: true })
    const emit = vi.fn()
    const obs = observeOriginPorts(fake.session, emit)
    expect(obs.ports()).toEqual([])
    expect(() => obs.dispose()).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
  })
})
