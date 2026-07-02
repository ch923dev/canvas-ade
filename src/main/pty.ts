import type { IpcMain, BrowserWindow, MessagePortMain } from 'electron'
import { MessageChannelMain } from 'electron'
import { isForeignSender } from './ipcGuard'
import { execFile } from 'node:child_process'
import * as pty from 'node-pty'
import { parsePortsFromOutput } from './portDetect'
import {
  MAX_OUTPUT_PAGE,
  pageOutput,
  stripAnsi,
  createRing,
  pushRing,
  readRing,
  type OutputPage,
  type OutputRing
} from './ptyOutput'
import { enumerateShells, resolveShell, safeCwd } from './ptyShells'
import { getCurrentDir } from './projectStore'

// T-F1: the Context Tier-2 summary loop reads a terminal's runtime via getTerminalRuntime (below).
// Type-only import (erased at runtime → no coupling to the LLM stack) so the returned shape is
// guaranteed to match what createSummaryLoop expects.
import type { TerminalRuntime } from './summaryLoop'

/**
 * Terminal data plane lives on a MessagePort (binary-ish, high-volume PTY
 * output). Control (spawn/kill) is plain IPC. This is the architecture the
 * real Terminal board uses in Phase 2.1 — Phase 0 proves the bridge works.
 *
 * Spawn the SHELL, not the agent: a `launchCommand` (free-text, any agentic
 * CLI) is written as the FIRST PTY line so the agent inherits the user's PATH /
 * profile / auth from the shell. Lifecycle STATE (`spawning` → `running` →
 * `exited` / `spawn-failed`) is pushed back to the renderer over the SAME
 * MessagePort as `{ t: 'state', … }` so the board can render its identity pill.
 */
/**
 * Validate terminal resize dimensions before forwarding to ConPTY. Both cols
 * and rows must be positive integers in the range [1, 1000]. This guards both
 * MessagePort listener sites (spawn-time and adopt-time) — a non-integer
 * (80.5), zero, negative, or absurd value must never reach proc.resize().
 * Exported so the unit test targets the real code path used by both listeners.
 */
export function isValidResize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols > 0 &&
    rows > 0 &&
    cols <= 1000 &&
    rows <= 1000
  )
}

/**
 * BUG-023: clamp a single spawn dimension (cols or rows) to the [1, 1000] range
 * that isValidResize enforces on the resize path. Truncates fractional values
 * before clamping so the result is always an integer in [1, 1000].
 * Exported for unit testing — both spawn-time uses call this helper.
 */
export function clampSpawnDim(value: number, fallback: number): number {
  const v = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(1, v), 1000)
}

/** Renderer→PTY input/resize message over a board's MessagePort. The discriminated
 * union lets the resize branch read cols/rows as plain numbers (no non-null casts);
 * the runtime guards below still defend against malformed/untrusted payloads. */
type PortInputMsg = { t: 'input'; d: string } | { t: 'resize'; cols: number; rows: number }

/**
 * Attach the renderer→PTY input/resize forwarder to one MessagePort and start it.
 * This is the SINGLE renderer→PTY write guard, shared by the spawn-time and adopt-time
 * listener sites so the resize clamp (isValidResize) and the swallow-on-exited-pty
 * try/catch live in ONE place. node-pty's write/resize THROW on an exited-but-not-yet-
 * reaped pty; that throw would escape this EventEmitter listener as an uncaughtException
 * → app.exit(1), crashing the app — so it is swallowed (the session is being torn down).
 */
export function attachPortInput(port: MessagePortMain, proc: pty.IPty): void {
  port.on('message', (e) => {
    const m = e.data as PortInputMsg
    try {
      if (m.t === 'input' && typeof m.d === 'string') proc.write(m.d)
      else if (m.t === 'resize') {
        if (isValidResize(m.cols, m.rows)) proc.resize(m.cols, m.rows)
        else if (Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 1 && m.rows >= 1)
          // BUG-023: a legit but OVERSIZED grid (>1000 cols/rows — wide board at a
          // tiny font) is clamped instead of dropped, so row updates keep applying
          // instead of the PTY freezing at spawn dimensions. Garbage (non-integer,
          // <1, non-finite) is still dropped wholesale.
          proc.resize(clampSpawnDim(m.cols, 80), clampSpawnDim(m.rows, 24))
      }
    } catch {
      /* pty already exited */
    }
  })
  port.start()
}

export interface SpawnOpts {
  id: string
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
  /** Free-text agentic CLI to launch as the first PTY line (e.g. `claude`). */
  launchCommand?: string
}

/** Lifecycle state pushed to the renderer over the data plane (2.1). */
export type PtyState = 'spawning' | 'running' | 'exited' | 'spawn-failed'

/** Park a deleted terminal's process this long before reaping it (#15). */
const PARK_TTL_MS = 120_000
/** Cap of each session's replay buffer (#15). */
const RING_CAP_BYTES = 256 * 1024

/**
 * Live + parked session shapes. Declared as the structural surface the core
 * park / adopt / reap / dispose logic operates on, so that logic can be
 * unit-tested against mock procs and ports without the electron/node-pty
 * runtime. The real `pty.IPty` / `MessagePortMain` satisfy these.
 */
