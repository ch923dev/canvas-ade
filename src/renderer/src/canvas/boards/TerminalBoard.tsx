/**
 * Terminal board content (Phase 2.1) — a live xterm.js terminal bridged to
 * `node-pty` in MAIN over the MessagePort data plane (high-volume PTY output)
 * with the spawn/kill control plane on `ipcRenderer.invoke`, keyed by board id.
 *
 * Per CLAUDE.md we spawn the SHELL, not the agent; if `board.launchCommand` is
 * set it is written as the first PTY line (in `pty.ts`) so the agent inherits
 * PATH/profile/auth. The board is a plain terminal: a calm identity pill (status
 * dot + shell/agent name) plus two title-bar actions — Configure (shell /
 * launch command / cwd / editable label) and Restart. Clicking the body focuses
 * xterm directly so keystrokes always land. Owns this file only; shared surface frozen.
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
import { agentIdentity, statusFor, type TerminalState } from './terminalState'
import { isE2E, e2eTerminals } from '../../smoke/e2eRegistry'

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
  dimmed,
  lod = false
}: BoardViewProps<TerminalBoardData>): ReactElement {
  const screenRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const portRef = useRef<MessagePort | null>(null)

  const [state, setState] = useState<TerminalState>('spawning')
  const [configOpen, setConfigOpen] = useState(false)

  const identity = agentIdentity(board.launchCommand, board.shell)

  // ── Bridge: spawn the PTY, wire the MessagePort, fit on resize ──────────────
  // Keyed by board id so re-mounts (LOD swaps, drags) reconnect the same session
  // intent. The effect owns the full lifecycle and tears the session down on
  // unmount (kill the tree in MAIN via `killTerminal`).
  const spawn = useCallback((): (() => void) => {
    const el = screenRef.current
    if (!el) return () => {}

    // xterm paints glyphs onto a canvas/WebGL atlas where CSS var() does NOT
    // resolve — passing 'var(--mono)' breaks the canvas font parse, so glyphs
    // render tiny inside full-width cells (the wide letter-spacing). Resolve the
    // --mono design token to its literal font stack before handing it to xterm.
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() ||
      'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

    const term = new Terminal({
      fontFamily: mono,
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
    // One WebGL context per terminal. Chromium caps live GL contexts (~16) and
    // drops the OLDEST under churn — without a loss handler that terminal goes
    // permanently blank. Dispose the addon on context loss so xterm transparently
    // falls back to the DOM renderer; capture it so teardown frees the context.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        webglRef.current = null
      })
      term.loadAddon(webgl)
      webglRef.current = webgl
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
    if (isE2E()) e2eTerminals.set(board.id, term)

    // Forward keystrokes + resizes to whatever port is CURRENT. Registered ONCE
    // (not inside onWinMsg) so a restart — which delivers a fresh port through the
    // same persistent message listener — doesn't stack duplicate xterm listeners;
    // the disposables are released on teardown.
    const dataDisp = term.onData((d) => portRef.current?.postMessage({ t: 'input', d }))
    const resizeDisp = term.onResize(({ cols, rows }) =>
      portRef.current?.postMessage({ t: 'resize', cols, rows })
    )

    // Let xterm handle the key FIRST (Backspace/Enter/arrows/Ctrl-C are keydown-
    // driven on xterm's textarea), THEN stop it bubbling to the canvas / React Flow
    // global keys (1 / 0 / Esc / Backspace-Delete board-delete). Must be BUBBLE
    // phase: capture would intercept the event before xterm's textarea (a child of
    // `el`) ever sees it — which silently breaks Backspace and the other key-driven
    // controls while plain typing still works via the textarea input event.
    const stopKeys = (e: KeyboardEvent): void => e.stopPropagation()
    el.addEventListener('keydown', stopKeys)

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
      el.removeEventListener('keydown', stopKeys)
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
      if (isE2E()) e2eTerminals.delete(board.id)
      // Free the WebGL context before disposing the terminal (no-op if a prior
      // context-loss already disposed it and nulled the ref).
      try {
        webglRef.current?.dispose()
      } catch {
        /* already disposed */
      }
      webglRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [board.id, board.shell, board.cwd, board.launchCommand])

  useEffect(() => spawn(), [spawn])

  // ── Actions ─────────────────────────────────────────────────────────────────
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

  const status = statusFor(state, identity)

  const actions = (
    <>
      <IconBtn
        name="settings"
        title="Configure terminal"
        onClick={() => setConfigOpen((v) => !v)}
      />
      <IconBtn name="restart" title="Restart" onClick={restart} />
    </>
  )

  // Keep the full chrome (and the xterm host) ALWAYS mounted so the live PTY/agent
  // session survives zoom-out — see BoardNode. At LOD we hide the xterm well and
  // overlay the opaque LOD card on top (it fully covers the chrome beneath it),
  // never tearing the terminal down. The card's dot reflects the live status, so a
  // running agent still pulses `--ok` while zoomed out.
  return (
    <>
      <BoardFrame
        type="terminal"
        title={board.title}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        status={status}
        actions={actions}
        contentBg="var(--inset)"
      >
        <div style={lod ? shellHidden : shell}>
          {configOpen && <TerminalConfig board={board} onClose={() => setConfigOpen(false)} />}
          {/* Live xterm screen fills the whole well — a plain terminal (--inset bg).
              `nodrag nowheel` stops React Flow from treating clicks as a node drag or
              wheel as a canvas zoom. Crucially we also stop the mousedown reaching RF
              and force focus into xterm: otherwise RF focuses the node wrapper on
              click and swallows keystrokes until a restart (the "can't type" bug). */}
          <div
            className="nodrag nowheel"
            style={screenWrap}
            onMouseDown={(e) => {
              e.stopPropagation()
              termRef.current?.focus()
            }}
          >
            <div ref={screenRef} style={screen} />
          </div>
        </div>
      </BoardFrame>
      {lod && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <BoardFrame
            type="terminal"
            title={board.title}
            selected={selected}
            dimmed={dimmed}
            lod
            status={{ dot: status.dot }}
          />
        </div>
      )}
    </>
  )
}

const shell: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column'
}

/** LOD: hide the xterm well (keep it mounted so the PTY session stays alive). */
const shellHidden: React.CSSProperties = { ...shell, display: 'none' }

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
