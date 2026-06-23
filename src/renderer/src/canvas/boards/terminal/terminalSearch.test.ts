// Unit coverage for the two pure seams of find-in-terminal (Phase 2). The effectful addon wiring
// (TerminalFindBar) is covered by the @terminal e2e; these pin the decidable label + option logic.
import { describe, it, expect } from 'vitest'
import { formatMatchCount, buildSearchOptions, SEARCH_DECORATIONS } from './terminalSearch'

describe('formatMatchCount — the find-bar counter label (pure)', () => {
  it('no matches → "No results"', () => {
    expect(formatMatchCount(-1, 0)).toBe('No results')
    expect(formatMatchCount(0, 0)).toBe('No results') // count is authoritative even if index >= 0
  })

  it('a current match → "i+1 / N" (1-based for humans)', () => {
    expect(formatMatchCount(0, 4)).toBe('1 / 4') // first of four
    expect(formatMatchCount(3, 4)).toBe('4 / 4') // last of four
    expect(formatMatchCount(2, 27)).toBe('3 / 27')
  })

  it('threshold exceeded (index -1, count > 0) → the bare count, no cursor', () => {
    // The addon returns resultIndex -1 when there are more matches than the highlight limit.
    expect(formatMatchCount(-1, 1000)).toBe('1000')
  })
})

describe('buildSearchOptions — per-call SearchAddon options (pure)', () => {
  it('passes through case/regex and the incremental flag', () => {
    expect(
      buildSearchOptions({ caseSensitive: true, regex: false, incremental: true })
    ).toMatchObject({ caseSensitive: true, regex: false, incremental: true })
    expect(
      buildSearchOptions({ caseSensitive: false, regex: true, incremental: false })
    ).toMatchObject({ caseSensitive: false, regex: true, incremental: false })
  })

  it('ALWAYS attaches decorations — the addon emits onDidChangeResults (the counter) only then', () => {
    const opts = buildSearchOptions({ caseSensitive: false, regex: false, incremental: true })
    expect(opts.decorations).toBe(SEARCH_DECORATIONS)
  })
})

describe('SEARCH_DECORATIONS — addon colour constraints', () => {
  it('match/active backgrounds are #RRGGBB (addon rejects rgba/var)', () => {
    expect(SEARCH_DECORATIONS.matchBackground).toMatch(/^#[0-9a-fA-F]{6}$/)
    expect(SEARCH_DECORATIONS.activeMatchBackground).toMatch(/^#[0-9a-fA-F]{6}$/)
  })

  it('provides the two required overview-ruler colours', () => {
    expect(SEARCH_DECORATIONS.matchOverviewRuler).toBeTruthy()
    expect(SEARCH_DECORATIONS.activeMatchColorOverviewRuler).toBeTruthy()
  })
})
