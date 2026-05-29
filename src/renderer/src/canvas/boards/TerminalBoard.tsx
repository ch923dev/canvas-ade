/**
 * Terminal board content (Phase 2.1) — a live xterm.js terminal bridged to
 * `node-pty` in MAIN over the MessagePort data plane (high-volume PTY output)
 * with the spawn/kill control plane on `ipcRenderer.invoke`, keyed by board id.
 *
 * Per CLAUDE.md we spawn the SHELL, not the agent; if `board.launchCommand` is
 * set it is written as the first PTY line (in `pty.ts`) so the agent inherits
 * PATH/profile/auth. Chrome follows DESIGN.md §7.1: agent identity pill + run
 * timer, a 2px `--accent` indeterminate progress sliver while running (via
 * `BoardFrame running`), a braille spinner working line, and a bottom follow-up
 * prompt with a blinking caret. Title-bar actions: play/pause · restart ·
 * interrupt (Ctrl-C). Owns this file only; the shared surface is frozen.
 *
 * Lifecycle (spawning → running → awaiting-input → exited / spawn-failed) is
 * driven by the `{ t: 'state', … }` messages the bridge pushes over the port.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { TerminalConfig } from './TerminalConfig'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import { BoardFrame, IconBtn } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import {
  agentIdentity,
  brailleFrame,
  formatTimer,
  isRunning,
  statusFor,
  type TerminalState
} from './terminalState'

/** xterm palette mirrored from the design tokens (DESIGN.md §2). */
const THEME = {
  background: '#0e0e10', // --inset
  foreground: '#ededee', // --text
  cursor: '#4f8cff', // --accent
  cursorAccent: '#0e0e10',
  selectionBackground: 'rgba(79,140,255,0.25)',
  black: '#0e0e10',
  brightBlack: '#46464b',
  red: '#f2545b',
  green: '#3ecf8e',
  yellow: '#e8b339',
  blue: '#4f8cff',
  magenta: '#b18cff',
  cyan: '#3ecfce',
  white: '#9b9ba1',
  brightWhite: '#ededee'
} as const

/** A control-plane message arriving over the data-plane MessagePort. */
interface PortMessage {
  t: 'data' | 'exit' | 'state'
  d?: string
  code?: number
  state?: TerminalState
}

