/**
 * Terminal config popover (completes Phase 2.1's per-board shell selection).
 * Edits the board's durable `shell` / `launchCommand` / `cwd`; applying patches
 * the board in canvasStore, which re-runs TerminalBoard's spawn effect (its deps
 * include these fields) and respawns the session with the new config.
 *
 * `launchCommand` is free-text → ANY agentic CLI (e.g. `claude`, `codex`). It is
 * written as the first PTY line in pty.ts so the agent inherits PATH/profile/auth.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { TerminalBoard as TerminalBoardData } from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'

type ShellInfo = Awaited<ReturnType<typeof window.api.listShells>>[number]

export function TerminalConfig({
  board,
  onClose
}: {
  board: TerminalBoardData
  onClose: () => void
}): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const [shells, setShells] = useState<ShellInfo[]>([])
  const [shell, setShell] = useState(board.shell ?? '')
  const [launchCommand, setLaunchCommand] = useState(board.launchCommand ?? '')
  const [cwd, setCwd] = useState(board.cwd ?? '')

  const seededShell = useRef(board.shell)
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

  const apply = (): void => {
    useCanvasStore.getState().beginChange()
    updateBoard(board.id, {
      shell: shell || undefined,
      launchCommand: launchCommand.trim() || undefined,
      cwd: cwd.trim() || undefined
    })
    onClose()
  }

  return (
    <div
      style={pop}
      tabIndex={-1}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose()
      }}
    >
      <label style={lbl}>
        Shell
        <select style={fld} value={shell} onChange={(e) => setShell(e.target.value)}>
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
          onChange={(e) => setLaunchCommand(e.target.value)}
        />
      </label>
      <label style={lbl}>
        Working dir
        <input
          style={fld}
          placeholder="(blank = home)"
          spellCheck={false}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
        />
      </label>
      <div style={footer}>
        <button style={btnGhost} onClick={onClose}>
          Cancel
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
