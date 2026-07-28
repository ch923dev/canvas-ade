/**
 * Boot instrumentation (audit R8's gate half). Phase 0's R1 marks measure a project SWITCH; the
 * boot path had no instrument at all, so "boot-to-first-paint measured before/after" had nothing
 * to read. This is that instrument: a handful of named marks on the critical path from process
 * creation to the first shown frame.
 *
 * Deliberately electron-free and dependency-free so it unit-tests without an app, and so importing
 * it at the very top of index.ts costs nothing. The caller supplies the epoch anchor (Electron's
 * `process.getCreationTime()`), because that is the only value that sees the time Chromium spent
 * before our JS ran — anchoring on module load would silently exclude it.
 *
 * ALWAYS collected (a few Date.now() calls), NEVER written unless asked: the JSONL sink is opt-in
 * via CANVAS_BOOT_TIMING=1. That matters for the measurement it exists to serve — every automated
 * harness flavor (CANVAS_E2E / CANVAS_SMOKE) keeps the fixture server running by design, so the
 * R8 before/after can only be taken from an UNFLAVORED packaged launch. A diagnostic that had to
 * change a behavior gate to record itself would not be measuring the shipped configuration.
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BootMark {
  /** Mark name, in the order it was recorded. */
  name: string
  /** Milliseconds since the process-creation anchor. */
  ms: number
}

export interface BootTimingReport {
  marks: BootMark[]
  /** Free-form facts about the run being measured (build flavor, whether the gate opened, …). */
  notes: Record<string, string | number | boolean>
}

/** Injected clock/anchor so the unit tests are not at the mercy of real time. */
export interface BootTimingClock {
  /** Epoch ms the OS created this process (Electron `process.getCreationTime()`), or null. */
  creationTime: () => number | null
  now: () => number
}

const defaultClock: BootTimingClock = {
  creationTime: () => {
    const p = process as NodeJS.Process & { getCreationTime?: () => number | null }
    try {
      return typeof p.getCreationTime === 'function' ? p.getCreationTime() : null
    } catch {
      return null
    }
  },
  now: () => Date.now()
}

export interface BootTiming {
  /** Record a milestone; `notes` folds in facts about the run at the same site. */
  mark: (name: string, notes?: Record<string, string | number | boolean>) => void
  note: (key: string, value: string | number | boolean) => void
  report: () => BootTimingReport
  /** `name=ms` pairs, the one-line form written to stdout / the JSONL sink. */
  format: () => string
}

export function createBootTiming(clock: BootTimingClock = defaultClock): BootTiming {
  // `getCreationTime()` can return null (unsupported platform / restricted process). Falling back
  // to "now" makes every later mark relative to module load instead — still internally comparable,
  // and the report says which anchor it used so two runs are never compared across anchors.
  const created = clock.creationTime()
  const t0 = created ?? clock.now()
  const marks: BootMark[] = []
  const notes: Record<string, string | number | boolean> = {
    anchor: created === null ? 'module-load' : 'process-creation'
  }
  return {
    mark(name, extraNotes) {
      marks.push({ name, ms: Math.round((clock.now() - t0) * 10) / 10 })
      if (extraNotes) Object.assign(notes, extraNotes)
    },
    note(key, value) {
      notes[key] = value
    },
    report: () => ({ marks: [...marks], notes: { ...notes } }),
    format: () => marks.map((m) => `${m.name}=${m.ms}`).join(' ')
  }
}

/** The app-wide instance. One boot, one timeline. */
export const bootTiming = createBootTiming()

/**
 * The `ready-to-show` site: mark the first painted frame and emit the timeline. One call so
 * index.ts (at its file-size pin) carries the milestone, not the plumbing.
 */
export function markFirstPaint(opts: { userDataDir: string; packaged: boolean }): void {
  bootTiming.mark('readyToShow', { packaged: opts.packaged })
  flushBootTiming(bootTiming, {
    userDataDir: opts.userDataDir,
    enabled: process.env.CANVAS_BOOT_TIMING === '1'
  })
}

/**
 * Emit the timeline once, at the first shown frame. Always logs one line (dev/e2e read it off
 * stdout); appends a JSONL record under userData only when CANVAS_BOOT_TIMING=1, which is how the
 * packaged before/after capture collects N runs without a console attached.
 *
 * Swallows every fs error: a diagnostic must never be able to fail a boot.
 */
export function flushBootTiming(
  timing: BootTiming,
  opts: { userDataDir: string; enabled: boolean; appendFile?: (file: string, line: string) => void }
): void {
  console.log(`[boot] ${timing.format()}`)
  if (!opts.enabled) return
  const report = timing.report()
  try {
    const append = opts.appendFile ?? ((file, line) => appendFileSync(file, line))
    append(
      join(opts.userDataDir, 'boot-timing.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...report }) + '\n'
    )
  } catch {
    /* diagnostics only — never take the boot down */
  }
}
