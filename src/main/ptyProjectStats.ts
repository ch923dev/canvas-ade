/**
 * Project-scoped PTY statistics (busy-aware background eviction) — pure cores over structural
 * views of pty.ts's private `sessions`/`parked` maps (the ptyLifecycleMonitor discipline: this
 * module never touches those maps directly; pty.ts passes them through the thin wrappers it
 * exports). `countProjectSessionsCore` moved here VERBATIM from pty.ts per the file-size
 * doctrine — pty.ts sits at its max-lines ratchet, and these read-only projections have no
 * reason to live beside the session-lifecycle choke points.
 */

/** The live-session fields the stats cores read (pty.ts `SessionLike` satisfies this). */
export interface SessionStatsView {
  state: string
  projectDir?: string | null
  /** T-F1: epoch ms of the last PTY output (spawn/adopt-seeded, bumped per onData chunk). */
  lastActivityAt?: number
  proc?: { pid: number }
}

/** The parked-session fields the stats cores read (pty.ts `ParkedLike` satisfies this). */
export interface ParkedStatsView {
  kind?: 'undo' | 'background'
  owningDir?: string | null
  /** Busy-aware eviction: last output observed WHILE parked (park-seeded, bumped per onData). */
  lastActivityAt?: number
  proc?: { pid: number }
}

/**
 * Running-terminal count for `dir`: live 'running' sessions + background parks (a parked proc is
 * running by construction — an exited parked proc is dropped from the map by its onExit, so
 * parked ≈ running). Undo-parked sessions are excluded: they are deleted boards, not running
 * terminals of a project.
 */
export function countProjectSessionsCore(
  dir: string | null,
  sessionsMap: Map<string, SessionStatsView>,
  parkedMap: Map<string, ParkedStatsView>
): { running: number } {
  let running = 0
  for (const s of sessionsMap.values()) {
    if ((s.projectDir ?? null) === dir && s.state === 'running') running++
  }
  for (const p of parkedMap.values()) {
    if ((p.owningDir ?? null) === dir && p.kind === 'background') running++
  }
  return { running }
}

/**
 * Most recent PTY output timestamp across `dir`'s sessions — live AND background-parked
 * (undo parks excluded, mirroring countProjectSessionsCore). 0 = the dir owns no sessions /
 * none ever produced output. This is the background registry's idle clock: fresh output resets
 * the idle TTL, so a streaming agent is never "idle" no matter how long ago it was backgrounded.
 */
export function projectActivityAtCore(
  dir: string | null,
  sessionsMap: Map<string, SessionStatsView>,
  parkedMap: Map<string, ParkedStatsView>
): number {
  let last = 0
  for (const s of sessionsMap.values()) {
    if ((s.projectDir ?? null) === dir && (s.lastActivityAt ?? 0) > last)
      last = s.lastActivityAt ?? 0
  }
  for (const p of parkedMap.values()) {
    if ((p.owningDir ?? null) === dir && p.kind === 'background' && (p.lastActivityAt ?? 0) > last)
      last = p.lastActivityAt ?? 0
  }
  return last
}

/**
 * Root shell PIDs owned by `dir` (live running + background-parked) — the process-tree roots the
 * CPU busy-probe (bgBusyProbe) walks for descendant CPU-time deltas each sweep. A silent worker
 * (an agent mid-e2e producing no output) is caught by this signal, not by projectActivityAtCore.
 */
export function projectSessionPidsCore(
  dir: string | null,
  sessionsMap: Map<string, SessionStatsView>,
  parkedMap: Map<string, ParkedStatsView>
): number[] {
  const pids: number[] = []
  for (const s of sessionsMap.values()) {
    if ((s.projectDir ?? null) === dir && s.state === 'running' && s.proc) pids.push(s.proc.pid)
  }
  for (const p of parkedMap.values()) {
    if ((p.owningDir ?? null) === dir && p.kind === 'background' && p.proc) pids.push(p.proc.pid)
  }
  return pids
}
