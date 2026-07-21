/**
 * Terminal spawn lifecycle, extracted from TerminalBoard (god-file campaign, Tier-3).
 * Owns the PTY spawn/respawn/restart state machine and everything that must move as a
 * unit with it: the xterm construction, the MessagePort data-plane wiring, the
 * ResizeObserver-deferred spawn (#23/#34), the adopt/idle-on-mount fork (#15/M-1), the
 * scale-correct selection shim, the custom key handler (Shift+Enter = LF, copy/paste/font),
 * and the kill-tree teardown.
 *
 * RENDERER: the live terminal runs on xterm's built-in DOM renderer (terminal-crisp umbrella,
 * docs/research/2026-06-25-terminal-dom-renderer). DOM glyphs are re-rasterized by Chromium at
 * the live camera scale — like the whiteboard — so the terminal stays crisp under pan/zoom with
 * NO counter-scale. The xterm WebGL addon (a fixed-dpr canvas the camera transform resampled →
 * blur at any zoom != 1, soft for the whole gesture under the old FREEZE counter-scale) is no
 * longer loaded; a GPU-accelerated opt-in mode is a deferred follow-up (P2).
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
 *   - counterScale      — the FULL-VIEW font scale-up factor (Pure A1 #235): fullViewScale in
 *                         full view, 1 in-canvas (the DOM renderer needs no in-canvas counter-scale)
 * Everything else (fitRef, pendingRespawnRef, fontSizeRef, getZoom, the spawn/respawn
 * callbacks, the spawn effect) is INTERNAL.
 */
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject
} from 'react'
import { useStoreApi } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { runBackstopFit } from './terminalResizeBackstop'
import type { BackstopGate } from './terminalResizeBackstop'
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'
import type { TerminalState } from '../terminalState'
import {
  isE2E,
  e2eTerminals,
  e2eTerminalInput,
  e2eTerminalLink,
  e2eTerminalHeld,
  appendTerminalInput
} from '../../../smoke/e2eRegistry'
import { handleTerminalKey, TERMINAL_NEWLINE } from './terminalKeymap'
import {
  cacheSnapshot,
  clearSnapshot,
  copyWithFallback,
  emptySnapshot,
  readSnapshot
} from './selectionSnapshot'
import { registerTerminalInput, unregisterTerminalInput } from './terminalInputRegistry'
import { isIdleOnMount, clearIdleOnMount } from '../../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../../store/terminalRuntimeStore'
import {
  registerTerminalSnapshotter,
  unregisterTerminalSnapshotter
} from '../../../store/terminalSnapshotRegistry'
import { useTerminalLivenessStore, isTerminalLive } from '../../../store/terminalLivenessStore'
import { installSelectionShim } from './terminalSelection'
import { createResizeSettler, RESIZE_SETTLE_MS } from './terminalResizeSettle'
import { createTerminalWriteCoalescer, type TerminalWriteCoalescer } from './terminalWriteCoalescer'
import { BoardFullViewContext } from '../../fullViewContext'
import { resolveInitialFont } from './terminalFont'
import { resolveInitialScrollback } from './terminalScrollback'
import {
  terminalThemeColors,
  resolveTerminalFontFamily,
  resolveInitialThemeId,
  resolveInitialFontFamilyId
} from './terminalThemes'

/** A control-plane message arriving over the data-plane MessagePort. */
interface PortMessage {
  t: 'data' | 'exit' | 'state'
  d?: string
  code?: number
  state?: TerminalState
}

/** Platform check for the terminal key resolver's primary modifier (Cmd on macOS). */
const IS_MAC = navigator.platform.toLowerCase().includes('mac')

// Pure decision helpers live in terminalSpawnMath.ts (max-lines doctrine); imported for the
// hook body below AND re-exported so the unit tests + any external import keep this module
// path (the pty.ts › ptyResize.ts precedent).
import {
  conptyHint,
  fullViewScale,
  resolveSpawnArgs,
  nextStateAfterAdopt,
  finiteDims
} from './terminalSpawnMath'
export { conptyHint, fullViewScale, resolveSpawnArgs, nextStateAfterAdopt, finiteDims }

/**
 * Lane A held-buffer cap. While a terminal is hidden (off-screen / below-LOD) its PTY output is
 * HELD by the write coalescer, not rendered; this bounds the hold to roughly the configured
 * scrollback so a hidden firehose can't grow unbounded — past the cap the OLDEST held bytes are
 * dropped, exactly what xterm's scrollback would evict once the data rendered. ~512 chars/line is
 * generous for a heavily-SGR-coloured line; floored so a scrollback-0 terminal still holds the
 * recent screen. The cap is read per-enqueue (a thunk) so a live scrollback edit is honoured. */
const HOLD_BYTES_PER_LINE = 512
const HOLD_FLOOR_BYTES = 64_000

export interface TerminalSpawnDeps {
  board: TerminalBoardData
  /** Open project folder — a board with no explicit cwd spawns here, not os.homedir(). */
  projectDir: string | null | undefined
  /**
   * Place-first New Terminal flow: while true (this board is awaiting first-run config in
   * the dialog), the spawn effect is HELD — no xterm mounts, no PTY spawns. When it flips
   * false (dialog Create/Cancel), the effect runs once and mounts fresh, reading the
   * dialog-patched `launchCommand`. This is why the dialog config never races the spawn
   * (the xterm is constructed exactly once, after config is finalized).
   */
  configPending: boolean
  /** The xterm host div, planted by the host's render (term.open() mounts into it). */
  screenRef: RefObject<HTMLDivElement | null>
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
  /**
   * Web-links activation (Phase 4 correctness pack): the WebLinksAddon hands a Ctrl/Cmd-clicked
   * link's URI to the host, which routes it to a Browser board or the OS browser. Read through a
   * ref so the addon's click handler — built ONCE per spawn — never becomes a spawn dep (mirrors
   * the fontStepRef seam); `shiftKey` carries the board↔external destination flip.
   */
  onLinkActivate: (uri: string, opts: { shiftKey: boolean }) => void
}

/**
 * Stable handle the host hands to TerminalFindBar (Phase 2). `addonRef`/`termRef` are stable refs
 * and `close` is a stable callback, so the whole object is memoised once — the bar can be memo'd
 * and ignore the host's ~12 Hz spinner re-renders.
 */
export interface TerminalFindApi {
  /** Close the find bar (TerminalFindBar clears decorations + refocuses xterm on unmount). */
  close: () => void
  /** The live SearchAddon loaded on the current term (null before first spawn). */
  addonRef: RefObject<SearchAddon | null>
  termRef: RefObject<Terminal | null>
  /**
   * Find-count fix: synchronously flush the write coalescer's pending PTY bytes into the term
   * so the SearchAddon scans a buffer that matches the screen — without this, a query typed in
   * the same tick as fresh output searches a buffer that lacks it, and the addon's write-gated
   * recount latches the under-count until the NEXT output (minutes on an idle terminal).
   */
  flushPending: () => void
}

