/**
 * Terminal spawn lifecycle, extracted from TerminalBoard (god-file campaign, Tier-3).
 * Owns the PTY spawn/respawn/restart state machine and everything that must move as a
 * unit with it: the xterm construction, the MessagePort data-plane wiring, the
 * ResizeObserver-deferred spawn (#23/#34), the adopt/idle-on-mount fork (#15/M-1), the
 * WebGL renderer pooling (via useTerminalWebgl), the scale-correct selection shim, the
 * custom key handler (Shift+Enter = LF, copy/paste/font), and the kill-tree teardown.
 *
 * Behavior-preserving: this is a verbatim move of the callbacks that previously lived
 * inline in TerminalBoard. The only structural change is two pure decision helpers
 * (resolveSpawnArgs / nextStateAfterAdopt) hoisted out so the decidable seams are
 * unit-testable without the effectful machinery.
 *
 * SURFACED to the host (consumed in TerminalBoard's render / font effects):
 *   - state            — the lifecycle state (drives chrome, the idle overlay, the spinner)
 *   - termRef/portRef   — read by the context menu, focus-on-click, drop-paste, interrupt
 *   - launchOverrideRef — the Restart menu writes the one-shot `claude --resume` line here
 *   - startLaunchRef    — the idle "Start" button fires the current mount's launch()
 *   - fitWhole          — the font apply + dpr effects reflow the live grid through it
 *   - restart           — the Restart action / Resume-or-New menu
 *   - counterScale      — the settled-zoom FREEZE re-raster factor (host wrapper + font seam)
 * Everything else (fitRef, pendingRespawnRef, fontSizeRef, suspendWebglRef, getZoom, webgl, the
 * spawn/respawn callbacks, the spawn effect) is INTERNAL.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject
} from 'react'
import { useStoreApi } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'
import type { TerminalState } from '../terminalState'
import {
  isE2E,
  e2eTerminals,
  e2eTerminalInput,
  appendTerminalInput
} from '../../../smoke/e2eRegistry'
import { handleTerminalKey, TERMINAL_NEWLINE } from './terminalKeymap'
import { isIdleOnMount, clearIdleOnMount } from '../../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../../store/terminalRuntimeStore'
import { installSelectionShim } from './terminalSelection'
import { useTerminalWebgl } from './useTerminalWebgl'
import { BoardFullViewContext } from '../../fullViewContext'
import { resolveInitialFont } from './terminalFont'
import { useSettledZoomStore } from '../../../store/settledZoomStore'

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

/**
 * Resolve the PTY spawn descriptor's cwd + launchCommand. Pure, so the cwd fallback
 * chain and the one-shot launch-override precedence are unit-testable in isolation.
 *  - cwd: the board's explicit cwd, else the open project dir, else undefined (MAIN
 *    spawns in os.homedir()).
 *  - launchCommand: a one-shot `override` (e.g. `claude --resume <id>` from the Restart
 *    menu) wins over the board's persisted command. `??` (not `||`) so a deliberate
 *    empty override stays empty rather than reverting to the board command.
 */
export function resolveSpawnArgs(
  board: Pick<TerminalBoardData, 'cwd' | 'launchCommand'>,
  projectDir: string | null | undefined,
  override?: string
): { cwd: string | undefined; launchCommand: string | undefined } {
  return {
    cwd: board.cwd ?? projectDir ?? undefined,
    launchCommand: override ?? board.launchCommand
  }
}

/**
 * The adopt → idle → spawn fork, decided once after `adoptTerminal` resolves. Pure.
 *  - adopted (undo-of-delete reattach) → 'running' (the reposted port replays the buffer).
 *  - else idle-on-mount (disk-restored / duplicated) → 'idle' (explicit Start, no auto-spawn).
 *  - else → 'spawn' a fresh shell.
 */
