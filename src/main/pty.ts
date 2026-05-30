import type { IpcMain, BrowserWindow, MessagePortMain } from 'electron'
import { MessageChannelMain } from 'electron'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as pty from 'node-pty'

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

interface Session {
  proc: pty.IPty
  port: MessagePortMain
  /**
   * Recent output, boxed so the SAME reference travels into `parked` on park and
   * back into a session on adopt — the single `proc.onData` listener keeps appending
   * to it across the move (closures capture the box, not the map entry).
   */
  buf: { data: string }
}

const sessions = new Map<string, Session>()

interface Parked {
  proc: pty.IPty
  buf: { data: string }
  timer: ReturnType<typeof setTimeout>
}

/** Deleted-but-undoable sessions, kept alive up to PARK_TTL_MS for adopt-on-undo. */
const parked = new Map<string, Parked>()

/** Reap a parked session: stop its TTL timer and kill its process tree. */
function reapParked(id: string): Promise<void> {
  const p = parked.get(id)
  if (!p) return Promise.resolve()
  parked.delete(id)
  clearTimeout(p.timer)
  return killTree(p.proc)
}

/**
 * Park the live session for `id` instead of killing it (#15): move it out of
 * `sessions` (so the board-unmount's `pty:kill` no-ops), close the renderer port
 * (the proc keeps running and the onData listener keeps recording into `buf`), and
 * start a TTL after which the process tree is reaped if no undo adopts it.
 */
function park(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.port.close()
  } catch {
    /* already closed */
  }
  const timer = setTimeout(() => void reapParked(id), PARK_TTL_MS)
  timer.unref?.()
  parked.set(id, { proc: s.proc, buf: s.buf, timer })
}

/**
 * Adopt a parked session for `id` (#15): clear its TTL, bind a fresh MessagePort
 * to the still-running proc, move it back into `sessions`, replay the recorded
 * output buffer so the re-mounted xterm reconstructs its scrollback, and re-emit
 * `running`. Returns the live pid so the e2e can assert process identity. If no
 * session is parked, returns `{ adopted: false }` and the caller spawns fresh.
 */
function adopt(id: string, win: BrowserWindow): { adopted: boolean; pid?: number } {
  const p = parked.get(id)
  if (!p) return { adopted: false }
  clearTimeout(p.timer)
  parked.delete(id)

  const { port1, port2 } = new MessageChannelMain()
  port1.on('message', (e) => {
    const m = e.data as { t: string; d?: string; cols?: number; rows?: number }
    // Guard as in the spawn handler: a write/resize on an exited pty throws and
    // would escape to uncaughtException → app.exit(1). Swallow it.
    try {
      if (m.t === 'input' && typeof m.d === 'string') p.proc.write(m.d)
      else if (m.t === 'resize' && m.cols && m.rows) p.proc.resize(m.cols, m.rows)
    } catch {
      /* pty already exited */
    }
  })
  port1.start()

  // Back into `sessions` with the SAME boxed buffer; the spawn-time onData listener
  // now forwards live output to this new port (it looks up sessions.get(id)).
  sessions.set(id, { proc: p.proc, port: port1, buf: p.buf })
  win.webContents.postMessage('pty:port', { id }, [port2])

  // Replay recorded scrollback, then re-announce running.
  if (p.buf.data) port1.postMessage({ t: 'data', d: p.buf.data })
  port1.postMessage({ t: 'state', state: 'running' satisfies PtyState })

  return { adopted: true, pid: p.proc.pid }
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

export function registerPtyHandlers(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  ipcMain.handle('pty:shells', () => enumerateShells())

  ipcMain.handle('pty:spawn', (_e, opts: SpawnOpts) => {
    const win = getWin()
    if (!win) throw new Error('pty:spawn — no window')

    const shell = opts.shell || enumerateShells()[0].path
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
        cwd: opts.cwd || os.homedir(),
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
      // adopt onto the new port); none while parked → guard the post.
      const live = sessions.get(opts.id)
      if (live) {
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
        else if (m.t === 'resize' && m.cols && m.rows) proc.resize(m.cols, m.rows)
      } catch {
        /* pty already exited */
      }
    })
    port1.start()

    sessions.set(opts.id, { proc, port: port1, buf })
    win.webContents.postMessage('pty:port', { id: opts.id }, [port2])

    // Announce running, then — spawn the SHELL, not the agent — write the
    // launchCommand as the first PTY line so the agent inherits PATH/profile/auth.
    port1.postMessage({ t: 'state', state: 'running' satisfies PtyState })
    const launch = opts.launchCommand?.trim()
    if (launch) proc.write(launch + '\r')

    return { id: opts.id, shell, pid: proc.pid, state: 'running' as PtyState }
  })

  ipcMain.handle('pty:kill', (_e, id: string) => {
    cleanup(id)
    return true
  })

  ipcMain.handle('pty:park', (_e, id: string) => {
    park(id)
    return true
  })

  ipcMain.handle('pty:adopt', (_e, id: string) => {
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
function cleanup(id: string, proc?: pty.IPty): Promise<void> {
  const s = sessions.get(id)
  if (!s) return Promise.resolve()
  if (isStaleExit(s.proc, proc)) return Promise.resolve()
  sessions.delete(id)
  const done = killTree(s.proc)
  try {
    s.port.close()
  } catch {
    /* port already closed */
  }
  return done
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
  const pid = proc.pid
  if (process.platform === 'win32') {
    // taskkill /T /F reaps the descendant tree (taskkill alone, since proc.kill()
    // only signals the console process list, not deeply re-parented children).
    const reaped = new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => finish())
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
      process.kill(-pid, 'SIGKILL')
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
  const parkedDone = [...parked.keys()].map((id) => reapParked(id))
  const liveDone = [...sessions.keys()].map((id) => cleanup(id))
  return Promise.all([...parkedDone, ...liveDone]).then(() => undefined)
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
