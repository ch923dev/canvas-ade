/**
 * Builder for the Planning whiteboard's right-click menu entries — the entry
 * construction moved VERBATIM out of PlanningBoard.tsx when the D3-A Tint row
 * pushed it past the max-lines ratchet (no behavior change; the board threads its
 * store callbacks + measured sizes in via `deps`). No React in here.
 *
 * Every action is exactly ONE undo checkpoint via `run` (beginChange + commit);
 * the no-op-no-checkpoint discipline is delegated to the pure transforms
 * (align/distribute/group/tint/etc. return the input by reference when there's
 * nothing to do) backed by disabling the entries below when they would be no-ops.
 */
import type { NoteElement, PlanningElement } from '../../../lib/boardSchema'
import type { MenuEntry } from './ElementContextMenu'
import { alignElements, distributeElements, type AlignBoard, type AlignEdge } from './align'
import {
  duplicateElements,
  expandGroups,
  groupElements,
  isLocked,
  setLocked,
  setNoteTint,
  ungroupElements,
  type Measured
} from './elements'
import { NOTE_TINTS, TINT_CYCLE } from './tints'

export interface ContextMenuDeps {
  elements: PlanningElement[]
  /** The group-expanded selection the menu was opened with. */
  sel: ReadonlySet<string>
  /** Well content box (board-local px) so align/distribute flush + clamp to the BOARD. */
  wb: AlignBoard
  /** Live DOM sizes for the auto-sized kinds (text, checklist). */
  measured: Map<string, Measured>
  beginChange: () => void
  commit: (next: PlanningElement[]) => void
  clearSel: () => void
  setSelectedIds: (ids: Set<string>) => void
  newId: () => string
  /** Open the "Send to board…" picker for the (group-expanded) selection (cross-board transfer). */
  onOpenSendTo: (sel: ReadonlySet<string>) => void
}

export function buildContextMenuEntries(deps: ContextMenuDeps): MenuEntry[] {
  const {
    elements,
    sel,
    wb,
    measured,
    beginChange,
    commit,
    clearSel,
    setSelectedIds,
    newId,
    onOpenSendTo
  } = deps
  const selEls = elements.filter((e) => sel.has(e.id))
  const allLocked = selEls.length > 0 && selEls.every(isLocked)
  const anyGrouped = selEls.some((e) => !!e.groupId)
  const groupIds = new Set(selEls.map((e) => e.groupId).filter(Boolean))
  const isOneGroup = sel.size >= 2 && groupIds.size === 1 && selEls.every((e) => !!e.groupId)
  const run = (next: PlanningElement[]): void => {
    beginChange()
    commit(next)
  }
  const alignBtns = (['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] as AlignEdge[]).map(
    (edge) => ({
      id: edge,
      title: `Align ${edge}`,
      icon: `align-${edge === 'centerX' ? 'center-h' : edge === 'centerY' ? 'middle' : edge}`,
      onSelect: () => run(alignElements(elements, sel, edge, wb, measured))
    })
  )
  // Tintable = unlocked notes in the (group-expanded) selection; the Tint row is
  // dead UI without one, so disable rather than offer a guaranteed no-op (D3-A).
  const tintableNotes = selEls.filter((e): e is NoteElement => e.kind === 'note' && !isLocked(e))
  const entries: MenuEntry[] = [
    {
      kind: 'action',
      id: 'lock',
      label: allLocked ? 'Unlock' : 'Lock',
      onSelect: () => run(setLocked(elements, sel, !allLocked))
    },
    {
      kind: 'action',
      id: 'group',
      label: 'Group',
      disabled: sel.size < 2 || isOneGroup,
      onSelect: () => run(groupElements(elements, sel, newId()))
    },
    {
      kind: 'action',
      id: 'ungroup',
      label: 'Ungroup',
      disabled: !anyGrouped,
      onSelect: () => run(ungroupElements(elements, sel))
    },
    {
      kind: 'action',
      id: 'duplicate',
      label: 'Duplicate',
      onSelect: () => {
        beginChange()
        const { elements: wc, newIds } = duplicateElements(
          elements,
          expandGroups(elements, sel),
          12,
          12,
          newId
        )
        commit(wc)
        setSelectedIds(new Set(newIds))
      }
    },
    {
      kind: 'action',
      id: 'send-to-board',
      label: 'Send to board…',
      // Enabled for ANY non-empty selection: the picker's "+ New planning board" row is always a
      // valid destination, so this stays enabled even when no OTHER planning board exists (resolves
      // the spec §3.A wording — §10 Q2). The menu only builds with a non-empty `sel`, so no extra
      // guard. Capture the group-expanded selection so a whole group travels together.
      onSelect: () => onOpenSendTo(expandGroups(elements, sel))
    },
    {
      kind: 'swatchRow',
      id: 'tint',
      label: 'Tint',
      disabled: tintableNotes.length === 0,
      swatches: TINT_CYCLE.map((t) => ({
        id: t,
        title: `${t[0].toUpperCase()}${t.slice(1)} tint`,
        fill: NOTE_TINTS[t].fill,
        edge: NOTE_TINTS[t].edge,
        current: tintableNotes.length > 0 && tintableNotes.every((n) => n.tint === t),
        onSelect: () => run(setNoteTint(elements, sel, t))
      }))
    },
    {
      kind: 'iconRow',
      id: 'align',
      label: 'Align',
      disabled: sel.size < 2,
      buttons: alignBtns
    },
    {
      kind: 'iconRow',
      id: 'distribute',
      label: 'Distribute',
      disabled: sel.size < 3,
      buttons: [
        {
          id: 'h',
          title: 'Distribute horizontally',
          icon: 'distribute-h',
          onSelect: () => run(distributeElements(elements, sel, 'h', wb, measured))
        },
        {
          id: 'v',
          title: 'Distribute vertically',
          icon: 'distribute-v',
          onSelect: () => run(distributeElements(elements, sel, 'v', wb, measured))
        }
      ]
    },
    {
      kind: 'action',
      id: 'delete',
      label: 'Delete',
      danger: true,
      onSelect: () => {
        // Group then lock precedence (mirrors the keyboard Delete handler).
        const expanded = expandGroups(elements, sel)
        const removable = new Set(
          [...expanded].filter((rid) => {
            const el = elements.find((x) => x.id === rid)
            return el !== undefined && !isLocked(el)
          })
        )
        if (removable.size > 0) {
          beginChange()
          commit(elements.filter((el) => !removable.has(el.id)))
        }
        clearSel()
      }
    }
  ]
  return entries
}
