/**
 * The Planning inspector's ELEMENT bridge (P4). ONE hook that owns BOTH consumers of the element
 * action model, so the always-visible inspector and the right-click menu can never drift:
 *
 *  - `buildMenuEntries(sel)` — the exact builder `usePlanningPointer` / `usePlanningKeyboard` already
 *    consume for the context menu (moved verbatim out of PlanningBoard so that file stays under its
 *    max-lines ratchet). The `wb` / `measured` thunks read live refs at click time, not build time.
 *  - `element` — the presentation model for the inspector's Element section (`null` when nothing is
 *    selected or the board isn't in select mode). It reuses the SAME entries the menu is built from
 *    (render-safe now that the builder reads no refs), plus a pure kind summary that decides which
 *    per-kind controls to surface (typography / tint), and a batch typography apply (one undo step).
 *
 * "Composition, not new state" — mirrors P3 (the Tools grid drives the board's existing setTool). No
 * cross-tree store: `PlanningInspector` is portaled from inside PlanningBoard, so it already reaches
 * everything the board owns; this hook just packages it.
 */
import { useCallback, useMemo } from 'react'
import type { PlanningElement, TextElement } from '../../../../lib/boardSchema'
import { useCanvasStore } from '../../../../store/canvasStore'
import type { MenuEntry } from '../ElementContextMenu'
import { type AlignBoard } from '../align'
import { buildContextMenuEntries } from '../contextMenuEntries'
import {
  expandGroups,
  patchElement,
  setOpacity as applyOpacityT,
  setStrokeColor as applyStrokeColorT,
  setStrokeWidth as applyStrokeWidthT,
  bringToFront as zBringToFront,
  bringForward as zBringForward,
  sendBackward as zSendBackward,
  sendToBack as zSendToBack,
  type Measured
} from '../elements'
import { clampOpacity, type StrokeColorToken, type StrokeWidthToken } from '../strokeStyle'
import type { TextStylePatch } from '../TextToolbar'
import { summarizeSelection, type TypographyCommon } from './elementModel'

/** Store commit — a next array or a live-read transform (matches PlanningBoard's `commit`). */
type Commit = (next: PlanningElement[] | ((cur: PlanningElement[]) => PlanningElement[])) => void

/** Typography controls for a homogeneous text selection. `apply` patches every selected text in ONE
 *  undo step; the section gates no-op patches (re-selecting the active token never emits — mirrors
 *  the on-board TextToolbar's discipline). */
export interface TypographyControls {
  current: TypographyCommon
  apply: (patch: TextStylePatch) => void
}

/** P4b Appearance controls (always present when ≥1 element is selected). Each setter is ONE undo step
 *  with the live-read guard (a vanished selection never arms a checkpoint); the underlying transforms
 *  are ref-stable on a no-op, so re-picking the current value never pushes a phantom undo. Common
 *  values are `null` when the selection disagrees (indeterminate → no active control state). */
export interface AppearanceControls {
  /** Common opacity across the selection; `null` = indeterminate. Setter clamps to [0.1, 1]. */
  opacity: number | null
  setOpacity: (v: number) => void
  /** Stroke controls only when EVERY selected element is a line kind (arrow / pen). */
  showStroke: boolean
  strokeColor: StrokeColorToken | null
  setStrokeColor: (c: StrokeColorToken) => void
  strokeWidth: StrokeWidthToken | null
  setStrokeWidth: (w: StrokeWidthToken) => void
  /** Z-order (4 buttons): pure `elements[]` reorders — no schema. */
  bringToFront: () => void
  bringForward: () => void
  sendBackward: () => void
  sendToBack: () => void
}

/** The presentation model for the inspector's Element section. */
export interface ElementInspectorModel {
  count: number
  /** Section header suffix, e.g. `text` / `note` / `mixed`. */
  kindLabel: string
  mixed: boolean
  /** Homogeneous text → typography controls; otherwise null (decision 3 gating). */
  typography: TypographyControls | null
  /** Homogeneous note → render the tint swatch row (the entry lives in `entries`). */
  showTint: boolean
  /** Selection ≥2 → show align/distribute (distribute self-disables under 3, via its entry). */
  showArrange: boolean
  /** P4b appearance controls (opacity / stroke / z-order). */
  appearance: AppearanceControls
  /** The shared action + tint + align/distribute entries — the SAME model the context menu uses. */
  entries: MenuEntry[]
}

export interface PlanningElementInspectorArgs {
  /** Menu-open/render-time snapshot — display state only (labels/disabled/current-swatch). */
  elements: PlanningElement[]
  /** Live read at action-invoke time (BUG-008): actions write onto the CURRENT elements, never
   *  the snapshot, so an edit landing while a menu/inspector is open can't be clobbered. */
  getElements: () => PlanningElement[]
  selectedIds: ReadonlySet<string>
  /** Element controls only surface with the select tool (matches the toolbar / grip gate). */
  interactive: boolean
  boardId: string
  /** Well content box (board-local px) for align/distribute — a THUNK read at click time. Injected
   *  (not derived from a ref here) so calling the entry builder during render touches no `.current`
   *  (the react-hooks "refs during render" rule); the board owns the ref read in a callback. */
  wb: () => AlignBoard
  /** Live DOM sizes for the auto-sized kinds — a thunk, same reason as `wb`. */
  measured: () => Map<string, Measured>
  beginChange: () => void
  commit: Commit
  clearSel: () => void
  setSelectedIds: (ids: Set<string>) => void
  newId: () => string
  onOpenSendTo: (sel: ReadonlySet<string>) => void
}

