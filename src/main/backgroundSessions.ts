/**
 * C1 — background-project session wiring, extracted from index.ts (which sits at the max-lines
 * ratchet; same reason mcpBoot.ts / voiceBoot.ts exist). Owns the configured `projectSessions`
 * registry (every dep is a plain module import, so it moves here wholesale) plus the idle-TTL
 * sweep. index.ts imports the singleton + arms/disarms the sweep at the app-lifecycle points.
 *
 * The budget knobs are read through GETTERS so Low-RAM mode (a later PR) can tighten them live
 * without rebuilding the registry; the values here are the full-RAM defaults.
 *
 * Busy-aware eviction (2026-07-16): the sweep now (1) refreshes the CPU busy-probe over every
 * resident's session process trees, (2) runs the two-strike reap (warn → grace → close), and
 * (3) surfaces every warning/auto-close to the user — a renderer push on `project:bgLifecycle`
 * (toast) plus an OS notification (the user is, by definition, focused elsewhere when a
 * background project is at stake). The old sweep killed working agents on wall-clock alone and
 * told nobody but the console.
 */
import { app, Notification, type BrowserWindow } from 'electron'
import { basename, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createProjectSessions, type ProjectSessions } from './projectSessions'
import {
  parkProjectSessions,
  disposeProjectPtys,
  countProjectSessions,
  reapUndoParks,
  persistBackgroundRingTails,
  projectActivityAt,
  projectSessionPids
} from './pty'
import { appendTerminalSnapshot } from './terminalSnapshot'
import { createBusyProbe } from './bgBusyProbe'
import {
  backgroundProjectOsr,
  foregroundProjectOsr,
  disposeProjectOsr,
  countProjectOsr,
  trimOsrToBudget
} from './previewOsrBackground'
import { GLOBAL_OSR_MAX } from './previewOsr'
import { getCurrentDir } from './projectStore'
import { isLowRam } from './lowRamConfig'

// Keep at most MAX_BACKGROUND projects resident (PTYs parked + OSR frozen); backgrounding past it
// auto-closes the longest-backgrounded IDLE resident (working ones defer — see projectSessions).
// The idle TTL reaps a resident with no switch-back AND no PTY activity this long — activity
// resets the clock, so 30 min (was 10) only ever hits genuinely-abandoned residents. Low-RAM
// (AUDIT §5) keeps the original 10:4 proportion: cap 3→1, TTL 30→12 min.
const MAX_BACKGROUND = 3
const LOW_RAM_MAX_BACKGROUND = 1
const BG_IDLE_TTL_MS = 30 * 60_000
const LOW_RAM_BG_IDLE_TTL_MS = 12 * 60_000
const BG_SWEEP_INTERVAL_MS = 60_000
/** Two-strike grace: an idle resident is WARNED first (toast + OS notification), closed only if
 *  still idle this much later — the net for zero-CPU waits the busy probe can't see. */
const BG_REAP_GRACE_MS = 2 * BG_SWEEP_INTERVAL_MS
// H4: the TOTAL offscreen-renderer budget enforced on every project switch/foreground (C1 caps
// background PROJECTS; this caps resident RENDERERS — the many-Browser-boards-in-one-resident case
// C1 can't see). Full-RAM = the existence ceiling (a no-op — no reload churn for power users);
// Low-RAM lowers it to 3 so the 8 frozen ~150 MB renderers shed on switch (coupled to MAX_BACKGROUND).
const OSR_TRIM_BUDGET = GLOBAL_OSR_MAX
const LOW_RAM_OSR_TRIM_BUDGET = 3

// Phase 4: the persisted forever-keep list (the dialog's opt-in checkbox) — app/machine preference
// in userData, NEVER the project folder. Read lazily by the registry (first policy access is
// post-ready); a missing/corrupt file reads as [].
const foreverKeepFile = (): string => join(app.getPath('userData'), 'background-keep.json')

// Busy-aware eviction: one probe for the app run — per-dir CPU-delta verdicts, refreshed at the
// top of every sweep over the residents' session-root process trees.
const busyProbe = createBusyProbe()

