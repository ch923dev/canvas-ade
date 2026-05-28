import type { IpcMain, BrowserWindow, MessagePortMain } from 'electron'
import { MessageChannelMain } from 'electron'
import { execFile } from 'node:child_process'
import * as os from 'node:os'
import * as pty from 'node-pty'

/**
 * Terminal data plane lives on a MessagePort (binary-ish, high-volume PTY
 * output). Control (spawn/kill) is plain IPC. This is the architecture the
 * real Terminal board will use in Phase 2 — Phase 0 proves the bridge works.
 */
export interface SpawnOpts {
  id: string
  shell?: string
  args?: string[]
  cwd?: string
  cols?: number
  rows?: number
}

interface Session {
  proc: pty.IPty
  port: MessagePortMain
}

const sessions = new Map<string, Session>()

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

export function registerPtyHandlers(ipcMain: IpcMain, getWin: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', (_e, opts: SpawnOpts) => {
    const win = getWin()
    if (!win) throw new Error('pty:spawn — no window')

    const shell = opts.shell || defaultShell()
    const proc = pty.spawn(shell, opts.args ?? [], {
      name: 'xterm-256color',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd || os.homedir(),
      env: { ...process.env } as Record<string, string>
    })

    const { port1, port2 } = new MessageChannelMain()

    proc.onData((d) => port1.postMessage({ t: 'data', d }))
    proc.onExit(({ exitCode }) => {
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
    return { id: opts.id, shell, pid: proc.pid }
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