interface SessionLike {
  proc: pty.IPty
  port: MessagePortMain
  /**
   * Recent output, boxed (the OutputRing object) so the SAME reference travels into
   * `parked` on park and back into a session on adopt — the single `proc.onData`
   * listener keeps appending to it across the move (closures capture the box, not the
   * map entry). PERF-06: a chunk deque, joined only on read (readRing).
   */
  buf: OutputRing
  /**
   * Last lifecycle state, read by the MCP board registry. A live session is
   * 'running'; it is marked 'exited' in onExit immediately before cleanup() removes
   * it from the map, so listPtySessions in practice reports running boards (the
   * field tracks lifecycle honestly for when that contract widens in Phase 2).
   */
  state: PtyState
  /**
   * T-F1: epoch ms of the last PTY output, set at spawn/adopt and bumped on each
   * onData. Lets the Context Tier-2 summary distinguish an actively-working agent from
   * an idle/parked shell (getTerminalRuntime).
   */
  lastActivityAt: number
  /** T-F1: exit code, recorded in onExit (while the session briefly survives before cleanup). */
  exitCode?: number
  /**
   * Background sessions: the project dir that OWNS this session, captured from
   * projectStore.getCurrentDir() at spawn time — NOT from opts.cwd (a board's cwd override can
   * point anywhere). `null` = spawned with no project open (e.g. the e2e boot). Board ids are
   * UUIDs but they collide across git-cloned/copied projects, so every cross-session lookup
   * (adopt, parked-buffer reads) must be scoped by this tag, never by bare id.
   */
  projectDir?: string | null
}

/**
 * Why a session was parked. `'undo'` = board delete awaiting undo (#15) — reaped after
 * PARK_TTL_MS. `'background'` = its project was switched away with "keep running" — NO TTL;
 * reaped only by an explicit project close or app quit.
 */
export type ParkKind = 'undo' | 'background'

interface ParkedLike {
  proc: pty.IPty
  buf: OutputRing
  /** TTL reaper — absent for a `'background'` park (no timer is ever armed). */
  timer?: ReturnType<typeof setTimeout>
  /** Park reason (see {@link ParkKind}). Absent (legacy shape) reads as 'undo'. */
  kind?: ParkKind
  /** Owning project dir, copied from the session's `projectDir` at park time. */
  owningDir?: string | null
}

const sessions = new Map<string, SessionLike>()

/** Deleted-but-undoable sessions, kept alive up to PARK_TTL_MS for adopt-on-undo. */
const parked = new Map<string, ParkedLike>()

/**
 * PR-2: resolved spawn cwd per board id, for the read-only gitDiff (getTerminalCwd → gitDiff.ts).
 * Keyed by board id (NOT session lifecycle) so it survives the park/adopt MOVE untouched — the
 * ParkedLike shape carries no cwd, and threading it through the pure park/adopt cores is
 * unnecessary. Set at spawn; cleared wholesale on disposeAllPtys (project switch). A
 * non-terminal / never-spawned id is simply absent (gitDiff then reads no cwd and returns '').
 */
const boardCwds = new Map<string, string>()

/**
 * Injectable policy seam for injecting extra env vars at spawn time (e.g. CANVAS_RECAP_BOARD).
 * Returns a record to merge LAST into the spawn env, or undefined for no extra env.
 * Policy errors must NEVER break a spawn — the provider is called inside a try/catch.
 * index.ts wires the policy (consent + claude detection) here; pty.ts stays decoupled.
 */
type RecapEnvProvider = (opts: {
  id: string
  launchCommand?: string
  cwd?: string
}) => Record<string, string> | undefined
let recapEnvProvider: RecapEnvProvider | undefined

/** index.ts wires the policy (consent + claude detection) here; pty.ts stays decoupled. */
export function setRecapEnvProvider(fn: RecapEnvProvider | undefined): void {
  recapEnvProvider = fn
}

/**
 * Injectable spawn-time hook for the Agent Orchestration provisioner (PLAN §3, 2026-06-19).
 * Called LAST — just before the launch line is written — so the matching agent CLI's MCP config
 * carries the LIVE loopback endpoint + bearer BEFORE the agent reads it. The endpoint+token rotate
 * each app restart, so re-running this on every spawn is what fixes the stale-config failure
 * ("tool doesn't exist"). The injected provider owns the policy (consent + token mint + which CLI);
 * its write is synchronous so the file is on disk before the agent launches. Like recapEnvProvider,
 * a provider error must NEVER break a spawn — it is called inside a try/catch. NEVER logs the token.
 */
type OrchestrationSyncProvider = (opts: {
  id: string
  launchCommand?: string
  cwd?: string
}) => void
let orchestrationSyncProvider: OrchestrationSyncProvider | undefined

/** index.ts wires the policy (consent + mint + provisioner) here; pty.ts stays decoupled. */
export function setOrchestrationSyncProvider(fn: OrchestrationSyncProvider | undefined): void {
  orchestrationSyncProvider = fn
}

/** A freshly minted port pair (real `MessageChannelMain` or a test double). */
interface PortPair {
  port1: MessagePortMain
  port2: MessagePortMain
}
/** Injectable dependencies for the session-lifecycle core (real ones in prod). */
interface SessionDeps {
  killTree: (proc: pty.IPty) => Promise<void>
  newChannel: () => PortPair
  parkTtlMs: number
}

/**
 * Core of `reapParked`: stop the TTL timer and kill the process tree. Pure of
 * module state — operates on the passed `parked` map + injected `killTree`.
 *
 * FIND-009: `onReap` lets the caller forget id-keyed side-state (the module's `boardCwds`) when —
 * and ONLY when — a parked session is actually reaped, so a parked-then-reaped board's cwd entry
 * doesn't leak until the next project switch. Fired before the (async) tree-kill; absent for the
 * `disposeAllPtys` path, which clears that side-state wholesale.
 */
export function reapParkedCore(
  id: string,
  parkedMap: Map<string, ParkedLike>,
  deps: Pick<SessionDeps, 'killTree'>,
  onReap?: (id: string) => void
): Promise<void> {
  const p = parkedMap.get(id)
  if (!p) return Promise.resolve()
  parkedMap.delete(id)
  if (p.timer) clearTimeout(p.timer) // a background park never armed one
  onReap?.(id)
  return deps.killTree(p.proc)
}

