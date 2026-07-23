import { describe, it, expect, vi } from 'vitest'
import type { Dirent } from 'fs'
import {
  isDistinctive,
  extractIdentifiers,
  rankSymbols,
  scanProjectSymbols,
  createSymbolProvider
} from './voiceSymbols'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const norm = (p: string): string => p.replace(/\\/g, '/')

describe('isDistinctive', () => {
  it('accepts code-shaped identifiers', () => {
    expect(isDistinctive('useVoiceCapture')).toBe(true) // camelCase
    expect(isDistinctive('add_card')).toBe(true) // snake_case
    expect(isDistinctive('MessagePort')).toBe(true) // PascalCase
    expect(isDistinctive('sha1')).toBe(true) // has a digit
    expect(isDistinctive('previewosr')).toBe(true) // long-enough lowercase word
  })
  it('rejects keywords, fillers, and short common words', () => {
    expect(isDistinctive('const')).toBe(false) // keyword/stopword
    expect(isDistinctive('the')).toBe(false) // too short
    expect(isDistinctive('return')).toBe(false) // stopword
    expect(isDistinctive('map')).toBe(false) // short + stopword
  })
})

describe('extractIdentifiers', () => {
  it('pulls distinctive identifiers (with repeats) and skips prose + keywords', () => {
    const ids = extractIdentifiers('const useVoiceCapture = 1; return contextIsolation; the end')
    expect(ids).toContain('useVoiceCapture')
    expect(ids).toContain('contextIsolation')
    expect(ids).not.toContain('const')
    expect(ids).not.toContain('return')
    expect(ids).not.toContain('the')
  })
})

describe('rankSymbols', () => {
  it('ranks by frequency (ties alphabetical); bias is the capped head, dict the fuller set', () => {
    const counts = new Map([
      ['contextIsolation', 5],
      ['add_card', 5],
      ['useVoiceCapture', 2],
      ['MessagePort', 1]
    ])
    const { bias, dict } = rankSymbols(counts, { biasCap: 2 })
    expect(bias).toEqual(['add_card', 'contextIsolation']) // freq 5 tie → alphabetical, capped at 2
    expect(dict).toEqual(['add_card', 'contextIsolation', 'useVoiceCapture', 'MessagePort'])
  })
})

// ── a fake fs tree (normalized to forward slashes so the walker's path.join is platform-safe) ──
const dir = (name: string): Dirent =>
  ({ name, isDirectory: () => true, isFile: () => false }) as Dirent
const file = (name: string): Dirent =>
  ({ name, isDirectory: () => false, isFile: () => true }) as Dirent

const TREE: Record<string, Dirent[]> = {
  '/proj': [dir('src'), dir('node_modules'), dir('.git'), file('README.md')],
  '/proj/src': [file('a.ts'), file('b.py'), file('styles.css')],
  '/proj/node_modules': [file('evil.ts')]
}
const CONTENT: Record<string, string> = {
  '/proj/src/a.ts': 'const useVoiceCapture = 1; contextIsolation; contextIsolation',
  '/proj/src/b.py': 'add_card add_card modified_beam_search',
  '/proj/src/styles.css': '.some-class {}',
  '/proj/node_modules/evil.ts': 'shouldNeverAppear leakedSymbol'
}
const fakeReaddir = (async (d: string) =>
  TREE[norm(d)] ?? []) as unknown as typeof import('fs/promises').readdir
const fakeReadFile = (async (p: string) =>
  Buffer.from(CONTENT[norm(p)] ?? '')) as unknown as typeof import('fs/promises').readFile

describe('scanProjectSymbols', () => {
  it('walks source files, skips ignored dirs + non-source files, and counts identifiers', async () => {
    const { counts, files } = await scanProjectSymbols('/proj', {
      readdir: fakeReaddir,
      readFile: fakeReadFile
    })
    expect(files).toBe(3) // a.ts + b.py + styles.css (README.md skipped by extension)
    expect(counts.get('contextIsolation')).toBe(2)
    expect(counts.get('add_card')).toBe(2)
    expect(counts.get('useVoiceCapture')).toBe(1)
    expect(counts.has('leakedSymbol')).toBe(false) // node_modules pruned, never read
  })

  it('honours the file cap', async () => {
    const { files } = await scanProjectSymbols('/proj', {
      readdir: fakeReaddir,
      readFile: fakeReadFile,
      maxFiles: 1
    })
    expect(files).toBe(1)
  })
})

describe('createSymbolProvider', () => {
  it('serves EMPTY until the background build lands, then the ranked sets', async () => {
    const scan = vi.fn(async () => ({
      counts: new Map([
        ['contextIsolation', 3],
        ['add_card', 1]
      ]),
      files: 2
    }))
    const provider = createSymbolProvider({ getProjectDir: () => '/proj', scan, ttlMs: 1e9 })
    expect(provider.get()).toEqual({ bias: [], dict: [] }) // build kicked off, not yet resolved
    await tick()
    expect(provider.get().bias).toEqual(['contextIsolation', 'add_card'])
    expect(scan).toHaveBeenCalledTimes(1) // cached — no rebuild on the second get()
  })

  it('returns EMPTY (never the previous project) the instant the project changes', async () => {
    let cur = '/a'
    const scan = vi.fn(async (d: string) => ({
      counts: new Map([[d === '/a' ? 'alphaSymbol' : 'betaSymbol', 1]]),
      files: 1
    }))
    const provider = createSymbolProvider({ getProjectDir: () => cur, scan, ttlMs: 1e9 })
    provider.get()
    await tick()
    expect(provider.get().dict).toEqual(['alphaSymbol'])
    cur = '/b'
    expect(provider.get()).toEqual({ bias: [], dict: [] }) // /a's symbols must not leak into /b
    await tick()
    expect(provider.get().dict).toEqual(['betaSymbol'])
  })

  it('keeps the last good cache when a scan fails', async () => {
    let fail = false
    const scan = vi.fn(async () => {
      if (fail) throw new Error('scan boom')
      return { counts: new Map([['goodSymbol', 1]]), files: 1 }
    })
    const provider = createSymbolProvider({ getProjectDir: () => '/proj', scan, ttlMs: 0 })
    provider.get()
    await tick()
    expect(provider.get().dict).toEqual(['goodSymbol'])
    fail = true
    provider.refresh()
    await tick()
    expect(provider.get().dict).toEqual(['goodSymbol']) // unchanged — a failed scan never clears it
  })
})
