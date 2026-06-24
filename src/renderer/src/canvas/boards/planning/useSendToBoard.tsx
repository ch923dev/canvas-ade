/**
 * Host glue for the "Send to board…" picker (cross-board element transfer, Phase 2 — spec
 * §3.A / §4.3). Owns the picker's open-state + the captured source selection, renders
 * SendToBoardPanel, and on a pick routes the transfer through the Phase-1 engine
 * (`transferElements`) — computing the centered placement, spawning a fresh board for the
 * "+ New planning board" sentinel, and raising the click-to-focus confirmation toast (Q3).
 *
 * Extracted from PlanningBoard so the board file stays under its max-lines pin: the board only
 * threads the menu's `onOpenSendTo` callback + drops the returned panel into its JSX. All state
 * here is EPHEMERAL (open-flag, Copy/Move, captured selection) — never serialized, never routed
 * into `elements[]`/`PATCHABLE_KEYS` (scene/session split). The transfer is the engine's single
 * undo step; this hook never opens a second `beginChange`/`updateBoard` for it.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasStore, selectOtherPlanningBoards } from '../../../store/canvasStore'
import { showToast } from '../../../store/toastStore'
import {
  DEFAULT_BOARD_SIZE,
  type PlanningBoard as PlanningBoardData
} from '../../../lib/boardSchema'
import { elementBBox } from './elementRegistry'
import { expandGroups, isLocked, unionBBox, type TransferMode } from './elements'
import { NEW_PLANNING_BOARD, SendToBoardPanel, type SendTarget } from './SendToBoardPanel'

interface OpenState {
  x: number
  y: number
  /** The group-expanded source selection captured when the picker opened. */
  sel: ReadonlySet<string>
  /** Snapshot of the destination boards at open (the picker is transient — no live sub). */
  targets: SendTarget[]
}

export interface SendToBoardDeps {
  board: PlanningBoardData
  /** Canonical camera-fit focus path (focusBoardById), threaded from BoardNode for the toast's
   *  Focus action. Undefined off the canvas (tests) → the toast renders without the action. */
  onFocusBoard?: (id: string) => void
  /** The live element-context-menu state — its x/y anchors the picker at the cursor. */
  menuAnchor: { x: number; y: number } | null
}

export interface SendToBoardApi {
  /** Menu "Send to board…" entry → open the picker for `sel` (anchored at the menu). */
  onOpenSendTo: (sel: ReadonlySet<string>) => void
  /** The picker popover (or null when closed) — dropped into PlanningBoard's JSX. */
  sendToPanel: ReactElement | null
}

export function useSendToBoard({
  board,
  onFocusBoard,
  menuAnchor
}: SendToBoardDeps): SendToBoardApi {
  const [open, setOpen] = useState<OpenState | null>(null)
  // Latest menu anchor via a ref so onOpenSendTo stays identity-stable (the menu builder
  // depends on it; a fresh identity each render would re-create every memoized entry).
  const anchorRef = useRef(menuAnchor)
  useEffect(() => {
    anchorRef.current = menuAnchor
  }, [menuAnchor])

  const onOpenSendTo = useCallback(
    (sel: ReadonlySet<string>) => {
      const a = anchorRef.current
      const targets = selectOtherPlanningBoards(useCanvasStore.getState().boards, board.id).map(
        (b) => ({ id: b.id, title: b.title })
      )
      // Re-expand defensively (idempotent): the count + the transfer both work off the
      // group-expanded set, so a whole group always travels together.
      setOpen({ x: a?.x ?? 0, y: a?.y ?? 0, sel: expandGroups(board.elements, sel), targets })
    },
    [board.id, board.elements]
  )

  const pick = useCallback(
    ({ target, mode }: { target: string; mode: TransferMode }) => {
      if (!open) return
      const store = useCanvasStore.getState()
      // Center the payload in the target's content box (spec §4.3): the union bbox is the
      // (group-expanded, lock-filtered-on-move) selection at NOMINAL sizes — exactly what the
      // engine normalizes against — so the centered `at` matches the inserted payload. Clamp the
      // top-left to ≥ (16,16) so an oversized payload still lands inside the board.
      const expanded = expandGroups(board.elements, open.sel)
      const taken = board.elements.filter(
        (e) => expanded.has(e.id) && (mode === 'copy' || !isLocked(e))
      )
      const union = unionBBox(taken.map((e) => elementBBox(e)))
      const at = (w: number, h: number): { x: number; y: number } => ({
        x: Math.max(16, w / 2 - union.w / 2),
        y: Math.max(16, h / 2 - union.h / 2)
      })

      let targetId = target
      let title: string
      let placement: { x: number; y: number }
      if (target === NEW_PLANNING_BOARD) {
        // Spawn a fresh planning board off the source's right edge (freeSlot nudges off any
        // overlap), then center the payload in its default content box. addBoard is its own
        // undo step + the transfer one more — accepted for the New case (spec §10 Q2), no
        // coalescing needed.
        targetId = store.addBoard('planning', { x: board.x + board.w + 40, y: board.y })
        title =
          useCanvasStore.getState().boards.find((b) => b.id === targetId)?.title ??
          'New planning board'
        const d = DEFAULT_BOARD_SIZE.planning
        placement = at(d.w, d.h)
      } else {
        const tb = store.boards.find((b) => b.id === target)
        if (!tb) {
          setOpen(null)
          return
        }
        title = tb.title
        placement = at(tb.w, tb.h)
      }

      const { newIds } = store.transferElements(board.id, targetId, open.sel, mode, placement)
      setOpen(null)
      // Nothing actually transferred (e.g. a Move whose every member was locked) → no toast.
      if (newIds.length === 0) return
      showToast({
        message: `${mode === 'move' ? 'Moved' : 'Copied'} ${newIds.length} item${
          newIds.length === 1 ? '' : 's'
        } to ${title}`,
        // Click-to-focus the target via the canonical camera-fit path (Q3 — no auto-pan).
        action: onFocusBoard ? { label: 'Focus', run: () => onFocusBoard(targetId) } : undefined
      })
    },
    [open, board, onFocusBoard]
  )

  const sendToPanel = open ? (
    <SendToBoardPanel
      anchor={{ x: open.x, y: open.y }}
      count={open.sel.size}
      targets={open.targets}
      onPick={pick}
      onClose={() => setOpen(null)}
    />
  ) : null

  return { onOpenSendTo, sendToPanel }
}
