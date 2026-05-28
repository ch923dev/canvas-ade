import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

const THEME = {
  background: '#0e0e10',
  foreground: '#ededee',
  cursor: '#4f8cff',
  selectionBackground: 'rgba(79,140,255,0.25)',
  black: '#0e0e10',
  brightBlack: '#46464b',
  red: '#f2545b',
  green: '#3ecf8e',
  yellow: '#e8b339',
  blue: '#4f8cff',
  white: '#9b9ba1',
  brightWhite: '#ededee'
}

const TERM_ID = 'smoke-term'

export default function TerminalSmoke() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* GL unavailable — falls back to DOM/canvas renderer */
    }
    fit.fit()

    let port: MessagePort | null = null

    const onWinMsg = (e: MessageEvent): void => {
      const data = e.data as { __ptyPort?: boolean; id?: string }
      if (!data || !data.__ptyPort || data.id !== TERM_ID) return
      port = e.ports[0]
      port.onmessage = (ev): void => {
        const m = ev.data as { t: string; d?: string; code?: number }
        if (m.t === 'data' && m.d) term.write(m.d)
        else if (m.t === 'exit') term.write(`\r\n\x1b[90m[process exited: ${m.code}]\x1b[0m\r\n`)
      }
      port.start()
      term.onData((d) => port?.postMessage({ t: 'input', d }))
      term.onResize(({ cols, rows }) => port?.postMessage({ t: 'resize', cols, rows }))
    }
    window.addEventListener('message', onWinMsg)

    window.api
      .spawnTerminal({ id: TERM_ID, cols: term.cols, rows: term.rows })
      .catch((err: Error) => term.write(`\x1b[31mspawn failed: ${err.message}\x1b[0m\r\n`))

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* element detached */
      }
    })
    ro.observe(el)

    return () => {
      window.removeEventListener('message', onWinMsg)
      ro.disconnect()
      void window.api.killTerminal(TERM_ID)
      try {
        port?.close()
      } catch {
        /* ignore */
      }
      term.dispose()
    }
  }, [])

  return (
    <>
      <div className="hint">xterm.js ⇄ node-pty over a MessagePort · type to interact</div>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--inset)' }}>
        <div ref={ref} style={{ position: 'absolute', inset: 0, padding: 8 }} />
      </div>
    </>
  )
}
