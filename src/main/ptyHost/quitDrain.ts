/**
 * The quit-path drain decision, pure (review #337 round 2: the mixed-fleet partition needs
 * unit coverage, and bridge.ts imports electron so it can't be vitest-imported — the sessionDeps
 * extraction pattern). Semantics (DESIGN.md D5):
 *
 * - keep=false (every quit except an update install): the classic kill-everything drain.
 * - keep=true (update install): daemon-backed sessions DETACH (ports closed, procs alive in the
 *   daemon for the relaunch's reattach); IN-PROC members of a mixed fleet (the D2 surfaced
 *   fallback) are tree-killed — they cannot survive their owning process, so leaving them
 *   would leak unreattachable orphans. Applies to live sessions AND parked entries.
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
  keep: boolean
  sessions: Map<string, DrainSessionLike>
  parked: Map<string, DrainParkedLike>
  boardCwds: Map<string, string>
  isDaemonProxy: (proc: unknown) => boolean
  killTree: (proc: unknown) => Promise<void>
  disposeAllPtys: () => Promise<void>
  disconnect: () => void
}

export function quitDrainCore(d: QuitDrainDeps): Promise<void> {
  if (!d.keep) return d.disposeAllPtys()
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
