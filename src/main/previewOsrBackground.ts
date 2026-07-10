import {
  applyOsrPaint,
  disposeOsr,
  getOsrEntries,
  pickOsrEvictions,
  sweepPendingForProject,
  type OsrEntry
} from './previewOsr'

/**
 * Background project sessions (Phase 1 plumbing) — the project-scoped OSR operations.
 *
 * A project switch may KEEP a project's offscreen windows alive — frozen (stopPainting), muted,
 * and timer-throttled — instead of destroying them, so a switch-back resumes the SAME renderer
 * (in-page state intact: forms, SPA state, in-flight waits). These are the project-scoped
 * siblings of previewOsr's disposeAllOsr, driving its private maps through the narrow
 * getOsrEntries/disposeOsr/sweepPendingForProject surface (module split under the max-lines
 * ratchet, like previewOsrOwner). Nothing calls the background path until the Phase-2 switch
 * pipeline lands.
 */

/** Minimal window surface for the background/foreground transition (unit-testable — a real
 *  `BrowserWindow` satisfies it structurally; extends the applyOsrPaint target). */
interface OsrBackgroundTarget {
  webContents: {
    startPainting(): void
    stopPainting(): void
    invalidate(): void
    setBackgroundThrottling(allowed: boolean): void
    setAudioMuted(muted: boolean): void
  }
}
/** The mutable slice of `OsrEntry` the transition reads/writes. */
interface OsrBackgroundState {
  painting: boolean
  manualMuted: boolean
  backgrounded: boolean
}

/**
 * Flip one entry between backgrounded and foregrounded. Idempotent (returns false when already
 * in the requested state).
 *
 * Backgrounding: stop the paint pump (CPU→0; the renderer keeps the last frame on its <canvas>)
 * AND re-enable Chromium's background throttling — `stopPainting` stops the COMPOSITOR only, and
 * these windows are built with `backgroundThrottling: false`, so a backgrounded HMR/polling page
 * would otherwise keep burning CPU invisibly forever (risk R9).
 *
 * Foregrounding: un-throttle only. Paint is deliberately NOT resumed here — the renderer's
 * liveness manager owns that decision when the board remounts (`preview:osrSetPaint(true)` →
 * startPainting + invalidate), so a board that comes back off-screen stays frozen.
 *
 * Both directions re-derive the effective mute as `manualMuted || !painting` (the 4A formula —
 * mirrors previewOsrWidgets.applyEffectiveMute, which needs the full entry type): backgrounding
 * silences the page (stopPainting does not stop audio); the user's manual choice is restored
 * when paint actually resumes.
 */
export function applyOsrBackground(
  win: OsrBackgroundTarget,
  state: OsrBackgroundState,
  backgrounded: boolean
): boolean {
  if (state.backgrounded === backgrounded) return false
  state.backgrounded = backgrounded
  if (backgrounded) applyOsrPaint(win, state, false)
  try {
    win.webContents.setBackgroundThrottling(backgrounded)
  } catch {
    /* window gone */
  }
  try {
    win.webContents.setAudioMuted(state.manualMuted || !state.painting)
  } catch {
    /* window gone */
  }
  return true
}

function entriesOwnedBy(dir: string | null): Array<[string, OsrEntry]> {
  return [...getOsrEntries()].filter(([, e]) => e.projectDir === dir)
}

/** Background every open preview owned by `dir` (freeze + throttle + mute; window survives).
 *  Returns how many entries transitioned. */
export function backgroundProjectOsr(dir: string | null): number {
  sweepPendingForProject(dir) // buffered requests for a backgrounded project are stale
  let n = 0
  for (const [, e] of entriesOwnedBy(dir)) {
    if (applyOsrBackground(e.osrWin, e, true)) {
      // Stamp the true transition HERE so applyOsrBackground stays clock-free/pure — the
      // timestamp orders pickOsrEvictions' longest-backgrounded-first victim picking (Phase 3).
      e.backgroundedAt = Date.now()
      n++
    }
  }
  return n
}

/** Foreground `dir`'s previews on switch-back (un-throttle; paint resumes via the liveness
 *  manager once boards remount). Returns how many entries transitioned. */
export function foregroundProjectOsr(dir: string | null): number {
  let n = 0
  for (const [, e] of entriesOwnedBy(dir)) {
    if (applyOsrBackground(e.osrWin, e, false)) n++
    e.backgroundedAt = undefined // a foreground entry is never an eviction candidate
  }
  return n
}

/**
 * H4: shed excess BACKGROUND offscreen renderers down to `max` TOTAL windows, on a project
 * switch/foreground (NOT only at new-window creation, which is all `ensureOsr` covered — so up to
 * GLOBAL_OSR_MAX frozen ~150 MB Chromium renderers used to linger after switching to a browser-less
 * project). Only backgrounded entries are eligible (a foreground/active window is never evicted);
 * each evicted board keeps its frozen last frame + "paused" badge and revives on re-open. Returns
 * the evicted ids.
 *
 * ⚠️ Off-by-one: `pickOsrEvictions(entries, n)` computes `need = len - n + 1` — the `+1` makes room
 * for the ONE window `ensureOsr` is about to create. A standalone trim creates none, so it passes
 * `max + 1` to get `need = len - max` (trim to exactly `max`). Passing `max` would over-evict by one
 * — and at the Low-RAM `max = 1` it would evict EVERY background window. See the pinning test.
 */
export function trimOsrToBudget(max: number): string[] {
  const victims = pickOsrEvictions(getOsrEntries(), max + 1)
  for (const id of victims) disposeOsr(id)
  return victims
}

/** Destroy every offscreen window owned by `dir` — the "Close project" path. Scoped: closing
 *  project B must never destroy backgrounded project A's windows (unlike disposeAllOsr). */
export function disposeProjectOsr(dir: string | null): void {
  sweepPendingForProject(dir)
  for (const [id] of entriesOwnedBy(dir)) disposeOsr(id)
}

/** Open-preview count for `dir` (switch dialog + switcher badges). */
export function countProjectOsr(dir: string | null): number {
  return entriesOwnedBy(dir).length
}
