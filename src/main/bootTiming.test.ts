import { describe, it, expect, vi } from 'vitest'
import { createBootTiming, flushBootTiming, type BootTimingClock } from './bootTiming'

/**
 * Audit R8's gate is "boot-to-first-paint measured before/after", and before this module the boot
 * path carried no instrument at all (Phase 0's R1 marks measure a project SWITCH). These cases pin
 * the two properties the measurement depends on: marks are relative to PROCESS CREATION (not to
 * module load, which would silently drop Chromium's start-up), and the JSONL sink is opt-in so a
 * production-flavored capture never has to flip a behavior gate to record itself.
 */
describe('createBootTiming', () => {
  const clockAt = (creation: number | null, times: number[]): BootTimingClock => {
    let i = 0
    return { creationTime: () => creation, now: () => times[Math.min(i++, times.length - 1)] }
  }

  it('measures each mark from the PROCESS-CREATION anchor, not from module load', () => {
    // Process created at 1000; our JS does not run until 1250. A module-load anchor would report
    // moduleLoad=0 and hide the 250 ms of Chromium start-up that a boot measurement is about.
    const t = createBootTiming(clockAt(1000, [1250, 1400, 1900]))
    t.mark('moduleLoad')
    t.mark('whenReady')
    t.mark('readyToShow')
    expect(t.report().marks).toEqual([
      { name: 'moduleLoad', ms: 250 },
      { name: 'whenReady', ms: 400 },
      { name: 'readyToShow', ms: 900 }
    ])
    expect(t.report().notes.anchor).toBe('process-creation')
  })

  it('falls back to module load when getCreationTime() is unavailable, and SAYS so', () => {
    // First now() is consumed by the anchor fallback itself, so the timeline starts at 500.
    const t = createBootTiming(clockAt(null, [500, 500, 700]))
    t.mark('moduleLoad')
    t.mark('readyToShow')
    // Internally comparable (0 → 200), but the anchor note is what stops someone comparing a
    // module-load run against a process-creation one and reading the difference as a win.
    expect(t.report().marks).toEqual([
      { name: 'moduleLoad', ms: 0 },
      { name: 'readyToShow', ms: 200 }
    ])
    expect(t.report().notes.anchor).toBe('module-load')
  })

  it('carries per-run notes (which is how a run records whether the R8 gate opened)', () => {
    const t = createBootTiming(clockAt(0, [0]))
    t.note('localServer', 'skipped')
    t.note('packaged', true)
    expect(t.report().notes).toMatchObject({ localServer: 'skipped', packaged: true })
  })

  it('formats the timeline as one line', () => {
    const t = createBootTiming(clockAt(0, [10, 25]))
    t.mark('whenReady')
    t.mark('readyToShow')
    expect(t.format()).toBe('whenReady=10 readyToShow=25')
  })
})

describe('flushBootTiming', () => {
  it('writes NOTHING to the JSONL sink unless CANVAS_BOOT_TIMING opted in', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const appendFile = vi.fn()
    const t = createBootTiming({ creationTime: () => 0, now: () => 5 })
    t.mark('readyToShow')
    flushBootTiming(t, { userDataDir: 'C:\\ud', enabled: false, appendFile })
    expect(appendFile).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[boot] readyToShow=5') // the stdout line is unconditional
    log.mockRestore()
  })

  it('appends one JSON record per boot when enabled', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const appendFile = vi.fn()
    const t = createBootTiming({ creationTime: () => 0, now: () => 5 })
    t.mark('readyToShow')
    t.note('localServer', 'skipped')
    flushBootTiming(t, { userDataDir: 'C:\\ud', enabled: true, appendFile })
    expect(appendFile).toHaveBeenCalledTimes(1)
    const [file, line] = appendFile.mock.calls[0]
    expect(String(file).endsWith('boot-timing.jsonl')).toBe(true)
    expect(line).toMatch(/\n$/) // JSONL: one record per line
    const parsed = JSON.parse(String(line))
    expect(parsed.marks).toEqual([{ name: 'readyToShow', ms: 5 }])
    expect(parsed.notes.localServer).toBe('skipped')
    log.mockRestore()
  })

  it('never lets a sink failure escape into the boot path', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const t = createBootTiming({ creationTime: () => 0, now: () => 1 })
    expect(() =>
      flushBootTiming(t, {
        userDataDir: 'C:\\ud',
        enabled: true,
        appendFile: () => {
          throw new Error('ENOSPC')
        }
      })
    ).not.toThrow()
    log.mockRestore()
  })
})
