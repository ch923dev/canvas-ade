/**
 * Live-resource teardown/handover for a project switch (Background Project Sessions, Phase 2).
 *
 * `disposeLiveResources` — the legacy hard teardown: close every offscreen preview window and
 * kill every Terminal PTY tree. Without this, switching projects leaks renderers + orphans
 * node-pty child trees. Still the path for: the e2e reset, and switches with the
 * EXPANSE_BG_SESSIONS flag off. Idempotent / best-effort.
 *
 * `backgroundLiveResources` — the keep-alive sibling: snapshot the buffers, then hand the
 * ACTIVE project's PTYs (park, procs keep running) and preview windows (freeze + throttle)
 * to MAIN's background registry. MUST run BEFORE `setProjectLoading()` unmounts the boards —
 * park is what turns each unmount's `pty:kill`/`preview:osrClose` into a no-op.
 *
 * `closeActiveLiveResources` — the scoped close: like dispose, but kills ONLY what the active
 * project owns, so closing it never reaps another resident project's background sessions.
 */
import { flushAllTerminalSnapshots } from './terminalSnapshotRegistry'

export async function disposeLiveResources(expectedDir?: string): Promise<void> {
  // S3: snapshot every live terminal's scrollback BEFORE its PTY + xterm buffer are torn down, so a
  // project switch preserves the same restore-on-reopen surface the quit path gives. serialize reads
  // the renderer buffer, so it must run while the terms are still mounted (i.e. before the switch
  // completes and unmounts them). Best-effort — never blocks the dispose below.
  await flushAllTerminalSnapshots({ expectedDir }).catch(() => {})
  // Destroy every offscreen preview window in one shot (cheaper than per-id) — also removes
  // each board's per-session download listener (the session outlives the window).
  await window.api.closeAllOsr().catch(() => false)
  // PTY-1: reap EVERY PTY — live AND parked — in one main-side call. Iterating the
  // board list (terminal boards) and killing per-id missed PARKED sessions: a
  // terminal deleted within PARK_TTL (120s) awaiting undo is no longer in the board
  // list, and its proc lives in main's `parked` map, so its child tree leaked until
  // the TTL fired. disposeAllTerminals drains both maps.
  await window.api.disposeAllTerminals().catch(() => false)
}

export async function backgroundLiveResources(expectedDir?: string): Promise<boolean> {
  // Flush FIRST (needs the mounted xterms + currentDir still on the outgoing project): the
  // switch-time sidecar is the durability baseline — post-switch output lives only in each
  // parked session's ring until quit-tail persistence (Phase 5) lands.
  await flushAllTerminalSnapshots({ expectedDir }).catch(() => {})
  // Review fix: report the handover honestly — a swallowed failure here let the switch
  // proceed to the unmount, whose cleanups then KILLED the never-parked sessions the user
  // chose to keep. The caller aborts the switch on false (the save-failed pattern).
  const res = await Promise.resolve()
    .then(() => window.api.project.background())
    .catch(() => null)
  return res?.ok === true
}

export async function closeActiveLiveResources(expectedDir?: string): Promise<void> {
  await flushAllTerminalSnapshots({ expectedDir }).catch(() => {})
  await window.api.project.closeActive().catch(() => false)
}
