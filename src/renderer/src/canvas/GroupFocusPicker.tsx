/**
 * "Which group?" picker shown when focus is triggered with more than one group. Clones the
 * TidyMenu popover discipline (AppChrome): portaled to <body>, detaches live Browser views via
 * setMenuOpen (ADR 0002), closes on outside pointerdown / Escape / resize. One row per group;
 * choosing one calls onPick. Anchored at a client-space top-center point (the focus key has no
 * DOM anchor, so the caller centers it near the top of the pane).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'
import type { NamedGroup } from '../lib/boardSchema'

export interface GroupFocusPickerProps {
  groups: NamedGroup[]
  /** Client-space anchor (top-center) where the picker opens. */
  at: { x: number; y: number }
  onPick: (groupId: string) => void
  onClose: () => void
}

export function GroupFocusPicker({
  groups,
  at,
  onPick,
  onClose
}: GroupFocusPickerProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: -9999, left: -9999 })
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  // Detach live Browser views while the picker is open so a native WebContentsView can't paint
  // over it (ADR 0002). Token-keyed so closing this picker can't reattach under another open menu.
  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  // Center horizontally on the anchor, clamped into the viewport.
  useLayoutEffect(() => {
    const m = menuRef.current?.getBoundingClientRect()
    if (!m) return
    const PAD = 8
    const left = Math.max(PAD, Math.min(at.x - m.width / 2, window.innerWidth - m.width - PAD))
    setPos({ top: at.y, left })
  }, [at])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="group-pick-pop"
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 250 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="group-pick-head">Focus group</div>
      {groups.map((g) => (
        <button key={g.id} role="menuitem" className="group-pick-row" onClick={() => onPick(g.id)}>
          <span className="group-pick-name">{g.name}</span>
          <span className="group-pick-count">{g.boardIds.length}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
