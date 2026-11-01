/**
 * The shared invisible-code-point predicate behind `groupName.ts` and `dispatchSanitize.ts`. Pins
 * every range the 2026-11 sanitizer review listed (each endpoint), the ranges the older hand-kept
 * lists already had, and the visible neighbours that must NOT match.
 */
import { describe, expect, it } from 'vitest'
import { isInvisibleCodePoint, ZWJ } from './invisibleChars'

const ranges: Array<[string, number, number]> = [
  ['variation selectors', 0xfe00, 0xfe0f],
  ['variation selectors supplement', 0xe0100, 0xe01ef],
  ['tag characters', 0xe0000, 0xe007f],
  ['soft hyphen', 0x00ad, 0x00ad],
  ['combining grapheme joiner', 0x034f, 0x034f],
  ['Mongolian vowel separator', 0x180e, 0x180e],
  ['invisible operators', 0x2061, 0x2064],
  ['deprecated format controls', 0x206a, 0x206f],
  ['interlinear annotation', 0xfff9, 0xfffb],
  ['zero-width + LRM/RLM', 0x200b, 0x200f],
  ['bidi embeddings/overrides', 0x202a, 0x202e],
  ['bidi isolates', 0x2066, 0x2069],
  ['ALM', 0x061c, 0x061c],
  ['word joiner', 0x2060, 0x2060],
  ['BOM', 0xfeff, 0xfeff],
  ['Hangul filler', 0x3164, 0x3164]
]

describe('isInvisibleCodePoint', () => {
  it.each(ranges)('matches every %s code point', (_name, from, to) => {
    for (let cp = from; cp <= to; cp++) {
      expect(isInvisibleCodePoint(String.fromCodePoint(cp)), cp.toString(16)).toBe(true)
    }
  })

  it('exports the ZWJ it classifies as invisible', () => {
    expect(ZWJ).toBe('‍')
    expect(isInvisibleCodePoint(ZWJ)).toBe(true)
  })

  it('never matches visible text, spaces or the code points next to the ranges', () => {
    const visible = ['a', 'é', '中', '1', '-', ' ', ' ', '🚀', '❤', '́', '¬', '®']
    for (const ch of visible) {
      expect(isInvisibleCodePoint(ch), ch).toBe(false)
    }
    // Neighbours just outside the ranges (U+2065 / U+FFF8 / U+E0080+ are reserved-ignorable, so in).
    for (const cp of [0x00ac, 0x00ae, 0x0350, 0x1820, 0x2070, 0xfe10, 0xfffc]) {
      expect(isInvisibleCodePoint(String.fromCodePoint(cp)), cp.toString(16)).toBe(false)
    }
  })

  it('reads ONE code point: a longer string never matches', () => {
    expect(isInvisibleCodePoint('️️')).toBe(false)
    expect(isInvisibleCodePoint('')).toBe(false)
  })
})
