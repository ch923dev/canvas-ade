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
import { agentIdentity, isRunning, statusFor, type TerminalState } from './terminalState'
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

// ── Renderer-wide WebGL context budget (#12/#29) ──────────────────────────────
// Chromium caps live WebGL2 contexts per renderer (~16, shared across all terminal
// boards + Browser views + React Flow) and silently evicts the OLDEST once exceeded.
// The LOD release alone doesn't bound the many-visible-terminals case (lod is a
// global zoom-only flag), so we add a hard cap WELL under 16 — terminals over the
// cap stay on the slower DOM renderer instead of thrashing the shared budget. A
// freed slot (LOD detach, unmount, or context loss) re-upgrades one waiting
// DOM-fallback terminal so eviction is recoverable rather than permanent.
const WEBGL_BUDGET = 8
/** Board ids currently holding a live GL context. */
const liveWebgl = new Set<string>()
/** Board ids that want a GL context but are over budget — keyed retry callbacks. */
const wantWebgl = new Map<string, () => void>()

/** Reserve a GL slot for `id`. Returns false (caller stays on DOM renderer) at cap. */
function acquireWebglSlot(id: string): boolean {
  if (liveWebgl.has(id)) return true
  if (liveWebgl.size >= WEBGL_BUDGET) return false
  liveWebgl.add(id)
  return true
}

