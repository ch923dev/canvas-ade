import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBudgetStore, dayKey, DEFAULT_MAX_CALLS_PER_DAY } from './llmBudget'

describe('llmBudget', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llmbudget-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // A fixed clock the test can advance.
  function clockAt(iso: string): () => Date {
    return () => new Date(iso)
  }

  it('has a sane default cap', () => {
    expect(DEFAULT_MAX_CALLS_PER_DAY).toBeGreaterThan(0)
  })

  it('dayKey is the local YYYY-MM-DD', () => {
    expect(dayKey(new Date(2026, 5, 3, 14, 0, 0))).toBe('2026-06-03')
  })

  it('consumes calls up to the cap, then blocks', () => {
    const b = createBudgetStore(dir, clockAt('2026-06-03T10:00:00'))
    expect(b.tryConsume(2)).toBe(true)
    expect(b.tryConsume(2)).toBe(true)
    expect(b.tryConsume(2)).toBe(false) // cap hit
    expect(b.peek().calls).toBe(2) // a blocked call does NOT increment
  })

  it('a cap of 0 blocks immediately', () => {
    const b = createBudgetStore(dir, clockAt('2026-06-03T10:00:00'))
    expect(b.tryConsume(0)).toBe(false)
    expect(b.peek().calls).toBe(0)
  })

  it('persists the counter across store instances on the same day', () => {
    const c = clockAt('2026-06-03T10:00:00')
    createBudgetStore(dir, c).tryConsume(5)
    const b2 = createBudgetStore(dir, c)
    expect(b2.peek().calls).toBe(1)
    expect(b2.tryConsume(5)).toBe(true)
    expect(b2.peek().calls).toBe(2)
  })

  it('resets on a new calendar day', () => {
    createBudgetStore(dir, clockAt('2026-06-03T23:59:00')).tryConsume(1) // day full at cap 1
    const next = createBudgetStore(dir, clockAt('2026-06-04T00:01:00'))
    expect(next.peek().calls).toBe(0) // new day → reset
    expect(next.tryConsume(1)).toBe(true)
  })

  it('treats a missing or corrupt counter file as zero', () => {
    const b = createBudgetStore(dir, clockAt('2026-06-03T10:00:00'))
    expect(b.peek().calls).toBe(0) // missing
    rmSync(join(dir, 'llm-budget.json'), { force: true })
    // write garbage
    writeFileSync(join(dir, 'llm-budget.json'), '{not json', 'utf8')
    expect(b.peek().calls).toBe(0) // corrupt → zero
  })

  it('writes llm-budget.json into the given dir only', () => {
    createBudgetStore(dir, clockAt('2026-06-03T10:00:00')).tryConsume(5)
    expect(existsSync(join(dir, 'llm-budget.json'))).toBe(true)
    const raw = readFileSync(join(dir, 'llm-budget.json'), 'utf8')
    expect(raw).not.toMatch(/api[_-]?key/i) // never key material
    expect(JSON.parse(raw)).toMatchObject({ day: '2026-06-03', calls: 1 })
  })
})
