import { describe, it, expect } from 'vitest'
import { hhmm, relAge, spanLabel, baseName } from './recapFormat'

describe('recapFormat', () => {
  it('hhmm formats epoch ms as local HH:MM and degrades on zero', () => {
    const ts = new Date(2026, 5, 13, 4, 7).getTime() // local 04:07
    expect(hhmm(ts)).toBe('04:07')
    expect(hhmm(0)).toBe('--:--')
  })

  it('relAge buckets seconds / minutes / hours', () => {
    expect(relAge(2_000)).toBe('just now')
    expect(relAge(8_000)).toBe('8s ago')
    expect(relAge(3 * 60_000)).toBe('3m ago')
    expect(relAge(2 * 3_600_000)).toBe('2h ago')
    expect(relAge(-5_000)).toBe('just now') // clamped, never negative
  })

  it('spanLabel renders compact durations', () => {
    expect(spanLabel(40_000)).toBe('40s')
    expect(spanLabel(47 * 60_000)).toBe('47m')
    expect(spanLabel(125 * 60_000)).toBe('2h 05m')
    expect(spanLabel(120 * 60_000)).toBe('2h')
  })

  it('baseName takes the last segment across both separators', () => {
    expect(baseName('Z:\\repo\\src\\CLAUDE.md')).toBe('CLAUDE.md')
    expect(baseName('/home/u/x/file.ts')).toBe('file.ts')
    expect(baseName('plain.txt')).toBe('plain.txt')
    expect(baseName('')).toBe('')
  })
})