export interface TerminalSpawnApi {
  state: TerminalState
  /** Phase 5 · S3: this idle mount restored a persisted scrollback snapshot — the host shows the
   *  restored (read-only) buffer with a bottom "Session restored" bar instead of the opaque overlay. */
  restored: boolean
  /** Bg sessions Phase 5: the session EXITED while its project was backgrounded — the restored
   *  bar says "exited in background (code N)" and the residue tail is spliced after the snapshot.
   *  Null when the restore is a plain snapshot (no background exit). */
  restoredExitCode: number | null
  /** Read-only from the host (it only reads `.current`); the hook's internals own writes. */
  termRef: RefObject<Terminal | null>
  portRef: RefObject<MessagePort | null>
  /** The host WRITES these (Restart menu sets the override; idle Start reads the launcher). */
  launchOverrideRef: MutableRefObject<string | undefined>
  startLaunchRef: MutableRefObject<(() => void) | null>
  fitWhole: () => void
  restart: () => void
  /**
   * FULL-VIEW font scale-up factor (Pure A1 #235; S3 unfroze the grid): in full view the
   * board is portaled OUTSIDE React Flow (no camera); the render font is enlarged
   * (pinned × counterScale = fullViewScale) and the grid then refits to the modal at that
   * font through the lossless S2 backstop (no reflow corruption; spare width → columns).
   * In-canvas it is 1: the DOM renderer re-rasters crisp at the live camera scale, so no
   * counter-scale wrapper is needed (the host rides the camera transform directly).
   */
  counterScale: number
  /** Phase 2 find-in-terminal: whether the find bar is open (host mounts TerminalFindBar). */
  findOpen: boolean
  /** Stable handle the host passes to TerminalFindBar. */
  findApi: TerminalFindApi
  /**
   * Terminal-copy fix (docs/reviews/2026-07-11-terminal-copy-paste-research): the last-known
   * selection TEXT ('' when none cached / expired). The copy paths (Ctrl+C, context menu) fall
   * back to this when the live `getSelection()` is empty — a streaming agent's mouse-tracking
   * toggles wipe the live selection out from under the user (xterm `SelectionService.disable()`).
   */
  selectionFallback: () => string
  /** Open the find bar (Ctrl/Cmd+F equivalent) — surfaces the keyboard-only Find as a clickable
   *  affordance for the Board Inspector's Session section. */
  openFind: () => void
}

