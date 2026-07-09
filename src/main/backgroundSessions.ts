/**
 * C1 — background-project session wiring, extracted from index.ts (which sits at the max-lines
 * ratchet; same reason mcpBoot.ts / voiceBoot.ts exist). Owns the configured `projectSessions`
 * registry (every dep is a plain module import, so it moves here wholesale) plus the idle-TTL
 * sweep. index.ts imports the singleton + arms/disarms the sweep at the app-lifecycle points.
 *
 * The budget knobs are read through GETTERS so Low-RAM mode (a later PR) can tighten them live
 * without rebuilding the registry; the values here are the full-RAM defaults.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createProjectSessions, type ProjectSessions } from './projectSessions'
import {
  parkProjectSessions,
  disposeProjectPtys,
  countProjectSessions,
  reapUndoParks,
  persistBackgroundRingTails
} from './pty'
import { appendTerminalSnapshot } from './terminalSnapshot'
import {
  backgroundProjectOsr,
  foregroundProjectOsr,
  disposeProjectOsr,
  countProjectOsr
} from './previewOsrBackground'
import { getCurrentDir } from './projectStore'

// Keep at most MAX_BACKGROUND projects resident (PTYs parked + OSR frozen); backgrounding past it
// auto-closes the longest-backgrounded. The idle TTL reaps a resident left untouched (never
// switched back to) this long. The sweep cadence is how often the TTL is checked.
const MAX_BACKGROUND = 3
const BG_IDLE_TTL_MS = 10 * 60_000
const BG_SWEEP_INTERVAL_MS = 60_000

// Phase 4: the persisted forever-keep list (the dialog's opt-in checkbox) — app/machine preference
// in userData, NEVER the project folder. Read lazily by the registry (first policy access is
// post-ready); a missing/corrupt file reads as [].
const foreverKeepFile = (): string => join(app.getPath('userData'), 'background-keep.json')

export const projectSessions: ProjectSessions = createProjectSessions({
  reapUndoParks,
  parkPtys: parkProjectSessions,
  disposePtys: disposeProjectPtys,
  countPtys: countProjectSessions,
  backgroundOsr: backgroundProjectOsr,
  foregroundOsr: foregroundProjectOsr,
  disposeOsr: disposeProjectOsr,
  countOsr: countProjectOsr,
  now: () => Date.now(),
  maxBackground: () => MAX_BACKGROUND,
  idleTtlMs: () => BG_IDLE_TTL_MS,
  // C1 data-loss fix: flush a closing background project's parked ring tails to their snapshot
  // sidecar BEFORE its PTYs are disposed (disposeProjectPtys does not; the renderer flush covers
  // only the ACTIVE project's xterms).
  persistRingTails: (dir) => persistBackgroundRingTails(appendTerminalSnapshot, dir),
  loadForeverKeeps: () => {
    const parsed: unknown = JSON.parse(readFileSync(foreverKeepFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []
  },
  saveForeverKeeps: (dirs) => writeFileSync(foreverKeepFile(), JSON.stringify(dirs), 'utf8')
})

let sweepTimer: ReturnType<typeof setInterval> | null = null

/**
 * Arm the idle-TTL sweep: reap residents idle past BG_IDLE_TTL_MS via the SCOPED close (ring-tail
 * flush → dispose), protecting the ACTIVE project. `unref()` so it never holds the app open;
 * idempotent. The switch-back re-spawn window (a resident reaped just as the user returns) is a
 * safe re-spawn — its output was already flushed. Call once in whenReady (skip under the smoke).
 */
export function startBackgroundIdleSweep(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const active = getCurrentDir()
    void projectSessions
      .reapIdle(active ? [active] : [])
      .then((closed) => {
        if (closed.length) console.info(`[bg-sessions] idle-reaped ${closed.length} project(s)`)
      })
      .catch(() => undefined)
  }, BG_SWEEP_INTERVAL_MS)
  sweepTimer.unref()
}

/** Stop the sweep so it can't fire after teardown (shutdown). Idempotent. */
export function stopBackgroundIdleSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}
