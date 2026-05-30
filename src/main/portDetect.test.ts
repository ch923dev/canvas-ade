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
    expect(parsePortsFromOutput('Starting development server at http://127.0.0.1:8000/')[0]).toEqual(
      { url: 'http://127.0.0.1:8000', host: '127.0.0.1', port: 8000 }
    )
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
})
