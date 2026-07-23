import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// @ts-expect-error — plain .mjs tooling module, no types
import { loadCorpus, buildBiasList, DEFAULT_BIAS_CAP } from './corpus.mjs'

let dir: string

/** Write a manifest plus stub wavs; loadCorpus only checks the files EXIST. */
function writeCorpus(manifest: unknown, files: string[] = []): string {
  const path = join(dir, 'manifest.json')
  writeFileSync(path, JSON.stringify(manifest), 'utf8')
  for (const f of files) writeFileSync(join(dir, f), '')
  return path
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'stt-eval-corpus-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadCorpus', () => {
  it('loads a valid manifest and resolves audio paths', () => {
    const path = writeCorpus(
      {
        sampleRate: 16000,
        utterances: [
          { id: 'u001', reference: 'run pnpm typecheck', keyterms: ['pnpm', 'typecheck'] }
        ]
      },
      ['u001.wav']
    )
    const c = loadCorpus(path)
    expect(c.sampleRate).toBe(16000)
    expect(c.utterances).toHaveLength(1)
    expect(c.utterances[0].file).toContain('u001.wav')
    expect(c.utterances[0].keyterms).toEqual(['pnpm', 'typecheck'])
  })

  it('defaults the filename to <id>.wav', () => {
    const path = writeCorpus({ utterances: [{ id: 'u002', reference: 'hello' }] }, ['u002.wav'])
    expect(loadCorpus(path).utterances[0].file).toContain('u002.wav')
  })

  it('points at the recorder when the manifest is missing', () => {
    expect(() => loadCorpus(join(dir, 'nope.json'))).toThrow(/pnpm stt:record/)
  })

  it('rejects a corpus with no utterances rather than reporting a vacuous 0% WER', () => {
    const path = writeCorpus({ utterances: [] })
    expect(() => loadCorpus(path)).toThrow(/no utterances/)
  })

  it('rejects duplicate ids', () => {
    const path = writeCorpus(
      {
        utterances: [
          { id: 'dup', reference: 'a' },
          { id: 'dup', reference: 'b' }
        ]
      },
      ['dup.wav']
    )
    expect(() => loadCorpus(path)).toThrow(/duplicate id/)
  })

  it('rejects an entry with no reference transcript', () => {
    const path = writeCorpus({ utterances: [{ id: 'u003', reference: '   ' }] }, ['u003.wav'])
    expect(() => loadCorpus(path)).toThrow(/no reference transcript/)
  })

  it('rejects an entry whose audio is missing', () => {
    const path = writeCorpus({ utterances: [{ id: 'ghost', reference: 'hi' }] })
    expect(() => loadCorpus(path)).toThrow(/missing audio/)
  })

  it('reports invalid JSON with the path', () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(() => loadCorpus(path)).toThrow(/not valid JSON/)
  })
})

describe('buildBiasList', () => {
  const utterances = [
    { keyterms: ['pnpm', 'typecheck'] },
    { keyterms: ['pnpm', 'vitest'] },
    { keyterms: ['pnpm'] }
  ]

  it('dedupes and orders by frequency', () => {
    expect(buildBiasList(utterances).terms[0]).toBe('pnpm')
  })

  it('breaks frequency ties alphabetically so runs are reproducible', () => {
    // typecheck and vitest both appear once — order must not depend on Map insertion.
    const { terms } = buildBiasList(utterances)
    expect(terms).toEqual(['pnpm', 'typecheck', 'vitest'])
  })

  it('caps the list and reports how many were dropped', () => {
    const { terms, dropped } = buildBiasList(utterances, 2)
    expect(terms).toHaveLength(2)
    expect(dropped).toBe(1)
  })

  it('reports zero dropped when everything fits', () => {
    expect(buildBiasList(utterances, 10).dropped).toBe(0)
  })

  it('defaults to a deliberately low cap — long glossaries measurably hurt accuracy', () => {
    expect(DEFAULT_BIAS_CAP).toBeLessThanOrEqual(50)
  })

  it('handles a corpus with no keyterms at all', () => {
    expect(buildBiasList([{ keyterms: [] }, {}])).toEqual({ terms: [], dropped: 0 })
  })

  it('ignores blank terms', () => {
    expect(buildBiasList([{ keyterms: ['  ', 'real'] }]).terms).toEqual(['real'])
  })

  it('supports a cap of 0 (pure unbiased control)', () => {
    const { terms, dropped } = buildBiasList(utterances, 0)
    expect(terms).toEqual([])
    expect(dropped).toBe(3)
  })
})