/**
 * Core of `park` (#15): move the live session out of `sessions`, close its
 * renderer port, arm a TTL whose expiry reaps the tree, and store it in `parked`.
 * `reap` is the bound reaper invoked when the timer fires.
 *
 * Background sessions: `parkTtlMs === undefined` arms NO timer (the park lives until an
 * explicit project close or quit) — used with `kind: 'background'` by parkProjectSessionsCore.
 * The session's owning project travels into the parked entry so adopt/reads stay project-scoped.
 */
export function parkCore(
  id: string,
  sessionsMap: Map<string, SessionLike>,
  parkedMap: Map<string, ParkedLike>,
  reap: (id: string) => void,
  parkTtlMs?: number,
  kind: ParkKind = 'undo'
): void {
  const s = sessionsMap.get(id)
  if (!s) return
  sessionsMap.delete(id)
  try {
    s.port.close()
  } catch {
    /* already closed */
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  if (parkTtlMs !== undefined) {
    timer = setTimeout(() => reap(id), parkTtlMs)
    timer.unref?.()
  }
  parkedMap.set(id, { proc: s.proc, buf: s.buf, timer, kind, owningDir: s.projectDir ?? null })
}

/**
 * Core of `adopt` (#15): clear the TTL, bind a fresh MessagePort to the
 * still-running proc, move it back into `sessions`, replay scrollback, re-emit
 * `running`, and hand the renderer port off via `transferPort`. Returns the live
 * pid so the e2e can assert process identity. No second spawn — same proc.
 */
export function adoptCore(
  id: string,
  sessionsMap: Map<string, SessionLike>,
  parkedMap: Map<string, ParkedLike>,
  deps: Pick<SessionDeps, 'newChannel' | 'killTree'>,
  transferPort: (port2: MessagePortMain) => void,
  requireOwner?: { dir: string | null }
): { adopted: boolean; pid?: number } {
  const p = parkedMap.get(id)
  if (!p) return { adopted: false }
  // Background sessions (R1): board UUIDs collide across git-cloned/copied projects. When the
  // caller supplies the ACTIVE project dir, a parked entry owned by a DIFFERENT project must
  // never be handed to this renderer — leave it parked untouched (its true owner adopts it on
  // switch-back) and let the caller fall through to the snapshot-restore/spawn path.
  if (requireOwner !== undefined && (p.owningDir ?? null) !== requireOwner.dir) {
    return { adopted: false }
  }
  if (p.timer) clearTimeout(p.timer)
  parkedMap.delete(id)

  // BUG-024: mirror the Bug #13 spawn-path guard — if a LIVE session already holds
  // this id (e.g. duplicate board ids from a hand-edited canvas.json, or an MCP
  // adopt against an already-running board), reap it before the set so the
  // displaced proc is not orphaned outside both maps.
  if (sessionsMap.has(id)) {
    void cleanupCore(id, sessionsMap, deps)
  }

  const { port1, port2 } = deps.newChannel()
  attachPortInput(port1, p.proc)

  // Back into `sessions` with the SAME boxed buffer; the spawn-time onData listener
  // now forwards live output to this new port (it looks up sessions.get(id)).
  sessionsMap.set(id, {
    proc: p.proc,
    port: port1,
    buf: p.buf,
    state: 'running',
    lastActivityAt: Date.now(), // T-F1: adopt = fresh activity (scrollback is about to replay)
    projectDir: p.owningDir ?? null // the tag survives the park→adopt round-trip
  })
  transferPort(port2)

  // Replay recorded scrollback, then re-announce running. PERF-06: the deque is joined
  // here (readRing), not on every onData chunk.
  const replay = readRing(p.buf)
  if (replay) port1.postMessage({ t: 'data', d: replay })
  port1.postMessage({ t: 'state', state: 'running' satisfies PtyState })

  return { adopted: true, pid: p.proc.pid }
}

const sessionDeps: SessionDeps = {
  killTree: (proc) => killTree(proc),
  newChannel: () => new MessageChannelMain(),
  parkTtlMs: PARK_TTL_MS
}

/** Reap a parked session: stop its TTL timer and kill its process tree. */
function reapParked(id: string): Promise<void> {
  // FIND-009: a parked session never routed through cleanupCore, so its boardCwds entry would
  // otherwise leak until the next project switch. Forget it as part of the reap.
  return reapParkedCore(id, parked, sessionDeps, (rid) => boardCwds.delete(rid))
}

/**
 * Park the live session for `id` instead of killing it (#15): move it out of
 * `sessions` (so the board-unmount's `pty:kill` no-ops), close the renderer port
 * (the proc keeps running and the onData listener keeps recording into `buf`), and
 * start a TTL after which the process tree is reaped if no undo adopts it.
 */
function park(id: string): void {
  parkCore(id, sessions, parked, (pid) => void reapParked(pid), sessionDeps.parkTtlMs)
}

/**
 * Adopt a parked session for `id` (#15): clear its TTL, bind a fresh MessagePort
 * to the still-running proc, move it back into `sessions`, replay the recorded
 * output buffer so the re-mounted xterm reconstructs its scrollback, and re-emit
 * `running`. Returns the live pid so the e2e can assert process identity. If no
 * session is parked, returns `{ adopted: false }` and the caller spawns fresh.
 */
function adopt(id: string, win: BrowserWindow): { adopted: boolean; pid?: number } {
  // Owner-scoped (R1): only a parked session owned by the ACTIVE project may reattach.
  return adoptCore(
    id,
    sessions,
    parked,
    sessionDeps,
    (port2) => win.webContents.postMessage('pty:port', { id }, [port2]),
    { dir: getCurrentDir() }
  )
}

/**
 * The parked entry for `id` ONLY when the ACTIVE project owns it (R1: board UUIDs collide
 * across cloned projects — a background project's buffered output must never leak into a
 * same-id board of another project via the parked fallbacks below).
 */
function parkedForActiveProject(id: string): ParkedLike | undefined {
  const p = parked.get(id)
  if (!p) return undefined
  return (p.owningDir ?? null) === getCurrentDir() ? p : undefined
}

/**
 * Bug #33 (defense-in-depth): every handler below rejects IPC that did not originate from the
 * main window's main frame via the shared `isForeignSender` (./ipcGuard). ipcMain channels are
 * shared by ALL webContents, including the per-board preview WebContentsViews that load untrusted
 * localhost content; today those views have no preload, so this is not exploitable — but the
 * guard ENFORCES the PTY-isolation invariant rather than leaving it incidental.
 */
export function registerPtyHandlers(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  ipcMain.handle('pty:shells', (e) => (isForeignSender(e, getWin) ? [] : enumerateShells()))

  ipcMain.handle('terminal:detectPorts', (e, id: string) => {
    if (isForeignSender(e, getWin)) return []
    // Read whichever buffer holds this board's output — live session or (owner-scoped) parked.
    const box = sessions.get(id)?.buf ?? parkedForActiveProject(id)?.buf
    return parsePortsFromOutput(box ? readRing(box) : '')
  })

  ipcMain.handle('pty:spawn', (e, opts: SpawnOpts) => {
    if (isForeignSender(e, getWin)) throw new Error('pty:spawn — forbidden sender')
    const win = getWin()
    if (!win) throw new Error('pty:spawn — no window')

    // Bug #13: a Restart can race the mount's deferred/adopt launch so two pty:spawn
    // calls land under one id. Without this, sessions.set below overwrites the prior
    // entry WITHOUT reaping its proc, dropping that process out of BOTH the sessions
    // and parked maps so neither cleanup() nor disposeAllPtys() ever kills it (an
    // orphaned agent child-tree). Reap any session already occupying this id first,
    // turning the silent overwrite into a safe replace. (cleanup() deletes the entry
    // synchronously, then tree-kills async; the displaced proc's later onExit no-ops
    // via the isStaleExit guard.)
    if (sessions.has(opts.id)) void cleanup(opts.id)

    // M5: validate the persisted shell against the system-discovered list — a
    // corrupt canvas.json must not be able to spawn an arbitrary binary in main.
    const shell = resolveShell(opts.shell, enumerateShells())
    // Git Bash with no explicit args: launch as a login+interactive shell so it
    // sources its profile (otherwise PATH/prompt are bare under ConPTY).
    let args = opts.args ?? []
    if (process.platform === 'win32' && args.length === 0 && /\\bash\.exe$/i.test(shell)) {
      args = ['-l', '-i']
    }
    let recapEnv: Record<string, string> | undefined
    try {
      recapEnv = recapEnvProvider?.({
        id: opts.id,
        launchCommand: opts.launchCommand,
        cwd: opts.cwd
      })
    } catch {
      recapEnv = undefined // policy must never break a spawn
    }

    // BUG-023: clamp spawn dims to the same [1, 1000] bounds that isValidResize
    // enforces on the resize path. Without this, a board wider than 1000 cols
    // spawns fine but every subsequent resize (including row-only changes) is
    // silently dropped by the isValidResize gate in attachPortInput, freezing
    // the PTY at its spawn dimensions and causing TUI misrenders.
    const spawnCols = clampSpawnDim(opts.cols ?? 80, 80)
    const spawnRows = clampSpawnDim(opts.rows ?? 24, 24)
    // PR-2: resolve the cwd ONCE so the live process and the gitDiff cwd map agree.
    const spawnCwd = safeCwd(opts.cwd)
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: spawnCols,
        rows: spawnRows,
        cwd: spawnCwd,
        env: { ...process.env, ...(recapEnv ?? {}) } as Record<string, string>
      })
    } catch (err) {
      // No live session was registered, so report the failure straight back.
      const message = err instanceof Error ? err.message : String(err)
      return { id: opts.id, shell, pid: -1, state: 'spawn-failed' as PtyState, error: message }
    }

    const { port1, port2 } = new MessageChannelMain()

    const buf = createRing(RING_CAP_BYTES)
    proc.onData((d) => {
      pushRing(buf, d) // PERF-06: amortised O(chunk), no per-chunk O(cap) copy
      // Forward to the current live port (looked up at fire time, so it follows an
      // adopt onto the new port); none while parked → guard the post. Identity
      // guard `live.proc === proc`: a dying OLD proc keeps draining bytes for up to
      // ~1s after kill() (node-pty's flush window), and without this check those
      // late bytes would bleed into a freshly-restarted session under the same id.
      const live = sessions.get(opts.id)
      if (live && live.proc === proc) {
        live.lastActivityAt = Date.now() // T-F1: output = activity (drives running-vs-idle)
        try {
          live.port.postMessage({ t: 'data', d })
        } catch {
          /* port closed */
        }
      }
    })
    proc.onExit(({ exitCode }) => {
      // Post lifecycle to the CURRENT live port (looked up at fire time) the same
      // way onData does — so an ADOPTED session (re-bound to a fresh port by adopt())
      // is told when its process exits. Posting to the captured spawn-time `port1`
      // would hit the port park() already closed, and the adopted renderer would
      // stay stuck in 'running' forever. During a restart/config-respawn the port
      // may already be closed (the new session took over this id), so guard the post.
      try {
        // Identity guard: only the session that still OWNS this exact proc should
        // be told it exited — a stale OLD-proc exit must not post 'exited' to a NEW
        // session that has since respawned under the same id (mirrors isStaleExit).
        const live = sessions.get(opts.id)
        if (live && live.proc === proc) {
          live.state = 'exited'
          live.exitCode = exitCode // T-F1: record the code while the session briefly survives
          live.port.postMessage({ t: 'state', state: 'exited' satisfies PtyState, code: exitCode })
          live.port.postMessage({ t: 'exit', code: exitCode })
        }
      } catch {
        /* port already closed by a newer session */
      }
      // Reference our OWN proc so a late exit from this (old) process cannot tear
      // down a freshly respawned session that now occupies the same id.
      cleanup(opts.id, proc)
      // If this proc was parked (deleted, awaiting undo) and exited on its own, drop it.
      const p = parked.get(opts.id)
      if (p && p.proc === proc) {
        clearTimeout(p.timer)
        parked.delete(opts.id)
        // FIND-009: this parked exit bypasses cleanupCore too, so drop the gitDiff cwd here as well.
        boardCwds.delete(opts.id)
      }
    })

    attachPortInput(port1, proc)

    sessions.set(opts.id, {
      proc,
      port: port1,
      buf,
      state: 'running',
      lastActivityAt: Date.now(),
      // Background sessions: tag the OWNING project (the one open at spawn), not opts.cwd —
      // a board's cwd override can point anywhere. null = no project open (e2e boot).
      projectDir: getCurrentDir()
    })
    boardCwds.set(opts.id, spawnCwd) // PR-2: remember the resolved cwd for the read-only gitDiff
    win.webContents.postMessage('pty:port', { id: opts.id }, [port2])

    // Announce running, then — spawn the SHELL, not the agent — write the
    // launchCommand as the first PTY line so the agent inherits PATH/profile/auth.
    port1.postMessage({ t: 'state', state: 'running' satisfies PtyState })

    // Agent Orchestration (PLAN §3): re-sync the live MCP endpoint into the matching CLI's config
    // BEFORE the agent launches, so a real terminal agent can reach Expanse's MCP and a restart
    // refreshes the rotated endpoint. Policy + token mint live in the injected provider; the write
    // is synchronous (file on disk before the launch line). A failure here must NEVER break the
    // spawn (mirrors the recapEnvProvider guard above).
    try {
      orchestrationSyncProvider?.({
        id: opts.id,
        launchCommand: opts.launchCommand,
        cwd: spawnCwd
      })
    } catch {
      /* provisioning is best-effort — never block the spawn */
    }

    const launch = opts.launchCommand?.trim()
    if (launch) proc.write(launch + '\r')

    return { id: opts.id, shell, pid: proc.pid, state: 'running' as PtyState }
  })

  ipcMain.handle('pty:kill', (e, id: string) => {
    if (isForeignSender(e, getWin)) return false
    cleanup(id)
    return true
  })

  // PTY-1: tear down EVERY session — live AND parked — for a project switch. The
  // per-board `pty:kill` loop missed parked sessions (a terminal deleted <PARK_TTL
  // ago, awaiting undo, lives in the `parked` map, not `sessions`), leaking its
  // child tree until the 120s TTL fired. disposeAllPtys() drains both maps now.
  ipcMain.handle('pty:disposeAll', (e) => {
    if (isForeignSender(e, getWin)) return false
    return disposeAllPtys().then(() => true)
  })

  ipcMain.handle('pty:park', (e, id: string) => {
    if (isForeignSender(e, getWin)) return false
    park(id)
    return true
  })

  ipcMain.handle('pty:adopt', (e, id: string) => {
    if (isForeignSender(e, getWin)) return { adopted: false }
    const win = getWin()
    if (!win) return { adopted: false }
    return adopt(id, win)
  })
}