export interface PlanningElementInspector {
  buildMenuEntries: (sel: ReadonlySet<string>) => MenuEntry[]
  element: ElementInspectorModel | null
}

export function usePlanningElementInspector({
  elements,
  getElements,
  selectedIds,
  interactive,
  boardId,
  wb,
  measured,
  beginChange,
  commit,
  clearSel,
  setSelectedIds,
  newId,
  onOpenSendTo
}: PlanningElementInspectorArgs): PlanningElementInspector {
  // The context-menu entry builder (moved from PlanningBoard). `wb`/`measured` arrive as opaque
  // thunks (the board reads its refs inside them, at click time), so this reads no refs directly —
  // calling it during the inspector's render below is safe; the pointer/keyboard hooks call it at
  // event time.
  const buildMenuEntries = useCallback(
    (sel: ReadonlySet<string>): MenuEntry[] =>
      buildContextMenuEntries({
        elements,
        getElements,
        sel,
        wb,
        measured,
        beginChange,
        commit,
        clearSel,
        setSelectedIds,
        newId,
        onOpenSendTo
      }),
    [
      elements,
      getElements,
      wb,
      measured,
      beginChange,
      commit,
      clearSel,
      setSelectedIds,
      newId,
      onOpenSendTo
    ]
  )

  // Batch typography — patch every still-live selected text in ONE undo step (live-read guard so a
  // race with a delete/blur-prune can't push a phantom checkpoint; mirrors PlanningBoard.onTextPatch).
  const applyTypography = useCallback(
    (textIds: string[], patch: TextStylePatch) => {
      const live = useCanvasStore.getState().boards.find((b) => b.id === boardId)
      const els = live?.type === 'planning' ? live.elements : []
      const liveIds = textIds.filter((id) => els.some((e) => e.id === id))
      if (liveIds.length === 0) return
      beginChange()
      commit((cur) =>
        liveIds.reduce(
          (acc, id) => patchElement<TextElement>(acc, id, (t) => ({ ...t, ...patch })),
          cur
        )
      )
    },
    [boardId, beginChange, commit]
  )

  // P4b batch runner — apply a pure elements[] transform to the selection in ONE undo step, with the
  // same live-read guard as applyTypography. The transforms (setOpacity / setStroke* / z-order) are
  // ref-stable on a no-op, so a redundant action returns the same array ref → applyBoardPatch's
  // reference compare treats it as a no-op and never pushes a phantom undo (BUG M3 class).
  const runBatch = useCallback(
    (ids: string[], transform: (cur: PlanningElement[]) => PlanningElement[]) => {
      const live = useCanvasStore.getState().boards.find((b) => b.id === boardId)
      const els = live?.type === 'planning' ? live.elements : []
      if (!ids.some((id) => els.some((e) => e.id === id))) return
      beginChange()
      commit(transform)
    },
    [boardId, beginChange, commit]
  )

  const element = useMemo<ElementInspectorModel | null>(() => {
    if (!interactive || selectedIds.size === 0) return null
    // Build against the group-expanded set — the same set the right-click menu operates on, so the
    // count + actions cover whole groups, not just the clicked member.
    const effective = expandGroups(elements, selectedIds)
    const summary = summarizeSelection(elements, effective)
    if (summary.count === 0) return null
    const entries = buildMenuEntries(effective)
    const typography: TypographyControls | null = summary.typography
      ? { current: summary.typography, apply: (patch) => applyTypography(summary.ids, patch) }
      : null
    const ids = summary.ids
    const appearance: AppearanceControls = {
      opacity: summary.opacity,
      setOpacity: (v) => runBatch(ids, (cur) => applyOpacityT(cur, ids, clampOpacity(v))),
      showStroke: summary.isAllLine,
      strokeColor: summary.strokeColor,
      setStrokeColor: (c) => runBatch(ids, (cur) => applyStrokeColorT(cur, ids, c)),
      strokeWidth: summary.strokeWidth,
      setStrokeWidth: (w) => runBatch(ids, (cur) => applyStrokeWidthT(cur, ids, w)),
      bringToFront: () => runBatch(ids, (cur) => zBringToFront(cur, ids)),
      bringForward: () => runBatch(ids, (cur) => zBringForward(cur, ids)),
      sendBackward: () => runBatch(ids, (cur) => zSendBackward(cur, ids)),
      sendToBack: () => runBatch(ids, (cur) => zSendToBack(cur, ids))
    }
    return {
      count: summary.count,
      kindLabel: summary.kindLabel,
      mixed: summary.mixed,
      typography,
      showTint: summary.isAllNotes,
      showArrange: summary.count >= 2,
      appearance,
      entries
    }
  }, [interactive, selectedIds, elements, buildMenuEntries, applyTypography, runBatch])

  return { buildMenuEntries, element }
}