/** Requires ReactFlowProvider (useStoreApi) + BoardFullViewContext in the render tree. */
export function useTerminalSpawn(deps: TerminalSpawnDeps): TerminalSpawnApi {
  const { board, projectDir, screenRef, fontStepRef, fontResetRef, pasteIntoTerminal } = deps
  const { configPending } = deps

  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Phase 5 · S2: the SerializeAddon snapshots the buffer for the lossless drag-resize backstop.
  // `resizeBackstopRef` holds the write coalescer while a snapshot→reset→rewrite is in flight so
  // in-flight PTY bytes queue and flush AFTER the restored scrollback (never into the reset buffer).
  const serializeAddonRef = useRef<SerializeAddon | null>(null)
  const resizeBackstopRef = useRef(false)
  // Re-entrancy gate for the backstop: a continuous drag fires the ResizeObserver per-frame while
  // a prior backstop's async `term.write` is still parsing (large scrollback spans frames). Without
  // this, a second fit would snapshot a half-written buffer and reset() away the pre-drag scrollback
  // — the #5319 corruption this slice removes. `pending` coalesces skipped frames into one catch-up.
  const backstopGateRef = useRef<BackstopGate>({ pending: false })
  // The backstop's coalesced catch-up re-fit (see runBackstopFit) is invoked through its OWN ref,
  // not `fitWholeRef` directly, so `fitWhole` never statically captures `fitWholeRef` — which would
  // make the `[fitWhole]`-keyed mirror effect a forbidden self-referential mutation
  // (react-hooks/immutability). This ref is wired in a mount-only effect below.
  const refitRef = useRef<() => void>(() => {})
  // Phase 2 find-in-terminal: the SearchAddon is loaded onto the term alongside fit (so it is
  // re-created with every respawn), and the open-state lives here because the Ctrl/Cmd+F chord is
  // detected in this hook's xterm key handler. The bar's query/result state stays LOCAL to
  // TerminalFindBar (per-keystroke re-renders never reach the host).
  const searchAddonRef = useRef<SearchAddon | null>(null)
  // Terminal-copy fix: last-known selection text, cached on onSelectionChange and consumed by
  // the copy paths when the live selection was wiped mid-gesture (selectionSnapshot.ts has the
  // full policy: what caches it, what invalidates it, and why).
  const snapRef = useRef(emptySnapshot())
  const [findOpen, setFindOpen] = useState(false)
  const closeFind = useCallback(() => setFindOpen(false), [])
  const openFind = useCallback(() => setFindOpen(true), [])
  // Terminal-copy fix: non-consuming read of the snapshot for the host (menu enable-state +
  // the context-menu Copy fallback). Stable identity — reads the ref at call time.
  const selectionFallback = useCallback(() => readSnapshot(snapRef.current, performance.now()), [])
  // Find-count fix: the bar's flush-before-search seam. Routed through its OWN function ref
  // (the refitRef precedent above) rather than reading coalescerRef here: a coalescerRef read
  // reachable from an effect would make the spawn effect's `coalescerRef.current = coalescer`
  // a forbidden cross-effect mutation under the compiler lint. The spawn effect fills this
  // right after it creates the coalescer and resets it on teardown.
  const flushPendingRef = useRef<() => void>(() => {})
  const findApi = useMemo<TerminalFindApi>(
    () => ({
      close: closeFind,
      addonRef: searchAddonRef,
      termRef,
      flushPending: () => flushPendingRef.current()
    }),
    [closeFind]
  )
  // Make the buffer current the moment the bar opens (the seed-from-selection search runs on
  // mount). If the board is mid-reveal (liveness still settling) the flush refuses and the
  // bar's settle re-search covers the catch-up instead.
  useEffect(() => {
    if (findOpen) findApi.flushPending()
  }, [findOpen, findApi])
  // True once the grid has had a real fit, i.e. it carries an established column count with
  // scrollback worth protecting: an established grid's cols change routes through the lossless
  // S2 backstop, while a FRESH mount takes the plain initial fit (nothing to corrupt, and
  // skipping it would spawn a wrong-width PTY — #regression). Since S3 a full-view fit also
  // establishes (the exit refit must ride the backstop too). Reset per new term in spawn().
  const establishedRef = useRef(false)
  // Switch-back replay fix: true once THIS term's grid reflects a real layout (a fit whose
  // proposeDimensions was finite). Until then the term sits at the constructor-default 80×24,
  // and any bytes written — an adopt's replayed scrollback, a restored snapshot — would wrap at
  // 80 cols and then be mangled by the first real fit's reflow (plainFit path: a fresh grid has
  // no backstop). The write coalescer's hold gate reads this ref, so pre-fit bytes queue and
  // flush AFTER the grid is real. Reset per new term in the spawn closure (beside establishedRef).
  const gridFittedRef = useRef(false)
  const portRef = useRef<MessagePort | null>(null)
  // #23: when a Restart happens while the well is unfitted (LOD/display:none),
  // proposeDimensions has no finite dims yet, so we defer the actual respawn and
  // let the spawn effect's ResizeObserver consume this flag on the first good fit.
  const pendingRespawnRef = useRef(false)
  // BUG-033: re-entrancy guard for respawn(). termRef.current!==term alone only catches a
  // full remount (a NEW term object) — it does NOT catch a second respawn() firing on the
  // SAME term before the first's spawnTerminal IPC resolves (e.g. two Restart clicks, or a
  // deferred pendingRespawnRef fire racing an explicit Restart). Without this, a slow OLDER
  // spawn's rejection/`spawn-failed` can land AFTER a newer respawn already succeeded and is
  // running, clobbering the live session with a false "spawn failed" banner. Bumped at the
  // start of every respawn(); a result is applied only if it is still the latest generation.
  const respawnGenerationRef = useRef(0)
  // T-resume: a one-shot launchCommand override for the NEXT respawn (the Restart menu's
  // "Resume session" sets `claude --resume <id>`); respawn consumes + clears it so only that
  // spawn uses it and a later restart falls back to board.launchCommand.
  const launchOverrideRef = useRef<string | undefined>(undefined)
  // M-1: the idle-state "Start" button calls back into the CURRENT mount's `launch()`
  // (the spawn closure is local per mount). The spawn effect points this ref at a
  // launcher that flips `spawnAllowed` and fires; null while no live term exists.
  const startLaunchRef = useRef<(() => void) | null>(null)
  // S3: this mount has gone live via an explicit Start/Resume — set by startLaunchRef AND restart()
  // so the async snapshot-restore (readSnapshot resolves a frame later) can't write a stale buffer
  // INTO a session the user already started on the same term. Reset per new term in spawn().
  const startedRef = useRef(false)
  // board.fontSize for the spawn closure's INITIAL xterm construction, read via a ref so
  // a size change never becomes a spawn dep (which would respawn the PTY).
  const fontSizeRef = useRef<number | undefined>(board.fontSize)

  // Keep the spawn closure's initial-font ref synced (read on construction only; never a spawn dep).
  useEffect(() => {
    fontSizeRef.current = board.fontSize
  }, [board.fontSize])

  // Desktop-notifications P3: the board's monitorActivity opt-out, forwarded on every spawn so MAIN
  // can silence this session's generic-PTY lifecycle notifications. Read via a ref (like fontSizeRef)
  // so a mid-session flip never becomes a spawn dep — it takes effect on the next (re)spawn, matching
  // the other spawn-time board fields; a live flip still reaches MAIN through the board mirror.
  const monitorActivityRef = useRef<boolean | undefined>(board.monitorActivity)
  useEffect(() => {
    monitorActivityRef.current = board.monitorActivity
  }, [board.monitorActivity])

  // v20 OpenRouter routing intent, forwarded on every spawn so MAIN can inject the provider
  // env (compile-gated feature — inert in ungated builds). Read via a ref (mirrors
  // monitorActivityRef) so a dialog edit never becomes a spawn dep — the dialog's
  // Apply & restart path respawns anyway, which is when the new intent takes effect.
  const openRouterRef = useRef<TerminalBoardData['openRouter']>(board.openRouter)
  useEffect(() => {
    openRouterRef.current = board.openRouter
  }, [board.openRouter])

  // board.themeId / board.fontFamilyId for the spawn closure's INITIAL xterm construction, read via
  // refs so a change is NEVER a spawn dep — the theme/font apply LIVE in the host (TerminalBoard's
  // live-apply effects) without respawning the PTY (mirrors fontSizeRef / scrollbackRef). Lane B.
  const themeIdRef = useRef<string | undefined>(board.themeId)
  const fontFamilyIdRef = useRef<string | undefined>(board.fontFamilyId)
  useEffect(() => {
    themeIdRef.current = board.themeId
  }, [board.themeId])
  useEffect(() => {
    fontFamilyIdRef.current = board.fontFamilyId
  }, [board.fontFamilyId])

  // board.scrollback for the spawn closure's INITIAL xterm construction (read via a ref so a
  // change is never a spawn dep), AND applied live to an existing term: xterm's `scrollback`
  // option is mutable, so an edit takes effect WITHOUT respawning the PTY — no session loss,
  // mirroring the live font seam. Lowering it trims the oldest buffered lines; raising is lossless.
  // Web-links handler (Phase 4): ref-synced so the addon's click handler (built once per spawn)
  // always calls the host's LATEST router without becoming a spawn dep. Mirrors fontStepRef.
  const onLinkActivateRef = useRef(deps.onLinkActivate)
  useEffect(() => {
    onLinkActivateRef.current = deps.onLinkActivate
  }, [deps.onLinkActivate])

  const scrollbackRef = useRef<number | undefined>(board.scrollback)
  useEffect(() => {
    scrollbackRef.current = board.scrollback
    const term = termRef.current
    const next = resolveInitialScrollback(board.scrollback)
    if (term && term.options.scrollback !== next) term.options.scrollback = next
  }, [board.scrollback])

  // ── Lane A: render-liveness gate (xterm #880) ────────────────────────────────
  // useTerminalLiveness (mounted once in CanvasInner) publishes whether THIS board is on-screen
  // ∧ ≥ LOD. We mirror its flag into a ref the spawn closure's write coalescer reads: while hidden
  // the coalescer HOLDS incoming PTY data (the session never pauses — bytes still arrive and
  // accumulate, bounded by ~scrollback) and renders nothing; on becoming visible it flushes the
  // held bytes losslessly so the revealed terminal catches up. Read via a NON-reactive store
  // subscription (never a React re-render): a flip is a ref write + at most one rAF flush.
  const liveRef = useRef(true)
  const coalescerRef = useRef<TerminalWriteCoalescer | null>(null)
  useEffect(() => {
    const apply = (live: boolean): void => {
      if (live === liveRef.current) return
      liveRef.current = live
      if (live) coalescerRef.current?.onVisible() // reveal → catch up on the held buffer
    }
    apply(isTerminalLive(board.id)) // seed (default-true until the first reconcile assigns it)
    // The store holds ONLY the live map, so every change is a liveness change; apply() diff-guards.
    return useTerminalLivenessStore.subscribe((s) => apply(s.live[board.id] ?? true))
  }, [board.id])

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
  // Layout effect (kept from the freeze era): the only remaining reader is `getZoom` (the
  // selection shim's camera correction), but committing the ref synchronously — before the
  // portal relocation's post-layout RO delivery — is still the tightest ordering and costs
  // nothing. (S3 removed the fitWhole/RO freeze reads; the grid now refits via the backstop.)
  useLayoutEffect(() => {
    fullViewRef.current = isFullView
  }, [isFullView])

  // ── Full-view font scale-up (Pure A1 #235; grid unfrozen in S3) ───────────────
  // The live terminal runs on xterm's DOM renderer, which Chromium re-rasters crisp at the
  // live camera scale — so IN-CANVAS there is NO counter-scale: counterScale is 1 and the
  // host rides the camera `scale(z)` transform directly (like the whiteboard). counterScale
  // is != 1 ONLY in full view, where the board is portaled OUTSIDE React Flow (no camera):
  // the render font is enlarged (pinned × fullViewScale) so full view reads BIGGER, and —
  // since S3 — the grid then REFITS to the modal at that font through the lossless S2
  // backstop, so the min-fit letterbox's spare axis becomes real columns/rows instead of
  // dead space. cols/rows stay FROZEN across in-canvas zoom (a camera zoom is a CSS
  // transform on an ancestor and never resizes the host's border box), so the PTY/TUI
  // never reflows on zoom.
  //
  // LIVE window size while in full view (stale-scale fix): fullViewScale used to read
  // window.innerWidth/Height once at render, so toggling OS fullscreen / maximize WHILE in
  // full view left the factor stale (the shipped-A1 "accepted minor gap" — measured real:
  // the modal grows but the grid keeps its old scale, reading as dead space). Track the
  // window size in state while full view is open: a resize re-renders → counterScale
  // recomputes → the useTerminalReraster font seam re-applies pinned × scale → the
  // row-fill hook (keyed on the scale) re-fills the modal height. Cols still never change.
  const [fvWinSize, setFvWinSize] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight
  }))
  useEffect(() => {
    if (!isFullView) return undefined
    const update = (): void => {
      setFvWinSize((s) =>
        s.w === window.innerWidth && s.h === window.innerHeight
          ? s
          : { w: window.innerWidth, h: window.innerHeight }
      )
    }
    update() // enter: catch a resize that happened while in-canvas (state would be stale)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [isFullView])
  const counterScale = isFullView ? fullViewScale(board.w, board.h, fvWinSize.w, fvWinSize.h) : 1
  // Ref mirror for the spawn closure (initial font) — NEVER a spawn dep, so a full-view
  // toggle cannot respawn the PTY (mirrors fontSizeRef).
  const counterScaleRef = useRef(counterScale)
  useEffect(() => {
    counterScaleRef.current = counterScale
  }, [counterScale])
  // Resize-storm fix (T1b): a counterScale change (full-view enter/exit, the live mid-full-view
  // OS rescale) opens a TRANSITION window. The portal relocation's ResizeObserver fire lands
  // inside it with STALE cell metrics — the font seam's new render font hasn't been measured
  // yet — so its fit proposes the wrong cols and pays a full serialize→reset→rewrite backstop
  // that the reraster's own one-frame-deferred refit immediately repeats at the correct
  // metrics: two full-buffer replays + two SIGWINCH repaints per transition where one suffices
  // (each spurious repaint litters scrollback via claude-code#51828). While the flag is up the
  // RO skips its fit; the NEXT explicit fitWhole — the reraster's deferred refit, or whichever
  // caller lands first (both orderings safe: whoever runs consumes the flag and fits) — owns
  // the transition. Layout effect so the flag is up BEFORE the relocation's RO delivery.
  const csTransitionRef = useRef(false)
  const prevCsTransitionRef = useRef(counterScale)
  useLayoutEffect(() => {
    if (prevCsTransitionRef.current === counterScale) return
    prevCsTransitionRef.current = counterScale
    csTransitionRef.current = true
  }, [counterScale])

  // Live camera zoom for the selection shim. The DOM-rendered host rides the raw React Flow
  // viewport transform `scale(z')` (no counter-scale wrapper), so the element's on-screen
  // visual scale IS the camera zoom — xterm's native cell math must be corrected by exactly
  // that. Full view portals the board OUTSIDE React Flow with no RESTING CSS scale (the
  // scale-up is the bigger render font alone), so the shim reads 1 there. (During the ~320ms
  // open/close stretch the modal frame is transiently scaled; a selection started
  // mid-animation could be slightly off — pre-existing, unchanged here.)
  const getZoom = useCallback(
    (): number => (fullViewRef.current ? 1 : rfStore.getState().transform[2]),
    [rfStore]
  )

  const [state, setState] = useState<TerminalState>('spawning')
  // Phase 5 · S3: true when this idle mount restored a persisted scrollback snapshot from disk — the
  // host then swaps the opaque "Start" overlay for a bottom bar so the restored (read-only) output
  // stays visible. Reset per new term; set by the adopt fork when a sidecar is read + written back.
  const [restored, setRestored] = useState(false)
  // Bg sessions Phase 5: exit code of a session that died while backgrounded (residue UX).
  const [restoredExitCode, setRestoredExitCode] = useState<number | null>(null)

  // Publish live PTY state so the preview-link edge can render stale when this
  // terminal is not running (bug 3); clear on unmount so a removed board stops
  // counting as a running source.
  useEffect(() => {
    useTerminalRuntimeStore.getState().setRunning(board.id, state)
  }, [board.id, state])
  useEffect(() => () => useTerminalRuntimeStore.getState().clear(board.id), [board.id])

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
    // Resize-storm fix (T1b): any explicit fit consumes the counterScale-transition flag —
    // this call IS the transition's fit (normally the reraster's deferred correct-metrics
    // refit), so the ResizeObserver's suppression window ends here.
    csTransitionRef.current = false
    // Full-view UNFREEZE (S3, terminal-display fix): Pure A1 used to freeze an ESTABLISHED grid
    // here — a cols-changing refit rode xterm's lossy reflow (truncation/duplication), so full
    // view scaled the font only and LETTERBOXED the non-binding axis (the "dead space at the
    // right" complaint). The S2 backstop (below) has since made a cols change LOSSLESS
    // (snapshot → resize → reset → re-write), so full view now refits THROUGH it: the portal's
    // well resize proposes the modal grid at the scaled font (pinned × counterScale) and the
    // spare width becomes real columns; the exit resize refits back to the board grid the same
    // way. The PTY gets its SIGWINCH both ways, so a TUI agent reflows to the wide grid.
    // Phase 5 · S2 — lossless drag-resize. An ESTABLISHED grid whose COLS change (a real board
    // drag-resize — the last live reflow path now that zoom rides counterScale and full view is
    // frozen) would hit xterm's lossy buffer reflow (#5319). Snapshot → resize → reset → re-write so
    // xterm re-WRAPS cleanly at the new width instead. Fresh/first-layout fits (not yet established)
    // and rows-only resizes take the plain fit — neither reflows. `runBackstopFit` also GUARDS
    // re-entry: a continuous drag fires this per-frame while a prior backstop's async write is still
    // parsing, so it defers (coalesces to one catch-up refit) instead of overlapping two
    // serialize/reset pairs — which would snapshot a half-written buffer and lose scrollback.
    // Returns false when it skipped (backstop in flight) or the well is not laid out → skip the
    // row-shed below.
    const didFit = runBackstopFit(backstopGateRef.current, {
      currentCols: () => term.cols,
      propose: () => {
        const p = fit.proposeDimensions()
        return finiteDims(p) ? { cols: p.cols, rows: p.rows } : undefined
      },
      established: () => establishedRef.current,
      plainFit: () => {
        try {
          fit.fit()
          return true
        } catch {
          return false // well not laid out (LOD / display:none)
        }
      },
      isInFlight: () => resizeBackstopRef.current,
      refit: () => refitRef.current(),
      serialize: () => serializeAddonRef.current?.serialize() ?? '',
      resize: (c, r) => term.resize(c, r),
      reset: () => term.reset(),
      write: (data, done) => term.write(data, done),
      pausePump: () => {
        resizeBackstopRef.current = true
      },
      resumePump: () => {
        resizeBackstopRef.current = false
        coalescerRef.current?.onVisible() // flush PTY bytes held during the snapshot, in order
      }
    })
    if (!didFit) return
    // Switch-back replay fix: the fit above ran, but plainFit can "succeed" as a silent no-op
    // when the well has no layout (FitAddon.fit() returns early on an undefined proposal), so
    // gate the release on a FINITE proposal — the grid now truly reflects the board's width.
    if (!gridFittedRef.current && finiteDims(fit.proposeDimensions())) {
      gridFittedRef.current = true
      // Release the bytes held for the pre-fit window (an adopt's replayed scrollback / a
      // restored snapshot that raced this first fit) — they now wrap at the true column count.
      coalescerRef.current?.onVisible()
      // Heal PTY↔term grid drift: an adopted session's PTY kept its pre-park size, and this
      // fit may have run BEFORE the reposted port attached (term.onResize posted into a null
      // portRef). One explicit sync is cheap — a same-size resize is a no-op downstream, and
      // a real change gives the TUI its SIGWINCH repaint. The port-attach path mirrors this
      // for the opposite ordering.
      portRef.current?.postMessage({ t: 'resize', cols: term.cols, rows: term.rows })
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
    // Any real fit establishes the grid (S3): with the full-view freeze gone, a session born in
    // full view must ALSO establish, so its exit refit rides the lossless backstop instead of a
    // plain reflow. (Pre-S3 this was in-canvas-only — the freeze keyed off an in-canvas base.)
    establishedRef.current = true
  }, [screenRef])

  // Route the in-spawn fit calls through a ref so `spawn`'s dependency array stays byte-identical
  // (fitWhole is itself stable [], but the ref mirrors the fontStepRef pattern and removes any
  // exhaustive-deps churn risk). Kept in sync below.
  const fitWholeRef = useRef<() => void>(() => {})
  useEffect(() => {
    fitWholeRef.current = fitWhole
  }, [fitWhole])
  // Mount-only: forward the backstop's catch-up re-fit to the current fitWhole. `[]` deps (NOT
  // `[fitWhole]`) so `fitWhole` — which captures `refitRef` — is never a dependency of the effect
  // that assigns it; the arrow reads `fitWholeRef.current` lazily, so it always calls the latest fit.
  useEffect(() => {
    refitRef.current = () => fitWholeRef.current()
  }, [])

  // Fire a fresh PTY spawn into the CURRENT term. Shared by the Restart action and
  // the ResizeObserver's deferred-respawn path (#23). The async .then()/.catch()
  // bail if the captured term was disposed/replaced mid-IPC (#16), and a rejected
  // pty:spawn invoke surfaces the error instead of leaving the board stuck on
  // 'spawning' (#11).
  const respawn = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // BUG-033: claim this call's generation. Any earlier in-flight respawn() on this same
    // term is now stale — its eventual .then()/.catch() must not touch state/term below.
    const generation = ++respawnGenerationRef.current
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
        rows: term.rows,
        monitorActivity: monitorActivityRef.current,
        openRouter: openRouterRef.current
      })
      .then((res) => {
        if (termRef.current !== term || respawnGenerationRef.current !== generation) return
        if (res.state === 'spawn-failed') {
          setState('spawn-failed')
          term.write(`\x1b[31mspawn failed: ${res.error ?? 'unknown error'}\x1b[0m\r\n`)
        }
      })
      .catch((err: Error) => {
        if (termRef.current !== term || respawnGenerationRef.current !== generation) return
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

    // Font family from the closed registry (terminalThemes.ts, Lane B). xterm measures + renders
    // glyphs with the literal `fontFamily` and CSS var() does NOT resolve there, so the registry
    // reads the literal stack off the --term-mono* var (default 'system' = the hinted OS terminal
    // stack — Cascadia Mono/Consolas/SF Mono). Read via the ref so a font change applies LIVE in
    // the host without respawning; an absent/unknown id degrades to the system default.
    const mono = resolveTerminalFontFamily(resolveInitialFontFamilyId(fontFamilyIdRef.current))

    const term = new Terminal({
      fontFamily: mono,
      // The board's pinned font in board-content px (× counterScale, which is 1 in-canvas and
      // the full-view scale-up otherwise). The DOM renderer re-rasters at the live camera
      // scale, so no zoom-dependent counter-scale is applied in-canvas.
      fontSize: resolveInitialFont(fontSizeRef.current) * counterScaleRef.current,
      lineHeight: 1.2,
      cursorBlink: true,
      // ANSI palette from the closed theme registry (Lane B). Read via the ref so a theme change
      // applies LIVE in the host (term.options.theme = {…fresh}) without respawning the PTY; an
      // absent id resolves to the sticky last-used, an unknown id degrades to the Canvas default.
      theme: terminalThemeColors(resolveInitialThemeId(themeIdRef.current)),
      allowProposedApi: true,
      // Bounded scrollback (perf SLICE-012): xterm retains ~12 B/cell that never releases while a
      // board stays mounted at LOD. Now configurable per board (Appearance tab) with a sticky
      // default; absent => 2000. Capped at 50000 (~70 MB worst case/terminal — see
      // terminalScrollback.ts) so a runaway log can't exhaust RAM. No "unlimited" by design.
      scrollback: resolveInitialScrollback(scrollbackRef.current),
      // A-Win (terminal-scrollback fix § A-Win): on Windows 11 ConPTY (build ≥ 21376) tell xterm the
      // ConPTY context so its resize/scrollback handling aligns with ConPTY's own screen reprint —
      // this cuts the xterm⇄ConPTY double-layout that duplicates/garbles rows on a resize (the
      // residual drag-resize path; full view is already reflow-free via Pure A1). Undefined off
      // Windows or on older builds, where setting it would DISABLE reflow and lose data on widen.
      windowsPty: conptyHint(window.api?.osWinBuild ?? null),
      // Terminal-copy fix: when the child TUI has mouse-tracking on, xterm forwards mouse events
      // to it and plain drag-select is disabled; Shift+drag forces local selection everywhere,
      // and this gives macOS the conventional Option+click force as well (VS Code's
      // `terminal.integrated.macOptionClickForcesSelection`). No-op on Windows/Linux.
      macOptionClickForcesSelection: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Phase 2: find-in-terminal. Loaded per-term (disposed with the term on respawn). Decorations
    // (the match highlights + onDidChangeResults count) are requested per find call by the bar.
    const search = new SearchAddon()
    term.loadAddon(search)
    searchAddonRef.current = search
    // Phase 4 correctness pack — Unicode 11 width tables: correct cell width for emoji / CJK /
    // combining chars, fixing wide-glyph misalignment AND the wrap miscount that fed the reflow
    // drift Phase 1 fought. Proposed API (allowProposedApi is set above).
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    // Phase 5 · S2: buffer snapshot for the lossless drag-resize backstop (no DOM binding needed).
    const serializeAddon = new SerializeAddon()
    term.loadAddon(serializeAddon)
    serializeAddonRef.current = serializeAddon
    // S3: publish this term's buffer serializer so the app can flush its scrollback to the
    // `.canvas/terminal/<id>.snapshot` sidecar on quit / window-close / project-switch (see
    // terminalSnapshotRegistry). Unregistered on teardown. A new term starts un-restored.
    registerTerminalSnapshotter(board.id, () => serializeAddonRef.current?.serialize() ?? null)
    setRestored(false)
    setRestoredExitCode(null)
    startedRef.current = false // a fresh term: no explicit Start/Resume has run on it yet
    term.open(el)
    termRef.current = term
    fitRef.current = fit
    // Phase 4 — clickable links: Ctrl/Cmd+click activates (plain click stays with the selection
    // shim); the host routes the URI to a Browser board or the OS browser. The handler reads the
    // host's latest router via the ref so this closure-built addon never depends on its identity.
    // Loaded AFTER term.open(): xterm's Linkifier (which sets the hovered link + binds the
    // mousedown/up activation) initializes against the DOM at open, so the provider must register
    // onto an opened terminal to be clickable.
    const activateLink = (
      uri: string,
      mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
    ): void => {
      if (!(mods.ctrlKey || mods.metaKey)) return // require the modifier; plain click = select
      onLinkActivateRef.current(uri, { shiftKey: !!mods.shiftKey })
    }
    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => activateLink(uri, event),
        isE2E()
          ? {
              // Real-hover probe: the @terminal e2e asserts the addon actually DETECTED + linkified a
              // URL (the part synthetic clicks can't reach), reading this back as `window.__linkHover`.
              hover: (_e, uri) => {
                ;(window as unknown as { __linkHover?: string }).__linkHover = uri
              }
            }
          : undefined
      )
    )
    // e2e seam: drive the EXACT activation function the addon calls so the routing (modifier gate →
    // Browser-board create/route or shell:openExternal) is testable without an xterm link-click.
    if (isE2E()) e2eTerminalLink.set(board.id, activateLink)
    establishedRef.current = false // a fresh grid: not yet fitted in-canvas (full-view freeze base)
    gridFittedRef.current = false // a fresh grid: constructor-default 80×24 until the first real fit
    // No WebGL/canvas RENDERER addon is loaded (the fit/search/unicode/web-links addons above
    // don't change the render path) => xterm uses its built-in DOM renderer, which Chromium
    // re-rasterizes crisp at any camera scale (the fix for pan/zoom blur).
    // Whole-cell mount fit (clip-free). Routed through the ref so spawn's deps stay byte-identical.
    fitWholeRef.current()
    if (isE2E()) e2eTerminals.set(board.id, term)

    // Scale-correct selection (F2a): xterm's native cell math is off by the element's
    // on-screen visual scale. The DOM host rides the raw camera transform `scale(z')`, so
    // that scale IS the camera zoom — getZoom returns it (1 in full view, where the board is
    // portaled outside the camera). The `.xterm-screen` element exists once `term.open(el)`
    // ran; `el.parentElement` is the nodrag/nowheel screenWrap that owns the mouse surface.
    const screenEl = el.querySelector('.xterm-screen') as HTMLElement | null
    const wrapEl = el.parentElement
    const selectionDisp =
      screenEl && wrapEl ? installSelectionShim(wrapEl, screenEl, getZoom) : null

    // Terminal-copy fix: cache the selection TEXT the moment it exists (xterm stores only
    // buffer coordinates — an Ink redraw rewrites the cells under an intact-looking highlight,
    // and agent-side mouse-tracking toggles clear it outright). Empty updates are ignored by
    // cacheSnapshot: clears are handled by the gesture listeners below, never by this event.
    const selSnapDisp = term.onSelectionChange(() => {
      cacheSnapshot(snapRef.current, term.getSelection(), performance.now())
    })
    // A plain left-click in the well is the deliberate-deselect gesture → drop the fallback so
    // the next Ctrl+C is SIGINT. A new drag re-caches via onSelectionChange on its own; Shift is
    // excluded because Shift+click EXTENDS a selection (and Shift+drag is the forced-selection
    // escape hatch under mouse-tracking). Capture phase: at zoom ≠ 1 the selection shim swallows
    // the original mousedown at the wrap and re-dispatches a clone from `.xterm-screen` — capture
    // on `el` sees exactly one of the two in both regimes.
    const invalidateSnapOnDown = (e: MouseEvent): void => {
      if (e.button === 0 && !e.shiftKey) clearSnapshot(snapRef.current)
    }
    el.addEventListener('mousedown', invalidateSnapOnDown, true)

    // Forward keystrokes + resizes to whatever port is CURRENT. Registered ONCE
    // (not inside onWinMsg) so a restart — which delivers a fresh port through the
    // same persistent message listener — doesn't stack duplicate xterm listeners;
    // the disposables are released on teardown.

    // All PTY-bound input flows through one seam so the e2e harness can observe it and
    // so the key handler (newline) and term.paste both share the same path.
    const sendInput = (d: string): void => {
      if (isE2E()) appendTerminalInput(board.id, d)
      // Terminal-copy fix: typed input invalidates the copy-fallback snapshot — the user is
      // interacting with the agent again, so a later Ctrl+C means interrupt, not copy. ESC-
      // prefixed data is NOT typed intent and must not invalidate: mouse reports under DECSET
      // 1000/1002/1003 (the very agent-side traffic the snapshot exists to survive), focus
      // events, arrow keys, bracketed-paste frames.
      if (!d.startsWith('\x1b')) clearSnapshot(snapRef.current)
      portRef.current?.postMessage({ t: 'input', d })
    }
    // Voice V3 injection seam: paste rides term.paste (bracketed), submit is ONE discrete \r
    // down the same sendInput path as typed keys. Registered here (not at :705) because it
    // closes over sendInput; unregistered in teardown beside the e2e registries.
    registerTerminalInput(board.id, {
      paste: (text) => term.paste(text),
      submit: () => sendInput('\r')
    })
    const dataDisp = term.onData((d) => sendInput(d))
    // Resize-storm fix (T1a): the xterm grid may step several times in one transition (the
    // backstop's cols resize + the whole-cell row-shed land in the same fitWhole; a coalesced
    // catch-up fit can follow) — forwarding EACH step to the PTY means one ConPTY SIGWINCH +
    // one TUI live-region repaint per step, and every repaint litters scrollback under
    // claude-code#51828. The settler collapses the burst: the PTY sees only the SETTLED grid,
    // one resize per ~3-frame window. The adopt grid-sync heals (fitWhole / port-attach) stay
    // DIRECT posts — they are one-shot drift repairs, and MAIN's same-size dedup absorbs them
    // when the grids already agree.
    const resizeSettler = createResizeSettler({
      post: (cols, rows) => portRef.current?.postMessage({ t: 'resize', cols, rows }),
      delayMs: RESIZE_SETTLE_MS,
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (h) => window.clearTimeout(h)
    })
    const resizeDisp = term.onResize(({ cols, rows }) => resizeSettler.push(cols, rows))

    // Custom key handling (returns false to suppress xterm's default for keys we own).
    // handleTerminalKey calls e.preventDefault() for every owned chord — REQUIRED: xterm's
    // _keyDown bails before its own preventDefault once we return false, so without it the
    // follow-up keypress for Enter leaks a CR after our LF (the Shift+Enter submit bug).
    //  - Shift+Enter inserts a newline (LF / Ctrl+J via TERMINAL_NEWLINE; NOT the ConPTY-fragile ESC+CR).
    //  - Ctrl/Cmd+C copies when a selection exists — live OR the snapshot fallback (a streaming
    //    agent's mouse-tracking toggles wipe the live one) — else falls through to xterm's
    //    SIGINT (\x03). Cmd is primary on macOS so Ctrl+C stays SIGINT there. The highlight is
    //    cleared only after MAIN verifies the clipboard write landed (readback in clipboardIpc);
    //    on failure it stays as the "not copied" signal. The snapshot is likewise consumed only
    //    on a VERIFIED write (one-shot: the NEXT Ctrl+C is SIGINT again, same cadence as the old
    //    copy-then-clear) — consuming it before the async result would strand a failed
    //    snapshot-fallback copy with nothing left to retry, so the user's second Ctrl+C would
    //    fall through to SIGINT (review fix, PR #332).
    //  - Ctrl/Cmd+V smart-pastes (image → staged path, else text), via term.paste so
    //    multiline content gets bracketed-paste markers.
    term.attachCustomKeyEventHandler((e) =>
      handleTerminalKey(
        e,
        {
          hasSelection:
            term.hasSelection() || readSnapshot(snapRef.current, performance.now()) !== '',
          isMac: IS_MAC
        },
        {
          newline: () => sendInput(TERMINAL_NEWLINE),
          copySelection: () =>
            copyWithFallback({
              live: term.getSelection(),
              cell: snapRef.current,
              now: performance.now(),
              write: (t) => window.api.clipboard.writeText(t),
              clearHighlight: () => {
                if (termRef.current === term) term.clearSelection()
              }
            }),
          paste: () => void pasteIntoTerminal(term, board.id, () => termRef.current === term),
          fontStep: (d) => fontStepRef.current(d),
          fontReset: () => fontResetRef.current(),
          find: () => setFindOpen(true)
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

    // S3 restore: set true just before enqueueing the disk-restored snapshot so the coalescer's
    // NEXT flush (immediate if live, deferred to reveal if hidden — same hold gate as live PTY
    // data) scrolls the view to the restored bottom once the write actually lands.
    let scrollAfterRestore = false
    // Lane A write coalescer (xterm #880): batch PTY chunks into one rAF flush, and HOLD them
    // while this board is hidden (liveRef false — off-screen / below-LOD), flushing losslessly on
    // reveal. The PTY + xterm buffer stay alive; only the render is gated. The hold is bounded to
    // ~scrollback (read live via the thunk) so a hidden firehose can't grow unbounded.
    const coalescer = createTerminalWriteCoalescer({
      write: (chunk) => {
        if (!scrollAfterRestore) {
          term.write(chunk)
          return
        }
        scrollAfterRestore = false
        term.write(chunk, () => term.scrollToBottom())
      },
      // Hold while hidden (Lane A) OR while a resize-backstop snapshot is in flight (S2) OR while
      // the grid is still the unfitted 80×24 default (switch-back replay fix) — in every case the
      // bytes queue instead of rendering wrong (interleaved into a reset buffer / wrapped at 80
      // cols and reflow-mangled by the first fit); they flush in order on resume/fit.
      isLive: () => liveRef.current && !resizeBackstopRef.current && gridFittedRef.current,
      schedule: (fn) => requestAnimationFrame(fn),
      cancel: (h) => cancelAnimationFrame(h),
      holdCap: () =>
        Math.max(
          HOLD_FLOOR_BYTES,
          resolveInitialScrollback(scrollbackRef.current) * HOLD_BYTES_PER_LINE
        )
    })
    coalescerRef.current = coalescer
    // Find-count fix: arm the find bar's flush-before-search seam on THIS coalescer.
    flushPendingRef.current = (): void => {
      coalescer.flushNow()
    }
    // e2e: surface the held-byte count so a spec can prove a hidden terminal's PTY keeps producing
    // (buffer accumulating) while its rendered framebuffer stays frozen.
    if (isE2E()) e2eTerminalHeld.set(board.id, () => coalescer.held())

    const onWinMsg = (e: MessageEvent): void => {
      // SEC-2 class: adopt ports only from our own preload's same-window re-post — e.source is
      // this window for those. Pin the SOURCE, not the origin string (origin compare is
      // unreliable under packaged file://).
      if (e.source !== window) return
      const data = e.data as { __ptyPort?: boolean; id?: string }
      if (!data || !data.__ptyPort || data.id !== board.id) return
      const port = e.ports[0]
      portRef.current = port
      port.onmessage = (ev): void => {
        const m = ev.data as PortMessage
        if (m.t === 'data' && m.d) coalescer.enqueue(m.d)
        else if (m.t === 'state' && m.state) setState(m.state)
        else if (m.t === 'exit') {
          // Route the final line through the coalescer so it stays ORDERED after any bytes still
          // held while hidden (a direct write would jump ahead of them); the state flip is chrome
          // and applies immediately.
          coalescer.enqueue(`\r\n\x1b[90m[process exited: ${m.code ?? 0}]\x1b[0m\r\n`)
          setState('exited')
        }
      }
      port.start()
      // Switch-back replay fix (port-attach leg): if the grid was already fitted before this
      // port existed — the common visible-mount adopt, where fitWhole ran synchronously at
      // term.open but term.onResize had no port to post to — sync the PTY to the term's grid
      // now. An adopted PTY kept its pre-park size; a fresh spawn was born at these dims, so
      // the message is a no-op there. Mirrors the fit-side sync in fitWhole.
      if (gridFittedRef.current) {
        port.postMessage({ t: 'resize', cols: term.cols, rows: term.rows })
      }
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
    // S3: set once this idle mount wrote a persisted snapshot into the (frozen) term, so the Start
    // handler resets that read-only buffer before the fresh PTY's output replaces it.
    let restoredSnapshot = false
    // A fresh mount supersedes any respawn parked by a Restart on the prior term
    // incarnation (#23) — the initial launch() owns this term's first spawn.
    pendingRespawnRef.current = false
    const launch = (): void => {
      if (spawned || !spawnAllowed) return
      if (!finiteDims(fit.proposeDimensions())) return
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
          rows: term.rows,
          monitorActivity: monitorActivityRef.current,
          openRouter: openRouterRef.current
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
      startedRef.current = true // going live — suppress any still-in-flight snapshot restore
      // S3: a restored terminal shows its prior (read-only) scrollback; Start spawns a FRESH PTY, so
      // clear that snapshot first — the live output replaces it rather than appending after it. Also
      // drop any restore bytes the coalescer is still HOLDING (board was hidden when restore ran) so
      // they can't flush into the now-live session after reset.
      if (restoredSnapshot) {
        term.reset()
        coalescer.clear()
        scrollAfterRestore = false
        restoredSnapshot = false
        setRestored(false)
        setRestoredExitCode(null)
      }
      spawnAllowed = true
      setState('spawning')
      launch()
    }
    void window.api.adoptTerminal(board.id).then((res) => {
      if (disposed) {
        // Background sessions (R4): this adopt raced the unmount — a rapid switch-back-and-
        // away can land it AFTER the boards started tearing down. The session is now LIVE with
        // its fresh port pointing at a dead consumer, and the unmount's killTerminal already
        // no-op'd (it ran while the session was still parked). Undo the adopt by re-parking:
        // MAIN types the park automatically (cross-project ⇒ background/no-TTL; same project ⇒
        // undo/TTL), so a backgrounded project's shell survives and a same-project orphan reaps.
        if (res.adopted) void window.api.parkTerminal(board.id).catch(() => {})
        return
      }
      const decision = nextStateAfterAdopt(res.adopted, isIdleOnMount(board.id))
      if (decision === 'running') {
        setState('running')
      } else if (decision === 'idle') {
        setState('idle')
        // S3: an idle mount (disk-restored / duplicated) with a persisted snapshot restores its prior
        // output into the frozen term so the user SEES their last session read-only until Start. Keyed
        // by board id, so a duplicate (new id) has no sidecar and stays a blank idle. A later resize
        // that changes cols re-wraps this buffer losslessly via the S2 backstop (established grid).
        // Bg sessions Phase 5 (R6 residue UX): alongside the snapshot, consume any exit
        // residue — the post-park tail + code of a session that DIED while its project was
        // backgrounded. Spliced AFTER the snapshot (the snapshot covers up to the park; the
        // residue is exactly what followed), and the restored bar says so with the code.
        void Promise.all([
          window.api.terminal.readSnapshot(board.id),
          Promise.resolve()
            .then(() => window.api.terminal.exitResidue(board.id))
            .catch(() => null)
        ]).then(([snap, residue]) => {
          // startedRef guards the race where the user hits Start/Resume (which spawns on THIS term)
          // before this async read settles — writing then would splice the stale buffer into the
          // now-live session. disposed/termRef cover a remount; startedRef covers same-term-went-live.
          if (disposed || termRef.current !== term || startedRef.current) return
          // Review fix: residue with an EMPTY tail still carries the exit code — a session
          // that died in the background without emitting bytes (and never flushed a
          // snapshot) must still show the "Exited in background (code N)" bar, not a blank
          // idle board. Only a mount with neither snapshot NOR residue stays plain.
          if (!snap && !residue) return
          // Route through the Lane A coalescer (not a direct term.write): a hidden/below-LOD board
          // must defer this write until it goes live, exactly like the live-PTY path, so a restore
          // on an off-screen terminal doesn't pay the render cost the liveness gate exists to avoid.
          scrollAfterRestore = true
          if (snap) coalescer.enqueue(snap)
          if (residue?.output) coalescer.enqueue(residue.output)
          restoredSnapshot = true
          setRestored(true)
          if (residue) setRestoredExitCode(residue.exitCode)
        })
      } else {
        spawnAllowed = true
        launch()
      }
    })

    // FREEZE gate: under the DOM renderer the host rides the camera as a CSS transform on an
    // ANCESTOR (.react-flow__viewport), which does not change `el`'s border-box layout size —
    // so a zoom does not fire this ResizeObserver at all (cols/rows are frozen across zoom by
    // construction). The wrap key (screenWrap clientW×H, z-INVARIANT world px) is kept as
    // defense and to key the refits we DO want: mount (0/undefined → W), real board resize,
    // LOD/display:none exit, full-view portal in/out. Any spurious zoom-driven fire leaves the
    // key unchanged and is skipped wholesale.
    let lastWrapKey: string | null = null
    const ro = new ResizeObserver(() => {
      // Full-view portal resizes are NO LONGER frozen out here (S3 unfreeze): the well growing to
      // the modal on enter / shrinking back on exit is exactly the refit signal, and fitWhole
      // routes an established grid's cols change through the lossless S2 backstop. The enter fire
      // may land before the font seam has applied the full-view render font — that first fit
      // proposes at the old metrics, and the seam's own post-apply fitWhole converges the grid one
      // backstop later (the in-flight gate coalesces overlapping fits, so they run sequentially).
      // A detached `el` (no parent) yields no key: fall through to the (cheap, guarded)
      // refit rather than skip — a null key must never satisfy the gate, or two fires
      // while detached would compare null === null and silently drop a real refit.
      const wrap = el.parentElement
      const key = wrap ? `${wrap.clientWidth}x${wrap.clientHeight}` : null
      if (key !== null && key === lastWrapKey) return // zoom-driven layout change — FREEZE: no refit
      lastWrapKey = key
      // Resize-storm fix (T1b): during a counterScale transition (full-view enter/exit) this
      // fire arrives with STALE cell metrics — the seam's new render font isn't measured yet —
      // so fitting here proposes the wrong cols and pays a full backstop replay + SIGWINCH
      // that the reraster's deferred correct-metrics refit immediately repeats. Skip the fit;
      // that refit (which consumes the flag in fitWhole) owns the transition. Narrow on
      // purpose: an UNFITTED grid (fresh mount straight into full view) still fits here — its
      // plain fit has no backstop to waste and the deferred launch() below is its only spawn
      // driver; a parked deferred respawn likewise rides this fire (its only driver), at
      // stale-metrics cost identical to the pre-fix behavior.
      if (csTransitionRef.current && gridFittedRef.current && !pendingRespawnRef.current) return
      fitWholeRef.current() // whole-cell fit (clip-free); swallows the not-laid-out throw itself
      // First good fit after a hidden/LOD mount spawns the deferred PTY at the
      // board's true width; later fits no-op (`spawned` guard) and just resize.
      launch()
      // #23: a Restart issued while the well was unfitted parked a respawn; the
      // first good fit (well now visible) drives it at the board's true width.
      if (pendingRespawnRef.current && finiteDims(fit.proposeDimensions())) {
        pendingRespawnRef.current = false
        respawn()
      }
    })
    ro.observe(el)

    return () => {
      disposed = true
      window.removeEventListener('message', onWinMsg)
      el.removeEventListener('keydown', stopKeys)
      el.removeEventListener('mousedown', invalidateSnapOnDown, true)
      selectionDisp?.()
      selSnapDisp.dispose()
      // The snapshot belongs to the disposed term's buffer — a fresh/reconfigured term must
      // never serve a predecessor's selection through the fallback.
      clearSnapshot(snapRef.current)
      dataDisp.dispose()
      resizeDisp.dispose()
      // T1a: drop any pending settled resize — the session is going away; a post-teardown
      // fire would land on a null/closed port anyway (post guards with ?.), this just makes
      // the cancellation explicit.
      resizeSettler.dispose()
      ro.disconnect()
      // S3: stop advertising this term's serializer (it is disposed below). The going-away flush
      // (quit/close/switch) already ran on the live registry before teardown; a React unmount for a
      // config-change respawn simply re-registers the fresh term.
      unregisterTerminalSnapshotter(board.id)
      void window.api.killTerminal(board.id)
      void window.api.cleanupStagedImages(board.id)
      try {
        portRef.current?.close()
      } catch {
        /* port already closed */
      }
      portRef.current = null
      // Lane A: drop the held buffer + cancel any scheduled flush (the term is disposed below).
      coalescer.clear()
      if (coalescerRef.current === coalescer) coalescerRef.current = null
      // Find-count fix: disarm the find bar's flush seam (a respawn re-arms it on the new
      // coalescer above; between teardown and respawn it must be a no-op, never a stale flush).
      flushPendingRef.current = (): void => {}
      unregisterTerminalInput(board.id)
      if (isE2E()) e2eTerminals.delete(board.id)
      if (isE2E()) e2eTerminalInput.delete(board.id)
      if (isE2E()) e2eTerminalLink.delete(board.id)
      if (isE2E()) e2eTerminalHeld.delete(board.id)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchAddonRef.current = null // disposed with the term above
      // S2: drop the snapshot addon ref + clear any in-flight backstop hold so a reused/replaced
      // term never starts with the pump stuck paused.
      serializeAddonRef.current = null
      resizeBackstopRef.current = false
      backstopGateRef.current.pending = false // drop any coalesced re-fit so a reused term starts clean
      // Phase 2: a FULL xterm replacement (reconfigure shell/cwd/launchCommand) disposes the old
      // SearchAddon. Close any open find bar so it re-subscribes to the FRESH addon on reopen — its
      // onDidChangeResults binds once at mount on the stable `api` and can't re-target in place, so
      // a left-open bar would show a frozen counter. The prior session's search context is gone, so
      // closing is also correct UX. (The Restart/respawn() path reuses the term+addon — unaffected.)
      setFindOpen(false)
      startLaunchRef.current = null
    }
    // screenRef / fontStepRef / fontResetRef / pasteIntoTerminal are STABLE (refs +
    // a module fn), so listing them keeps spawn's identity churn-free — the PTY only
    // respawns on a genuine PTY-relevant change (the board id/shell/cwd/launchCommand,
    // projectDir, respawn, getZoom). They are listed (not omitted) because exhaustive-deps
    // no longer recognizes them as stable once they arrive via props rather than a local
    // useRef (the useGroupInteractions #98 lesson).
  }, [
    board.id,
    board.shell,
    board.cwd,
    board.launchCommand,
    projectDir,
    respawn,
    getZoom,
    screenRef,
    fontStepRef,
    fontResetRef,
    pasteIntoTerminal
  ])

  // Hold the spawn while the New Terminal dialog is open (place-first flow): no xterm
  // mounts until config is finalized, so the first (and only) mount reads the patched
  // launchCommand. When configPending flips false the effect runs spawn() once.
  useEffect(() => {
    if (configPending) return undefined
    return spawn()
  }, [spawn, configPending])

  // ── Actions ─────────────────────────────────────────────────────────────────
  /** Restart: kill the current session + respawn a fresh shell in place. */
  const restart = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // A Restart is explicit start intent — drop the idle-on-mount flag (mirrors the
    // Start button) so a later spawn-effect re-run (config Apply) doesn't render the
    // idle overlay over this now-live PTY and let Start spawn a 2nd session (PTY-2).
    clearIdleOnMount(board.id)
    // S3: a Restart/Resume from a RESTORED idle term goes live — drop the restored flag so the
    // "Session restored" bar can't linger (it is gated on state==='idle', but clearing keeps the
    // flag honest), and mark started so an in-flight snapshot restore can't write into this now-live
    // session. term.reset() below clears the read-only snapshot buffer for the fresh session.
    setRestored(false)
    setRestoredExitCode(null)
    startedRef.current = true
    void window.api.killTerminal(board.id)
    try {
      portRef.current?.close()
    } catch {
      /* already closed */
    }
    portRef.current = null
    term.reset()
    // Lane A: discard any coalesced/held bytes from the prior session so they can't flush into the
    // freshly-reset terminal (the term is reused on this path — no new spawn closure runs).
    coalescerRef.current?.clear()
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
    restored,
    restoredExitCode,
    termRef,
    portRef,
    launchOverrideRef,
    startLaunchRef,
    fitWhole,
    restart,
    counterScale,
    findOpen,
    findApi,
    openFind,
    selectionFallback
  }
}
