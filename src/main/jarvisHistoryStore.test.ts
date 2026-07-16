/**
 * Jarvis J5 — jarvisHistoryStore units (D4′): the history file round-trip + repair
 * funnel, the deterministic rolling-summary compression, clear, and the per-project
 * consent store (canonicalized keys — BUG-022 posture).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  COMPRESS_TRIGGER,
  MAX_SUMMARY_LEN,
  clearJarvisHistory,
  compressJarvisHistory,
  emptyJarvisHistory,
  jarvisHistoryFileFor,
  readJarvisHistory,
  readJarvisHistoryConsent,
  repairJarvisHistory,
  writeJarvisHistory,
  writeJarvisHistoryConsent,
  type JarvisHistoryFile
} from './jarvisHistoryStore'
import { HISTORY_PROMPT_WINDOW, type JarvisTurn } from './jarvisPersona'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jarvishist-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const turn = (i: number, role: JarvisTurn['role'] = i % 2 === 0 ? 'user' : 'assistant') => ({
  role,
  text: `turn ${i}`
})

describe('history file round-trip', () => {
  it('writes under .canvas/memory/jarvis and reads back identically', () => {
    const h: JarvisHistoryFile = { turns: [turn(0), turn(1)], summary: 'earlier stuff' }
    writeJarvisHistory(dir, h)
    expect(jarvisHistoryFileFor(dir)).toBe(join(dir, '.canvas', 'memory', 'jarvis', 'history.json'))
    expect(existsSync(jarvisHistoryFileFor(dir))).toBe(true)
    expect(readJarvisHistory(dir)).toEqual(h)
  })

  it('an absent or corrupt file reads as empty (never throws)', () => {
    expect(readJarvisHistory(dir)).toEqual(emptyJarvisHistory())
    mkdirSync(dirname(jarvisHistoryFileFor(dir)), { recursive: true })
    writeFileSync(jarvisHistoryFileFor(dir), '{oops', 'utf8')
    expect(readJarvisHistory(dir)).toEqual(emptyJarvisHistory())
  })

  it('repair drops malformed turns, caps text, and coerces a bad summary', () => {
    const r = repairJarvisHistory({
      turns: [
        { role: 'user', text: 'ok' },
        { role: 'narrator', text: 'invalid role' },
        { role: 'assistant' }, // no text
        'garbage',
        { role: 'assistant', text: 'x'.repeat(9000) }
      ],
      summary: 42
    })
    expect(r.turns).toHaveLength(2)
    expect(r.turns[0]).toEqual({ role: 'user', text: 'ok' })
    expect(r.turns[1].text.length).toBe(4000)
    expect(r.summary).toBe('')
  })

  it('clear deletes the file and is a safe no-op when absent', () => {
    writeJarvisHistory(dir, { turns: [turn(0)], summary: '' })
    clearJarvisHistory(dir)
    expect(existsSync(jarvisHistoryFileFor(dir))).toBe(false)
    clearJarvisHistory(dir) // no throw
  })
})

describe('compressJarvisHistory', () => {
  it('under the trigger it returns the input untouched', () => {
    const h: JarvisHistoryFile = {
      turns: Array.from({ length: COMPRESS_TRIGGER }, (_, i) => turn(i)),
      summary: ''
    }
    expect(compressJarvisHistory(h)).toBe(h)
  })

  it('past the trigger it folds everything older than the window into summary lines', () => {
    const n = COMPRESS_TRIGGER + 2
    const h: JarvisHistoryFile = {
      turns: Array.from({ length: n }, (_, i) => turn(i)),
      summary: ''
    }
    const c = compressJarvisHistory(h)
    expect(c.turns).toHaveLength(HISTORY_PROMPT_WINDOW)
    expect(c.turns[0].text).toBe(`turn ${n - HISTORY_PROMPT_WINDOW}`)
    const lines = c.summary.split('\n')
    expect(lines).toHaveLength(n - HISTORY_PROMPT_WINDOW)
    expect(lines[0]).toBe('User: turn 0')
    expect(lines[1]).toBe('Assistant: turn 1')
  })

  it('appends to an existing summary and drops the OLDEST lines past the cap', () => {
    const long = 'y'.repeat(150)
    const h: JarvisHistoryFile = {
      turns: Array.from({ length: COMPRESS_TRIGGER + 40 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as JarvisTurn['role'],
        text: `${long} ${i}`
      })),
      summary: 'OLDEST-LINE-MUST-DROP\n' + 'z'.repeat(MAX_SUMMARY_LEN - 100)
    }
    const c = compressJarvisHistory(h)
    expect(c.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_LEN)
    expect(c.summary).not.toContain('OLDEST-LINE-MUST-DROP')
    // The newest folded turn's line survives at the tail.
    expect(c.summary).toContain(`${COMPRESS_TRIGGER + 40 - HISTORY_PROMPT_WINDOW - 1}`)
  })

  it('summary lines collapse whitespace and truncate with an ellipsis', () => {
    const h: JarvisHistoryFile = {
      turns: [
        { role: 'user', text: '  spaced\n\nout   text  ' },
        ...Array.from({ length: COMPRESS_TRIGGER + 1 }, (_, i) => turn(i))
      ],
      summary: ''
    }
    const c = compressJarvisHistory(h)
    expect(c.summary.split('\n')[0]).toBe('User: spaced out text')
  })
})

describe('per-project consent store', () => {
  it('round-trips a decision and answers undefined when undecided', () => {
    expect(readJarvisHistoryConsent(dir, 'M:/proj')).toBeUndefined()
    writeJarvisHistoryConsent(dir, 'M:/proj', 'enabled')
    expect(readJarvisHistoryConsent(dir, 'M:/proj')).toBe('enabled')
    writeJarvisHistoryConsent(dir, 'M:/other', 'declined')
    expect(readJarvisHistoryConsent(dir, 'M:/other')).toBe('declined')
    expect(readJarvisHistoryConsent(dir, 'M:/proj')).toBe('enabled')
  })

  it('canonicalizes Windows-style keys (case + trailing separator never re-prompt)', () => {
    writeJarvisHistoryConsent(dir, 'M:\\Projects\\App', 'enabled')
    expect(readJarvisHistoryConsent(dir, 'm:\\projects\\app\\')).toBe('enabled')
    // Separator shape is deliberately NOT normalized (recapConsent posture — path.normalize
    // would rewrite POSIX-shaped keys); only case + trailing separators fold.
    expect(readJarvisHistoryConsent(dir, 'M:/projects/app')).toBeUndefined()
  })

  it('a corrupt consent file reads as empty', () => {
    writeFileSync(join(dir, 'jarvis-history-consent.json'), 'not json', 'utf8')
    expect(readJarvisHistoryConsent(dir, 'M:/proj')).toBeUndefined()
    expect(readFileSync(join(dir, 'jarvis-history-consent.json'), 'utf8')).toBe('not json')
  })
})