export function nextStateAfterAdopt(
  adopted: boolean,
  idleOnMount: boolean
): 'running' | 'idle' | 'spawn' {
  if (adopted) return 'running'
  if (idleOnMount) return 'idle'
  return 'spawn'
}

export interface TerminalSpawnDeps {
  board: TerminalBoardData
  /** Open project folder — a board with no explicit cwd spawns here, not os.homedir(). */
  projectDir: string | null | undefined
  /** Global LOD (zoom-out) flag. Sole driver of the WebGL suspension policy (the
   *  counter-scale keeps GL crisp at every settled zoom); NEVER respawns the PTY. */
  lod: boolean
  /** The xterm host div, planted by the host's render (term.open() mounts into it). */
  screenRef: RefObject<HTMLDivElement>
  /** Host font-handler bridges — the custom key handler routes Ctrl +/-/0 through these.
   *  MutableRefObject (host seeds each with a no-op) so `.current` is never null at the call site. */
  fontStepRef: MutableRefObject<(delta: number) => void>
  fontResetRef: MutableRefObject<() => void>
  /**
   * Smart paste (the module fn exported from TerminalBoard). Passed in rather than
   * imported to avoid a host↔hook import cycle; it is a stable module reference, so
   * listing it in the spawn dep set below does not churn the callback identity.
   */
  pasteIntoTerminal: (term: Terminal, boardId: string, isLive?: () => boolean) => void
}

export interface TerminalSpawnApi {
  state: TerminalState
  /** Read-only from the host (it only reads `.current`); the hook's internals own writes. */
  termRef: RefObject<Terminal | null>
  portRef: RefObject<MessagePort | null>
  /** The host WRITES these (Restart menu sets the override; idle Start reads the launcher). */
  launchOverrideRef: MutableRefObject<string | undefined>
  startLaunchRef: MutableRefObject<(() => void) | null>
  fitWhole: () => void
  restart: () => void
  /**
   * Settled-zoom counter-scale factor (FREEZE re-raster): the host lays the xterm
   * well out at `boardContent × counterScale` with `transform: scale(1/counterScale)`
   * and drives the effective render font (pinned × counterScale). 1 in full view and
   * whenever the settled zoom is unusable. Updates once per camera settle, never per
   * gesture frame.
   */
  counterScale: number
}