/**
 * Identity guard for a process's own `onExit` cleanup: a late exit from an OLD
 * process must NOT reap the session if the stored session has since been
 * replaced by a NEW process under the same id. Reference identity only — pure,
 * so it is unit-testable without the electron/node-pty runtime. `exiting` is
 * `undefined` for an explicit `pty:kill`, which always proceeds.
 */
export function isStaleExit<T>(stored: T, exiting: T | undefined): boolean {
  return exiting !== undefined && stored !== exiting
}

/**
 * Tear down the session for `id`. Identity-aware: when `proc` is supplied (a
 * process's own `onExit`), no-op unless the stored session still owns that exact
 * process — this is what stops a stale OLD-process exit from reaping the NEW
 * session that has since respawned under the same id. An explicit `pty:kill`
 * passes no `proc` and always tears down the current session.
 */
/**
 * Core of `cleanup`: identity-aware teardown of one session. Pure of module
 * state — operates on the passed `sessions` map + injected `killTree`. When
 * `proc` is supplied (a process's own `onExit`), no-op unless the stored session
 * still owns that exact process (stale-exit guard).
 */
export function cleanupCore(
  id: string,
  sessionsMap: Map<string, SessionLike>,
  deps: Pick<SessionDeps, 'killTree'>,
  proc?: pty.IPty
): Promise<void> {
  const s = sessionsMap.get(id)
  if (!s) return Promise.resolve()
  if (isStaleExit(s.proc, proc)) return Promise.resolve()
  sessionsMap.delete(id)
  // PR-2: drop this board's gitDiff cwd when its session is torn down, so the map doesn't
  // accrete entries for the session lifetime (it otherwise only drained on project switch).
  // Kept across park/adopt (parkCore doesn't route here); a respawn re-sets it AFTER this
  // synchronous delete (the Bug #13 restart reaps the old session before the new spawn).
  boardCwds.delete(id)
  // BUG-022: when the shell/agent exited naturally (state === 'exited') AND this
  // is the process's own onExit callback (proc !== undefined), the root PID is
  // already dead and the OS may recycle it before taskkill resolves — a force-kill
  // against a recycled PID can harm an unrelated process tree. Skip killTree on
  // the natural-exit path only. An explicit pty:kill (proc === undefined, no caller
  // proc pinning) always goes through because it may tear down a still-running proc.
  // Still call node-pty's own kill(): it disposes the ConPTY handle + conout worker
  // deterministically and closes the pseudoconsole (reaping children still attached
  // to it) — without ever addressing the possibly-recycled root PID via taskkill.
  let done: Promise<void>
  if (s.state === 'exited' && proc !== undefined) {
    try {
      s.proc.kill()
    } catch {
      /* already disposed */
    }
    done = Promise.resolve()
  } else {
    done = deps.killTree(s.proc)
  }
  try {
    s.port.close()
  } catch {
    /* port already closed */
  }
  return done
}

