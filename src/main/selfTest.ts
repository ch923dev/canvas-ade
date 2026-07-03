import * as os from 'node:os'
import * as pty from 'node-pty'
import { probeOsrPaint, probeOsrPaintWindow } from './previewOsrProbe'

export interface SelfTestResult {
  pty: boolean
  ptyDetail: string
  // Does an off-tree offscreen view paint? (the OSR engine's make-or-break check)
  // osr = bare WebContentsView; osrWin = hidden offscreen BrowserWindow (the OSR host).
  osr: boolean
  osrDetail: string
  osrWin: boolean
  osrWinDetail: string
}

/**
 * Headless smoke for the MAIN-process dependencies: spawn a real PTY and run a
 * sentinel command, and stream a localhost page through the offscreen (OSR) preview.
 * Renderer deps (React Flow, xterm) self-report via console (see App.tsx).
 * Run with CANVAS_SMOKE=1 (keep open) or CANVAS_SMOKE=exit (quit after).
 */
export async function runSelfTest(localUrl: string): Promise<SelfTestResult> {
  const result: SelfTestResult = {
    pty: false,
    ptyDetail: '',
    osr: false,
    osrDetail: '',
    osrWin: false,
    osrWinDetail: ''
  }

  await testPty(result)
  // The make-or-break check — an offscreen view must stream a real frame. Run both
  // hosts: a bare off-tree WebContentsView, and a hidden offscreen BrowserWindow.
  const osr = await probeOsrPaint(localUrl)
  result.osr = osr.painted
  result.osrDetail = osr.detail
  const osrWin = await probeOsrPaintWindow(localUrl)
  result.osrWin = osrWin.painted
  result.osrWinDetail = osrWin.detail
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
