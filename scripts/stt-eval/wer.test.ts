import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs tooling module, no types (same pattern as e2e-scope.test.ts)
import {
  normalizeTokens,
  foldIdentifier,
  alignTokens,
  wordErrorRate,
  keytermRecall,
  scoreUtterance,
  aggregate
} from './wer.mjs'

describe('normalizeTokens', () => {
  it('lowercases and splits on code separators so formatting never inflates WER', () => {
    // The whole point: `--no-verify` and "no verify" must tokenise identically, because
    // formatting is scored by keyterm-exact recall, not by WER.
    expect(normalizeTokens('--no-verify')).toEqual(['no', 'verify'])
    expect(normalizeTokens('no verify')).toEqual(['no', 'verify'])
    expect(normalizeTokens('src/main/voiceIpc.ts')).toEqual(['src', 'main', 'voiceipc', 'ts'])
  })

  it('drops punctuation but keeps intra-word apostrophes', () => {
    expect(normalizeTokens("Don't stop, please!")).toEqual(["don't", 'stop', 'please'])
    expect(normalizeTokens("'quoted'")).toEqual(['quoted'])
  })

  it('normalises smart quotes to ascii before stripping', () => {
    expect(normalizeTokens('don’t')).toEqual(["don't"])
  })

  it('maps number words to digits so both spellings converge', () => {
    expect(normalizeTokens('sixteen kilohertz')).toEqual(['16', 'kilohertz'])
    expect(normalizeTokens('16 kilohertz')).toEqual(['16', 'kilohertz'])
  })

  it('drops filler words from both sides', () => {
    expect(normalizeTokens('um run the uh build')).toEqual(['run', 'the', 'build'])
  })

  it('returns an empty list for non-strings and blank input', () => {
    expect(normalizeTokens(undefined)).toEqual([])
    expect(normalizeTokens('')).toEqual([])
    expect(normalizeTokens('   ')).toEqual([])
  })
})

describe('foldIdentifier', () => {
  it('collapses case and every separator', () => {
    expect(foldIdentifier('useVoiceCapture')).toBe('usevoicecapture')
    expect(foldIdentifier('use voice capture')).toBe('usevoicecapture')
    expect(foldIdentifier('use-voice_capture')).toBe('usevoicecapture')
  })

  it('is empty for punctuation-only input', () => {
    expect(foldIdentifier('--')).toBe('')
    expect(foldIdentifier(null)).toBe('')
  })
})

describe('alignTokens', () => {
  it('counts a perfect match as all hits', () => {
    expect(alignTokens(['a', 'b', 'c'], ['a', 'b', 'c'])).toMatchObject({
      hits: 3,
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      distance: 0
    })
  })

  it('classifies substitution, deletion and insertion separately', () => {
    expect(alignTokens(['a', 'b'], ['a', 'x'])).toMatchObject({ substitutions: 1, distance: 1 })
    expect(alignTokens(['a', 'b'], ['a'])).toMatchObject({ deletions: 1, distance: 1 })
    expect(alignTokens(['a'], ['a', 'b'])).toMatchObject({ insertions: 1, distance: 1 })
  })

  it('handles empty sides', () => {
    expect(alignTokens([], ['a', 'b'])).toMatchObject({ insertions: 2, distance: 2 })
    expect(alignTokens(['a', 'b'], [])).toMatchObject({ deletions: 2, distance: 2 })
    expect(alignTokens([], [])).toMatchObject({ distance: 0 })
  })

  it('keeps the edit breakdown summing to the distance', () => {
    const a = alignTokens(['run', 'the', 'build', 'script'], ['ran', 'build', 'script', 'now'])
    expect(a.substitutions + a.deletions + a.insertions).toBe(a.distance)
  })
})