function cleanup(id: string, proc?: pty.IPty): Promise<void> {
  return cleanupCore(id, sessions, sessionDeps, proc)
}

/**
 * Core of `disposeAllPtys`: drain BOTH maps — reap every parked session and tear
 * down every live one — resolving once each tree-kill has been reaped. Pure of
 * module state for unit testing.
 */
export function disposeAllPtysCore(
  sessionsMap: Map<string, SessionLike>,
  parkedMap: Map<string, ParkedLike>,
  deps: Pick<SessionDeps, 'killTree'>
): Promise<void> {
  const parkedDone = [...parkedMap.keys()].map((id) => reapParkedCore(id, parkedMap, deps))
  const liveDone = [...sessionsMap.keys()].map((id) => cleanupCore(id, sessionsMap, deps))
  return Promise.all([...parkedDone, ...liveDone]).then(() => undefined)
}

/**
 * The OS-specific command for reaping a process's whole tree. Extracted PURE from
 * killTree so the exact argv (Windows) / signal+pgid (POSIX) is unit-testable —
 * agentic CLIs spawn child process trees and a bare kill() leaves orphans (#49).
 */
export type KillTreeCommand =
  | { kind: 'taskkill'; file: 'taskkill'; args: string[] }
  | { kind: 'pgid'; pgid: number; signal: 'SIGKILL' }

