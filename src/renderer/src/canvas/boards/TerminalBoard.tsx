/**
 * Terminal board content (Phase 2.1) — a live xterm.js terminal bridged to
 * `node-pty` in MAIN over the MessagePort data plane (high-volume PTY output)
 * with the spawn/kill control plane on `ipcRenderer.invoke`, keyed by board id.
 *
 * Per CLAUDE.md we spawn the SHELL, not the agent; if `board.launchCommand` is
 * set it is written as the first PTY line (in `pty.ts`) so the agent inherits
 * PATH/profile/auth. The board is a plain terminal: a calm identity pill (status
 * dot + shell/agent name); every per-type control (Configure / Restart / font /
 * interrupt / recap / preview) lives in the Board Inspector (P5 — the title bar
 * carries no action cluster). Clicking the body focuses xterm directly so
 * keystrokes always land. Owns this file only; shared surface frozen.
 *
 * Lifecycle (spawning → running → awaiting-input → exited / spawn-failed) is
 * driven by the `{ t: 'state', … }` messages the bridge pushes over the port.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { agentIdentity, isRunning, statusFor } from './terminalState'
import { useAttentionStore } from '../../store/attentionStore'
import { useCanvasStore } from '../../store/canvasStore'
import {
  classifyPushTargets,
  resolveLinkBoardTarget,
  type PreviewCandidate
} from '../../lib/previewTarget'
import { isOpenableScheme, resolveLinkDestination } from './terminal/terminalLinks'
import {
  runDetectPorts,
  makePortDetectNote,
  type DetectedUrl,
  type Gesture
} from './terminalPreview'
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'
import { quotePathsForPaste } from './terminal/terminalDrop'
import { useResumeValidity } from './terminal/useResumeValidity'
import { useHookHealth } from './terminal/useHookHealth'
import { BrowserPickPanel, NEW_BROWSER } from './terminal/BrowserPickPanel'
import { usePickerDismiss } from './terminal/usePickerDismiss'
import { useTerminalSpawn } from './terminal/useTerminalSpawn'
import { NewTerminalDialog } from './terminal/NewTerminalDialog'
import { presetById } from './terminal/agentPresets'
import { pasteIntoTerminal } from './terminal/pasteIntoTerminal'
import { TerminalHint } from './terminal/TerminalHint'
import { usePaletteRestart } from './terminal/usePaletteRestart'
import { notifyResumeFellBack } from './terminal/resumeFallbackToast'
import { RecapView } from '../RecapView'
import { useTerminalFlip } from './useTerminalFlip'
import {
  clampTerminalFont,
  resolveInitialFont,
  writeStickyFont,
  DEFAULT_TERMINAL_FONT,
  MIN_TERMINAL_FONT,
  MAX_TERMINAL_FONT
} from './terminal/terminalFont'
import { useTerminalAppearance } from './terminal/useTerminalAppearance'
import { useTerminalReraster } from './terminal/useTerminalReraster'
import { useTerminalFullViewFill } from './terminal/useTerminalFullViewFill'
import { resolveInitialThemeId, terminalThemeColors } from './terminal/terminalThemes'
import { useRunTimer } from './terminal/useRunTimer'
import { useInterruptFeedback } from './terminal/useInterruptFeedback'
import { TerminalEndCTA } from './terminal/TerminalEndCTA'
import { TerminalIdleAffordance } from './terminal/TerminalIdleAffordance'
import { buildTerminalMenuEntries } from './terminal/terminalMenu'
import { TerminalFindBar } from './terminal/TerminalFindBar'
import { TerminalInspector } from './terminal/TerminalInspector'
import { useInspectorSlot } from '../inspector/inspectorSlotStore'
import { TerminalJumpButton } from './terminal/TerminalJumpButton'
import { shell, shellHidden, screenWrap, screen } from './terminal/terminalBoardStyles'

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
  onRemoveFromAllGroups,
  onPushPreviewTo,
  onStartConnect
}: BoardViewProps<TerminalBoardData>): ReactElement {
  const screenRef = useRef<HTMLDivElement>(null)
  // Keymap effects + the Ctrl-wheel listener call the latest nudge/reset through refs so
  // the spawn callback's identity stays stable (no respawn when the font handlers change).
  const fontStepRef = useRef<(delta: number) => void>(() => {})
  const fontResetRef = useRef<() => void>(() => {})
  // Trailing timer that coalesces a burst of nudges (Ctrl-wheel / held key) into one undo step.
  const fontBurstRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Authoritative font value, advanced SYNCHRONOUSLY in setFont. nudgeFont steps from THIS, not
  // xterm's live `options.fontSize` (which only updates after the apply effect runs next paint) —
  // so a Ctrl-wheel / held-key burst that fires several ticks within one frame steps once per
  // notch instead of reading a stale size and collapsing to a single step. The apply effect
  // re-syncs it to EXTERNAL changes (undo / project load) so a later nudge starts from the truth.
  const liveFontRef = useRef<number>(resolveInitialFont(board.fontSize))
  // The font this board was BORN with (the sticky default at mount, then frozen). The apply effect
  // falls back to this for an UNPINNED board instead of the LIVE sticky: this board's own nudges
  // mutate the sticky, so a live fallback would not revert when undo clears the pin back to
  // undefined. (The sticky still seeds the NEXT terminal via the spawn closure — it just stops
  // retroactively driving THIS one once the board exists.) A lazy-init useState (not a ref) so it
  // can be read during render without tripping react-hooks/refs; the setter is intentionally unused.
  const [bornFont] = useState<number>(() => resolveInitialFont(board.fontSize))

  // Terminal-theming chrome bg (Lane B follow-up): the xterm SURFACE is repainted by the theme, but
  // the board chrome around it (content-well, the 12px well padding, the full-view letterbox gutter)
  // was hardcoded `--inset` — so a non-default theme (e.g. Dracula #282a36, Solarized Light #fdf6e3)
  // showed a mismatched near-black frame around themed text. Drive the chrome bg from the SAME resolved
  // palette xterm renders: `board.themeId ?? bornThemeId` (unpinned falls back to the sticky id this
  // board was born with, mirroring useTerminalAppearance). Default resolves to #0e0e10 == --inset ⇒
  // existing/default boards are pixel-identical (zero regression).
  const [bornThemeId] = useState<string>(() => resolveInitialThemeId(board.themeId))
  const themeBg = terminalThemeColors(board.themeId ?? bornThemeId).background ?? 'var(--inset)'

  // A board with no explicit cwd spawns in the open project folder, not os.homedir().
  const projectDir = useCanvasStore((s) => s.project.dir)
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  // Place-first New Terminal flow: true while THIS board awaits first-run config in the
  // dialog. Held terminals don't spawn (the dialog resolves first) — see useTerminalSpawn.
  const configPending = useCanvasStore((s) => s.configPendingId === board.id)
  const clearConfigPending = useCanvasStore((s) => s.clearConfigPending)

  // Phase 4 — clickable terminal links. The WebLinksAddon (loaded in useTerminalSpawn) hands a
  // Ctrl/Cmd-clicked URI here. Smart default by host: a local dev URL opens in a Browser board
  // (reusing a same-origin one, else spawning beside this terminal — the same create/route path as
  // the port-detect "Preview" button); every other http(s) URL, plus mailto, opens in the OS
  // browser. Shift flips board↔external. file:/javascript:/data:/custom are ignored here and
  // re-rejected in MAIN. Defined ABOVE useTerminalSpawn (it consumes this) — needs only the
  // onPushPreviewTo prop + board.id, both in scope, so there's no use-before-define.
  const handleLink = useCallback(
    (uri: string, opts: { shiftKey: boolean }): void => {
      if (!isOpenableScheme(uri)) return
      const dest = resolveLinkDestination(uri, opts)
      if (dest === 'external' || !onPushPreviewTo) {
        // External, or no canvas action wired (e.g. LOD card) → open in the OS browser. MAIN
        // re-validates the scheme before shell.openExternal (never trust the renderer for an open).
        void window.api.openExternalUrl(uri)
        return
      }
      const target = resolveLinkBoardTarget(useCanvasStore.getState().boards, board.id, uri)
      onPushPreviewTo(uri, target)
    },
    [board.id, onPushPreviewTo]
  )

  // ── Spawn lifecycle ───────────────────────────────────────────────────────────
  // The PTY spawn/respawn/restart state machine + xterm construction + MessagePort data
  // plane + ResizeObserver-deferred spawn + adopt/idle fork + DOM-renderer + selection
  // shim + custom key handler + kill-tree teardown all live in useTerminalSpawn. The host
  // keeps only the DOM anchor (screenRef), the font-handler bridge refs the key handler
  // reads (fontStepRef/fontResetRef), and the smart-paste fn (passed in — not imported —
  // to avoid a host↔hook import cycle). The returned refs/`fitWhole`/`restart` are listed
  // in every consuming dep array below; destructuring a hook's refs/setters otherwise
  // strips exhaustive-deps' stable-identity recognition (the useGroupInteractions lesson).
  const {
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
    openFind
  } = useTerminalSpawn({
    board,
    projectDir,
    screenRef,
    fontStepRef,
    fontResetRef,
    pasteIntoTerminal,
    configPending,
    onLinkActivate: handleLink
  })

  // Edit-config dialog open (the unified New Terminal dialog in 'edit' mode). A modal with
  // explicit Cancel/Apply — no non-modal outside-close guard needed (it replaced the popover).
  const [configOpen, setConfigOpen] = useState(false)
  const closeConfig = useCallback(() => setConfigOpen(false), [])
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null)
  // T15: flip to the recap back-face. The xterm well (front) stays MOUNTED across the
  // flip so the live PTY session never tears down — see the flip wrapper in render.
  // The fold animation + double-click trigger live in useTerminalFlip (flat-at-rest 3D,
  // so it never reintroduces the preserve-3d pointer-hit-test bug). `flipped` aliases it.
  const flip = useTerminalFlip()
  const flipped = flip.flipped
  // T-resume: the Inspector's Session controls offer Resume-vs-New only when we know a session
  // to resume (P5: the title-bar restart button + its anchored popover menu are gone).
  // F1: MAIN-validated — the stored id alone proves nothing (eager capture / rotation /
  // retention all leave a dead id in canvas.json); see useResumeValidity.
  const canResume = useResumeValidity(board, state)
  // F4: hook-health fault for the Inspector's Session line (null = healthy, renders nothing).
  const hookHealth = useHookHealth(board, state)
  // P0.5 Board Inspector: non-null only when THIS terminal is the single eligible selection (the
  // shell publishes its content slot then). We portal our per-type inspector into it below — reusing
  // the very same handlers every other affordance uses, so there is no duplicated wiring or state.
  const inspectorSlot = useInspectorSlot(board.id)
  // Shared respawn routines (D2-B) used by every re-run affordance — the idle restored bar,
  // the end-state CTA, the recap face, and the Inspector's Session actions (P5: the title-bar
  // restart menu is gone). F3: Resume asks MAIN for the launch line AT CLICK TIME
  // (`terminal:resumeLaunch` re-resolves the transcript fresh, so a stored id that died since
  // the last check degrades to `claude --continue` / a fresh start instead of a dead
  // `--resume`; sanitization lives in MAIN — canvas.json is untrusted input). New/Restart
  // starts fresh (clears the override). Both consume launchOverrideRef then hit the shared
  // respawn; an IPC failure also falls back to fresh (never a stale guess).
  const resumeSession = useCallback((): void => {
    void window.api.terminal
      .resumeLaunch(board.id, {
        sessionId: board.agentSessionId,
        transcriptPath: board.agentTranscriptPath
      })
      .then((r) => {
        // F1b: the fresh degrade is safe but silent — the user picked Resume; say so.
        if (r?.mode === 'fresh') notifyResumeFellBack()
        launchOverrideRef.current = r?.command
        restart()
      })
      .catch(() => {
        notifyResumeFellBack()
        launchOverrideRef.current = undefined
        restart()
      })
  }, [board.id, board.agentSessionId, board.agentTranscriptPath, launchOverrideRef, restart])
  const restartFresh = useCallback((): void => {
    launchOverrideRef.current = undefined
    restart()
  }, [launchOverrideRef, restart])
  // D4-A: consume palette restart intents for this board (resume/new — same launch
  // override + respawn path as the Restart menu below).
  usePaletteRestart(
    board.id,
    board.agentSessionId,
    board.agentTranscriptPath,
    launchOverrideRef,
    restart
  )

  // D2-B (audit A6): flipping moves focus WITH the visible face — the recap wrapper on
  // flip, xterm back on flip-back. Without this, focus stayed on the hidden xterm behind
  // the opaque recap (keystrokes typed "into nothing"). RETRIED across the fold, not a
  // single deferred shot: `flipped` swaps at the 90° edge MID-FOLD, and during the
  // unfold's commits xterm's helper textarea can be transiently unfocusable — focus()
  // is then a SILENT no-op (the Menu.tsx lesson) and a one-shot attempt loses the race
  // under load (caught by terminalPolish.e2e on a slow run). Bounded: ~14 ticks ≈ the
  // 2×150ms fold + margin, then gives up; cleanup cancels on re-flip/unmount.
  const recapRef = useRef<HTMLDivElement>(null)
  const flipFocusInit = useRef(true)
  useEffect(() => {
    if (flipFocusInit.current) {
      flipFocusInit.current = false // mount is not a flip — don't steal focus on load
      return
    }
    let tries = 0
    let t: number
    const attempt = (): void => {
      let landed = false
      if (flip.flipped) {
        const w = recapRef.current
        w?.focus()
        landed = !!w && (document.activeElement === w || w.contains(document.activeElement))
      } else {
        const term = termRef.current
        term?.focus()
        landed = !!term?.textarea && document.activeElement === term.textarea
      }
      if (!landed && ++tries < 14) t = window.setTimeout(attempt, 25)
    }
    t = window.setTimeout(attempt, 0)
    return () => window.clearTimeout(t)
  }, [flip.flipped, termRef])

  // Prefer the chosen agent preset's label for the identity pill (e.g. "Claude"); a plain
  // Shell preset still shows the resolved shell name (more informative than "Shell"), and a
  // terminal with no preset (MCP-spawned / pre-v10) falls back to command/shell inference.
  const presetLabel =
    board.agentKind && board.agentKind !== 'shell' ? presetById(board.agentKind)?.label : undefined
  const identity = presetLabel ?? agentIdentity(board.launchCommand, board.shell)
  const running = isRunning(state)

  // ── Per-board font size ───────────────────────────────────────────────────────
  // Persist path (the four triggers call these — they never touch xterm directly):
  const setFont = useCallback(
    // `sticky` defaults true so adjustments seed the new-terminal default. Reset passes false:
    // resetting ONE board to the factory size must not clobber the user's global preference.
    (next: number, sticky = true): void => {
      const clamped = clampTerminalFont(next)
      if (clamped === liveFontRef.current) return // no-op (already this size / clamped at a bound)
      liveFontRef.current = clamped // advance the authoritative value SYNCHRONOUSLY (burst-safe)
      // Leading-edge undo checkpoint: snapshot once per burst so a Ctrl-wheel / held-key run
      // collapses into ONE undo step; the trailing timer ends the burst (beginChange dedups).
      if (fontBurstRef.current === null) useCanvasStore.getState().beginChange()
      if (fontBurstRef.current) clearTimeout(fontBurstRef.current)
      fontBurstRef.current = setTimeout(() => {
        fontBurstRef.current = null
      }, 500)
      updateBoard(board.id, { fontSize: clamped }) // persist the per-board pin
      if (sticky) writeStickyFont(clamped) // update the new-terminal default (skipped on reset)
    },
    [board.id, updateBoard]
  )
  const nudgeFont = useCallback(
    (delta: number): void => setFont(liveFontRef.current + delta),
    [setFont]
  )
  // Reset is a per-board factory reset (12.5) that leaves the global sticky default untouched.
  const resetFont = useCallback((): void => setFont(DEFAULT_TERMINAL_FONT, false), [setFont])

  // Keep the keymap/wheel refs pointed at the latest handlers (stable spawn identity).
  useEffect(() => {
    fontStepRef.current = nudgeFont
    fontResetRef.current = resetFont
  }, [nudgeFont, resetFont])

  // Settled-zoom native re-raster (FREEZE): the single font seam (the ONLY writer of
  // term.options.fontSize — pinned × counterScale, never routed through updateBoard/
  // undo) + the counter-scale wrapper style for the xterm host. All the wiring and
  // its invariants live in useTerminalReraster, which also reads BoardFullViewContext:
  // in full view (Pure A1) counterScale is the modal-fill factor and the wrapper stays
  // identity, so the frozen grid scales up via the render font alone — no column change,
  // no scrollback reflow.
  const screenStyle = useTerminalReraster({
    pinnedFontSize: board.fontSize,
    bornFont,
    counterScale,
    termRef,
    fitWhole,
    liveFontRef,
    identityStyle: screen
  })

  // Refit when devicePixelRatio changes (e.g. the window moved to a monitor with different scaling) —
  // the host doesn't resize, so the ResizeObserver never fires, but the cell height changed.
  // (In full view fitWhole is a deliberate no-op for an established grid — Pure A1 freeze — so a dpr
  // change while maximized is reconciled by the in-canvas refit on exit. CSS cell size is font-driven,
  // not dpr-driven, so nothing clips meanwhile.)
  useEffect(() => {
    let mql: MediaQueryList | null = null
    const onChange = (): void => {
      fitWhole()
      attach() // re-arm for the NEW dpr (each mql is dpr-specific)
    }
    const attach = (): void => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onChange, { once: true })
    }
    attach()
    return () => mql?.removeEventListener('change', onChange)
  }, [fitWhole])

  // Live theme + font-family apply (Lane B): a themeId/fontFamilyId change applies to the LIVE term
  // (palette repaint / typeface swap + refit) with no respawn — see useTerminalAppearance.
  useTerminalAppearance({
    themeId: board.themeId,
    fontFamilyId: board.fontFamilyId,
    termRef,
    fitWhole
  })

  // Full-view row-fill: in full view, grow/shrink term.rows (rows-only ⇒ cols frozen ⇒ NO reflow) so
  // the frozen-width grid fills the modal height, and scroll to the bottom so the agent's input prompt
  // is visible. Removes the letterbox gutter and fixes "Claude input not visible in a long session".
  useTerminalFullViewFill(termRef)

  // Clear the burst timer on unmount.
  useEffect(
    () => () => {
      if (fontBurstRef.current) clearTimeout(fontBurstRef.current)
    },
    []
  )

  // Ctrl+wheel font zoom over the well (VS Code / iTerm idiom; macOS pinch arrives as
  // ctrl-wheel). NATIVE non-passive listener — React's synthetic onWheel is passive, so
  // preventDefault would no-op. The screen div is inside `.nowheel`, so React Flow never
  // zooms; we stop plain-wheel scrollback only when Ctrl is held.
  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      if (e.deltaY === 0) return // tilt-wheel / horizontal trackpad pan: no font change
      e.preventDefault()
      e.stopPropagation()
      fontStepRef.current(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // TERM-01: an elapsed run timer (mm:ss) appended to the running pill — statusFor
  // already renders the optional `timer` arg as a ` · ${timer}` suffix.
  const runTimer = useRunTimer(running)
  // Desktop-notifications P2 (#314): unseen attention re-tints the pill DOT to warn/err (the
  // DESIGN.md Surface-1 dot column) — the label stays the runtime truth (running/idle/exited); the
  // node-level ring/badge overlay carries the wording. The warn/err dot also disarms BoardFrame's
  // --ok glyph pulse, so the attention pulse is the only one lit.
  const attention = useAttentionStore((s) => s.byId[board.id])
  const attnDot =
    attention === 'needs-input' ? 'var(--warn)' : attention === 'error' ? 'var(--err)' : null
  const baseStatus = statusFor(state, identity, runTimer)
  // C2: the §7.1 "working" braille spinner is a pure-CSS ::before in BoardFrame (gated on `running`)
  // — it no longer bumps component state on this node every 80ms (12.5×/sec). So there is NO JS
  // spinner-glyph label prefix here (that reintroduced exactly the churn C2 removed); the attention
  // dot is the only status override, and the CSS ::before renders the spinner.
  const status = attnDot ? { ...baseStatus, dot: attnDot } : baseStatus

  // TERM-06: send Ctrl-C + a brief confirmation (⏹ button pulse + "interrupt sent" chip).
  const { interruptSent, interrupt } = useInterruptFeedback(portRef)

  // Slice C′: detected dev-server URLs (picker when >1) + a transient "not found" note
  // (D1-A: the note is a board-keyed toast now, not a board overlay).
  // DetectedUrl and Gesture types are imported from ./terminalPreview.
  const [portChoices, setPortChoices] = useState<{ urls: DetectedUrl[]; gesture: Gesture } | null>(
    null
  )
  const previewNote = useMemo(() => makePortDetectNote(board.id), [board.id])
  // Multi-select connect picker (long-press, or tap with nothing linked): pick one or more
  // browsers (B + C) and/or a fresh spawn to wire to this terminal and push the url to each.
  // The panel (checkboxes + sever warning) lives in BrowserPickPanel; its transient checked
  // state resets by unmounting.
  const [browserPick, setBrowserPick] = useState<{
    url: string
    candidates: PreviewCandidate[]
  } | null>(null)

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
      setBrowserPick({ url, candidates })
    },
    [board.id, onPushPreviewTo]
  )

  const onPreview = useCallback(
    (gesture: Gesture) =>
      runDetectPorts(
        () => window.api.detectPorts(board.id),
        previewNote,
        routeUrl,
        setPortChoices,
        gesture
      ),
    [board.id, previewNote, routeUrl]
  )

  // Apply the multi-select connect picker: wire every checked browser to this terminal
  // (re-pointing its previewSourceId, severing any prior link) + push the url; spawn a
  // fresh browser if "+ New browser" is checked.
  const confirmBrowserPick = useCallback(
    (checked: Set<string>) => {
      if (!browserPick) return
      const { url } = browserPick
      checked.forEach((key) => {
        if (key === NEW_BROWSER) onPushPreviewTo?.(url, { kind: 'spawn' })
        else onPushPreviewTo?.(url, { kind: 'existing', id: key })
      })
      setBrowserPick(null)
    },
    [browserPick, onPushPreviewTo]
  )

  // D0-4: Escape / outside-pointerdown dismissal for the two pickers (they were
  // Cancel-only). The picker divs stop their own pointerdown.
  const dismissPickers = useCallback((): void => {
    setPortChoices(null)
    setBrowserPick(null)
  }, [])
  usePickerDismiss(!!portChoices || !!browserPick, dismissPickers)

  // Effective font for the disabled-at-bound state: mirror the apply effect's fallback (born font,
  // NOT live sticky) so the buttons track the size this board actually renders at, not another
  // board's sticky drift. PINNED-space deliberately — the [MIN, MAX] bounds are pinned-space, so
  // the ± buttons disable at the same pin regardless of zoom (the render font is pin × cs).
  // (P5: the title-bar action cluster is gone — the Inspector is the one control home; this feeds
  // the Inspector stepper + the right-click menu.)
  const effectiveFont = clampTerminalFont(board.fontSize ?? bornFont)

  // Right-click context menu over the well. Reuses the planning menu component. When the
  // running TUI has mouse reporting on (term.modes.mouseTrackingMode !== 'none'), plain
  // right-click passes through to the app; Shift+right-click forces our menu. The entries
  // are built HERE (an event handler — ref access is allowed) and frozen in `menu` state,
  // so the selection/font-bound disabled flags are stable for the menu's lifetime and no
  // ref is read during render (TERM-07 moved the builder to terminalMenu.ts).
  const openMenu = useCallback(
    (e: React.MouseEvent) => {
      const term = termRef.current
      if (!term) return
      const mouseMode = term.modes.mouseTrackingMode !== 'none'
      if (mouseMode && !e.shiftKey) return // let the TUI have the right-click
      e.preventDefault()
      e.stopPropagation()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        entries: buildTerminalMenuEntries({
          hasSel: term.hasSelection(),
          boardId: board.id,
          effectiveFont,
          minFont: MIN_TERMINAL_FONT,
          maxFont: MAX_TERMINAL_FONT,
          termRef,
          nudgeFont,
          resetFont
        })
      })
    },
    [termRef, board.id, effectiveFont, nudgeFont, resetFont]
  )

  // Keep the full chrome (and the xterm host) ALWAYS mounted so the live PTY/agent
  // session survives zoom-out — see BoardNode. At LOD we hide the xterm well and
  // overlay the opaque LOD card on top (it fully covers the chrome beneath it),
  // never tearing the terminal down. The card's dot reflects the live status, so a
  // running agent still pulses `--ok` while zoomed out.
  return (
    <>
      {/* P0.5 Board Inspector content — portaled into the shell's slot only while this terminal is the
          single eligible selection. Same handlers as the title-bar actions (kept), zero duplication. */}
      {inspectorSlot &&
        createPortal(
          <TerminalInspector
            running={running}
            interruptSent={interruptSent}
            onInterrupt={interrupt}
            font={effectiveFont}
            defaultFont={DEFAULT_TERMINAL_FONT}
            onDecFont={() => nudgeFont(-1)}
            onIncFont={() => nudgeFont(1)}
            decFontDisabled={effectiveFont <= MIN_TERMINAL_FONT}
            incFontDisabled={effectiveFont >= MAX_TERMINAL_FONT}
            onResetFont={resetFont}
            canResume={canResume}
            onRestart={restart}
            onResume={resumeSession}
            onNew={restartFresh}
            recapShown={flipped}
            onToggleRecap={flip.toggle}
            onFind={openFind}
            health={hookHealth}
            shell={board.shell}
            command={board.launchCommand}
            cwd={board.cwd}
            onConfigure={() => setConfigOpen(true)}
            onPushPreview={() => void onPreview('tap')}
            onChooseTarget={() => void onPreview('hold')}
          />,
          inspectorSlot
        )}
      <BoardFrame
        type="terminal"
        boardId={board.id}
        title={board.title}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        running={running}
        spawning={state === 'spawning'}
        status={status}
        contentBg={themeBg}
        onFull={onFull}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        onAddToGroup={onAddToGroup}
        onRemoveFromGroup={onRemoveFromGroup}
        onRemoveFromAllGroups={onRemoveFromAllGroups}
        onStartConnect={onStartConnect}
      >
        <div style={{ ...(lod ? shellHidden : shell), ...flip.perspectiveStyle }}>
          {/* T15 flip + double-click: the stage rotates as a UNIT during the fold, then settles
              FLAT (transform:none at rest — see useTerminalFlip). The FRONT face (live xterm well)
              stays mounted always — flipping never unmounts it, so the PTY survives. When `flipped`,
              the recap renders as an OPAQUE overlay on top. We still never leave a PERSISTENT
              `rotateY`/preserve-3d at rest: Chromium mis-maps pointer hit-testing on nested 3D
              back-faces, which once left the recap's refresh button unclickable. The fold's 3D
              exists only mid-animation and never crosses 90°. Double-click anywhere flips (and
              flips back); it overrides React Flow's onNodeDoubleClick focus for terminals. */}
          <div
            style={flip.stageStyle}
            onDoubleClick={(e) => {
              // Skip interactive chrome (dock buttons, pickers/menus, the editable label) so a
              // double-click on a control never also flips the board.
              if (
                (e.target as HTMLElement).closest(
                  'button, input, select, label, .ca-port-picker, [data-no-flip]'
                )
              )
                return
              e.stopPropagation() // stop RF's node-double-click (focusBoard) from also firing
              flip.toggle()
            }}
          >
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                flexDirection: 'column',
                // recap overlay is up → don't let the xterm behind it grab pointer/focus
                pointerEvents: flipped ? 'none' : 'auto',
                // Contain this face's stacking (the idle "Start" overlay sets zIndex:2). Without
                // a stacking context here that z-index leaks to a shared ancestor and paints OVER
                // the sibling recap overlay (which has none) → flipping an idle board showed
                // "Start shell" instead of the recap. isolate keeps it under the recap face.
                isolation: 'isolate'
              }}
            >
              {/* M-1: a restored/duplicated terminal starts idle (no auto-spawn) with an explicit
              Start. S3: a fresh idle uses the opaque overlay; a restored one uses a bottom bar so its
              read-only scrollback stays visible (see TerminalIdleAffordance). #270: the fresh-idle
              overlay honors the board's theme background (themeBg), so a themed terminal doesn't flash
              the default --inset while idle. */}
              <TerminalIdleAffordance
                state={state}
                restored={restored}
                restoredExitCode={restoredExitCode}
                identity={identity}
                background={themeBg}
                onStart={() => startLaunchRef.current?.()}
                canResume={canResume}
                onResume={resumeSession}
              />
              {portChoices && portChoices.urls.length > 1 && (
                <div
                  className="ca-port-picker nodrag"
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
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
                <BrowserPickPanel
                  candidates={browserPick.candidates}
                  onCancel={() => setBrowserPick(null)}
                  onConfirm={confirmBrowserPick}
                />
              )}
              {/* Live xterm screen fills the whole well — a plain terminal (--inset bg).
              `nodrag nowheel` stops React Flow from treating clicks as a node drag or
              wheel as a canvas zoom. Crucially we also stop the mousedown reaching RF
              and force focus into xterm: otherwise RF focuses the node wrapper on
              click and swallows keystrokes until a restart (the "can't type" bug). */}
              <div
                className="nodrag nowheel"
                style={{ ...screenWrap, background: themeBg }}
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
                <div ref={screenRef} style={screenStyle} />
                {/* Phase 2: find-in-terminal bar (Ctrl/Cmd+F). Floats top-right of the well. */}
                {findOpen && <TerminalFindBar api={findApi} />}
                {/* Phase 5 · S4: jump-to-bottom badge. Floats bottom-right; self-hides at the
                    tail. `ready` gates its scroll subscription to a term that exists (≠ idle);
                    `raised` lifts it above the TERM-04 end-CTA when that owns the bottom bar. */}
                <TerminalJumpButton
                  termRef={termRef}
                  ready={state !== 'idle'}
                  raised={state === 'exited' || state === 'spawn-failed'}
                />
                {/* TERM-04: an exited / spawn-failed terminal now offers an in-well re-run
                    CTA (bottom bar — never covers the scrollback). Restart re-runs (fresh),
                    Resume re-attaches a known session, Retry/Configure for a failed spawn.
                    Owns the end states; the launch-command hint below steps aside for them. */}
                {(state === 'exited' || state === 'spawn-failed') && (
                  <TerminalEndCTA
                    failed={state === 'spawn-failed'}
                    identity={identity}
                    canResume={canResume}
                    onRestart={restartFresh}
                    onResume={resumeSession}
                    onConfigure={() => setConfigOpen(true)}
                  />
                )}
                {/* D2-B 🎨 first-run hint (signed off 2026-06-11): a bare-shell terminal
                    (no launchCommand) shows one dismissible pill pointing at ⚙. Hidden at
                    idle (the Start overlay covers that state) and at the end states (the
                    TERM-04 CTA above owns exited/spawn-failed — its Configure/Retry covers
                    the same intent without stacking two bars). Gone forever once dismissed
                    anywhere (hintDismissal.ts) or a launch command is set. */}
                {!board.launchCommand &&
                  state !== 'idle' &&
                  state !== 'exited' &&
                  state !== 'spawn-failed' && (
                    <TerminalHint onConfigure={() => setConfigOpen(true)} />
                  )}
              </div>
              {menu && (
                <ElementContextMenu
                  x={menu.x}
                  y={menu.y}
                  entries={menu.entries}
                  onClose={() => setMenu(null)}
                />
              )}
            </div>
            {/* Recap overlay: rendered only while flipped (so it doesn't fetch memory for every
                terminal up-front). Opaque (RecapView paints var(--surface)) so it fully covers the
                xterm beneath. `nodrag nowheel` keeps React Flow from treating a click as a node-drag
                or a scroll as a canvas zoom. No 3D transform → correct pointer hit-testing. */}
            {flipped && (
              <div
                ref={recapRef}
                tabIndex={-1} // A6 focus-transfer target (programmatic only, not tabbable)
                className="nodrag nowheel"
                style={{ position: 'absolute', inset: 0, outline: 'none' }}
                data-test={`recap-wrap-${board.id}`}
              >
                <RecapView
                  boardId={board.id}
                  canResume={canResume}
                  onResume={() => {
                    // Shared resume routine, then flip back to the terminal (like onStart) so the
                    // resumed session is visible — staying on the recap face after acting is jarring.
                    resumeSession()
                    flip.toggle()
                  }}
                  // No session to resume/restart → offer to START one from the recap. Spawns the
                  // shell + fires launchCommand (the same Start as the idle front face), then flips
                  // back to the terminal so the new session is visible.
                  canStart={state === 'idle'}
                  onStart={() => {
                    startLaunchRef.current?.()
                    flip.toggle()
                  }}
                />
              </div>
            )}
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
            onFull={onFull}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
          />
        </div>
      )}
      {/* One dialog for create + edit (Option A). create: place-first, opens over the
          just-dropped board (spawn held until Create/Cancel) — close clears the held flag so
          the gated spawn runs. edit: the ⚙ / first-run hint reconfigures a LIVE terminal —
          Apply patches shell/launchCommand/cwd which respawns; close just hides it. Modal
          portals to body, so its position in this tree is immaterial. */}
      {(configPending || configOpen) && (
        <NewTerminalDialog
          board={board}
          mode={configPending ? 'create' : 'edit'}
          onClose={configPending ? clearConfigPending : closeConfig}
        />
      )}
    </>
  )
}
