import type { IpcMain, BrowserWindow, MessagePortMain, IpcMainInvokeEvent } from 'electron'
import { MessageChannelMain } from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as pty from 'node-pty'
import { parsePortsFromOutput } from './portDetect'
import { MAX_OUTPUT_PAGE, pageOutput, stripAnsi, type OutputPage } from './ptyOutput'
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
 * Append `chunk` to a capped output ring buffer, keeping only the last `cap`
 * characters (drop-oldest). Pure, so it is unit-tested. Used to record each
 * session's recent output for replay when a deleted terminal is adopted on undo.
 */
export function appendRing(prev: string, chunk: string, cap: number): string {
  const next = prev + chunk
  return next.length <= cap ? next : next.slice(next.length - cap)
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

/** One discoverable shell on this OS, surfaced to the per-board shell picker. */
export interface ShellInfo {
  /** Absolute path or bare command passed to `pty.spawn`. */
  path: string
  /** Short display label, e.g. `pwsh` / `bash`. */
  label: string
  /** True for the OS-aware default (the first match). */
  default?: boolean
}

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
   * Recent output, boxed so the SAME reference travels into `parked` on park and
   * back into a session on adopt — the single `proc.onData` listener keeps appending
   * to it across the move (closures capture the box, not the map entry).
   */
  buf: { data: string }
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
}
interface ParkedLike {
  proc: pty.IPty
  buf: { data: string }
  timer: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, SessionLike>()

/** Deleted-but-undoable sessions, kept alive up to PARK_TTL_MS for adopt-on-undo. */
const parked = new Map<string, ParkedLike>()

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
 */
export function reapParkedCore(
  id: string,
  parkedMap: Map<string, ParkedLike>,
  deps: Pick<SessionDeps, 'killTree'>
): Promise<void> {
  const p = parkedMap.get(id)
  if (!p) return Promise.resolve()
  parkedMap.delete(id)
  clearTimeout(p.timer)
  return deps.killTree(p.proc)
}

/**
 * Core of `park` (#15): move the live session out of `sessions`, close its
 * renderer port, arm a TTL whose expiry reaps the tree, and store it in `parked`.
 * `reap` is the bound reaper invoked when the timer fires.
 */
export function parkCore(
  id: string,
  sessionsMap: Map<string, SessionLike>,
  parkedMap: Map<string, ParkedLike>,
  reap: (id: string) => void,
  parkTtlMs: number
): void {
  const s = sessionsMap.get(id)
  if (!s) return
  sessionsMap.delete(id)
  try {
    s.port.close()
  } catch {
    /* already closed */
  }
  const timer = setTimeout(() => reap(id), parkTtlMs)
  timer.unref?.()
  parkedMap.set(id, { proc: s.proc, buf: s.buf, timer })
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
  deps: Pick<SessionDeps, 'newChannel'>,
  transferPort: (port2: MessagePortMain) => void
): { adopted: boolean; pid?: number } {
  const p = parkedMap.get(id)
  if (!p) return { adopted: false }
  clearTimeout(p.timer)
  parkedMap.delete(id)

  const { port1, port2 } = deps.newChannel()
  port1.on('message', (e) => {
    const m = e.data as { t: string; d?: string; cols?: number; rows?: number }
    // Guard as in the spawn handler: a write/resize on an exited pty throws and
    // would escape to uncaughtException → app.exit(1). Swallow it.
    try {
      if (m.t === 'input' && typeof m.d === 'string') p.proc.write(m.d)
      else if (m.t === 'resize' && isValidResize(m.cols!, m.rows!)) p.proc.resize(m.cols!, m.rows!)
    } catch {
      /* pty already exited */
    }
  })
  port1.start()

  // Back into `sessions` with the SAME boxed buffer; the spawn-time onData listener
  // now forwards live output to this new port (it looks up sessions.get(id)).
  sessionsMap.set(id, {
    proc: p.proc,
    port: port1,
    buf: p.buf,
    state: 'running',
    lastActivityAt: Date.now() // T-F1: adopt = fresh activity (scrollback is about to replay)
  })
  transferPort(port2)

  // Replay recorded scrollback, then re-announce running.
  if (p.buf.data) port1.postMessage({ t: 'data', d: p.buf.data })
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
  return reapParkedCore(id, parked, sessionDeps)
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
  return adoptCore(id, sessions, parked, sessionDeps, (port2) =>
    win.webContents.postMessage('pty:port', { id }, [port2])
  )
}

/**
 * Canonical dedupe key for a shell path. Resolves 8.3 short names, junctions,
 * and symlinks via `realpathSync.native` (so a non-canonical COMSPEC and
 * `onPath('cmd')` that point at the SAME cmd.exe collapse to one key), falling
 * back to a normalized path when the target doesn't exist. Pure except for the
 * realpath probe; the resolver is injectable so it is unit-testable.
 */
export function canonicalizeShellPath(
  p: string,
  realpath: (q: string) => string = (q) => fs.realpathSync.native(q)
): string {
  try {
    return realpath(p)
  } catch {
    return path.normalize(p)
  }
}

/** First existing path on the system PATH for a bare command name. */
function onPath(cmd: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/** First of the candidate absolute paths that exists as a file. */
function firstFile(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {
      /* unreadable */
    }
  }
  return null
}

/**
 * SEC-1: validate a spawn cwd. The renderer's `opts.cwd` is trusted-user input but a
 * corrupt/hand-edited canvas.json can carry a missing or non-dir path; an invalid cwd
 * throws inside pty.spawn. Mirror the `shell`/`dir` hardening: fall back to home unless
 * cwd is an existing directory.
 */
export function safeCwd(cwd?: string): string {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) return cwd
  } catch {
    /* not accessible / does not exist → fall through */
  }
  return os.homedir()
}