export function killTreeCommand(platform: NodeJS.Platform, pid: number): KillTreeCommand {
  if (platform === 'win32') {
    // taskkill /T reaps the descendant tree (proc.kill() only signals the console
    // process list, not deeply re-parented children).
    return { kind: 'taskkill', file: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
  }
  // POSIX: the pty session is its own process group; kill the negative pgid.
  return { kind: 'pgid', pgid: -pid, signal: 'SIGKILL' }
}

/**
 * Agentic CLIs spawn child process trees. On Windows a bare kill() leaves
 * orphans, so kill the whole tree with taskkill /T /F. Returns a Promise that
 * resolves when the tree-kill child process has exited (or a short safety timeout
 * elapses) so an abrupt shutdown can AWAIT the reap before `app.exit` instead of
 * racing a fixed timer (#49). The node-pty `kill()` (ConPTY/conout Worker dispose)
 * is synchronous, so it always runs regardless of the taskkill timing.
 */
function killTree(proc: pty.IPty): Promise<void> {
  const cmd = killTreeCommand(process.platform, proc.pid)
  if (cmd.kind === 'taskkill') {
    const reaped = new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      execFile(cmd.file, cmd.args, () => finish())
      // Bounded fallback: never block shutdown indefinitely on a hung taskkill.
      setTimeout(finish, 2000).unref?.()
    })
    // ALSO call node-pty's own kill() so the pseudoconsole handle + conout Worker
    // thread are disposed deterministically at session teardown — taskkill reaps
    // the OS process tree but leaves node-pty's ConPTY/worker until process exit.
    try {
      proc.kill()
    } catch {
      /* ConPTY already torn down */
    }
    return reaped
  } else {
    try {
      process.kill(cmd.pgid, cmd.signal)
    } catch {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }
    return Promise.resolve()
  }
}

/**
 * Tear down every live session. Awaitable (#49): resolves once each session's
 * tree-kill has been reaped (bounded), so an abrupt `app.exit` path can await this
 * before exiting instead of racing a fixed timer and orphaning a child tree.
 */
export function disposeAllPtys(): Promise<void> {
  boardCwds.clear() // PR-2: drop all gitDiff cwd entries on project switch
  return disposeAllPtysCore(sessions, parked, sessionDeps)
}

/* ── Background project sessions (Phase 1 plumbing) ─────────────────────────────────────────────
 * A project switch may PARK a project's live sessions (keep the procs running, ports closed,
 * output buffering into each ring) instead of killing them, so a switch-back live-reattaches via
 * the existing adopt-first terminal mount. These are the project-scoped siblings of park/
 * disposeAllPtys; nothing calls the park path until the Phase-2 switch pipeline lands. */

/**
 * Core of `parkProjectSessions`: park every LIVE session owned by `dir` as a `'background'`
 * park — NO TTL (reaped only by disposeProjectPtys or quit's disposeAllPtys). Returns how many
 * sessions were parked. The no-op `reap` is never invoked (no timer is armed without a TTL).
 */
export function parkProjectSessionsCore(
  dir: string | null,
  sessionsMap: Map<string, SessionLike>,
  parkedMap: Map<string, ParkedLike>
): number {
  let parkedCount = 0
  for (const [id, s] of [...sessionsMap.entries()]) {
    if ((s.projectDir ?? null) !== dir) continue
    parkCore(id, sessionsMap, parkedMap, () => undefined, undefined, 'background')
    parkedCount++
  }
  return parkedCount
}

/** Park the ACTIVE project's live sessions for a background switch (Phase-2 pipeline entry). */
export function parkProjectSessions(dir: string | null): number {
  return parkProjectSessionsCore(dir, sessions, parked)
}

/**
 * Core of `disposeProjectPtys`: the project-scoped sibling of disposeAllPtysCore — reap the
 * parked sessions and tear down the live ones owned by `dir`, leaving every other project's
 * resident sessions untouched (closing project B must never kill backgrounded project A).
 */
export function disposeProjectPtysCore(
  dir: string | null,
  sessionsMap: Map<string, SessionLike>,
  parkedMap: Map<string, ParkedLike>,
  deps: Pick<SessionDeps, 'killTree'>,
  onReap?: (id: string) => void
): Promise<void> {
  const parkedDone = [...parkedMap.entries()]
    .filter(([, p]) => (p.owningDir ?? null) === dir)
    .map(([id]) => reapParkedCore(id, parkedMap, deps, onReap))
  const liveDone = [...sessionsMap.entries()]
    .filter(([, s]) => (s.projectDir ?? null) === dir)
    .map(([id]) => cleanupCore(id, sessionsMap, deps))
  return Promise.all([...parkedDone, ...liveDone]).then(() => undefined)
}

