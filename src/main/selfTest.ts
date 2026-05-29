import type { BrowserWindow } from 'electron'
import { WebContentsView } from 'electron'
import * as os from 'node:os'
import * as pty from 'node-pty'

export interface SelfTestResult {
  pty: boolean
  ptyDetail: string
  preview: boolean
  previewDetail: string
}

/**
 * Headless smoke for the MAIN-process dependencies: spawn a real PTY and run a
 * sentinel command, and load a localhost page into a throwaway WebContentsView.
 * Renderer deps (React Flow, xterm) self-report via console (see App.tsx).
 * Run with CANVAS_SMOKE=1 (keep open) or CANVAS_SMOKE=exit (quit after).
 */
export async function runSelfTest(win: BrowserWindow, localUrl: string): Promise<SelfTestResult> {
  const result: SelfTestResult = {
    pty: false,
    ptyDetail: '',
    preview: false,
    previewDetail: ''
  }

  await testPty(result)
  await testPreview(win, localUrl, result)
  return result
}

function testPty(result: SelfTestResult): Promise<void> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const shell = isWin ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash'
    const sentinel = 'CANVAS_PTY_' + 'OK'
    let buf = ''
    let done = false

    const finish = (ok: boolean, detail: string): void => {
      if (done) return
      done = true
      result.pty = ok
      result.ptyDetail = detail
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      resolve()
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: os.homedir(),
        env: { ...process.env } as Record<string, string>
      })
    } catch (err) {
      finish(false, `spawn failed: ${(err as Error).message}`)
      return
    }

    proc.onData((d) => {
      buf += d
      // The shell echoes our command AND prints the result; the printed token
      // appears on its own (the echo contains the concatenation expression).
      if (buf.includes(sentinel)) finish(true, `pty pid=${proc.pid} shell=${shell}`)
    })
    proc.onExit(() => {
      if (!done) finish(buf.includes(sentinel), `exited; sawSentinel=${buf.includes(sentinel)}`)
    })

    // Print the two halves concatenated so only the RESULT contains the token.
    const cmd = isWin ? `echo CANVAS_PTY_OK & exit\r` : `printf 'CANVAS_PTY_OK\\n'; exit\n`
    proc.write(cmd)

    setTimeout(
      () => finish(buf.includes(sentinel), `timeout; sawSentinel=${buf.includes(sentinel)}`),
      6000
    )
  })
}

function testPreview(win: BrowserWindow, localUrl: string, result: SelfTestResult): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    const finish = (ok: boolean, detail: string): void => {
      if (done) return
      done = true
      result.preview = ok
      result.previewDetail = detail
      try {
        win.contentView.removeChildView(view)
        view.webContents.close()
      } catch {
        /* ignore */
      }
      resolve()
    }

    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 400, height: 300 })
    view.webContents.once('did-finish-load', () => finish(true, `loaded ${localUrl}`))
    view.webContents.once('did-fail-load', (_e, code, desc) =>
      finish(false, `did-fail-load ${code} ${desc}`)
    )
    void view.webContents.loadURL(localUrl)
    setTimeout(() => finish(false, 'timeout loading localhost'), 6000)
  })
}
