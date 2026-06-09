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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { TerminalConfig } from './TerminalConfig'
import { Terminal } from '@xterm/xterm'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import { BoardFrame, IconBtn } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { agentIdentity, brailleFrame, isRunning, statusFor } from './terminalState'
import { prefersReducedMotion } from '../../lib/motion'
import { useCanvasStore } from '../../store/canvasStore'
import { classifyPushTargets, type PreviewCandidate } from '../../lib/previewTarget'
import { runDetectPorts, type DetectedUrl, type Gesture } from './terminalPreview'
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'
import { quotePathsForPaste } from './terminal/terminalDrop'
import { resumeCommand } from './terminal/resumeCommand'
import { useTerminalSpawn } from './terminal/useTerminalSpawn'
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

/**
 * Smart paste: if the clipboard holds an image, stage it to a temp file and inject the
 * quoted path; otherwise inject the clipboard text. Uses `term.paste` so multiline
 * content gets bracketed-paste markers when the agent enabled them (no per-line submit).
 * Exported for the decision-seam unit test (TerminalBoard.paste.test.ts) — a non-component
 * export from a component module, so react-refresh's only-export-components is moot here.
 */
// eslint-disable-next-line react-refresh/only-export-components
export async function pasteIntoTerminal(term: Terminal, boardId: string): Promise<void> {
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

  // A board with no explicit cwd spawns in the open project folder, not os.homedir().
  const projectDir = useCanvasStore((s) => s.project.dir)
  const updateBoard = useCanvasStore((s) => s.updateBoard)

  // ── Spawn lifecycle ───────────────────────────────────────────────────────────
  // The PTY spawn/respawn/restart state machine + xterm construction + MessagePort data
  // plane + ResizeObserver-deferred spawn + adopt/idle fork + WebGL pooling + selection
  // shim + custom key handler + kill-tree teardown all live in useTerminalSpawn. The host
  // keeps only the DOM anchor (screenRef), the font-handler bridge refs the key handler
  // reads (fontStepRef/fontResetRef), and the smart-paste fn (passed in — not imported —
  // to avoid a host↔hook import cycle). The returned refs/`fitWhole`/`restart` are listed
  // in every consuming dep array below; destructuring a hook's refs/setters otherwise
  // strips exhaustive-deps' stable-identity recognition (the useGroupInteractions lesson).
  const { state, termRef, portRef, launchOverrideRef, startLaunchRef, fitWhole, restart } =
    useTerminalSpawn({
      board,
      projectDir,
      lod,
      screenRef,
      fontStepRef,
      fontResetRef,
      pasteIntoTerminal
    })

  const [configOpen, setConfigOpen] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null)
  // T15: flip to the recap back-face. The xterm well (front) stays MOUNTED across the
  // flip so the live PTY session never tears down — see the flip wrapper in render.
  // The fold animation + double-click trigger live in useTerminalFlip (flat-at-rest 3D,
  // so it never reintroduces the preserve-3d pointer-hit-test bug). `flipped` aliases it.
  const flip = useTerminalFlip()
  const flipped = flip.flipped
  // T-resume: the Restart control offers Resume-vs-New only when we know a session to resume.
  const [restartMenu, setRestartMenu] = useState(false)
  const canResume = !!board.agentSessionId

  const identity = agentIdentity(board.launchCommand, board.shell)
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

  // Apply a persisted font change to the LIVE term + reflow the grid (→ PTY resize). Keyed on
  // board.fontSize (NOT a spawn dep) so resizing never respawns the PTY. Falls back to the BORN
  // font (frozen at mount) for an unpinned board — bornFont is stable so this still runs only when
  // board.fontSize actually changes.
  useEffect(() => {
    // Unpinned board falls back to the BORN font (frozen at mount), not the live sticky — a live
    // sticky would have drifted under this board's own nudges and so undo-to-unpinned would not
    // revert. Sync the authoritative ref FIRST (even before the term mounts) so a nudge after an
    // external change (undo / project load) steps from the truth.
    const fs = clampTerminalFont(board.fontSize ?? bornFont)
    liveFontRef.current = fs
    const term = termRef.current
    if (!term) return
    if (term.options.fontSize === fs) return
    term.options.fontSize = fs
    // A bigger font means taller cells -> the row count must drop; whole-cell fit keeps it
    // clip-free. (Unfitted well: fitWhole swallows the not-laid-out throw; next RO fit applies.)
    fitWhole()
    // termRef/fitWhole are stable (a ref + a []-useCallback from useTerminalSpawn); listed
    // because exhaustive-deps no longer treats the destructured hook refs as stable (#98).
  }, [board.fontSize, bornFont, fitWhole, termRef])

  // Refit when devicePixelRatio changes (e.g. the window moved to a monitor with different scaling) —
  // the host doesn't resize, so the ResizeObserver never fires, but the cell height changed.
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
      e.preventDefault()
      e.stopPropagation()
      fontStepRef.current(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

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
  }, [portRef]) // stable hook ref; listed for exhaustive-deps (#98)

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

  // Effective font for the disabled-at-bound state: mirror the apply effect's fallback (born font,
  // NOT live sticky) so the buttons track the size this board actually renders at, not another
  // board's sticky drift.
  const effectiveFont = clampTerminalFont(board.fontSize ?? bornFont)
  const actions = (
    <>
      {(selected || hovered) && (
        <>
          <IconBtn
            name="minus"
            title="Smaller font (Ctrl -)"
            onClick={() => nudgeFont(-1)}
            disabled={effectiveFont <= MIN_TERMINAL_FONT}
          />
          <IconBtn
            name="plus"
            title="Bigger font (Ctrl +)"
            onClick={() => nudgeFont(1)}
            disabled={effectiveFont >= MAX_TERMINAL_FONT}
          />
        </>
      )}
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
      <IconBtn
        name="restart"
        title={canResume ? 'Restart (resume or new session)' : 'Restart'}
        active={restartMenu}
        onClick={() => (canResume ? setRestartMenu((v) => !v) : restart())}
      />
      {/* T15: flip to the recap back-face. IconBtn has no data-test prop, so the e2e/test
          hook (`flip-<id>`) rides a wrapping span. */}
      <span data-test={`flip-${board.id}`} style={{ display: 'inline-flex' }}>
        <IconBtn
          name="back"
          title={flipped ? 'Show terminal' : 'Show recap'}
          active={flipped}
          onClick={flip.toggle}
        />
      </span>
    </>
  )

  // Right-click context menu over the well. Reuses the planning menu component. When the
  // running TUI has mouse reporting on (term.modes.mouseTrackingMode !== 'none'), plain
  // right-click passes through to the app; Shift+right-click forces our menu.
  // hasSel is captured at open-time so the Copy entry's disabled state is stable for the
  // menu's lifetime (avoids reading the ref during render).
  const openMenu = useCallback(
    (e: React.MouseEvent) => {
      const term = termRef.current
      if (!term) return
      const mouseMode = term.modes.mouseTrackingMode !== 'none'
      if (mouseMode && !e.shiftKey) return // let the TUI have the right-click
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY, hasSel: term.hasSelection() })
    },
    [termRef]
  ) // stable hook ref; listed for exhaustive-deps (#98)

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
            },
            {
              kind: 'action',
              id: 'font-bigger',
              label: 'Bigger font',
              disabled: effectiveFont >= MAX_TERMINAL_FONT,
              onSelect: () => nudgeFont(1)
            },
            {
              kind: 'action',
              id: 'font-smaller',
              label: 'Smaller font',
              disabled: effectiveFont <= MIN_TERMINAL_FONT,
              onSelect: () => nudgeFont(-1)
            },
            {
              kind: 'action',
              id: 'font-reset',
              label: 'Reset font',
              onSelect: () => resetFont()
            }
          ]
        : [],
    // termRef is a stable hook ref (the menu actions read termRef.current); listed for
    // exhaustive-deps now that it arrives via useTerminalSpawn rather than a local useRef (#98).
    [menu, board.id, effectiveFont, nudgeFont, resetFont, termRef]
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
                (e.target as HTMLElement).closest('button, input, .ca-port-picker, [data-no-flip]')
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
                pointerEvents: flipped ? 'none' : 'auto'
              }}
            >
              {configOpen && (
                <TerminalConfig
                  board={board}
                  onClose={() => setConfigOpen(false)}
                  fontSize={effectiveFont}
                  onSetFont={setFont}
                />
              )}
              {/* M-1: a restored/duplicated terminal starts idle (no auto-spawn). Offer an
              explicit Start that spawns the shell + fires launchCommand on click. */}
              {state === 'idle' && (
                <div
                  className="nodrag"
                  style={idleOverlay}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <button style={startBtn} onClick={() => startLaunchRef.current?.()}>
                    Start {identity}
                  </button>
                </div>
              )}
              {previewNote && (
                <div
                  className="ca-preview-note"
                  role="status"
                  onMouseDown={(e) => e.stopPropagation()}
                >
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
            {/* Recap overlay: rendered only while flipped (so it doesn't fetch memory for every
                terminal up-front). Opaque (RecapView paints var(--surface)) so it fully covers the
                xterm beneath. `nodrag nowheel` keeps React Flow from treating a click as a node-drag
                or a scroll as a canvas zoom. No 3D transform → correct pointer hit-testing. */}
            {flipped && (
              <div className="nodrag nowheel" style={{ position: 'absolute', inset: 0 }}>
                <RecapView boardId={board.id} />
              </div>
            )}
            {/* T-resume: Restart menu. Sits at the flip-stage level (not inside a face) so it stays
                interactive whether you're viewing the terminal OR the recap — you often resume FROM
                the recap. Resume → respawn with `claude --resume <sessionId>`; New → fresh launch. */}
            {restartMenu && (
              <div
                className="ca-port-picker nodrag nowheel"
                onMouseDown={(e) => e.stopPropagation()}
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 7 }}
              >
                <div className="ca-port-picker-title">Restart terminal</div>
                <button
                  className="ca-port-choice"
                  onClick={() => {
                    // Sanitise agentSessionId before it reaches the PTY — it comes from canvas.json
                    // (third-party-craftable), so resumeCommand strips it to a single inert token
                    // (or undefined → fresh launch). See resumeCommand.ts.
                    launchOverrideRef.current = resumeCommand(board.agentSessionId)
                    setRestartMenu(false)
                    restart()
                  }}
                >
                  Resume session
                </button>
                <button
                  className="ca-port-choice"
                  onClick={() => {
                    launchOverrideRef.current = undefined
                    setRestartMenu(false)
                    restart()
                  }}
                >
                  New session
                </button>
                <button className="ca-preview-dismiss" onClick={() => setRestartMenu(false)}>
                  Cancel
                </button>
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
  padding: '12px' // was '12px 12px 4px'; DESIGN.md §7.1 = 12px. Cosmetic — FitAddon ignores
  // this padding, so fitWhole (not the padding) is what prevents the clip.
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
