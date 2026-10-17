/**
 * The shared group-name sanitizer (C7). MAIN's group tools and C3's suggested names both run every
 * name through it, so this suite pins each strip class and the clamp boundary.
 */
import { describe, expect, it } from 'vitest'
import { GROUP_NAME_MAX, sanitizeGroupName } from './groupName'

describe('sanitizeGroupName', () => {
  it('keeps a plain name as-is', () => {
    expect(sanitizeGroupName('Auth flow')).toBe('Auth flow')
    expect(sanitizeGroupName('Café · données 🚀')).toBe('Café · données 🚀')
  })

  it('collapses every whitespace run (tab, newline, NBSP, LS/PS) to one space and trims', () => {
    expect(sanitizeGroupName('  Auth \t\t flow \n')).toBe('Auth flow')
    expect(sanitizeGroupName('a\r\nb')).toBe('a b')
    expect(sanitizeGroupName('a  b c d　e')).toBe('a b c d e')
  })

  it('strips C0 controls, DEL and C1 controls without leaving a double space', () => {
    expect(sanitizeGroupName('a\u0000b\u001bc\u007fd')).toBe('abcd')
    expect(sanitizeGroupName('x\u0080y\u009bz\u0085w')).toBe('xyzw')
    expect(sanitizeGroupName('a \u0007 b')).toBe('a b')
    expect(sanitizeGroupName('\u001b[31mred')).toBe('[31mred')
  })

  it('strips every bidi control (embeddings, overrides, isolates, marks, ALM)', () => {
    const bidi = [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c
    ]
    for (const code of bidi) {
      expect(sanitizeGroupName(`ab${String.fromCodePoint(code)}cd`)).toBe('abcd')
    }
    // The Trojan Source shape: an RLO that would visually reverse the tail of the label.
    expect(sanitizeGroupName('safe‮exe.txt')).toBe('safeexe.txt')
  })

  it('strips zero-width characters (ZWSP, ZWNJ, ZWJ, word joiner, BOM)', () => {
    for (const code of [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]) {
      expect(sanitizeGroupName(`ab${String.fromCodePoint(code)}cd`)).toBe('abcd')
    }
    expect(sanitizeGroupName('﻿Docs')).toBe('Docs')
  })

  it(`clamps to GROUP_NAME_MAX (${GROUP_NAME_MAX}) code units`, () => {
    expect(GROUP_NAME_MAX).toBe(80)
    expect(sanitizeGroupName('x'.repeat(200))).toBe('x'.repeat(GROUP_NAME_MAX))
    expect(sanitizeGroupName('x'.repeat(GROUP_NAME_MAX))).toHaveLength(GROUP_NAME_MAX)
  })

  it('never splits a surrogate pair at the clamp boundary', () => {
    // 79 ASCII + one astral char (2 code units) = 81 units: the emoji must go whole, not halved.
    const out = sanitizeGroupName(`${'x'.repeat(GROUP_NAME_MAX - 1)}🚀tail`)
    expect(out).toBe('x'.repeat(GROUP_NAME_MAX - 1))
    // 78 ASCII + emoji = exactly 80 units: it fits and stays whole.
    const fits = sanitizeGroupName(`${'x'.repeat(GROUP_NAME_MAX - 2)}🚀tail`)
    expect(fits).toBe(`${'x'.repeat(GROUP_NAME_MAX - 2)}🚀`)
    expect(fits).toHaveLength(GROUP_NAME_MAX)
  })

  it('drops a trailing space the clamp exposes', () => {
    expect(sanitizeGroupName(`${'x'.repeat(GROUP_NAME_MAX - 1)} yz`)).toBe(
      'x'.repeat(GROUP_NAME_MAX - 1)
    )
  })

  it('drops lone surrogates so the output is always well-formed', () => {
    expect(sanitizeGroupName('a\ud800b\udc00c')).toBe('abc')
    expect(sanitizeGroupName('a🚀b')).toBe('a🚀b')
  })

  it("returns '' when nothing usable remains (callers pick the fallback)", () => {
    expect(sanitizeGroupName('')).toBe('')
    expect(sanitizeGroupName('   \n\t ')).toBe('')
    expect(sanitizeGroupName('‮​\u0000﻿')).toBe('')
    expect(sanitizeGroupName(undefined as unknown as string)).toBe('')
    expect(sanitizeGroupName(42 as unknown as string)).toBe('')
  })

  it('is idempotent', () => {
    const samples = [
      '  Auth \n flow ',
      'a‮b​c',
      `${'x'.repeat(GROUP_NAME_MAX - 1)}🚀`,
      'a \u0007 b',
      'Docs'
    ]
    for (const s of samples) {
      const once = sanitizeGroupName(s)
      expect(sanitizeGroupName(once)).toBe(once)
    }
  })

  it("matches today's spawn_group rule on ordinary names (collapse, trim, clamp)", () => {
    const legacy = (raw: string): string => raw.replace(/\s+/g, ' ').trim().slice(0, 80)
    for (const raw of [
      'Auth flow',
      '  Billing\n\n webhooks ',
      'y'.repeat(120),
      'Front end / web'
    ]) {
      expect(sanitizeGroupName(raw)).toBe(legacy(raw))
    }
  })
})