describe('wordErrorRate', () => {
  it('is 0 for an exact match after normalisation', () => {
    expect(wordErrorRate('Run the build.', 'run the build').rate).toBe(0)
  })

  it('divides edits by REFERENCE length', () => {
    // 4 reference words, 1 substitution -> 0.25
    const r = wordErrorRate('run the build script', 'run the build scrapped')
    expect(r.refWords).toBe(4)
    expect(r.substitutions).toBe(1)
    expect(r.rate).toBeCloseTo(0.25)
  })

  it('can exceed 1.0 when an engine hallucinates extra words', () => {
    // Deliberately NOT clamped: a runaway hypothesis is a real failure mode
    // (Whisper repetition loops) and the report should show it.
    const r = wordErrorRate('build', 'build build build build')
    expect(r.rate).toBeGreaterThan(1)
  })

  it('scores an empty hypothesis against a real reference as total loss', () => {
    expect(wordErrorRate('run the build', '').rate).toBe(1)
  })

  it('treats an empty reference as 0 only when the hypothesis is also empty', () => {
    expect(wordErrorRate('', '').rate).toBe(0)
    expect(wordErrorRate('', 'something').rate).toBe(1)
  })

  it('ignores code-formatting differences', () => {
    expect(wordErrorRate('pass --no-verify', 'pass no verify').rate).toBe(0)
  })
})

describe('keytermRecall', () => {
  it('scores exact separately from loose', () => {
    const r = keytermRecall('call useVoiceCapture first', ['useVoiceCapture'])
    expect(r.results[0]).toMatchObject({ exact: true, loose: true })
    expect(r.exactRate).toBe(1)
  })

  it('flags the recoverable class — heard right, formatted wrong', () => {
    // This is the gap the deterministic replacement layer is meant to close.
    const r = keytermRecall('call use voice capture first', ['useVoiceCapture'])
    expect(r.results[0]).toMatchObject({ exact: false, loose: true })
    expect(r.exactRate).toBe(0)
    expect(r.looseRate).toBe(1)
  })

  it('reports a genuinely misheard term as neither', () => {
    const r = keytermRecall('call use voice capsule first', ['useVoiceCapture'])
    expect(r.results[0]).toMatchObject({ exact: false, loose: false })
  })

  it('is case-sensitive for exact matching', () => {
    expect(keytermRecall('call usevoicecapture', ['useVoiceCapture']).exactHits).toBe(0)
    expect(keytermRecall('call usevoicecapture', ['useVoiceCapture']).looseHits).toBe(1)
  })

  it('never matches a punctuation-only term against everything', () => {
    // foldIdentifier('--') is '' and ''.includes('') is true — guarded explicitly.
    const r = keytermRecall('anything at all', ['--'])
    expect(r.results[0]).toMatchObject({ exact: false, loose: false })
  })

  it('returns null rates for an empty keyterm list rather than a fake 0', () => {
    const r = keytermRecall('anything', [])
    expect(r.total).toBe(0)
    expect(r.exactRate).toBeNull()
    expect(r.looseRate).toBeNull()
  })

  it('ignores blank and non-string entries', () => {
    expect(keytermRecall('x', ['  ', null as unknown as string, 'x']).total).toBe(1)
  })
})

describe('aggregate', () => {
  it('pools edits over total reference words, not a mean of rates', () => {
    // A naive mean would give (1/1 + 0/9)/2 = 0.5; the correct pooled figure is
    // 1 edit / 10 reference words = 0.1. This is the bug the roll-up exists to avoid.
    const short = scoreUtterance({ reference: 'build', hypothesis: 'built' })
    const long = scoreUtterance({
      reference: 'one two three four five six seven eight nine',
      hypothesis: 'one two three four five six seven eight nine'
    })
    const agg = aggregate([short, long])
    expect(agg.refWords).toBe(10)
    expect(agg.distance).toBe(1)
    expect(agg.wer).toBeCloseTo(0.1)
  })

  it('pools keyterm hits across utterances', () => {
    const a = scoreUtterance({
      reference: 'run useVoiceCapture',
      hypothesis: 'run useVoiceCapture',
      keyterms: ['useVoiceCapture']
    })
    const b = scoreUtterance({
      reference: 'run voiceIpc',
      hypothesis: 'run voice ipc',
      keyterms: ['voiceIpc']
    })
    const agg = aggregate([a, b])
    expect(agg.keytermTotal).toBe(2)
    expect(agg.keytermExactHits).toBe(1)
    expect(agg.keytermLooseHits).toBe(2)
    expect(agg.keytermExactRate).toBeCloseTo(0.5)
    expect(agg.keytermLooseRate).toBe(1)
  })

  it('returns null rates for an empty corpus rather than dividing by zero', () => {
    const agg = aggregate([])
    expect(agg.utterances).toBe(0)
    expect(agg.wer).toBeNull()
    expect(agg.keytermExactRate).toBeNull()
  })
})
