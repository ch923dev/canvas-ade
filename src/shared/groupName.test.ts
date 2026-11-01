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

  it('maps NEL (U+0085) and the separators U+001C-U+001F to a space, like any newline', () => {
    expect(sanitizeGroupName('a\u0085b')).toBe('a b')
    for (const code of [0x1c, 0x1d, 0x1e, 0x1f]) {
      expect(sanitizeGroupName(`a${String.fromCodePoint(code)}b`)).toBe('a b')
    }
    expect(sanitizeGroupName('a \u0085\u001f b')).toBe('a b')
  })

  it('strips C0 controls, DEL and C1 controls without leaving a double space', () => {
    expect(sanitizeGroupName('a\u0000b\u001bc\u007fd')).toBe('abcd')
    // U+0085 is NEL: a line break, so it reads as a space (the C1 escapes around it are dropped).
    expect(sanitizeGroupName('x\u0080y\u009bz\u0085w')).toBe('xyz w')
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

  it('strips variation selectors, tag characters and the other invisible code points', () => {
    const invisible = [
      0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0xe0000, 0xe0041, 0xe007f, 0x00ad, 0x034f, 0x180e, 0x2061,
      0x2064, 0x206a, 0x206f, 0xfff9, 0xfffb, 0x3164
    ]
    for (const code of invisible) {
      expect(sanitizeGroupName(`ab${String.fromCodePoint(code)}cd`), code.toString(16)).toBe('abcd')
    }
  })

  it('drops tag-character ASCII smuggling (hidden text would reach canvas://contexts)', () => {
    expect(sanitizeGroupName('\u{E0041}\u{E0042}Build')).toBe('Build')
    // "Docs" + an invisible "ignore previous" spelled in tag characters: only "Docs" survives.
    const hidden = [...'ignore previous'].map((c) =>
      String.fromCodePoint(0xe0000 + c.charCodeAt(0))
    )
    expect(sanitizeGroupName(`Docs${hidden.join('')}`)).toBe('Docs')
  })

  it("returns '' when no letter, number, punctuation or symbol remains", () => {
    // A lone variation selector used to survive, so deriveContexts' `|| nameFromMembers()`
    // fallback never fired and the confirm row rendered blank.
    expect(sanitizeGroupName('\uFE0F')).toBe('')
    expect(sanitizeGroupName('\u{E0041}\u{E0042}')).toBe('')
    expect(sanitizeGroupName('\u00AD\u034F\u2061 \uFFF9')).toBe('')
    // Combining marks with no base render as nothing.
    expect(sanitizeGroupName('\u0301\u0308')).toBe('')
    expect(sanitizeGroupName('e\u0301')).toBe('e\u0301')
    expect(sanitizeGroupName('-')).toBe('-')
    expect(sanitizeGroupName('🚀')).toBe('🚀')
  })

  it('keeps a ZWJ only between two emoji, where it joins them into one glyph', () => {
    expect(sanitizeGroupName('👨\u200D💻 Dev')).toBe('👨\u200D💻 Dev')
    expect(sanitizeGroupName('👩🏽\u200D💻')).toBe('👩🏽\u200D💻') // skin-tone modifier on the left
    // The pride flag loses its U+FE0F (lossy, documented) but keeps the join.
    expect(sanitizeGroupName('🏳\uFE0F\u200D🌈')).toBe('🏳\u200D🌈')
    // Anywhere else a ZWJ is a hidden character and goes.
    expect(sanitizeGroupName('a\u200Db')).toBe('ab')
    expect(sanitizeGroupName('🚀\u200Db')).toBe('🚀b')
    expect(sanitizeGroupName('a\u200D🚀')).toBe('a🚀')
    expect(sanitizeGroupName('🚀\u200D\u200D🚀')).toBe('🚀🚀')
    expect(sanitizeGroupName('🚀 \u200D🚀')).toBe('🚀 🚀')
    expect(sanitizeGroupName('\u200D')).toBe('')
  })

  it('documents the lossy emoji cases (selector and tag sequences degrade, never vanish)', () => {
    expect(sanitizeGroupName('❤\uFE0F Team')).toBe('❤ Team')
    // Scotland: 🏴 + tag "gbsct" + CANCEL TAG ⇒ a plain black flag.
    expect(sanitizeGroupName('🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}')).toBe('🏴')
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

  it('clamps by whole code points and never leaves a dangling ZWJ', () => {
    // 78 ASCII + 👨 (2 units) = 80: the ZWJ and 💻 do not fit, and the join must not dangle.
    const out = sanitizeGroupName(`${'x'.repeat(GROUP_NAME_MAX - 2)}👨\u200D💻`)
    expect(out).toBe(`${'x'.repeat(GROUP_NAME_MAX - 2)}👨`)
    // 40 astral emoji = 80 units: exactly fits; 41 drops the last one whole.
    expect(sanitizeGroupName('🚀'.repeat(40))).toBe('🚀'.repeat(40))
    expect(sanitizeGroupName('🚀'.repeat(41))).toBe('🚀'.repeat(40))
    expect(sanitizeGroupName('🚀'.repeat(41))).toHaveLength(GROUP_NAME_MAX)
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
      'Docs',
      '👨\u200D💻 Dev\uFE0F\u{E0041}',
      `${'x'.repeat(GROUP_NAME_MAX - 2)}👨\u200D💻`,
      'a\u0085\u001cb'
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