/** Free `id`'s slot and let one waiting DOM-fallback terminal try to upgrade. */
function releaseWebglSlot(id: string): void {
  if (!liveWebgl.delete(id)) return
  const next = wantWebgl.entries().next()
  if (!next.done) {
    const [waitingId, retry] = next.value
    wantWebgl.delete(waitingId)
    retry()
  }
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
  // #23: when a Restart happens while the well is unfitted (LOD/display:none),
  // proposeDimensions has no finite dims yet, so we defer the actual respawn and
  // let the spawn effect's ResizeObserver consume this flag on the first good fit.
  const pendingRespawnRef = useRef(false)

  const [state, setState] = useState<TerminalState>('spawning')
  const [configOpen, setConfigOpen] = useState(false)

  const identity = agentIdentity(board.launchCommand, board.shell)
  const running = isRunning(state)

  // `lod` read by the spawn effect (initial WebGL attach) without making it a spawn
  // dep — `lod` must NOT respawn the PTY (the session survives zoom-out by design).
  const lodRef = useRef(lod)
  useEffect(() => {
    lodRef.current = lod
  }, [lod])

  // ── WebGL renderer pooling (#10/#12/#29) ─────────────────────────────────────
  // Chromium caps live WebGL2 contexts (~16, shared with Browser views + React
  // Flow) and silently drops the OLDEST under churn. We (1) hold a GL context only
  // for DETAIL-view terminals — a board at LOD releases so on-screen terminals keep
  // theirs — AND (2) enforce a hard renderer-wide cap (WEBGL_BUDGET) via the
  // module-level registry, since `lod` is global zoom-only and never bounds the
  // many-visible-terminals case. Over the cap a terminal stays on the DOM renderer
  // and registers a retry that fires when a slot frees. The PTY session is
  // independent of the renderer, so this is purely a perf/quality lever.
  //
  // The over-budget retry (wantWebgl) and onContextLoss re-acquire closures must
  // re-invoke attachWebgl, but a useCallback can't reference its own binding from its
  // body (react-hooks). Route the recursive call through a ref kept in sync below.
  const attachWebglRef = useRef<(t: Terminal) => void>(() => {})
  const attachWebgl = useCallback(
    (term: Terminal): void => {
      if (webglRef.current) return
      // Over budget: stay on the DOM renderer and queue a retry for when a slot
      // frees (LOD detach / unmount / context loss elsewhere). Re-read the live
      // term then so a disposed/LOD'd board never upgrades.
      if (!acquireWebglSlot(board.id)) {
        wantWebgl.set(board.id, () => {
          const t = termRef.current
          if (!lodRef.current && t) attachWebglRef.current(t)
        })
        return
      }
      wantWebgl.delete(board.id)
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          webglRef.current = null
          // Free our slot (re-upgrades one waiting DOM-fallback terminal), then —
          // if still in detail view — try to re-acquire so an in-detail eviction
          // (#29) recovers rather than stranding us on the DOM renderer forever.
          releaseWebglSlot(board.id)
          setTimeout(() => {
            const t = termRef.current
            if (!lodRef.current && t) attachWebglRef.current(t)
          }, 0)
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        /* GL unavailable — xterm falls back to the DOM/canvas renderer */
        releaseWebglSlot(board.id)
      }
    },
    [board.id]
  )

  const detachWebgl = useCallback((): void => {
    try {
      webglRef.current?.dispose()
    } catch {
      /* already disposed */
    }
    webglRef.current = null
    wantWebgl.delete(board.id)
    releaseWebglSlot(board.id)
  }, [board.id])

  // Keep the recursion ref pointed at the latest attachWebgl (stable per board.id).
  useEffect(() => {
    attachWebglRef.current = attachWebgl
  }, [attachWebgl])

  // Release the GL context at LOD; re-acquire on return to detail view. Guarded by
  // a live terminal (the spawn effect owns mount/unmount of `term` itself).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (lod) detachWebgl()
    else attachWebgl(term)
  }, [lod, attachWebgl, detachWebgl])

  // Fire a fresh PTY spawn into the CURRENT term. Shared by the Restart action and
  // the ResizeObserver's deferred-respawn path (#23). The async .then()/.catch()
  // bail if the captured term was disposed/replaced mid-IPC (#16), and a rejected
  // pty:spawn invoke surfaces the error instead of leaving the board stuck on
  // 'spawning' (#11).
  const respawn = useCallback(() => {
    const term = termRef.current
    if (!term) return
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
        if (termRef.current !== term) return
        if (res.state === 'spawn-failed') {
          setState('spawn-failed')
          term.write(`\x1b[31mspawn failed: ${res.error ?? 'unknown error'}\x1b[0m\r\n`)
        }
      })
      .catch((err: Error) => {
        if (termRef.current !== term) return
        setState('spawn-failed')
        term.write(`\x1b[31mspawn failed: ${err.message}\x1b[0m\r\n`)
      })
  }, [board.id, board.shell, board.cwd, board.launchCommand])

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
    // Attach a GL context only when mounting in detail view; a board mounted at LOD
    // runs on the DOM renderer until it returns to detail (see the LOD effect above).
    if (!lodRef.current) attachWebgl(term)
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

    // Spawn the PTY only ONCE per mount, and only after the xterm host has a real
    // layout — i.e. fit produced finite cols/rows. A board created while the camera
    // is below LOD mounts with the well at `display:none`, so fit.fit() no-ops and
    // term.cols/rows are the default 80×24; spawning then would size the PTY (and
    // write the launchCommand TUI) at the wrong width (#34). We defer until the
    // ResizeObserver reports the first good fit (the well becoming visible resizes
    // it), at which point dims reflect the board's true column width.
    // #15: try to ADOPT a parked session (undo of a delete) before spawning fresh.
    // `spawnAllowed` stays false until adopt resolves with adopted:false, so neither
    // the immediate launch() nor the ResizeObserver can spawn a fresh shell over an
    // adoptable one. When adopted, the reposted port + replayed scrollback arrive via
    // the existing onWinMsg listener.
    let spawned = false
    let spawnAllowed = false
    let disposed = false
    // A fresh mount supersedes any respawn parked by a Restart on the prior term
    // incarnation (#23) — the initial launch() owns this term's first spawn.
    pendingRespawnRef.current = false
    const launch = (): void => {
      if (spawned || !spawnAllowed) return
      const dims = fit.proposeDimensions()
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      spawned = true
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
    }
    // Decide adopt-vs-spawn once. Adopted → the reposted port + replayed buffer
    // arrive over onWinMsg (no spawn). Not adopted → allow the normal spawn flow
    // (immediate try here + the ResizeObserver's deferred try for the #34 LOD case).
    void window.api.adoptTerminal(board.id).then((res) => {
      if (disposed) return
      if (res.adopted) {
        setState('running')
      } else {
        spawnAllowed = true
        launch()
      }
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* element detached mid-resize */
      }
      // First good fit after a hidden/LOD mount spawns the deferred PTY at the
      // board's true width; later fits no-op (`spawned` guard) and just resize.
      launch()
      // #23: a Restart issued while the well was unfitted parked a respawn; the
      // first good fit (well now visible) drives it at the board's true width.
      if (pendingRespawnRef.current) {
        const dims = fit.proposeDimensions()
        if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
          pendingRespawnRef.current = false
          respawn()
        }
      }
    })
    ro.observe(el)

    return () => {
      disposed = true
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
      // context-loss or LOD detach already disposed it and nulled the ref).
      detachWebgl()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [board.id, board.shell, board.cwd, board.launchCommand, attachWebgl, detachWebgl, respawn])

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
    // #23: only spawn now if the well is laid out (finite proposed dims). A board
    // restarted entirely under LOD has a display:none well where fit.fit() no-ops
    // and term.cols/rows are the 80×24 default — spawning then sizes the PTY (and
    // any launchCommand TUI) at the wrong width. Defer to the ResizeObserver's
    // first good fit, mirroring the initial-spawn deferral.
    const fit = fitRef.current
    try {
      fit?.fit()
    } catch {
      /* element not laid out yet */
    }
    const dims = fit?.proposeDimensions()
    if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      pendingRespawnRef.current = false
      respawn()
    } else {
      pendingRespawnRef.current = true
    }
  }, [respawn, board.id])

  const status = statusFor(state, identity)

  /** Interrupt: send Ctrl-C (SIGINT) over the data plane to the running agent. */
  const interrupt = useCallback(() => {
    portRef.current?.postMessage({ t: 'input', d: '\x03' })
  }, [])

  const actions = (
    <>
      {running && <IconBtn name="stop" title="Interrupt (Ctrl-C)" onClick={interrupt} />}
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
        running={running}
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
            running={running}
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
