/**
 * The quit-path drain decision, pure (review #337 round 2: the mixed-fleet partition needs
 * unit coverage, and bridge.ts imports electron so it can't be vitest-imported — the sessionDeps
 * extraction pattern). Semantics (DESIGN.md D5):
 *
 * - keep=false (every quit except an update install): the classic kill-everything drain — and,
 *   unless the quit is a keep-quit (below), the DAEMON is told to stop too. MAIN's maps are not
 *   the whole fleet: the daemon also holds survivors of a previous run that no board re-adopted
 *   (project B's agents, kept across a "Keep running" close, while this run only ever opened
 *   project A). disposeAllPtys cannot see those, so "Stop all & close" used to leave them running
 *   headless — not listed in the close modal, no tray, no window (ADR 0011: a quit drains every
 *   tree).
 * - keep=true (update install): daemon-backed sessions DETACH (ports closed, procs alive in the
 *   daemon for the relaunch's reattach); IN-PROC members of a mixed fleet (the D2 surfaced
 *   fallback) are tree-killed — they cannot survive their owning process, so leaving them
 *   would leak unreattachable orphans. Applies to live sessions AND parked entries. The daemon
 *   and its un-adopted survivors are left exactly as they are.
 */
export interface DrainSessionLike {
  proc: unknown
  port: { close(): void }
  flushData?: () => void
}

export interface DrainParkedLike {
  proc: unknown
  timer?: ReturnType<typeof setTimeout>
}

export interface QuitDrainDeps {
  /** Detach instead of kill: a keep-quit AND MAIN holds daemon sessions to detach. */
  keep: boolean
  /**
   * The quit asked to keep sessions (update install / entering tray residency), whether or not
   * MAIN holds any. `keep` is false for a keep-quit from a project with no terminals — nothing to
   * detach — yet the daemon's other sessions must still ride it out, so this, not `keep`, decides
   * whether the daemon is stopped.
   */
  keepRequested: boolean
  /** Tell the daemon to tree-kill everything it holds and exit. Must write its request in the
   *  calling tick (the crash sinks exit right after the sync part) and never start a daemon. */
  stopDaemon: () => Promise<void>
  sessions: Map<string, DrainSessionLike>
  parked: Map<string, DrainParkedLike>
  boardCwds: Map<string, string>
  isDaemonProxy: (proc: unknown) => boolean
  killTree: (proc: unknown) => Promise<void>
  disposeAllPtys: () => Promise<void>
  disconnect: () => void
}

export function quitDrainCore(d: QuitDrainDeps): Promise<void> {
  if (!d.keep) {
    // Sessions MAIN tracks first: disposeAllPtys issues their kills synchronously and resolves
    // once MAIN's own tree-kills are reaped — the awaited part of the quit (#49).
    const drained = d.disposeAllPtys()
    if (d.keepRequested) return drained
    // Then everything else the daemon holds. Best-effort by nature: no daemon, or one that cannot
    // be reached, is not a reason to fail (or stall) the quit.
    const stopped = d.stopDaemon().catch(() => undefined)
    return Promise.all([drained, stopped]).then(() => undefined)
  }
  const kills: Promise<void>[] = []
  for (const s of d.sessions.values()) {
    try {
      s.flushData?.()
    } catch {
      /* already torn down */
    }
    try {
      s.port.close()
    } catch {
      /* already closed */
    }
    if (!d.isDaemonProxy(s.proc)) kills.push(d.killTree(s.proc))
  }
  d.sessions.clear()
  for (const p of d.parked.values()) {
    if (p.timer) clearTimeout(p.timer)
    if (!d.isDaemonProxy(p.proc)) kills.push(d.killTree(p.proc))
  }
  d.parked.clear()
  d.boardCwds.clear()
  d.disconnect()
  return Promise.all(kills).then(() => undefined)
}
