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
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { useStoreApi } from '@xyflow/react'
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
  isRunning,
  statusFor,
  type TerminalState
} from './terminalState'
import { prefersReducedMotion } from '../../lib/motion'
import { isE2E, e2eTerminals, e2eTerminalInput, appendTerminalInput } from '../../smoke/e2eRegistry'
import { handleTerminalKey, TERMINAL_NEWLINE } from './terminal/terminalKeymap'
import { useCanvasStore, isIdleOnMount, clearIdleOnMount } from '../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../store/terminalRuntimeStore'
import { classifyPushTargets, type PreviewCandidate } from '../../lib/previewTarget'
import { runDetectPorts, type DetectedUrl, type Gesture } from './terminalPreview'
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'
import { quotePathsForPaste } from './terminal/terminalDrop'
import { installSelectionShim } from './terminal/terminalSelection'
import { BoardFullViewContext } from '../fullViewContext'

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

/** Platform check for the terminal key resolver's primary modifier (Cmd on macOS). */
const IS_MAC = navigator.platform.toLowerCase().includes('mac')

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

/**
 * Smart paste: if the clipboard holds an image, stage it to a temp file and inject the
 * quoted path; otherwise inject the clipboard text. Uses `term.paste` so multiline
 * content gets bracketed-paste markers when the agent enabled them (no per-line submit).
 */
async function pasteIntoTerminal(term: Terminal, boardId: string): Promise<void> {
  // Staging can fail (ENOSPC disk full, EPERM antivirus lock, read-only .canvas/tmp).
  // The IPC handler now returns null on those errors, but guard the await itself too
  // so any unexpected rejection falls through to the text-paste branch rather than
  // propagating to the `void` call site and silently dropping the paste entirely.
  let path: string | null = null
  try {
    path = await window.api.stageClipboardImage(boardId)
  } catch {
    path = null
  }
  if (term.element === undefined) return // disposed during the await
  if (path) {
    term.paste(`"${path}" `)
    return
  }
  const text = await window.api.clipboard.readText()
  if (text && term.element !== undefined) term.paste(text)
}

