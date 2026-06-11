import { describe, expect, it } from 'vitest'
import { rankMatches, scoreMatch } from './paletteSearch'

describe('scoreMatch', () => {
  it('empty / whitespace query matches everything at score 0', () => {
    expect(scoreMatch('', 'Tidy boards')).toBe(0)
    expect(scoreMatch('   ', 'anything')).toBe(0)
  })

  it('word-prefix beats mid-word substring beats subsequence', () => {
    const prefix = scoreMatch('tid', 'Tidy boards')!
    const mid = scoreMatch('oar', 'Tidy boards')!
    const subseq = scoreMatch('tbs', 'Tidy boards')!
    expect(prefix).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(subseq)
  })

  it('matches any word start, not just the first', () => {
    expect(scoreMatch('boa', 'Tidy boards')!).toBeGreaterThan(scoreMatch('oar', 'Tidy boards')!)
  })

  it('is case-insensitive', () => {
    expect(scoreMatch('TIDY', 'tidy boards')).not.toBeNull()
    expect(scoreMatch('tidy', 'TIDY BOARDS')).not.toBeNull()
  })

  it('rejects a non-match (including broken subsequences)', () => {
    expect(scoreMatch('xyz', 'Tidy boards')).toBeNull()
    expect(scoreMatch('sdraob', 'boards')).toBeNull() // chars present but out of order
  })

  it('ANDs multi-token queries', () => {
    expect(scoreMatch('new term', 'New terminal board')).not.toBeNull()
    expect(scoreMatch('new nope', 'New terminal board')).toBeNull()
  })
})

describe('rankMatches', () => {
  const items = ['Group selected boards', 'Go to board: agent-1', 'Ungroup: feature-x']

  it('ranks better matches first (prefix > substring > subsequence)', () => {
    const out = rankMatches('gr', items, (s) => s)
    expect(out[0]).toBe('Group selected boards') // word-prefix
    // 'Ungroup' (substring) outranks 'Go to board' (g…r subsequence only).
    expect(out.indexOf('Ungroup: feature-x')).toBeLessThan(out.indexOf('Go to board: agent-1'))
  })

  it('drops true non-matches', () => {
    expect(rankMatches('zzz', items, (s) => s)).toEqual([])
  })

  it('keeps input order for equal scores (stable)', () => {
    const out = rankMatches('', items, (s) => s)
    expect(out).toEqual(items)
  })
})
