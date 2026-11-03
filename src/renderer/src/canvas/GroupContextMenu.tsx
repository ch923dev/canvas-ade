/**
 * Right-click menu for a group's name tab: Rename, Focus, Tidy group, Add selected boards, Remove
 * group. Rendered through the shared <Menu> shell (D1-C): body portal, unified viewport clamp at
 * the click point, outside-pointerdown / Esc / resize close, menuitem roving tabindex +
 * arrow-key navigation. "Add selected boards" is disabled when nothing is selected. Every row
 * closes the menu after its action runs, so callers pass the action alone.
 */
import { type ReactElement } from 'react'
import { Menu } from './Menu'

export interface GroupContextMenuProps {
  at: { x: number; y: number }
  hasSelection: boolean
  onRename: () => void
  onFocus: () => void
  /** Spatial I3: arrange ONLY this group (the default tidy); neighbours never move. */
  onTidy: () => void
  onAddSelected: () => void
  onRemove: () => void
  onClose: () => void
}

export function GroupContextMenu(props: GroupContextMenuProps): ReactElement {
  const { at, hasSelection, onRename, onFocus, onTidy, onAddSelected, onRemove, onClose } = props
  const act = (fn: () => void) => (): void => {
    fn()
    onClose()
  }
  return (
    <Menu anchor={at} onClose={onClose} label="Group actions" className="group-ctx">
      <button role="menuitem" className="group-ctx-row" onClick={act(onRename)}>
        Rename
      </button>
      <button role="menuitem" className="group-ctx-row" onClick={act(onFocus)}>
        Focus
      </button>
      <button role="menuitem" className="group-ctx-row" onClick={act(onTidy)}>
        Tidy group
      </button>
      <button
        role="menuitem"
        className="group-ctx-row"
        disabled={!hasSelection}
        onClick={act(onAddSelected)}
      >
        Add selected boards
      </button>
      <div className="group-ctx-divider" />
      <button role="menuitem" className="group-ctx-row group-ctx-danger" onClick={act(onRemove)}>
        Remove group
      </button>
    </Menu>
  )
}
