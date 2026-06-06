/**
 * Right-click menu for a group's name tab: Rename, Focus, Add selected boards, Remove group.
 * Same popover discipline as GroupFocusPicker (portal, outside-pointerdown / Esc / resize close,
 * setMenuOpen per ADR 0002). "Add selected boards" is disabled when nothing is selected.
 */
import { useEffect, useId, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'

export interface GroupContextMenuProps {
  at: { x: number; y: number }
  hasSelection: boolean
  onRename: () => void
  onFocus: () => void
  onAddSelected: () => void
  onRemove: () => void
  onClose: () => void
}

export function GroupContextMenu(props: GroupContextMenuProps): ReactElement {
  const { at, hasSelection, onRename, onFocus, onAddSelected, onRemove, onClose } = props
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

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

  return createPortal(
    <div
      role="menu"
      className="group-ctx"
      style={{ position: 'fixed', top: at.y, left: at.x, zIndex: 250 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button role="menuitem" className="group-ctx-row" onClick={onRename}>
        Rename
      </button>
      <button role="menuitem" className="group-ctx-row" onClick={onFocus}>
        Focus
      </button>
      <button
        role="menuitem"
        className="group-ctx-row"
        disabled={!hasSelection}
        onClick={onAddSelected}
      >
        Add selected boards
      </button>
      <div className="group-ctx-divider" />
      <button role="menuitem" className="group-ctx-row group-ctx-danger" onClick={onRemove}>
        Remove group
      </button>
    </div>,
    document.body
  )
}
