/**
 * Right-click menu for a group's name tab: Rename, Focus, Add selected boards, Remove group.
 * Rendered through the shared <Menu> shell (D1-C): body portal, unified viewport clamp at
 * the click point, outside-pointerdown / Esc / resize close, menuitem roving tabindex +
 * arrow-key navigation, setMenuOpen per ADR 0002. "Add selected boards" is disabled when
 * nothing is selected.
 */
import { type ReactElement } from 'react'
import { Menu } from './Menu'

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
  return (
    <Menu anchor={at} onClose={onClose} label="Group actions" className="group-ctx">
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
    </Menu>
  )
}