export const projectSessions: ProjectSessions = createProjectSessions({
  reapUndoParks,
  parkPtys: parkProjectSessions,
  disposePtys: disposeProjectPtys,
  countPtys: countProjectSessions,
  backgroundOsr: backgroundProjectOsr,
  // H4: foreground the incoming project's windows, THEN trim resident background renderers to the
  // budget. On a switch the outgoing project is already backgrounded (backgroundLiveResources runs
  // before project:open), so this sheds its excess frozen renderers at the switch — not only when
  // the next Browser board somewhere triggers ensureOsr. Foreground/active windows are never evicted.
  foregroundOsr: (dir) => {
    const n = foregroundProjectOsr(dir)
    trimOsrToBudget(isLowRam() ? LOW_RAM_OSR_TRIM_BUDGET : OSR_TRIM_BUDGET)
    return n
  },
  disposeOsr: disposeProjectOsr,
  countOsr: countProjectOsr,
  now: () => Date.now(),
  // Low-RAM getters: read fresh so the mode (decided once at boot) is honoured without a rebuild.
  maxBackground: () => (isLowRam() ? LOW_RAM_MAX_BACKGROUND : MAX_BACKGROUND),
  idleTtlMs: () => (isLowRam() ? LOW_RAM_BG_IDLE_TTL_MS : BG_IDLE_TTL_MS),
  // C1 data-loss fix: flush a closing background project's parked ring tails to their snapshot
  // sidecar BEFORE its PTYs are disposed (disposeProjectPtys does not; the renderer flush covers
  // only the ACTIVE project's xterms).
  persistRingTails: (dir) => persistBackgroundRingTails(appendTerminalSnapshot, dir),
  loadForeverKeeps: () => {
    const parsed: unknown = JSON.parse(readFileSync(foreverKeepFile(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : []
  },
  saveForeverKeeps: (dirs) => writeFileSync(foreverKeepFile(), JSON.stringify(dirs), 'utf8'),
  // Busy-aware eviction: output recency from the PTY plane, CPU verdicts from the probe.
  activityAt: (dir) => projectActivityAt(dir),
  isBusy: (dir) => busyProbe.isBusy(dir),
  graceMs: () => BG_REAP_GRACE_MS
})

let sweepTimer: ReturnType<typeof setInterval> | null = null
let sweeping = false

/** The user-facing lifecycle kinds the sweep pushes on `project:bgLifecycle`. */
type BgLifecycleKind = 'warned' | 'closed' | 'evicted'

const BG_NOTIFY_COPY: Record<BgLifecycleKind, (name: string) => { title: string; body: string }> = {
  warned: (name) => ({
    title: 'Background project idle',
    body: `${name} has been idle — closing in ~2 min. Switch back to keep it running.`
  }),
  closed: (name) => ({
    title: 'Background project closed',
    body: `${name} was closed after staying idle in the background.`
  }),
  evicted: (name) => ({
    title: 'Background project closed',
    body: `${name} was closed to free memory.`
  })
}

// Surface one sweep outcome: renderer toast push + OS notification. OS layer muted under the
// headless harnesses (mirrors lifecycleNotifications.isHeadlessHarness) so e2e/smoke never pops
// a real desktop notification; the renderer push still fires (asserted by specs via the toast).
function notifyBg(
  getWin: (() => BrowserWindow | null) | undefined,
  kind: BgLifecycleKind,
  dir: string
): void {
  const name = basename(dir)
  const win = getWin?.()
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('project:bgLifecycle', { kind, dir, name })
  }
  if (process.env.CANVAS_E2E || process.env.CANVAS_SMOKE) return
  try {
    if (Notification.isSupported()) {
      const { title, body } = BG_NOTIFY_COPY[kind](name)
      new Notification({ title, body }).show()
    }
  } catch {
    /* best-effort — a notification failure must never break the sweep */
  }
}

/** One sweep tick: refresh the busy probe over every resident's process trees, then run the
 *  two-strike reap + deferred cap retry, then surface every warning/close to the user. */
async function runSweep(getWin?: () => BrowserWindow | null): Promise<void> {
  const residents = projectSessions.listBackgroundProjects()
  if (residents.length === 0) return
  const roots = new Map(residents.map((r) => [r.dir, projectSessionPids(r.dir)]))
  await busyProbe.update(roots) // swallows sampler failures internally (keeps prior verdicts)
  const active = getCurrentDir()
  const { closed, warned, capEvicted } = await projectSessions.reapIdle(active ? [active] : [])
  for (const w of warned) notifyBg(getWin, 'warned', w.dir)
  for (const dir of closed) notifyBg(getWin, 'closed', dir)
  for (const dir of capEvicted) notifyBg(getWin, 'evicted', dir)
  if (closed.length || capEvicted.length) {
    console.info(`[bg-sessions] auto-closed ${closed.length + capEvicted.length} project(s)`)
  }
}

/**
 * Arm the idle-TTL sweep: reap residents idle past BG_IDLE_TTL_MS via the SCOPED close (ring-tail
 * flush → dispose), protecting the ACTIVE project, working residents (busy probe + output
 * recency), and ∞ forever-keeps. `getWin` feeds the warning/close toasts. `unref()` so it never
 * holds the app open; idempotent. The switch-back re-spawn window (a resident reaped just as the
 * user returns) is a safe re-spawn — its output was already flushed. Call once in whenReady
 * (skip under the smoke).
 */
export function startBackgroundIdleSweep(getWin?: () => BrowserWindow | null): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    if (sweeping) return // a slow process-table sample must never stack sweep ticks
    sweeping = true
    void runSweep(getWin)
      .catch(() => undefined)
      .finally(() => {
        sweeping = false
      })
  }, BG_SWEEP_INTERVAL_MS)
  sweepTimer.unref()
}

/** Stop the sweep so it can't fire after teardown (shutdown). Idempotent. */
export function stopBackgroundIdleSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer)
  sweepTimer = null
}
