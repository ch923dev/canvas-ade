/**
 * The board ⋯ menu (extracted from BoardFrame.tsx at the S1 max-lines ratchet — the
 * boardDefaults precedent): the shared overflow menu every board's title bar mounts, with the
 * S6 group rows, the S1 caller-supplied extraItems (terminal lead grant/revoke), and the
 * standard Full view / Duplicate / Delete actions. BoardFrame re-exports BoardMenu +
 * BoardMenuExtraItem so existing import sites are unchanged.
 */
import type { MouseEvent, ReactElement } from 'react'
import { Fragment, useRef, useState } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { IconBtn } from './BoardFrame'
import { Menu } from './Menu'

/** S6 group rows for the ⋯ menu, split out so the live `groups` subscription runs ONLY while
 *  the menu is open. Kept in BoardMenu's always-mounted trigger, the whole-array subscription
 *  re-rendered every board's title bar on any group create/rename/membership change (PERF-04). */
function BoardGroupMenuItems({
  boardId,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromAllGroups,
  renderItem
}: {
  boardId?: string
  onAddToGroup?: (groupId: string) => void
  /** GROUP-06: remove this board from ONE named group (per-membership row). */
  onRemoveFromGroup?: (groupId: string) => void
  /** GROUP-06: remove from every group at once — earns a row only when in 2+ groups. */
  onRemoveFromAllGroups?: () => void
  renderItem: (label: string, danger: boolean, fn?: (e: MouseEvent) => void) => ReactElement
}): ReactElement | null {
  // Read groups live so the eligible-list / membership reflect the current state.
  const groups = useCanvasStore((s) => s.groups)
  const memberGroups = boardId ? groups.filter((g) => g.boardIds.includes(boardId)) : []
  const eligibleGroups =
    boardId && onAddToGroup ? groups.filter((g) => !g.boardIds.includes(boardId)) : []
  const hasAddRows = !!onAddToGroup && eligibleGroups.length > 0
  const hasRemoveRows = !!onRemoveFromGroup && memberGroups.length > 0
  if (!hasAddRows && !hasRemoveRows) return null
  return (
    <>
      {/* GROUP-06: a quiet caption so the per-group Add/Remove rows read as one cluster. Not a
          menuitem (no role) → the Menu shell's roving-tabindex/arrow nav skips it. */}
      <div className="board-menu-cap" aria-hidden="true">
        Groups
      </div>
      {/* one "Add to {name}" row per group this board is NOT already in. */}
      {hasAddRows &&
        eligibleGroups.map((g) => (
          <span key={`add-${g.id}`} style={{ display: 'contents' }}>
            {renderItem(`Add to ${g.name}`, false, () => onAddToGroup?.(g.id))}
          </span>
        ))}
      {/* GROUP-06: one "Remove from {name}" row per group the board belongs to (was a single
          all-or-nothing "Remove from group" — no per-group target when in several). */}
      {hasRemoveRows &&
        memberGroups.map((g) => (
          <span key={`rm-${g.id}`} style={{ display: 'contents' }}>
            {renderItem(`Remove from ${g.name}`, false, () => onRemoveFromGroup?.(g.id))}
          </span>
        ))}
      {/* "Remove from all groups" only earns its place when the board is in 2+ groups. */}
      {onRemoveFromAllGroups &&
        memberGroups.length >= 2 &&
        renderItem('Remove from all groups', false, onRemoveFromAllGroups)}
    </>
  )
}

/** ⋯ overflow popover: Full view · Duplicate · Add/Remove group · Delete (DESIGN §6.1; S6). */
/** One caller-supplied ⋯-menu row (S1: the terminal lead grant/revoke items). */
export interface BoardMenuExtraItem {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

export function BoardMenu({
  boardId,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onRemoveFromAllGroups,
  extraItems
}: {
  /** This board's id — used to compute eligible groups (not already a member) + membership. */
  boardId?: string
  onFull?: (e: MouseEvent) => void
  onDuplicate?: () => void
  onDelete?: () => void
  /** S6: add this board to a group. One item per eligible group. */
  onAddToGroup?: (groupId: string) => void
  /** GROUP-06: remove this board from ONE named group (per-membership row). */
  onRemoveFromGroup?: (groupId: string) => void
  /** GROUP-06: remove from every group at once — shown only when the board is in 2+. */
  onRemoveFromAllGroups?: () => void
  /** S1: per-type rows rendered between Duplicate and the group rows (terminal lead items). */
  extraItems?: BoardMenuExtraItem[]
}): ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)

  const openMenu = (e: MouseEvent): void => {
    e.stopPropagation()
    setOpen((v) => !v)
  }

  const item = (
    label: string,
    danger: boolean,
    fn?: (e: MouseEvent) => void,
    disabled?: boolean
  ): ReactElement => (
    <button
      className="board-menu-item"
      role="menuitem"
      data-danger={danger || undefined}
      disabled={disabled || undefined}
      onClick={(e) => {
        e.stopPropagation()
        setOpen(false)
        fn?.(e)
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      ref={triggerRef}
      style={{ position: 'relative', display: 'inline-flex' }}
      // Prevent React Flow from treating a ⋯ button press as a canvas-node drag start (the
      // trigger sits in the title bar, which is the RF drag handle). Outside-close re-click
      // toggling (#BUG-045) no longer needs this — the Menu shell's anchor exclusion covers it.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* The ⋯ dots are a near-inkless glyph; bump stroke + use a brighter rest colour so
          the overflow affordance is actually visible at rest (not only when clicked). */}
      <IconBtn
        name="more"
        title="More"
        active={open}
        size={16}
        sw={2.6}
        restColor="var(--text-2)"
        onClick={openMenu}
      />
      {/* Shared Menu shell (D1-C): body portal, viewport clamp (right-aligned under the
          trigger, flips above on bottom overflow — bug 14), Escape/outside/resize close,
          menuitem roving tabindex + arrow keys, and the ADR 0002 detach-live-previews-
          while-open signal. The trigger wrapper above is the anchor (and is excluded
          from outside-close so re-clicking the ⋯ toggles closed — BUG-045). */}
      {open && (
        <Menu
          anchor={triggerRef}
          align="right"
          label="Board actions"
          className="board-menu"
          onClose={() => setOpen(false)}
        >
          {onFull && item('Full view', false, onFull)}
          {onDuplicate && item('Duplicate', false, () => onDuplicate())}
          {/* S1: per-type rows (terminal lead grant/revoke) — caller-supplied, one fragment per
              row so the Menu shell's roving tabindex still sees plain menuitem buttons. */}
          {extraItems?.map((x) => (
            <Fragment key={x.id}>
              {item(x.label, x.danger ?? false, () => x.onSelect(), x.disabled)}
            </Fragment>
          ))}
          {/* S6 group rows — mounted only here (menu open), so the groups subscription
              never re-renders a closed board's title bar (PERF-04). */}
          {(onAddToGroup || onRemoveFromGroup) && (
            <BoardGroupMenuItems
              boardId={boardId}
              onAddToGroup={onAddToGroup}
              onRemoveFromGroup={onRemoveFromGroup}
              onRemoveFromAllGroups={onRemoveFromAllGroups}
              renderItem={item}
            />
          )}
          {onDelete && item('Delete', true, () => onDelete())}
        </Menu>
      )}
    </div>
  )
}
