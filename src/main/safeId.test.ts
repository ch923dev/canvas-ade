import { describe, it, expect } from 'vitest'
import { isSafeId, SAFE_ID, MAX_ID_LEN } from './safeId'

describe('isSafeId (MCP-07 shared id-safety contract)', () => {
  it('accepts uuid/nanoid-style ids (letters, digits, _, -)', () => {
    expect(isSafeId('abc-123_XYZ')).toBe(true)
    expect(isSafeId('t1')).toBe(true)
    expect(isSafeId('V1StGXR8_Z5jdHi6B-myT')).toBe(true)
  })

  it('rejects a non-string, empty, or whitespace id', () => {
    expect(isSafeId(undefined)).toBe(false)
    expect(isSafeId(null)).toBe(false)
    expect(isSafeId(123)).toBe(false)
    expect(isSafeId('')).toBe(false)
    expect(isSafeId('board id with spaces')).toBe(false)
  })

  it('rejects path-traversal / separator characters (no escaping the memory dir)', () => {
    expect(isSafeId('../traversal')).toBe(false)
    expect(isSafeId('a/b')).toBe(false)
    expect(isSafeId('a\\b')).toBe(false)
    expect(isSafeId('a.b')).toBe(false)
  })

  it('rejects an over-long id at the MAX_ID_LEN boundary (BUG-019)', () => {
    expect(isSafeId('a'.repeat(MAX_ID_LEN))).toBe(true)
    expect(isSafeId('a'.repeat(MAX_ID_LEN + 1))).toBe(false)
  })

  it('exports the charset both memory modules share', () => {
    expect(SAFE_ID.test('abc-123_XYZ')).toBe(true)
    expect(SAFE_ID.test('a/b')).toBe(false)
  })
})
