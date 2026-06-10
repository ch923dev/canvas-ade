/**
 * Terminal config popover (completes Phase 2.1's per-board shell selection).
 * Edits the board's durable `shell` / `launchCommand` / `cwd`; applying patches
 * the board in canvasStore, which re-runs TerminalBoard's spawn effect (its deps
 * include these fields) and respawns the session with the new config.
 *
 * `launchCommand` is free-text → ANY agentic CLI (e.g. `claude`, `codex`). It is
 * written as the first PTY line in pty.ts so the agent inherits PATH/profile/auth.
 * The Label field edits `board.title` (the header text — what the terminal is for);
 * a label-only change does NOT respawn (only shell/launchCommand/cwd are spawn deps).
 *
 * D2-B: implicit closes (Escape / outside pointerdown / ⚙ re-click via closeSignal)
 * run through an unsaved-changes guard — dirty edits arm a confirm row instead of
 * silently discarding (the audit's "non-modal + no guard" finding).
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { MIN_TERMINAL_FONT, MAX_TERMINAL_FONT } from './terminal/terminalFont'
import { configDirty } from './terminal/configDirty'

type ShellInfo = Awaited<ReturnType<typeof window.api.listShells>>[number]

export function TerminalConfig({
  board,
  onClose,
  fontSize,
  onSetFont,
  closeSignal = 0,
  triggerRef
}: {
  board: TerminalBoardData
  onClose: () => void
  fontSize: number
  onSetFont: (next: number) => void
  /** Bumped by the host when the ⚙ trigger asks to close — routed through the guard. */
  closeSignal?: number
  /** The ⚙ trigger's wrapper — excluded from outside-close so its click can toggle. */
  triggerRef?: RefObject<HTMLElement | null>
}): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [title, setTitle] = useState(board.title)
  const [shell, setShell] = useState(board.shell ?? '')
  const [launchCommand, setLaunchCommand] = useState(board.launchCommand ?? '')
  const [cwd, setCwd] = useState(board.cwd ?? '')
  // D2-B unsaved-changes guard: an implicit close (Escape / outside click / ⚙ re-click)
  // with unsaved edits no longer silently discards — it arms this confirm state instead
  // (warn line + Cancel relabelled Discard). Explicit Cancel/Discard always closes.
  const [confirming, setConfirming] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  const seededShell = useRef(board.shell)
  // True only once the user actually picks a shell from the dropdown. The effect
  // below auto-seeds the select to list[0] for display when the board has no
  // explicit shell — but that auto-seed must NOT be persisted, or a label-only
  // Apply would flip `board.shell` from undefined → the default path, changing a
  // spawn dep and killing the live session on every Apply (#9).
  const shellTouched = useRef(false)
  useEffect(() => {
    let live = true
    void window.api.listShells().then((list) => {
      if (!live) return
      setShells(list)
      if (!seededShell.current && list[0]) setShell(list[0].path)
    })
    return () => {
      live = false
    }
  }, [])

  // The guarded-close listeners below are MOUNT-STABLE and read everything through
  // refs at event time — dep-driven re-subscription would remove a window listener
  // MID-DISPATCH and swallow the very event being handled (the D1-B/C Escape-bug
  // class). Dirty itself is computed lazily in requestClose (never during render).
  const draftRef = useRef({ board, title, shell, launchCommand, cwd })
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    draftRef.current = { board, title, shell, launchCommand, cwd }
    onCloseRef.current = onClose
  })

  /** Guarded close: clean → close; dirty (same normalization as apply) → arm the
   *  confirm row (idempotent). */
  const requestClose = useCallback((): void => {
    const d = draftRef.current
    if (configDirty(d.board, { ...d, shellTouched: shellTouched.current })) setConfirming(true)
    else onCloseRef.current()
  }, [])

  // The popover was fully non-modal (the audit finding): clicks elsewhere left it
  // open. Outside-pointerdown now requests a guarded close. Capture phase, so a
  // stopPropagation anywhere in the app can't strand it (Menu.tsx discipline); the
  // ⚙ trigger is excluded so its own click handler can toggle without re-entry.
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (popRef.current?.contains(t)) return
      if (triggerRef?.current?.contains(t)) return
      requestClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [requestClose, triggerRef])

  // ⚙ re-click while open: the host bumps closeSignal instead of unmounting us, so
  // the guard gets a say. Skip the mount-time value (the counter persists in the host).
  const seenSignal = useRef(closeSignal)
  useEffect(() => {
    if (closeSignal === seenSignal.current) return
    seenSignal.current = closeSignal
    requestClose()
  }, [closeSignal, requestClose])

  // Inline-styled fields can't use :focus-visible, so mirror the §6 select-ring
  // (1.5px accent box-shadow) via focus/blur handlers for a visible keyboard state.
  const ringOn = (e: { currentTarget: HTMLElement }): void => {
    e.currentTarget.style.boxShadow = '0 0 0 1.5px var(--accent)'
  }
  const ringOff = (e: { currentTarget: HTMLElement }): void => {
    e.currentTarget.style.boxShadow = ''
  }

  const apply = (): void => {
    useCanvasStore.getState().beginChange()
    updateBoard(board.id, {
      title: title.trim() || board.title,
      // Only persist `shell` when the user explicitly chose one; otherwise leave it
      // untouched so a label-only Apply doesn't seed undefined → default and respawn.
      ...(shellTouched.current ? { shell: shell || undefined } : {}),
      launchCommand: launchCommand.trim() || undefined,
      cwd: cwd.trim() || undefined
    })
    onClose()
  }

  return (
    <div
      ref={popRef}
      style={pop}
      className="nowheel"
      data-no-flip
      tabIndex={-1}
      onWheel={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        // First Escape with dirty edits arms the confirm; a second one (or any field
        // edit) steps back to editing — Escape never silently discards.
        if (e.key === 'Escape') {
          if (confirming) setConfirming(false)
          else requestClose()
        }
      }}
    >
      <label style={lbl}>
        Label
        <input
          style={fld}
          placeholder="What this terminal is for"
          spellCheck={false}
          value={title}
          onChange={(e) => {
            setConfirming(false) // an edit = "keep editing"; disarm the confirm row
            setTitle(e.target.value)
          }}
          onFocus={ringOn}
          onBlur={ringOff}
        />
      </label>
      <label style={lbl}>
        Shell
        <select
          style={fld}
          value={shell}
          onChange={(e) => {
            shellTouched.current = true
            setConfirming(false)
            setShell(e.target.value)
          }}
          onFocus={ringOn}
          onBlur={ringOff}
        >
          {shells.map((s) => (
            <option key={s.path} value={s.path}>
              {s.label}
              {s.default ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label style={lbl}>
        Launch command
        <input
          style={fld}
          placeholder="e.g. claude  (blank = shell only)"
          spellCheck={false}
          value={launchCommand}
          onChange={(e) => {
            setConfirming(false)
            setLaunchCommand(e.target.value)
          }}
          onFocus={ringOn}
          onBlur={ringOff}
        />
      </label>
      <label style={lbl}>
        Working dir
        <input
          style={fld}
          placeholder="(blank = home)"
          spellCheck={false}
          value={cwd}
          onChange={(e) => {
            setConfirming(false)
            setCwd(e.target.value)
          }}
          onFocus={ringOn}
          onBlur={ringOff}
        />
      </label>
      <div style={lbl}>
        Font size
        <div style={fontRow}>
          <button
            type="button"
            style={{ ...stepBtn, ...(fontSize <= MIN_TERMINAL_FONT ? stepBtnOff : null) }}
            onClick={() => onSetFont(fontSize - 1)}
            disabled={fontSize <= MIN_TERMINAL_FONT}
          >
            A{'\u2212'}
          </button>
          <span style={fontVal}>{fontSize}</span>
          <button
            type="button"
            style={{ ...stepBtn, ...(fontSize >= MAX_TERMINAL_FONT ? stepBtnOff : null) }}
            onClick={() => onSetFont(fontSize + 1)}
            disabled={fontSize >= MAX_TERMINAL_FONT}
          >
            A+
          </button>
        </div>
      </div>
      {confirming && (
        <div style={warnRow} role="alert">
          Unsaved changes — apply or discard?
        </div>
      )}
      <div style={footer}>
        <button style={btnGhost} onClick={onClose}>
          {confirming ? 'Discard' : 'Cancel'}
        </button>
        <button style={btnPrimary} onClick={apply}>
          Apply &amp; restart
        </button>
      </div>
    </div>
  )
}

const pop: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  zIndex: 5,
  width: 240,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 'var(--r-inner)',
  background: 'var(--surface-raised)',
  border: '1px solid var(--border)',
  boxShadow: 'var(--shadow-pop)'
}
const lbl: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontFamily: 'var(--ui)',
  fontSize: 11,
  color: 'var(--text-3)'
}
const fld: React.CSSProperties = {
  height: 26,
  padding: '0 8px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 12,
  outline: 'none'
}
const btnGhost: React.CSSProperties = {
  height: 26,
  padding: '0 10px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 12,
  cursor: 'pointer'
}
const btnPrimary: React.CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)'
}
const footer: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 6,
  marginTop: 2
}
/** D2-B guard: the "Unsaved changes" line shown when an implicit close was requested. */
const warnRow: React.CSSProperties = {
  fontFamily: 'var(--ui)',
  fontSize: 11,
  color: 'var(--warn)'
}
const fontRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8
}
const stepBtn: React.CSSProperties = {
  height: 26,
  width: 34,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 13,
  cursor: 'pointer'
}
// Muted disabled state at a font bound — mirrors BoardFrame's IconBtn (opacity 0.35, default cursor)
// so the popover stepper matches the title-bar controls instead of looking active-but-dead.
const stepBtnOff: React.CSSProperties = { opacity: 0.35, cursor: 'default' }
const fontVal: React.CSSProperties = {
  minWidth: 34,
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--text-2)'
}
