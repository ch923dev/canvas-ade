/**
 * A small floating text input to (re)name a group, anchored at a client-space point. Mirrors the
 * TerminalConfig inline-popover discipline: controlled value, focus ring, Enter commits, Esc
 * cancels, stopPropagation on keydown so the canvas keymap (Ctrl+G/f/Esc) doesn't fire while
 * typing. Calls setMenuOpen so a live Browser board detaches and can't paint over it (ADR 0002).
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'

export interface GroupNamePopoverProps {
  /** Initial text (auto-name for create; current name for rename). */
  initial: string
  /** Client-space anchor (top-left of the input). */
  at: { x: number; y: number }
  onCommit: (name: string) => void
  onCancel: () => void
}

export function GroupNamePopover({
  initial,
  at,
  onCommit,
  onCancel
}: GroupNamePopoverProps): ReactElement {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): void => {
    const name = value.trim()
    if (name) onCommit(name)
    else onCancel()
  }

  return createPortal(
    <div
      className="group-name-pop"
      style={{ position: 'fixed', top: at.y, left: at.x, zIndex: 250 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="group-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') onCancel()
        }}
        onBlur={commit}
        placeholder="Group name"
      />
    </div>,
    document.body
  )
}