export function TerminalBoard({
  board,
  selected,
  hovered,
  dimmed
}: BoardViewProps<TerminalBoardData>): ReactElement {
  const screenRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const portRef = useRef<MessagePort | null>(null)

  const [state, setState] = useState<TerminalState>('spawning')
  const [elapsed, setElapsed] = useState(0)
  const [frame, setFrame] = useState(0)
  const [configOpen, setConfigOpen] = useState(false)

  const identity = agentIdentity(board.launchCommand, board.shell)
  const running = isRunning(state)

  // ── Bridge: spawn the PTY, wire the MessagePort, fit on resize ──────────────
  // Keyed by board id so re-mounts (LOD swaps, drags) reconnect the same session
  // intent. The effect owns the full lifecycle and tears the session down on
  // unmount (kill the tree in MAIN via `killTerminal`).
  const spawn = useCallback((): (() => void) => {
    const el = screenRef.current
    if (!el) return () => {}

    const term = new Terminal({
      fontFamily: 'var(--mono), ui-monospace, Menlo, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      term.loadAddon(new WebglAddon())
    } catch {
      /* GL unavailable — xterm falls back to the DOM/canvas renderer */
    }
    try {
      fit.fit()
    } catch {
      /* element not laid out yet */
    }
    termRef.current = term
    fitRef.current = fit

    // Forward keystrokes + resizes to whatever port is CURRENT. Registered ONCE
    // (not inside onWinMsg) so a restart — which delivers a fresh port through the
    // same persistent message listener — doesn't stack duplicate xterm listeners;
    // the disposables are released on teardown.
    const dataDisp = term.onData((d) => portRef.current?.postMessage({ t: 'input', d }))
    const resizeDisp = term.onResize(({ cols, rows }) =>
      portRef.current?.postMessage({ t: 'resize', cols, rows })
    )

    // The canvas binds global keys (1 fit / 0 reset / Esc / Backspace-Delete).
    // Stop key events from a focused terminal bubbling to those handlers so the
    // user can type those characters into the shell.
    const stopKeys = (e: KeyboardEvent): void => e.stopPropagation()
    el.addEventListener('keydown', stopKeys, true)

    const onWinMsg = (e: MessageEvent): void => {
      const data = e.data as { __ptyPort?: boolean; id?: string }
      if (!data || !data.__ptyPort || data.id !== board.id) return
      const port = e.ports[0]
      portRef.current = port
      port.onmessage = (ev): void => {
        const m = ev.data as PortMessage
        if (m.t === 'data' && m.d) term.write(m.d)
        else if (m.t === 'state' && m.state) setState(m.state)
        else if (m.t === 'exit') {
          setState('exited')
          term.write(`\r\n\x1b[90m[process exited: ${m.code ?? 0}]\x1b[0m\r\n`)
        }
      }
      port.start()
    }
    window.addEventListener('message', onWinMsg)

    setState('spawning')
    window.api
      .spawnTerminal({
        id: board.id,
        shell: board.shell,
        cwd: board.cwd,
        launchCommand: board.launchCommand,
        cols: term.cols,
        rows: term.rows
      })
      .then((res) => {
        if (res.state === 'spawn-failed') {
          setState('spawn-failed')
          term.write(`\x1b[31mspawn failed: ${res.error ?? 'unknown error'}\x1b[0m\r\n`)
        }
      })
      .catch((err: Error) => {
        setState('spawn-failed')
        term.write(`\x1b[31mspawn failed: ${err.message}\x1b[0m\r\n`)
      })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* element detached mid-resize */
      }
    })
    ro.observe(el)

    return () => {
      window.removeEventListener('message', onWinMsg)
      el.removeEventListener('keydown', stopKeys, true)
      dataDisp.dispose()
      resizeDisp.dispose()
      ro.disconnect()
      void window.api.killTerminal(board.id)
      try {
        portRef.current?.close()
      } catch {
        /* port already closed */
      }
      portRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [board.id, board.shell, board.cwd, board.launchCommand])

  useEffect(() => spawn(), [spawn])

  // Run timer (mm:ss): tick only while a live process is running.
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  // Braille spinner (~90ms/frame) for the working line; idle when not running.
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setFrame((f) => f + 1), 90)
    return () => window.clearInterval(id)
  }, [running])

  // ── Actions (DESIGN.md §7.1) ────────────────────────────────────────────────
  /** Send Ctrl-C to interrupt the foreground process without killing the shell. */
  const interrupt = useCallback(() => {
    portRef.current?.postMessage({ t: 'input', d: '\x03' })
    termRef.current?.focus()
  }, [])

  /** Restart: kill the current session + respawn a fresh shell in place. */
  const restart = useCallback(() => {
    const term = termRef.current
    if (!term) return
    void window.api.killTerminal(board.id)
    try {
      portRef.current?.close()
    } catch {
      /* already closed */
    }
    portRef.current = null
    term.reset()
    setState('spawning')
    setElapsed(0)
    void window.api
      .spawnTerminal({
        id: board.id,
        shell: board.shell,
        cwd: board.cwd,
        launchCommand: board.launchCommand,
        cols: term.cols,
        rows: term.rows
      })
      .then((res) => {
        if (res.state === 'spawn-failed') {
          setState('spawn-failed')
          term.write(`\x1b[31mspawn failed: ${res.error ?? 'unknown error'}\x1b[0m\r\n`)
        }
      })
  }, [board.id, board.shell, board.cwd, board.launchCommand])

  /** Play/pause: stop the live session, or restart one when stopped. */
  const toggleRun = useCallback(() => {
    if (running || state === 'awaiting-input') {
      void window.api.killTerminal(board.id)
      setState('exited')
    } else {
      restart()
    }
  }, [running, state, board.id, restart])

  const live = running || state === 'awaiting-input'
  const status = statusFor(state, identity, running ? formatTimer(elapsed) : undefined)

  const actions = (
    <>
      <IconBtn name="settings" title="Configure" onClick={() => setConfigOpen((v) => !v)} />
      <IconBtn name={live ? 'pause' : 'play'} title={live ? 'Pause' : 'Run'} onClick={toggleRun} />
      <IconBtn name="restart" title="Restart" onClick={restart} />
      <IconBtn name="stop" title="Interrupt (Ctrl-C)" danger onClick={interrupt} />
    </>
  )

  return (
    <BoardFrame
      type="terminal"
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      running={running}
      status={status}
      actions={actions}
      contentBg="var(--inset)"
    >
      <div style={shell}>
        {configOpen && <TerminalConfig board={board} onClose={() => setConfigOpen(false)} />}
        {/* Live xterm screen — fills the well; --inset bg, 12px padding (§7.1). */}
        <div style={screenWrap}>
          <div ref={screenRef} style={screen} />
        </div>

        {/* Working line: braille spinner + current action while running. */}
        {running && (
          <div style={workingLine}>
            <span style={{ color: 'var(--accent)', width: 10, display: 'inline-block' }}>
              {brailleFrame(frame)}
            </span>
            <span>working…</span>
          </div>
        )}

        {/* Follow-up prompt: focuses the live terminal on click (§7.1). */}
        <div
          style={prompt}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => termRef.current?.focus()}
        >
          <span style={{ color: 'var(--accent)' }}>›</span>
          <span style={{ color: 'var(--text-faint)' }}>
            {live ? 'send a follow-up instruction' : 'session stopped — restart to continue'}
          </span>
          {live && <span className="ca-blink" style={caret} />}
        </div>
      </div>
    </BoardFrame>
  )
}

const shell: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column'
}

const screenWrap: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
  background: 'var(--inset)'
}

const screen: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  padding: '12px 12px 4px'
}

const workingLine: React.CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  lineHeight: '19px',
  color: 'var(--text-2)',
  display: 'flex',
  gap: 8,
  padding: '0 12px 4px'
}

const prompt: React.CSSProperties = {
  flex: 'none',
  borderTop: '1px solid var(--border-subtle)',
  padding: '8px 14px',
  fontFamily: 'var(--mono)',
  fontSize: 12.5,
  color: 'var(--text-3)',
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  cursor: 'text',
  background: 'color-mix(in srgb, var(--inset) 70%, var(--surface))'
}

const caret: React.CSSProperties = {
  width: 7,
  height: 14,
  background: 'var(--text-3)',
  borderRadius: 1,
  marginLeft: -2
}
