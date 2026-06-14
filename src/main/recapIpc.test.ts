import { describe, it, expect } from 'vitest'
import { narrowNarrative } from './recapIpc'

// narrowNarrative is the trust boundary for the user-editable sidecar (board-<id>.recap.json):
// the summary loop writes it sanitized, but it sits in the project folder where a user or another
// tool can edit it, so it must shape-check every field + re-bound lengths and never throw.
describe('narrowNarrative — untrusted sidecar boundary', () => {
  it('accepts a well-formed narrative and preserves its fields', () => {
    expect(
      narrowNarrative({
        now: 'doing X',
        next: 'do Y',
        beats: [{ ts: 1000, text: 'a', role: 'user' }],
        asOf: 5000
      })
    ).toEqual({
      now: 'doing X',
      next: 'do Y',
      beats: [{ ts: 1000, text: 'a', role: 'user' }],
      asOf: 5000
    })
  })

  it('returns undefined for non-objects and for a missing/invalid now or asOf', () => {
    expect(narrowNarrative(null)).toBeUndefined()
    expect(narrowNarrative(undefined)).toBeUndefined()
    expect(narrowNarrative('str')).toBeUndefined()
    expect(narrowNarrative(42)).toBeUndefined()
    expect(narrowNarrative({})).toBeUndefined()
    expect(narrowNarrative({ now: 'x' })).toBeUndefined() // asOf missing
    expect(narrowNarrative({ now: 'x', asOf: 'nope' })).toBeUndefined() // asOf not a number
    expect(narrowNarrative({ now: 'x', asOf: NaN })).toBeUndefined() // asOf not finite
    expect(narrowNarrative({ now: 123, asOf: 5 })).toBeUndefined() // now not a string
  })

  it('defaults beats to [] when absent or not an array, and drops a non-string next', () => {
    expect(narrowNarrative({ now: 'x', asOf: 5 })).toEqual({ now: 'x', beats: [], asOf: 5 })
    expect(narrowNarrative({ now: 'x', asOf: 5, beats: 'nope' })).toEqual({
      now: 'x',
      beats: [],
      asOf: 5
    })
    // a non-string `next` is omitted entirely (not coerced)
    expect(narrowNarrative({ now: 'x', asOf: 5, next: 7 })).toEqual({
      now: 'x',
      beats: [],
      asOf: 5
    })
  })

  it('drops malformed beats and coerces role to "agent" unless it is exactly "user"', () => {
    const out = narrowNarrative({
      now: 'x',
      asOf: 5,
      beats: [
        { ts: 1, text: 'ok', role: 'user' },
        { ts: 2, text: 'no-role' }, // role missing -> agent
        { ts: 3, text: 'odd', role: 'system' }, // unknown role -> agent
        { ts: 'bad', text: 'x' }, // ts not a number -> dropped
        { ts: 4 }, // text missing -> dropped
        { ts: NaN, text: 'x' } // ts not finite -> dropped
      ]
    })
    expect(out?.beats).toEqual([
      { ts: 1, text: 'ok', role: 'user' },
      { ts: 2, text: 'no-role', role: 'agent' },
      { ts: 3, text: 'odd', role: 'agent' }
    ])
  })

  it('re-bounds a hand-edited huge sidecar: caps beats to 8 and every text field to 2000 chars', () => {
    const big = 'a'.repeat(5000)
    const beats = Array.from({ length: 20 }, (_, i) => ({
      ts: i + 1,
      text: big,
      role: 'agent' as const
    }))
    const out = narrowNarrative({ now: big, next: big, beats, asOf: 5 })
    expect(out?.beats.length).toBe(8)
    expect(out?.beats[0].text.length).toBe(2000)
    expect(out?.now.length).toBe(2000)
    expect(out?.next?.length).toBe(2000)
  })
})
