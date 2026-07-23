import { describe, it, expect } from 'vitest'
import { restoreFormatting, buildSymbolMap, spokenSegments } from './voiceFormatRestore'

// Ported verbatim from scripts/stt-eval/formatRestore.test.ts (PR #368) — the measured 85.5%
// keyterm-exact depends on this algorithm staying identical.

const SYMBOLS = [
  'contextIsolation',
  'useVoiceCapture',
  'add_card',
  'MessagePort',
  'modified_beam_search',
  'electron-builder',
  'ts',
  'git'
]

describe('spokenSegments', () => {
  it('counts camelCase humps', () => {
    expect(spokenSegments('useVoiceCapture')).toBe(3)
    expect(spokenSegments('contextIsolation')).toBe(2)
  })
  it('counts separator segments', () => {
    expect(spokenSegments('modified_beam_search')).toBe(3)
    expect(spokenSegments('electron-builder')).toBe(2)
  })
  it('treats an acronym run as one segment before a CamelWord', () => {
    expect(spokenSegments('HTMLParser')).toBe(2)
  })
})

describe('buildSymbolMap', () => {
  it('indexes by folded form and reports the max span', () => {
    const map = buildSymbolMap(SYMBOLS)
    expect(map.byFold.get('contextisolation')).toBe('contextIsolation')
    expect(map.byFold.get('modifiedbeamsearch')).toBe('modified_beam_search')
    expect(map.maxSpan).toBe(3) // useVoiceCapture / modified_beam_search
  })

  it('drops ambiguous folds instead of guessing', () => {
    const map = buildSymbolMap(['add_card', 'addCard', 'safeStorage'])
    expect(map.byFold.has('addcard')).toBe(false) // two spellings fold the same → dropped
    expect(map.dropped).toContain('addcard')
    expect(map.byFold.get('safestorage')).toBe('safeStorage') // unaffected
  })

  it('ignores empty / non-string entries', () => {
    const map = buildSymbolMap(['git', '', '   ', null, 42] as unknown as string[])
    expect(map.byFold.get('git')).toBe('git')
    expect(map.byFold.size).toBe(1)
  })
})

describe('restoreFormatting', () => {
  it('rewrites a camelCase identifier spoken as separate words', () => {
    expect(restoreFormatting('the context isolation flag', SYMBOLS)).toBe(
      'the contextIsolation flag'
    )
  })

  it('rewrites a 3-word identifier', () => {
    expect(restoreFormatting('call use voice capture now', SYMBOLS)).toBe(
      'call useVoiceCapture now'
    )
  })

  it('rewrites a snake_case identifier and consumes the spoken gap', () => {
    expect(restoreFormatting('add card to the board', SYMBOLS)).toBe('add_card to the board')
  })

  it('is case-insensitive on the spoken form', () => {
    expect(restoreFormatting('Context Isolation is on', SYMBOLS)).toBe('contextIsolation is on')
  })

  it('prefers the LONGEST match', () => {
    expect(restoreFormatting('use modified beam search here', SYMBOLS)).toBe(
      'use modified_beam_search here'
    )
  })

  it('only matches WHOLE words, never a substring', () => {
    expect(restoreFormatting('edit tsconfig please', SYMBOLS)).toBe('edit tsconfig please')
    expect(restoreFormatting('the ts file', SYMBOLS)).toBe('the ts file')
  })

  it('preserves surrounding punctuation and spacing', () => {
    expect(restoreFormatting('open src/main, then message port.', SYMBOLS)).toBe(
      'open src/main, then MessagePort.'
    )
  })

  it('leaves text untouched when nothing matches', () => {
    expect(restoreFormatting('just some plain english words', SYMBOLS)).toBe(
      'just some plain english words'
    )
  })

  it('handles multiple matches in one string', () => {
    expect(restoreFormatting('the context isolation and message port', SYMBOLS)).toBe(
      'the contextIsolation and MessagePort'
    )
  })

  it('does NOT merge multi-word matches split by punctuation (sentence boundary)', () => {
    expect(restoreFormatting('please add. card is broken', SYMBOLS)).toBe(
      'please add. card is broken'
    )
    expect(restoreFormatting('context, isolation matters', SYMBOLS)).toBe(
      'context, isolation matters'
    )
  })

  it('still matches a multi-word symbol across multiple plain spaces / a newline', () => {
    expect(restoreFormatting('call use  voice\tcapture now', SYMBOLS)).toBe(
      'call useVoiceCapture now'
    )
  })

  it('falls back to a shorter whitespace-only match when the longer span is punctuated', () => {
    expect(restoreFormatting('use modified beam. search here', SYMBOLS)).toBe(
      'use modified beam. search here'
    )
  })

  it('does not rewrite an ambiguous fold', () => {
    const out = restoreFormatting('add card here', ['add_card', 'addCard'])
    expect(out).toBe('add card here') // ambiguous → left as prose
  })

  it('returns non-string / empty input unchanged', () => {
    expect(restoreFormatting('', SYMBOLS)).toBe('')
    // @ts-expect-error deliberately wrong type
    expect(restoreFormatting(null, SYMBOLS)).toBe(null)
  })

  it('accepts a prebuilt symbol map (the cloud engine reuses one per utterance)', () => {
    const map = buildSymbolMap(SYMBOLS)
    expect(restoreFormatting('the context isolation flag', map)).toBe('the contextIsolation flag')
  })
})