/** Kill every session (live + parked) owned by `dir` — the "Close project" path. */
export function disposeProjectPtys(dir: string | null): Promise<void> {
  // FIND-009 discipline: parked reaps forget their gitDiff cwd per-id (cleanupCore already
  // deletes the live ones) — no wholesale boardCwds.clear() here, other projects keep theirs.
  return disposeProjectPtysCore(dir, sessions, parked, sessionDeps, (id) => boardCwds.delete(id))
}

/**
 * Core of `countProjectSessions`: how many of `dir`'s terminals are RUNNING — live sessions
 * still in 'running' plus background-parked sessions (their procs run headless; an exited
 * parked proc is dropped from the map by its onExit, so parked ≈ running). Undo-parked
 * sessions are excluded: they are deleted boards, not running terminals of a project.
 */
export function countProjectSessionsCore(
  dir: string | null,
  sessionsMap: Map<string, Pick<SessionLike, 'state' | 'projectDir'>>,
  parkedMap: Map<string, Pick<ParkedLike, 'kind' | 'owningDir'>>
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

/** Running-terminal count for `dir` (switch dialog + switcher badges). */
export function countProjectSessions(dir: string | null): { running: number } {
  return countProjectSessionsCore(dir, sessions, parked)
}

/**
 * Snapshot of live PTY sessions for the MCP board registry (read-only; control
 * plane only — never the PTY data stream). Parked (deleted-but-undoable) sessions
 * are excluded: they are not live boards. Exited sessions are removed by cleanup()
 * on their onExit, so every listed board is effectively 'running' today.
 */
export function listPtySessions(): Array<{ id: string; status: PtyState }> {
  return [...sessions.entries()].map(([id, s]) => ({ id, status: s.state }))
}

/**
 * 🔒 Pure core of getTerminalRuntime (T-F1). Reads one board's runtime snapshot from the session
 * map. Keyed on `state`/`lastActivityAt`/`exitCode` only (narrowed map type) so it unit-tests with a
 * fake map. An absent id (non-terminal / closed / parked-not-live / already-cleaned-up) → undefined.
 * READ-ONLY, control-plane only — never the PTY data stream, never a write.
 */
export function getTerminalRuntimeCore(
  id: string,
  sessionMap: Map<string, { state: PtyState; lastActivityAt: number; exitCode?: number }>
): TerminalRuntime | undefined {
  const s = sessionMap.get(id)
  if (!s) return undefined
  return { state: s.state, lastActivityAt: s.lastActivityAt, exitCode: s.exitCode }
}

/**
 * MAIN-internal accessor for a terminal board's live runtime (T-F1), injected into the Context
 * Tier-2 summary loop (createSummaryLoop) so a board's prose can reflect running/idle/exited. Returns
 * undefined for any id without a LIVE session — the loop then omits the status line (never throws,
 * never blocks). Read-only; not exposed to the renderer.
 */
export function getTerminalRuntime(id: string): TerminalRuntime | undefined {
  return getTerminalRuntimeCore(id, sessions)
}

/**
 * 🔒 Pure core of getTerminalActivityStaleMs (BUG-007). Ms since the board's last PTY output,
 * computed against the injected `nowMs` clock. An absent id (non-terminal / closed / parked-not-live)
 * → undefined. Keyed on `lastActivityAt` only (narrowed map type) so it unit-tests with a fake map.
 * READ-ONLY, control-plane only — never the PTY data stream, never a write.
 */
export function getTerminalActivityStaleMsCore(
  id: string,
  sessionMap: Map<string, { lastActivityAt: number }>,
  nowMs: number
): number | undefined {
  const s = sessionMap.get(id)
  if (!s) return undefined
  return Math.max(0, nowMs - s.lastActivityAt)
}

/**
 * MAIN-internal activity-staleness predicate (BUG-007): ms since terminal board `id` last produced
 * PTY output. Drives the MCP idle-reaper's dormancy measure — a live agent shell's coarse status pill
 * stays 'running' for its whole lifetime, so the reaper can't use that bucket to detect a quiescent
 * board; output silence is the real dormancy signal. Returns undefined for any id without a LIVE
 * session (non-terminal / closed / parked) — the reaper then falls back to its status-bucket check.
 * Read-only; never exposed to the renderer.
 */
export function getTerminalActivityStaleMs(id: string): number | undefined {
  return getTerminalActivityStaleMsCore(id, sessions, Date.now())
}

/**
 * PR-2: the resolved spawn cwd for a board id, or undefined for a non-terminal / never-spawned
 * id. Read-only; control-plane only — gitDiff.ts runs `simple-git` against it in MAIN. Survives
 * park/adopt (boardCwds is keyed by board id, not session lifecycle).
 */
export function getTerminalCwd(id: string): string | undefined {
  return boardCwds.get(id)
}

/**
 * Gracefully close the live PTY for `id` before its board is removed (MCP close_board,
 * T3.2). Best-effort GRACEFUL FIRST: interrupt any running foreground agent (Ctrl-C)
 * and ask the shell to `exit`, then wait a short grace window for a natural exit
 * (onExit → cleanup drops it from `sessions`). Anything still alive after the window is
 * hard tree-killed via `cleanup` (taskkill /T /F — see "kill the tree"). A non-terminal
 * or absent id is a no-op. Always resolves; never throws on the PTY (close is
 * best-effort). The board-unmount `pty:kill` that follows the removal then no-ops.
 */
export async function drainPty(id: string, graceMs = 600): Promise<void> {
  return drainPtyCore(id, sessions, drainPtyDeps, graceMs)
}

/** Injectable dependencies for `drainPtyCore` (real ones bind module state). */
interface DrainDeps {
  /** Identity-aware teardown — pins the OLD proc so a respawn under the same id survives. */
  cleanup: (id: string, proc?: pty.IPty) => Promise<void>
  /** Grace-window poll. Injectable so the respawn race is deterministically testable. */
  sleep: (ms: number) => Promise<void>
}

const drainPtyDeps: DrainDeps = {
  cleanup: (id, proc) => cleanup(id, proc),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
}

/**
 * Core of `drainPty` (T3.2): graceful close then a hard tree-kill if the proc
 * outlives the grace window. Pure of module state so the respawn race is
 * unit-testable. PINS the original proc (BUG-001): if a `pty:spawn` replaces the
 * session under the SAME id during the grace window, (1) the poll's early-return
 * is gated on process IDENTITY — `sessions.has(id)` would stay true and never
 * bail — and (2) the final hard-kill passes the pinned OLD proc to the
 * identity-aware `cleanup`, so a respawned NEW session is never reaped (mirrors
 * the `onExit` pattern that passes its own `proc` to `cleanup`).
 */
export async function drainPtyCore(
  id: string,
  sessionsMap: Map<string, SessionLike>,
  deps: DrainDeps,
  graceMs: number
): Promise<void> {
  const s = sessionsMap.get(id)
  if (!s) return
  // Pin our own proc: a respawn under the same id within the grace window must
  // NOT cause us to tear down the replacement.
  const proc = s.proc
  try {
    proc.write('\x03') // Ctrl-C — interrupt a running foreground agent/command
    proc.write('exit\r') // then ask the shell itself to exit cleanly
  } catch {
    /* proc already gone — fall through to the hard kill */
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    // Identity, not mere presence: bail only when OUR proc has left the map
    // (exited cleanly OR was replaced by a respawn — either way nothing for us to kill).
    if (sessionsMap.get(id)?.proc !== proc) return
    await deps.sleep(60)
  }
  await deps.cleanup(id, proc) // still alive → hard tree-kill OUR proc (identity-guarded)
}

/**
 * Read one capped, ANSI-stripped, tail-anchored page of a board's PTY scrollback
 * for the MCP layer (T1.4 🔒). READ-ONLY, control-plane only — it reads the SAME
 * 256 KB ring (`buf`) that adopt-replay uses (live OR parked, so exited boards
 * stay readable for post-mortem), strips escape codes, and slices ONE page; it never
 * returns the raw unbounded buffer and never writes to the PTY. `truncatedHead` is
 * derived from ring saturation (`raw.length >= RING_CAP_BYTES`) so the page can
 * honestly report `droppedOlder` when the cap has discarded older output.
 */
export function readPtyOutput(id: string, opts?: { cursor?: number; limit?: number }): OutputPage {
  // Parked fallback is owner-scoped (R1): an active-project agent must not read a background
  // project's terminal output through a colliding board id.
  const box = sessions.get(id)?.buf ?? parkedForActiveProject(id)?.buf
  const raw = box ? readRing(box) : ''
  const truncatedHead = raw.length >= RING_CAP_BYTES
  return pageOutput(stripAnsi(raw), {
    cursor: opts?.cursor,
    limit: Math.min(opts?.limit ?? MAX_OUTPUT_PAGE, MAX_OUTPUT_PAGE),
    truncatedHead
  })
}

/**
 * E2E ONLY — append `text` straight into the live session's output ring (through the
 * real ring cap), simulating PTY output so the harness can deterministically
 * fill the buffer past the cap with known/ANSI content and assert the paged read.
 * Shell-agnostic (no dependence on what a command happens to print). Read path only;
 * exposes nothing to the renderer. Returns false if no live session holds `id`.
 */
export function debugSeedOutput(id: string, text: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  pushRing(s.buf, text)
  return true
}

/**
 * E2E (in-process smoke) ONLY — pid of the live OR parked session for `id`, so the
 * harness can assert process IDENTITY across a delete→undo (adopt must reattach the
 * SAME process, not spawn a new one). Read-only; exposes nothing new to the renderer.
 */
export function debugTerminalPid(id: string): number | null {
  return sessions.get(id)?.proc.pid ?? parked.get(id)?.proc.pid ?? null
}

/**
 * E2E ONLY — write directly to the live session's process (a runtime marker the
 * harness can look for in the replayed scrollback after undo). Not wired to the
 * renderer; the harness runs in MAIN and calls this directly.
 */
export function debugWriteTerminal(id: string, data: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.proc.write(data)
  return true
}

/**
 * 🔒 Pure core of the MCP dispatch write primitive (T4.3). Writes `text` into the live
 * session's PTY proc, keyed on the session map. ONLY terminals have sessions, so an
 * absent / non-terminal / unknown id has no entry → false (no write). A write into a
 * proc that has just exited can throw — we swallow it and return false rather than let
 * it crash MAIN (same discipline as `adoptCore`'s input forwarding). The boolean is the
 * caller's signal: the orchestrator audits a `false` as a failed dispatch and throws.
 */
export function writeToPtyCore(
  id: string,
  text: string,
  sessionMap: Map<string, { proc: Pick<pty.IPty, 'write'> }>
): boolean {
  const s = sessionMap.get(id)
  if (!s) return false
  try {
    s.proc.write(text)
    return true
  } catch {
    return false
  }
}

/**
 * 🔒 Production dispatch write (T4.3): write `text` into terminal board `id`'s PTY.
 * Returns false when no live terminal session holds the id (non-terminal target, closed
 * board, or a just-exited proc). MAIN-only; never exposed to the renderer. The MCP
 * dispatch path (mcpOrchestrator) calls this ONLY after a single-use nonce + a human
 * confirm + an audit entry have authorized the write.
 */
export function writeToPty(id: string, text: string): boolean {
  return writeToPtyCore(id, text, sessions)
}