export function TerminalBoard({
  board,
  selected,
  hovered,
  dimmed,
  lod = false,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onPushPreviewTo,
  onStartConnect
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
  // M-1: the idle-state "Start" button calls back into the CURRENT mount's `launch()`
  // (the spawn closure is local per mount). The spawn effect points this ref at a
  // launcher that flips `spawnAllowed` and fires; null while no live term exists.
  const startLaunchRef = useRef<(() => void) | null>(null)
  // Live camera zoom source for the selection shim. We read it from the React Flow store
  // AT MOUSE-EVENT TIME (transform[2]) rather than via useOnViewportChange: the latter's
  // onChange does not fire for programmatic, zero-duration zoom (e.g. rf.zoomTo) — only for
  // d3-zoom-driven gestures — so it would leave the shim reading a stale z=1. The store
  // transform is the canonical live zoom (the same source BoardNode/Canvas read for LOD).
  const rfStore = useStoreApi()
  // In full view the board is portaled OUTSIDE ReactFlow into the modal at visual
  // scale 1, but the camera zoom (transform[2]) is unchanged — so the selection shim
  // would mis-correct. Mirror the full-view flag into a ref (not a closure dep) so
  // `getZoom`'s identity stays stable: toggling full view must NOT re-run the spawn
  // effect / respawn the PTY.
  const isFullView = useContext(BoardFullViewContext)
  const fullViewRef = useRef(isFullView)
  useEffect(() => {
    fullViewRef.current = isFullView
  }, [isFullView])
  const getZoom = useCallback(
    (): number => (fullViewRef.current ? 1 : rfStore.getState().transform[2]),
    [rfStore]
  )

  const [state, setState] = useState<TerminalState>('spawning')
  const [configOpen, setConfigOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null)

  const identity = agentIdentity(board.launchCommand, board.shell)
  const running = isRunning(state)

  // Publish live PTY state so the preview-link edge can render stale when this
  // terminal is not running (bug 3); clear on unmount so a removed board stops
  // counting as a running source.
  useEffect(() => {
    useTerminalRuntimeStore.getState().setRunning(board.id, state)
  }, [board.id, state])
  useEffect(() => () => useTerminalRuntimeStore.getState().clear(board.id), [board.id])

  // A board with no explicit cwd spawns in the open project folder, not os.homedir().
  const projectDir = useCanvasStore((s) => s.project.dir)

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
        cwd: board.cwd ?? projectDir ?? undefined,
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
  }, [board.id, board.shell, board.cwd, board.launchCommand, projectDir])

  // ── Bridge: spawn the PTY, wire the MessagePort, fit on resize ──────────────
  // Keyed by board id so re-mounts (LOD swaps, drags) reconnect the same session
  // intent. The effect owns the full lifecycle and tears the session down on
  // unmount (kill the tree in MAIN via `killTerminal`).
  const spawn = useCallback((): (() => void) => {
    const el = screenRef.current
    if (!el) return () => {}

    // xterm paints glyphs onto a canvas/WebGL atlas where CSS var() does NOT
    // resolve — passing 'var(--term-mono)' breaks the canvas font parse, so glyphs
    // render tiny inside full-width cells (the wide letter-spacing). Resolve the
    // --term-mono token (hinted OS terminal stack — Cascadia Mono/Consolas/SF Mono)
    // to its literal value before handing it to xterm. A hinted system font renders
    // native-crisp on xterm's grayscale-AA atlas where the thin Geist Mono webfont read
    // soft. UI chrome stays on --mono (Geist Mono); only the live grid uses this.
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--term-mono').trim() ||
      'Consolas, ui-monospace, "SF Mono", Menlo, monospace'

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

    // Scale-correct selection (F2a): the board renders inside React Flow's scaled
    // viewport, so xterm's native cell math is off by the camera zoom. The capture-phase
    // shim feeds xterm coordinates corrected for the live zoom (no-op at z = 1). The
    // `.xterm-screen` element exists once `term.open(el)` ran; `el.parentElement` is the
    // nodrag/nowheel screenWrap that owns the mouse surface.
    const screenEl = el.querySelector('.xterm-screen') as HTMLElement | null
    const wrapEl = el.parentElement
    const selectionDisp =
      screenEl && wrapEl ? installSelectionShim(wrapEl, screenEl, getZoom) : null

    // Forward keystrokes + resizes to whatever port is CURRENT. Registered ONCE
    // (not inside onWinMsg) so a restart — which delivers a fresh port through the
    // same persistent message listener — doesn't stack duplicate xterm listeners;
    // the disposables are released on teardown.

    // All PTY-bound input flows through one seam so the e2e harness can observe it and
    // so the key handler (newline) and term.paste both share the same path.
    const sendInput = (d: string): void => {
      if (isE2E()) appendTerminalInput(board.id, d)
      portRef.current?.postMessage({ t: 'input', d })
    }
    const dataDisp = term.onData((d) => sendInput(d))
    const resizeDisp = term.onResize(({ cols, rows }) =>
      portRef.current?.postMessage({ t: 'resize', cols, rows })
    )

    // Custom key handling (returns false to suppress xterm's default for keys we own).
    // handleTerminalKey calls e.preventDefault() for every owned chord — REQUIRED: xterm's
    // _keyDown bails before its own preventDefault once we return false, so without it the
    // follow-up keypress for Enter leaks a CR after our LF (the Shift+Enter submit bug).
    //  - Shift+Enter inserts a newline (LF / Ctrl+J via TERMINAL_NEWLINE; NOT the ConPTY-fragile ESC+CR).
    //  - Ctrl/Cmd+C copies when a selection exists (then clears); else falls through to
    //    xterm's SIGINT (\x03). Cmd is primary on macOS so Ctrl+C stays SIGINT there.
    //  - Ctrl/Cmd+V smart-pastes (image → staged path, else text), via term.paste so
    //    multiline content gets bracketed-paste markers.
    term.attachCustomKeyEventHandler((e) =>
      handleTerminalKey(
        e,
        { hasSelection: term.hasSelection(), isMac: IS_MAC },
        {
          newline: () => sendInput(TERMINAL_NEWLINE),
          copySelection: () => {
            const sel = term.getSelection()
            if (!sel) return false
            void window.api.clipboard.writeText(sel)
            term.clearSelection()
            return true
          },
          paste: () => void pasteIntoTerminal(term, board.id)
        }
      )
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
          cwd: board.cwd ?? projectDir ?? undefined,
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
    // arrive over onWinMsg (no spawn, in-session undo reattach). Not adopted →
    // spawn UNLESS this board must mount idle (`isIdleOnMount`): a disk-restored or
    // duplicated terminal starts IDLE with a Start affordance so a reopened project
    // never silently spawns shells / fires launchCommand (M-1, the CLAUDE.md LOCKED
    // "restored terminals are idle" rule). The flag is NON-consuming (a restored board
    // stays idle across LOD remounts) and cleared only by an explicit Start, so an
    // in-session respawn (config change / restart) of an already-started terminal
    // spawns normally. The Start button wires back through `startLaunchRef` → launch().
    startLaunchRef.current = () => {
      clearIdleOnMount(board.id)
      spawnAllowed = true
      setState('spawning')
      launch()
    }
    void window.api.adoptTerminal(board.id).then((res) => {
      if (disposed) return
      if (res.adopted) {
        setState('running')
      } else if (isIdleOnMount(board.id)) {
        setState('idle')
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
      selectionDisp?.()
      dataDisp.dispose()
      resizeDisp.dispose()
      ro.disconnect()
      void window.api.killTerminal(board.id)
      void window.api.cleanupStagedImages(board.id)
      try {
        portRef.current?.close()
      } catch {
        /* port already closed */
      }
      portRef.current = null
      if (isE2E()) e2eTerminals.delete(board.id)
      if (isE2E()) e2eTerminalInput.delete(board.id)
      // Free the WebGL context before disposing the terminal (no-op if a prior
      // context-loss or LOD detach already disposed it and nulled the ref).
      detachWebgl()
      term.dispose()
      termRef.current = null
      fitRef.current = null
      startLaunchRef.current = null
    }
  }, [
    board.id,
    board.shell,
    board.cwd,
    board.launchCommand,
    projectDir,
    attachWebgl,
    detachWebgl,
    respawn,
    getZoom
  ])

  useEffect(() => spawn(), [spawn])

  // ── Actions ─────────────────────────────────────────────────────────────────
  /** Restart: kill the current session + respawn a fresh shell in place. */
  const restart = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // A Restart is explicit start intent — drop the idle-on-mount flag (mirrors the
    // Start button) so a later spawn-effect re-run (config Apply) doesn't render the
    // idle overlay over this now-live PTY and let Start spawn a 2nd session (PTY-2).
    clearIdleOnMount(board.id)
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

  // §9/§7.1 braille spinner: advance one frame every 80ms while running. Reduced
  // motion holds it on a static glyph (no interval → frame stays put).
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    if (!running || prefersReducedMotion()) return
    const id = setInterval(() => setSpinnerFrame((f) => f + 1), 80)
    return () => clearInterval(id)
  }, [running])

  const status = statusFor(state, identity)
  // Prefix the running label with the spinner glyph (the §7.1 "working" indicator).
  const displayStatus = running
    ? { ...status, label: `${brailleFrame(spinnerFrame)} ${status.label}` }
    : status

  /** Interrupt: send Ctrl-C (SIGINT) over the data plane to the running agent. */
  const interrupt = useCallback(() => {
    portRef.current?.postMessage({ t: 'input', d: '\x03' })
  }, [])

  // Slice C′: detected dev-server URLs (picker when >1) + a transient "not found" note.
  // DetectedUrl and Gesture types are imported from ./terminalPreview.
  const [portChoices, setPortChoices] = useState<{ urls: DetectedUrl[]; gesture: Gesture } | null>(
    null
  )
  const [previewNote, setPreviewNote] = useState<string | null>(null)
  // Multi-select connect picker (long-press, or tap with nothing linked): pick one or more
  // browsers (B + C) and/or a fresh spawn to wire to this terminal and push the url to each.
  const [browserPick, setBrowserPick] = useState<{
    url: string
    candidates: PreviewCandidate[]
  } | null>(null)
  const NEW_BROWSER = ' new' // sentinel checkbox key for "+ New browser"
  const [checked, setChecked] = useState<Set<string>>(new Set())

  // Route a resolved url by gesture. Tap + linked browser(s) → refresh them. Otherwise
  // (long-press, or tap with nothing linked) open the multi-select connect picker over the
  // candidates (B + C); with zero candidates just spawn a fresh browser.
  const routeUrl = useCallback(
    (url: string, gesture: Gesture) => {
      const { linkedIds, candidates } = classifyPushTargets(
        useCanvasStore.getState().boards,
        board.id
      )
      if (gesture === 'tap' && linkedIds.length > 0) {
        linkedIds.forEach((id) => onPushPreviewTo?.(url, { kind: 'existing', id }))
        return
      }
      if (candidates.length === 0) {
        onPushPreviewTo?.(url, { kind: 'spawn' }) // nothing to choose between → fresh browser
        return
      }
      setChecked(new Set())
      setBrowserPick({ url, candidates })
    },
    [board.id, onPushPreviewTo]
  )

  const onPreview = useCallback(
    (gesture: Gesture) =>
      runDetectPorts(
        () => window.api.detectPorts(board.id),
        setPreviewNote,
        routeUrl,
        setPortChoices,
        gesture
      ),
    [board.id, routeUrl]
  )

  // Apply the multi-select connect picker: wire every checked browser to this terminal
  // (re-pointing its previewSourceId, severing any prior link) + push the url; spawn a
  // fresh browser if "+ New browser" is checked.
  const confirmBrowserPick = useCallback(() => {
    if (!browserPick) return
    const { url } = browserPick
    checked.forEach((key) => {
      if (key === NEW_BROWSER) onPushPreviewTo?.(url, { kind: 'spawn' })
      else onPushPreviewTo?.(url, { kind: 'existing', id: key })
    })
    setBrowserPick(null)
  }, [browserPick, checked, onPushPreviewTo])

  const severCount = browserPick
    ? [...checked].filter((k) => browserPick.candidates.find((c) => c.id === k)?.connectedTo).length
    : 0

  const actions = (
    <>
      {running && <IconBtn name="stop" title="Interrupt (Ctrl-C)" onClick={interrupt} />}
      <IconBtn
        name="globe"
        title="Click: preview in linked browser · Hold / right-click: choose browser(s)"
        onClick={() => void onPreview('tap')}
        onLongPress={() => void onPreview('hold')}
        onContextMenu={() => void onPreview('hold')}
      />
      <IconBtn
        name="settings"
        title="Configure terminal"
        onClick={() => setConfigOpen((v) => !v)}
      />
      <IconBtn name="restart" title="Restart" onClick={restart} />
    </>
  )

  // Right-click context menu over the well. Reuses the planning menu component. When the
  // running TUI has mouse reporting on (term.modes.mouseTrackingMode !== 'none'), plain
  // right-click passes through to the app; Shift+right-click forces our menu.
  // hasSel is captured at open-time so the Copy entry's disabled state is stable for the
  // menu's lifetime (avoids reading the ref during render).
  const openMenu = useCallback((e: React.MouseEvent) => {
    const term = termRef.current
    if (!term) return
    const mouseMode = term.modes.mouseTrackingMode !== 'none'
    if (mouseMode && !e.shiftKey) return // let the TUI have the right-click
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, hasSel: term.hasSelection() })
  }, [])

  const menuEntries: MenuEntry[] = useMemo(
    () =>
      menu
        ? [
            {
              kind: 'action',
              id: 'copy',
              label: 'Copy',
              disabled: !menu.hasSel,
              onSelect: () => {
                const t = termRef.current
                const sel = t?.getSelection()
                if (t && sel) {
                  void window.api.clipboard.writeText(sel)
                  t.clearSelection()
                }
              }
            },
            {
              kind: 'action',
              id: 'paste',
              label: 'Paste',
              onSelect: () => {
                const t = termRef.current
                if (t) void pasteIntoTerminal(t, board.id)
              }
            },
            {
              kind: 'action',
              id: 'selectall',
              label: 'Select all',
              onSelect: () => termRef.current?.selectAll()
            },
            {
              kind: 'action',
              id: 'clear',
              label: 'Clear',
              onSelect: () => termRef.current?.clear()
            }
          ]
        : [],
    [menu, board.id]
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
        boardId={board.id}
        title={board.title}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        running={running}
        status={displayStatus}
        actions={actions}
        contentBg="var(--inset)"
        onFull={onFull}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onAddToGroup={onAddToGroup}
        onRemoveFromGroup={onRemoveFromGroup}
        onStartConnect={onStartConnect}
      >
        <div style={lod ? shellHidden : shell}>
          {configOpen && <TerminalConfig board={board} onClose={() => setConfigOpen(false)} />}
          {/* M-1: a restored/duplicated terminal starts idle (no auto-spawn). Offer an
              explicit Start that spawns the shell + fires launchCommand on click. */}
          {state === 'idle' && (
            <div className="nodrag" style={idleOverlay} onMouseDown={(e) => e.stopPropagation()}>
              <button style={startBtn} onClick={() => startLaunchRef.current?.()}>
                Start {identity}
              </button>
            </div>
          )}
          {previewNote && (
            <div className="ca-preview-note" role="status" onMouseDown={(e) => e.stopPropagation()}>
              {previewNote}
              <button className="ca-preview-dismiss" onClick={() => setPreviewNote(null)}>
                Dismiss
              </button>
            </div>
          )}
          {portChoices && portChoices.urls.length > 1 && (
            <div className="ca-port-picker nodrag" onMouseDown={(e) => e.stopPropagation()}>
              <div className="ca-port-picker-title">Multiple servers — choose one:</div>
              {portChoices.urls.map((u) => (
                <button
                  key={u.url}
                  className="ca-port-choice"
                  onClick={() => {
                    const { gesture } = portChoices
                    setPortChoices(null)
                    routeUrl(u.url, gesture)
                  }}
                >
                  {u.host}:{u.port}
                </button>
              ))}
              <button className="ca-preview-dismiss" onClick={() => setPortChoices(null)}>
                Cancel
              </button>
            </div>
          )}
          {browserPick && (
            <div className="ca-port-picker nodrag" onMouseDown={(e) => e.stopPropagation()}>
              <div className="ca-port-picker-title">Push to which browser(s)?</div>
              {browserPick.candidates.map((c) => (
                <label key={c.id} className="ca-browser-choice" title={c.url}>
                  <input
                    type="checkbox"
                    checked={checked.has(c.id)}
                    onChange={(e) =>
                      setChecked((prev) => {
                        const next = new Set(prev)
                        if (e.target.checked) next.add(c.id)
                        else next.delete(c.id)
                        return next
                      })
                    }
                  />
                  <span className="ca-browser-choice-label">{c.title}</span>
                  {c.connectedTo && (
                    <span
                      className="ca-browser-choice-warn"
                      title={`Connected to ${c.connectedTo.title}`}
                    >
                      ⚠ on {c.connectedTo.title}
                    </span>
                  )}
                </label>
              ))}
              <label className="ca-browser-choice">
                <input
                  type="checkbox"
                  checked={checked.has(NEW_BROWSER)}
                  onChange={(e) =>
                    setChecked((prev) => {
                      const next = new Set(prev)
                      if (e.target.checked) next.add(NEW_BROWSER)
                      else next.delete(NEW_BROWSER)
                      return next
                    })
                  }
                />
                <span className="ca-browser-choice-label">+ New browser</span>
              </label>
              {severCount > 0 && (
                <div className="ca-browser-sever">
                  ⚠ Disconnects {severCount} browser{severCount > 1 ? 's' : ''} from{' '}
                  {severCount > 1 ? 'their' : 'its'} current terminal.
                </div>
              )}
              <div className="ca-browser-actions">
                <button className="ca-preview-dismiss" onClick={() => setBrowserPick(null)}>
                  Cancel
                </button>
                <button
                  className="ca-browser-connect"
                  disabled={checked.size === 0}
                  onClick={confirmBrowserPick}
                >
                  Connect{checked.size > 0 ? ` ${checked.size}` : ''}
                </button>
              </div>
            </div>
          )}
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
            onContextMenu={openMenu}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault() // required for onDrop to fire
                e.stopPropagation()
              }
            }}
            onDrop={(e) => {
              const files = e.dataTransfer?.files
              if (!files || files.length === 0) return
              // preventDefault guards against browser nav (alongside App.tsx's window
              // handler); stopPropagation keeps any outer React drop listener from also
              // handling this drop.
              e.preventDefault()
              e.stopPropagation()
              const paths = Array.from(files).map((f) => window.api.pathForFile(f))
              const payload = quotePathsForPaste(paths)
              if (payload) termRef.current?.paste(payload)
            }}
          >
            <div ref={screenRef} style={screen} />
          </div>
          {menu && (
            <ElementContextMenu
              x={menu.x}
              y={menu.y}
              entries={menuEntries}
              onClose={() => setMenu(null)}
            />
          )}
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
            onFull={onFull}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
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

/** Idle (restored/duplicated, not yet started) overlay: centered Start affordance
 *  over the empty --inset well so the terminal never silently auto-spawns (M-1). */
const idleOverlay: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  zIndex: 2,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--inset)'
}

const startBtn: React.CSSProperties = {
  font: 'inherit',
  fontSize: 12.5,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-ctl)',
  padding: '6px 14px',
  cursor: 'pointer'
}