/**
 * Git for Windows' `bash.exe` (Git Bash), if installed. Probes the install root
 * derived from `git` on PATH (`…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`) plus
 * the usual Program Files / per-user locations. This is the REAL Git Bash, not
 * the `WindowsApps\bash.exe` Store alias (which is just the WSL launcher).
 */
function findGitBash(): string | null {
  const roots: string[] = []
  const git = onPath('git') // …\Git\cmd\git.exe → root is two dirs up
  if (git) roots.push(path.dirname(path.dirname(git)))
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  roots.push(path.join(pf, 'Git'), path.join(pf86, 'Git'))
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'))
  return firstFile(...roots.map((r) => path.join(r, 'bin', 'bash.exe')))
}

/** WSL launcher — prefer the real System32 binary over the WindowsApps alias. */
function findWsl(): string | null {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  return firstFile(path.join(sysRoot, 'System32', 'wsl.exe')) || onPath('wsl')
}

/**
 * Discoverable shells, OS-aware, best-default first (CLAUDE.md: Win
 * pwsh > powershell > cmd; *nix `$SHELL` then zsh > bash). Pure of side effects
 * beyond filesystem probes; the list drives the per-board shell picker, and the
 * head element is the spawn default when the board has no explicit `shell`.
 */
export function enumerateShells(): ShellInfo[] {
  const found: ShellInfo[] = []
  const seen = new Set<string>()
  const seenLabels = new Set<string>()
  const add = (p: string | null | undefined, label: string): void => {
    if (!p) return
    // Canonicalize first so 8.3/junction/symlink variants of the same binary
    // (e.g. a non-canonical COMSPEC vs onPath('cmd')) collapse to one entry, and
    // store the resolved path so the picker shows a single stable value.
    const resolved = canonicalizeShellPath(p)
    const key = resolved.toLowerCase()
    // Belt-and-suspenders: also dedupe by label, so the two `cmd` adds can never
    // both surface even if their canonical paths somehow differ.
    if (seen.has(key) || seenLabels.has(label)) return
    seen.add(key)
    seenLabels.add(label)
    found.push({ path: resolved, label })
  }

  if (process.platform === 'win32') {
    add(onPath('pwsh'), 'pwsh')
    add(onPath('powershell'), 'powershell')
    add(process.env.COMSPEC, 'cmd')
    add(onPath('cmd'), 'cmd')
    add(findGitBash(), 'git bash')
    add(findWsl(), 'wsl')
    // A standalone bash/zsh on PATH (e.g. MSYS2/Cygwin), skipping the
    // WindowsApps Store alias which is just the WSL launcher (already added).
    const stdBash = onPath('bash')
    if (stdBash && !/WindowsApps/i.test(stdBash)) add(stdBash, 'bash')
    const stdZsh = onPath('zsh')
    if (stdZsh && !/WindowsApps/i.test(stdZsh)) add(stdZsh, 'zsh')
  } else {
    if (process.env.SHELL) add(process.env.SHELL, path.basename(process.env.SHELL))
    add(onPath('zsh'), 'zsh')
    add(onPath('bash'), 'bash')
    add('/bin/bash', 'bash')
  }

  if (found.length === 0) found.push({ path: defaultShell(), label: 'shell' })
  found[0].default = true
  return found
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * M5 (defense-in-depth): validate a board's persisted `shell` before it reaches
 * `pty.spawn`. A corrupt/hand-edited `canvas.json` could otherwise name an
 * arbitrary binary that main would execute. Accept `shell` ONLY if (after
 * canonicalization) it matches one of the enumerated, system-discovered shells;
 * otherwise fall back to the OS-aware default (`shells[0]`). `undefined`/empty
 * also falls back. Pure (the canonicalize probe is the only side effect) so it
 * is unit-testable against a fixed `shells` list.
 */
export function resolveShell(shell: string | undefined, shells: ShellInfo[]): string {
  const fallback = shells[0]?.path ?? defaultShell()
  if (!shell) return fallback
  const wanted = canonicalizeShellPath(shell).toLowerCase()
  const ok = shells.some((s) => canonicalizeShellPath(s.path).toLowerCase() === wanted)
  return ok ? shell : fallback
}

/**
 * Bug #33 (defense-in-depth): reject IPC that did not originate from the main
 * window's main frame. ipcMain channels are shared by ALL webContents, including the
 * per-board preview WebContentsViews that load untrusted localhost content. Today
 * those views have no preload (no ipcRenderer), so this is not exploitable — but the
 * allowlist ENFORCES the PTY-isolation invariant rather than leaving it incidental to
 * the absence of a preview preload. A synthetic/internal call (no senderFrame) is
 * allowed; only a real foreign frame is blocked.
 */
export function isForeignSender(
  e: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  getMainFrame: () => unknown | null
): boolean {
  const main = getMainFrame()
  // A synthetic/internal call has no senderFrame — always allow (e.g. our own
  // in-process e2e harness invoking a handler directly).
  if (!e.senderFrame) return false
  // A REAL sender but the window/main-frame is unresolved (destroyed/closing):
  // we can't prove it's the trusted frame, so treat it as foreign and DENY.
  if (!main) return true
  return e.senderFrame !== main
}

export function registerPtyHandlers(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  // Resolve the trusted main frame lazily at call time — the window may be
  // (re)created or destroyed across a handler's lifetime.
  const getMainFrame = (): unknown | null => getWin()?.webContents.mainFrame ?? null

  ipcMain.handle('pty:shells', (e) => (isForeignSender(e, getMainFrame) ? [] : enumerateShells()))

  ipcMain.handle('terminal:detectPorts', (e, id: string) => {
    if (isForeignSender(e, getMainFrame)) return []
    // Read whichever buffer holds this board's output — live session or parked.
    const raw = sessions.get(id)?.buf.data ?? parked.get(id)?.buf.data ?? ''
    return parsePortsFromOutput(raw)
  })

  ipcMain.handle('pty:spawn', (e, opts: SpawnOpts) => {
    if (isForeignSender(e, getMainFrame)) throw new Error('pty:spawn — forbidden sender')
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
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: safeCwd(opts.cwd),
        env: { ...process.env } as Record<string, string>
      })
    } catch (err) {
      // No live session was registered, so report the failure straight back.
      const message = err instanceof Error ? err.message : String(err)
      return { id: opts.id, shell, pid: -1, state: 'spawn-failed' as PtyState, error: message }
    }

    const { port1, port2 } = new MessageChannelMain()

    const buf = { data: '' }
    proc.onData((d) => {
      buf.data = appendRing(buf.data, d, RING_CAP_BYTES)
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
      }
    })

    port1.on('message', (e) => {
      const m = e.data as { t: string; d?: string; cols?: number; rows?: number }
      // node-pty's write/resize THROW on an exited-but-not-yet-reaped pty
      // (resize: 'Cannot resize a pty that has already exited'). The throw would
      // escape this EventEmitter listener as an uncaughtException → app.exit(1),
      // crashing the whole app — so swallow it (the session is being torn down).
      try {
        if (m.t === 'input' && typeof m.d === 'string') proc.write(m.d)
        else if (m.t === 'resize' && isValidResize(m.cols!, m.rows!)) proc.resize(m.cols!, m.rows!)
      } catch {
        /* pty already exited */
      }
    })
    port1.start()

    sessions.set(opts.id, { proc, port: port1, buf, state: 'running', lastActivityAt: Date.now() })
    win.webContents.postMessage('pty:port', { id: opts.id }, [port2])

    // Announce running, then — spawn the SHELL, not the agent — write the
    // launchCommand as the first PTY line so the agent inherits PATH/profile/auth.
    port1.postMessage({ t: 'state', state: 'running' satisfies PtyState })
    const launch = opts.launchCommand?.trim()
    if (launch) proc.write(launch + '\r')

    return { id: opts.id, shell, pid: proc.pid, state: 'running' as PtyState }
  })

  ipcMain.handle('pty:kill', (e, id: string) => {
    if (isForeignSender(e, getMainFrame)) return false
    cleanup(id)
    return true
  })

  // PTY-1: tear down EVERY session — live AND parked — for a project switch. The
  // per-board `pty:kill` loop missed parked sessions (a terminal deleted <PARK_TTL
  // ago, awaiting undo, lives in the `parked` map, not `sessions`), leaking its
  // child tree until the 120s TTL fired. disposeAllPtys() drains both maps now.
  ipcMain.handle('pty:disposeAll', (e) => {
    if (isForeignSender(e, getMainFrame)) return false
    return disposeAllPtys().then(() => true)
  })

  ipcMain.handle('pty:park', (e, id: string) => {
    if (isForeignSender(e, getMainFrame)) return false
    park(id)
    return true
  })

  ipcMain.handle('pty:adopt', (e, id: string) => {
    if (isForeignSender(e, getMainFrame)) return { adopted: false }
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
  const done = deps.killTree(s.proc)
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
  return disposeAllPtysCore(sessions, parked, sessionDeps)
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
 * Gracefully close the live PTY for `id` before its board is removed (MCP close_board,
 * T3.2). Best-effort GRACEFUL FIRST: interrupt any running foreground agent (Ctrl-C)
 * and ask the shell to `exit`, then wait a short grace window for a natural exit
 * (onExit → cleanup drops it from `sessions`). Anything still alive after the window is
 * hard tree-killed via `cleanup` (taskkill /T /F — see "kill the tree"). A non-terminal
 * or absent id is a no-op. Always resolves; never throws on the PTY (close is
 * best-effort). The board-unmount `pty:kill` that follows the removal then no-ops.
 */
export async function drainPty(id: string, graceMs = 600): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.write('\x03') // Ctrl-C — interrupt a running foreground agent/command
    s.proc.write('exit\r') // then ask the shell itself to exit cleanly
  } catch {
    /* proc already gone — fall through to the hard kill */
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!sessions.has(id)) return // exited cleanly within the grace window
    await new Promise((r) => setTimeout(r, 60))
  }
  await cleanup(id) // still alive → hard tree-kill
}

