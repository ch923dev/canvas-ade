import { describe, it, expect } from 'vitest'
import { parsePortsFromOutput } from './portDetect'

describe('parsePortsFromOutput', () => {
  it('returns [] for empty/garbage input', () => {
    expect(parsePortsFromOutput('')).toEqual([])
    expect(parsePortsFromOutput('no url here')).toEqual([])
  })

  it('parses a vite Local line with ANSI codes', () => {
    const raw = '\x1b[32m➜\x1b[0m  \x1b[1mLocal\x1b[0m:   http://localhost:5173/\r\n'
    expect(parsePortsFromOutput(raw)).toEqual([
      { url: 'http://localhost:5173', host: 'localhost', port: 5173 }
    ])
  })

  it('parses Next (3000), Django (127.0.0.1:8000), Flask (5000)', () => {
    expect(parsePortsFromOutput('- Local:  http://localhost:3000')[0].port).toBe(3000)
    expect(
      parsePortsFromOutput('Starting development server at http://127.0.0.1:8000/')[0]
    ).toEqual({ url: 'http://127.0.0.1:8000', host: '127.0.0.1', port: 8000 })
    expect(parsePortsFromOutput('Running on http://127.0.0.1:5000')[0].port).toBe(5000)
  })

  it('normalizes 0.0.0.0 / [::] to localhost', () => {
    expect(parsePortsFromOutput('listening http://0.0.0.0:4000')[0]).toEqual({
      url: 'http://localhost:4000',
      host: 'localhost',
      port: 4000
    })
  })

  it('dedupes by host:port and orders most-recent (latest in stream) first', () => {
    const raw = 'http://localhost:5173\nrebuild...\nhttp://localhost:5173\nhttp://localhost:4321'
    const out = parsePortsFromOutput(raw)
    expect(out.map((u) => u.port)).toEqual([4321, 5173])
  })

  it('rejects out-of-range ports', () => {
    expect(parsePortsFromOutput('http://localhost:99999')).toEqual([])
  })

  it('drops a terminal soft-wrap fragment (truncated port) leaving the real URL', () => {
    // ConPTY wrapped the echoed command line mid-URL: `...localhost:300` ⏎ `0/`,
    // then the real URL printed intact. The :300 fragment must not survive.
    const raw = 'PS C:\\repo> echo http://localhost:300\n0/\nhttp://localhost:3000/\n'
    expect(parsePortsFromOutput(raw)).toEqual([
      { url: 'http://localhost:3000', host: 'localhost', port: 3000 }
    ])
  })

  it('drops a soft-wrap fragment that truncated before the port (bare host → :80)', () => {
    // Wrap landed after the host: `http://localhost` ⏎ `:3000/`. The bare-host
    // match defaults to :80 and must be dropped as a prefix of the real :3000.
    const raw = 'echo http://localhost\n:3000/\nhttp://localhost:3000/\n'
    expect(parsePortsFromOutput(raw).map((u) => u.port)).toEqual([3000])
  })

  it('keeps two genuinely distinct ports (neither a prefix of the other)', () => {
    const raw = 'http://localhost:3000\nhttp://localhost:8080'
    expect(
      parsePortsFromOutput(raw)
        .map((u) => u.port)
        .sort()
    ).toEqual([3000, 8080])
  })

  // BUG-009: expanded IPv6 loopback forms not matched by URL_RE
  it('detects expanded full-form IPv6 loopback [0:0:0:0:0:0:0:1] (Go net/http)', () => {
    const raw = 'Listening on http://[0:0:0:0:0:0:0:1]:8080'
    const out = parsePortsFromOutput(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ url: 'http://localhost:8080', host: 'localhost', port: 8080 })
  })

  it('detects IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]', () => {
    const raw = 'Server running at http://[::ffff:127.0.0.1]:3000'
    const out = parsePortsFromOutput(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ url: 'http://localhost:3000', host: 'localhost', port: 3000 })
  })

  it('detects zero-padded short-form IPv6 loopback [::0001]', () => {
    const raw = 'Listening on http://[::0001]:9000'
    const out = parsePortsFromOutput(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ url: 'http://localhost:9000', host: 'localhost', port: 9000 })
  })
})
