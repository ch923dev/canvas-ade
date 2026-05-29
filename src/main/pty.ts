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

interface Session {
  proc: pty.IPty
  port: MessagePortMain
}

const sessions = new Map<string, Session>()

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

/**
 * Discoverable shells, OS-aware, best-default first (CLAUDE.md: Win
 * pwsh > powershell > cmd; *nix `$SHELL` then zsh > bash). Pure of side effects
 * beyond filesystem probes; the list drives the per-board shell picker, and the
 * head element is the spawn default when the board has no explicit `shell`.
 */
export function enumerateShells(): ShellInfo[] {
  const found: ShellInfo[] = []
  const seen = new Set<string>()
  const add = (p: string | null | undefined, label: string): void => {
    if (!p) return
    const key = p.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push({ path: p, label })
  }

  if (process.platform === 'win32') {
    add(onPath('pwsh'), 'pwsh')
    add(onPath('powershell'), 'powershell')
    add(process.env.COMSPEC, 'cmd')
    add(onPath('cmd'), 'cmd')
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
    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, opts.args ?? [], {
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

    proc.onData((d) => port1.postMessage({ t: 'data', d }))
    proc.onExit(({ exitCode }) => {
      port1.postMessage({ t: 'state', state: 'exited' satisfies PtyState, code: exitCode })
      port1.postMessage({ t: 'exit', code: exitCode })
      cleanup(opts.id)
    })

    port1.on('message', (e) => {
      const m = e.data as { t: string; d?: string; cols?: number; rows?: number }
      if (m.t === 'input' && typeof m.d === 'string') proc.write(m.d)
      else if (m.t === 'resize' && m.cols && m.rows) proc.resize(m.cols, m.rows)
    })
    port1.start()

    sessions.set(opts.id, { proc, port: port1 })
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
}

function cleanup(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  killTree(s.proc)
  try {
    s.port.close()
  } catch {
    /* port already closed */
  }
}

/**
 * Agentic CLIs spawn child process trees. On Windows a bare kill() leaves
 * orphans, so kill the whole tree with taskkill /T /F.
 */
function killTree(proc: pty.IPty): void {
  const pid = proc.pid
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
      /* best effort */
    })
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
  }
}

export function disposeAllPtys(): void {
  for (const id of [...sessions.keys()]) cleanup(id)
}