/**
 * Read one capped, ANSI-stripped, tail-anchored page of a board's PTY scrollback
 * for the MCP layer (T1.4 🔒). READ-ONLY, control-plane only — it reads the SAME
 * 256 KB ring (`buf.data`) that adopt-replay uses (live OR parked, so exited boards
 * stay readable for post-mortem), strips escape codes, and slices ONE page; it never
 * returns the raw unbounded buffer and never writes to the PTY. `truncatedHead` is
 * derived from ring saturation (`raw.length >= RING_CAP_BYTES`) so the page can
 * honestly report `droppedOlder` when the cap has discarded older output.
 */
export function readPtyOutput(id: string, opts?: { cursor?: number; limit?: number }): OutputPage {
  const raw = sessions.get(id)?.buf.data ?? parked.get(id)?.buf.data ?? ''
  const truncatedHead = raw.length >= RING_CAP_BYTES
  return pageOutput(stripAnsi(raw), {
    cursor: opts?.cursor,
    limit: Math.min(opts?.limit ?? MAX_OUTPUT_PAGE, MAX_OUTPUT_PAGE),
    truncatedHead
  })
}

/**
 * E2E ONLY — append `text` straight into the live session's output ring (through the
 * real `appendRing` cap), simulating PTY output so the harness can deterministically
 * fill the buffer past the cap with known/ANSI content and assert the paged read.
 * Shell-agnostic (no dependence on what a command happens to print). Read path only;
 * exposes nothing to the renderer. Returns false if no live session holds `id`.
 */
export function debugSeedOutput(id: string, text: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.buf.data = appendRing(s.buf.data, text, RING_CAP_BYTES)
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