/** Requires ReactFlowProvider (useStoreApi) + BoardFullViewContext in the render tree. */
export function useTerminalSpawn(deps: TerminalSpawnDeps): TerminalSpawnApi {
  const { board, projectDir, lod, screenRef, fontStepRef, fontResetRef, pasteIntoTerminal } = deps

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const portRef = useRef<MessagePort | null>(null)
  // #23: when a Restart happens while the well is unfitted (LOD/display:none),
  // proposeDimensions has no finite dims yet, so we defer the actual respawn and
  // let the spawn effect's ResizeObserver consume this flag on the first good fit.
  const pendingRespawnRef = useRef(false)
  // T-resume: a one-shot launchCommand override for the NEXT respawn (the Restart menu's
  // "Resume session" sets `claude --resume <id>`); respawn consumes + clears it so only that
  // spawn uses it and a later restart falls back to board.launchCommand.
  const launchOverrideRef = useRef<string | undefined>(undefined)
  // M-1: the idle-state "Start" button calls back into the CURRENT mount's `launch()`
  // (the spawn closure is local per mount). The spawn effect points this ref at a
  // launcher that flips `spawnAllowed` and fires; null while no live term exists.
  const startLaunchRef = useRef<(() => void) | null>(null)
  // board.fontSize for the spawn closure's INITIAL xterm construction, read via a ref so
  // a size change never becomes a spawn dep (which would respawn the PTY). Mirrors
  // suspendWebglRef below.
  const fontSizeRef = useRef<number | undefined>(board.fontSize)

  // Keep the spawn closure's initial-font ref synced (read on construction only; never a spawn dep).
  useEffect(() => {
    fontSizeRef.current = board.fontSize
  }, [board.fontSize])

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

  // ── Settled-zoom native re-raster (FREEZE variant) ───────────────────────────
  // At settled camera zoom z the host lays the xterm well out at `boardContent × z`
  // and counter-scales it by 1/z (net visual scale 1), while THIS hook drives the
  // effective render font (pinned × z). The xterm backing store then maps 1:1 to
  // device pixels at every settled zoom — no camera resample, no defeated hinting
  // (docs/research/2026-06-12-terminal-native-reraster-audit.md). FREEZE: cols/rows
  // NEVER change from a zoom settle (see the ResizeObserver gate in the spawn
  // effect), so the PTY/TUI never reflows on zoom. Full view portals the board
  // OUTSIDE ReactFlow at visual scale 1 → counter-scale must be identity there.
  const settledZoom = useSettledZoomStore((s) => s.zoom)
  const counterScale =
    isFullView || !Number.isFinite(settledZoom) || settledZoom <= 0 ? 1 : settledZoom
  // Ref mirror for the spawn closure (initial font) + getZoom — NEVER a spawn dep,
  // so a zoom settle cannot respawn the PTY (mirrors fontSizeRef).
  const counterScaleRef = useRef(counterScale)
  useEffect(() => {
    counterScaleRef.current = counterScale
  }, [counterScale])

  // Net visual scale of the xterm element, for the selection shim: the camera
  // applies scale(z'), the counter-scale wrapper applies scale(1/cs) — at rest
  // z' === cs so the net is exactly 1 (the shim no-ops); mid-gesture it corrects
  // by the live ratio. Full view renders outside the camera at scale 1.
  const getZoom = useCallback(
    (): number =>
      fullViewRef.current ? 1 : rfStore.getState().transform[2] / counterScaleRef.current,
    [rfStore]
  )

  // WebGL suspension policy: LOD only. Under the counter-scale the GL canvas backing
  // store maps 1:1 to device pixels at EVERY settled zoom, so the #122 "release GL at
  // non-crisp zoom" valve is gone — the renderer no longer swaps on zoom at all. The
  // WEBGL_BUDGET cap in useTerminalWebgl still bounds the many-terminals case; an
  // over-budget board falls back to the DOM renderer, which is ALSO crisp at net
  // scale 1 (perf-only degradation). Read through a ref so a LOD flip NEVER respawns
  // the PTY — the session survives zoom by design.
  const suspendWebgl = lod
  const suspendWebglRef = useRef(suspendWebgl)
  useEffect(() => {
    suspendWebglRef.current = suspendWebgl
  }, [suspendWebgl])

  const [state, setState] = useState<TerminalState>('spawning')

  // Publish live PTY state so the preview-link edge can render stale when this
  // terminal is not running (bug 3); clear on unmount so a removed board stops
  // counting as a running source.
  useEffect(() => {
    useTerminalRuntimeStore.getState().setRunning(board.id, state)
  }, [board.id, state])
  useEffect(() => () => useTerminalRuntimeStore.getState().clear(board.id), [board.id])

  const { attachWebgl, detachWebgl } = useTerminalWebgl(
    board.id,
    suspendWebgl,
    suspendWebglRef,
    termRef
  )

  // Fit, then guarantee the grid is a WHOLE number of CURRENTLY-RENDERED cells tall. FitAddon
  // computes rows from the well height but IGNORES the screen div's CSS padding (measured: it
  // overcounts by one row; the 12px top padding then pushes the grid past the well bottom by a
  // sub-cell remainder that the overflow:hidden boundary clips). After fitting, compute the
  // target row count arithmetically (cell height is font-fixed, constant across sheds) and call
  // term.resize AT MOST ONCE — one PTY IPC instead of N separate resize calls.
  const fitWhole = useCallback((): void => {
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    try {
      fit.fit()
    } catch {
      return // well not laid out (LOD / display:none)
    }
    // Measure the SAME elements the Task-11 probe (terminalGeometry) reads: the rendered
    // `.xterm-screen` grid (a child of the screen host) vs the `.nowheel` well that clips it.
    // `screenRef` is the term.open() host; `.closest('.nowheel')` walks up to the screenWrap.
    const screenEl = screenRef.current?.querySelector('.xterm-screen') as HTMLElement | null
    const wellEl = screenRef.current?.closest('.nowheel') as HTMLElement | null
    if (!screenEl || !wellEl) return
    // Compute the final row count in JS and call term.resize AT MOST ONCE (one PTY IPC instead of N).
    // Each row shed lifts the (top-aligned) grid bottom by exactly one cell height (font-fixed,
    // constant across sheds), so we can arithmetically determine the target row count upfront.
    const grid = screenEl.getBoundingClientRect()
    const cellH = grid.height / Math.max(1, term.rows) // rendered cell height (font-fixed)
    let rows = term.rows
    let overflow = grid.bottom - wellEl.getBoundingClientRect().bottom
    while (overflow > 1 && rows > 1) {
      rows -= 1
      overflow -= cellH // each shed lifts the (top-aligned) grid bottom by one cell
    }
    if (rows !== term.rows) term.resize(term.cols, rows) // single PTY resize
  }, [screenRef])

  // Route the in-spawn fit calls through a ref so `spawn`'s dependency array stays byte-identical
  // (fitWhole is itself stable [], but the ref mirrors the fontStepRef/suspendWebglRef/attachWebglRef
  // pattern and removes any exhaustive-deps churn risk). Kept in sync below.
  const fitWholeRef = useRef<() => void>(() => {})
  useEffect(() => {
    fitWholeRef.current = fitWhole
  }, [fitWhole])

  // Fire a fresh PTY spawn into the CURRENT term. Shared by the Restart action and
  // the ResizeObserver's deferred-respawn path (#23). The async .then()/.catch()
  // bail if the captured term was disposed/replaced mid-IPC (#16), and a rejected
  // pty:spawn invoke surfaces the error instead of leaving the board stuck on
  // 'spawning' (#11).
  const respawn = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // Consume a one-shot launch override (e.g. `claude --resume <id>`) for THIS spawn only.
    const override = launchOverrideRef.current
    launchOverrideRef.current = undefined
    // Pass only the two consumed fields (not the whole `board`) so exhaustive-deps keys
    // respawn on board.cwd/launchCommand — NOT the board identity (which churns on a
    // move/rename/font-change and would respawn the PTY).
    const { cwd, launchCommand } = resolveSpawnArgs(
      { cwd: board.cwd, launchCommand: board.launchCommand },
      projectDir,
      override
    )
    void window.api
      .spawnTerminal({
        id: board.id,
        shell: board.shell,
        cwd,
        launchCommand,
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
      // Effective render font = pinned × counter-scale (FREEZE): the well is laid out
      // at boardContent × cs, so the initial fit lands the same cols/rows at any zoom.
      fontSize: resolveInitialFont(fontSizeRef.current) * counterScaleRef.current,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: THEME,
      allowProposedApi: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    // Attach a GL context only when mounting un-suspended (not under LOD);
    // otherwise the board runs on the DOM renderer until the suspension lifts
    // (see the suspend effect in useTerminalWebgl).
    if (!suspendWebglRef.current) attachWebgl(term)
    // Whole-cell mount fit (clip-free). Routed through the ref so spawn's deps stay byte-identical.
    fitWholeRef.current()
    if (isE2E()) e2eTerminals.set(board.id, term)

    // Scale-correct selection (F2a): xterm's native cell math is off by the element's
    // NET visual scale. Under the counter-scale that net is camera-z / counterScale —
    // exactly 1 at rest (the shim no-ops), the live ratio mid-gesture. getZoom returns
    // that net (NOT the raw camera z — feeding the camera z here double-corrects, the
    // audit's proven selection bug). The `.xterm-screen` element exists once
    // `term.open(el)` ran; `el.parentElement` is the nodrag/nowheel screenWrap that
    // owns the mouse surface.
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
          paste: () => void pasteIntoTerminal(term, board.id, () => termRef.current === term),
          fontStep: (d) => fontStepRef.current(d),
          fontReset: () => fontResetRef.current()
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
      const { cwd, launchCommand } = resolveSpawnArgs(
        { cwd: board.cwd, launchCommand: board.launchCommand },
        projectDir
      )
      window.api
        .spawnTerminal({
          id: board.id,
          shell: board.shell,
          cwd,
          launchCommand,
          cols: term.cols,
          rows: term.rows
        })
        .then((res) => {
          // Guard: if the effect was torn down and a new term was created before this
          // IPC resolved, the result belongs to the old session — discard it (#54).
          if (disposed || termRef.current !== term) return
          if (res.state === 'spawn-failed') {
            setState('spawn-failed')
            term.write(`\x1b[31mspawn failed: ${res.error ?? 'unknown error'}\x1b[0m\r\n`)
          }
        })
        .catch((err: Error) => {
          // Same guard: stale rejection must not mislabel the successor session (#54).
          if (disposed || termRef.current !== term) return
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
      const decision = nextStateAfterAdopt(res.adopted, isIdleOnMount(board.id))
      if (decision === 'running') {
        setState('running')
      } else if (decision === 'idle') {
        setState('idle')
      } else {
        spawnAllowed = true
        launch()
      }
    })

    // FREEZE gate: a zoom settle changes `el`'s LAYOUT size (the counter-scale wrapper
    // is boardContent × cs), so the ResizeObserver fires — but a zoom must NEVER refit
    // (cols/rows are frozen across zoom; the effective font scales instead). The
    // screenWrap parent is z-INVARIANT (its layout is the board content size in world
    // px), so its size keys exactly the refits we want: mount (0/undefined → W), real
    // board resize, LOD/display:none exit, full-view portal in/out. A zoom-only RO
    // fire leaves the key unchanged and is skipped wholesale.
    let lastWrapKey: string | null = null
    const ro = new ResizeObserver(() => {
      const wrap = el.parentElement
      const key = wrap ? `${wrap.clientWidth}x${wrap.clientHeight}` : null
      if (key === lastWrapKey) return // zoom-driven layout change — FREEZE: no refit
      lastWrapKey = key
      fitWholeRef.current() // whole-cell fit (clip-free); swallows the not-laid-out throw itself
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
    // screenRef / fontStepRef / fontResetRef / pasteIntoTerminal are STABLE (refs +
    // a module fn), so listing them keeps spawn's identity churn-free — the PTY only
    // respawns on a genuine PTY-relevant change (the board id/shell/cwd/launchCommand,
    // projectDir, the webgl handlers, respawn, getZoom). They are listed (not omitted)
    // because exhaustive-deps no longer recognizes them as stable once they arrive via
    // props rather than a local useRef (the useGroupInteractions #98 lesson).
  }, [
    board.id,
    board.shell,
    board.cwd,
    board.launchCommand,
    projectDir,
    attachWebgl,
    detachWebgl,
    respawn,
    getZoom,
    screenRef,
    fontStepRef,
    fontResetRef,
    pasteIntoTerminal
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
    fitWhole() // whole-cell fit (clip-free); no-ops when the well isn't laid out
    const dims = fit?.proposeDimensions()
    if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) {
      pendingRespawnRef.current = false
      respawn()
    } else {
      pendingRespawnRef.current = true
    }
  }, [respawn, board.id, fitWhole])

  return {
    state,
    termRef,
    portRef,
    launchOverrideRef,
    startLaunchRef,
    fitWhole,
    restart,
    counterScale
  }
}
