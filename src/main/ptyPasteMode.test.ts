import { describe, it, expect } from 'vitest'
import { createPasteModeTracker } from './ptyPasteMode'

const ON = '\x1b[?2004h'
const OFF = '\x1b[?2004l'

describe('createPasteModeTracker (DECSET 2004 — the dispatch paste-framing probe)', () => {
  it('an unseen id reports false (conservative default = raw writes)', () => {
    const t = createPasteModeTracker()
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('toggles on at ?2004h and off at ?2004l', () => {
    const t = createPasteModeTracker()
    t.observe('t1', `boot noise ${ON} prompt`)
    expect(t.isEnabled('t1')).toBe(true)
    t.observe('t1', `bye ${OFF}`)
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('the LAST toggle in a chunk wins (a TUI restoring then re-arming in one repaint)', () => {
    const t = createPasteModeTracker()
    t.observe('t1', `${ON}${OFF}${ON}`)
    expect(t.isEnabled('t1')).toBe(true)
    t.observe('t1', `${ON}${OFF}`)
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('matches a sequence split across output chunks (carry) — every split point', () => {
    // The real onData chunking can cut the 8-byte sequence anywhere, incl. after the bare ESC.
    for (let cut = 1; cut < ON.length; cut++) {
      const t = createPasteModeTracker()
      t.observe('t1', `head ${ON.slice(0, cut)}`)
      expect(t.isEnabled('t1')).toBe(false) // incomplete — must not fire early
      t.observe('t1', `${ON.slice(cut)} tail`)
      expect(t.isEnabled('t1')).toBe(true)
    }
  })

  it('matches a combined private-mode param list (\\x1b[?1049;2004h)', () => {
    const t = createPasteModeTracker()
    t.observe('t1', '\x1b[?1049;2004h')
    expect(t.isEnabled('t1')).toBe(true)
    t.observe('t1', '\x1b[?2004;25l')
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('ignores non-2004 private modes and a partial-param overlap (?12004h / ?20045h)', () => {
    const t = createPasteModeTracker()
    t.observe('t1', '\x1b[?25h\x1b[?1049h')
    expect(t.isEnabled('t1')).toBe(false)
    t.observe('t1', '\x1b[?12004h\x1b[?20045h') // params 12004/20045 ≠ 2004
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('ignores literal "2004" text without a control sequence', () => {
    const t = createPasteModeTracker()
    t.observe('t1', 'the year 2004 happened; [?2004h without ESC is just text')
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('tracks board ids independently', () => {
    const t = createPasteModeTracker()
    t.observe('a', ON)
    t.observe('b', 'plain shell output')
    expect(t.isEnabled('a')).toBe(true)
    expect(t.isEnabled('b')).toBe(false)
  })

  it('drop() forgets the state (respawn/adopt reset) and re-arms on the next toggle', () => {
    const t = createPasteModeTracker()
    t.observe('t1', ON)
    t.drop('t1')
    expect(t.isEnabled('t1')).toBe(false)
    t.observe('t1', ON)
    expect(t.isEnabled('t1')).toBe(true)
  })

  it('a stale carried toggle is idempotent — re-scanning the tail never flips state forward', () => {
    const t = createPasteModeTracker()
    t.observe('t1', ON) // whole sequence fits the carry tail
    t.observe('t1', 'x') // rescans carry+chunk → re-applies h (same state)
    expect(t.isEnabled('t1')).toBe(true)
    t.observe('t1', OFF)
    t.observe('t1', 'y')
    expect(t.isEnabled('t1')).toBe(false)
  })

  it('survives large chunks with the toggle buried mid-stream', () => {
    const t = createPasteModeTracker()
    t.observe('t1', `${'x'.repeat(5000)}${ON}${'y'.repeat(5000)}`)
    expect(t.isEnabled('t1')).toBe(true)
  })
})
