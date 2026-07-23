import { describe, it, expect } from 'vitest'
// @ts-expect-error — plain .mjs tooling module, no types
import { rankRows, renderReport } from './report.mjs'
// @ts-expect-error — plain .mjs tooling module, no types
import { scoreUtterance, aggregate } from './wer.mjs'

/** Build a results row the way run.mjs does, so the test exercises the real shape. */
function row(
  engineId: string,
  pairs: Array<{ reference: string; hypothesis: string; keyterms: string[] }>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const utterances = pairs.map((p, i) => ({
    id: `u${i}`,
    reference: p.reference,
    hypothesis: p.hypothesis,
    ms: 100,
    score: scoreUtterance(p)
  }))
  return {
    engineId,
    label: engineId,
    bias: 'biased',
    skipped: false,
    errors: 0,
    medianMs: 100,
    pricePerMinUsd: 0.001,
    utterances,
    agg: aggregate(utterances.map((u) => u.score)),
    ...extra
  }
}

const perfect = row('good', [
  {
    reference: 'call useVoiceCapture',
    hypothesis: 'call useVoiceCapture',
    keyterms: ['useVoiceCapture']
  }
])
const formatting = row('formatty', [
  {
    reference: 'call useVoiceCapture',
    hypothesis: 'call use voice capture',
    keyterms: ['useVoiceCapture']
  }
])
const skipped = {
  engineId: 'nokey',
  label: 'nokey',
  skipped: true,
  skipReason: 'KEY not set',
  errors: 0,
  utterances: []
}

describe('rankRows', () => {
  it('ranks by keyterm-exact first, because WER alone hides mangled identifiers', () => {
    // `formatty` has WER 0.5 vs `good` 0 AND worse keyterm recall, but the ordering
    // guarantee we care about is that keyterm-exact drives the sort.
    const ranked = rankRows([formatting, perfect])
    expect(ranked[0].engineId).toBe('good')
  })

  it('breaks keyterm ties on WER', () => {
    const a = row('a', [
      { reference: 'run the build now', hypothesis: 'run the build now', keyterms: [] }
    ])
    const b = row('b', [
      { reference: 'run the build now', hypothesis: 'run the built now', keyterms: [] }
    ])
    expect(rankRows([b, a])[0].engineId).toBe('a')
  })

  it('sinks skipped engines to the bottom regardless of score', () => {
    const ranked = rankRows([skipped, formatting])
    expect(ranked[ranked.length - 1].engineId).toBe('nokey')
  })

  it('does not mutate the input array', () => {
    const input = [formatting, perfect]
    const before = input.map((r) => r.engineId)
    rankRows(input)
    expect(input.map((r) => r.engineId)).toEqual(before)
  })
})

describe('renderReport', () => {
  const meta = {
    startedAt: '2026-07-21T00:00:00.000Z',
    utteranceCount: 1,
    audioSeconds: 4.2,
    biasTerms: ['useVoiceCapture'],
    biasCap: 30,
    biasDropped: 0,
    conditions: ['unbiased', 'biased']
  }

  it('renders a ranked table with both keyterm columns', () => {
    const md = renderReport({ meta, rows: [perfect, formatting] })
    expect(md).toContain('| Engine | Bias | WER | Keyterm exact | Keyterm loose |')
    expect(md).toContain('100.0%')
  })

  it('surfaces the recoverable gap for a formatting-only failure', () => {
    // exact 0%, loose 100% -> gap 100%: exactly the class a replacement rule fixes.
    const md = renderReport({ meta, rows: [formatting] })
    expect(md).toMatch(/formatting — fixable with a replacement rule/)
  })

  it('calls a genuinely misheard term out separately from a formatting miss', () => {
    const misheard = row('bad', [
      {
        reference: 'call useVoiceCapture',
        hypothesis: 'call use voice capsule',
        keyterms: ['useVoiceCapture']
      }
    ])
    expect(renderReport({ meta, rows: [misheard] })).toMatch(/genuinely misheard/)
  })

  it('states the skip reason instead of omitting the engine', () => {
    const md = renderReport({ meta, rows: [perfect, skipped] })
    expect(md).toContain('_skipped_')
    expect(md).toContain('KEY not set')
  })

  it('shouts when the bias cap dropped terms — a silent truncation reads as full coverage', () => {
    const md = renderReport({ meta: { ...meta, biasDropped: 12 }, rows: [perfect] })
    expect(md).toContain('**12 dropped by the cap**')
  })

  it('records the bias list so a stale results file is self-describing', () => {
    expect(renderReport({ meta, rows: [perfect] })).toContain('`useVoiceCapture`')
  })

  it('handles an all-skipped run without throwing', () => {
    const md = renderReport({ meta, rows: [skipped] })
    expect(md).toContain('No engine produced results')
  })
})
