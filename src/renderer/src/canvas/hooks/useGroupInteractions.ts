/**
 * Group interaction choreography extracted from Canvas.tsx (god-file maintainability, Tier-1).
 * Owns the ephemeral group UI state machine (naming popover · focus picker · tab context menu ·
 * the S6 "absorb" reflow flag + drag-onto-box drop target + its timer) and the five group action
 * callbacks (create · fit · select-members · focus · reflow-add). Behavior-preserving move: the
 * JSX, the keymap, and onNodeDrag/onNodeDragStart/onNodeDragStop in Canvas.tsx call the returned
 * API exactly as before. EPHEMERAL state only — none of it is ever persisted.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import { type ReactFlowInstance } from '@xyflow/react'
import { useCanvasStore } from '../../store/canvasStore'
import { boardsBounds } from '../../lib/boardGeometry'
import { Z_MAX } from '../../lib/canvasView'
import { cameraAnim } from '../../lib/motion'
import { nextGroupName } from '../../lib/groupName'
import { groupFitMaxZoom, computeGroupBoxes } from '../../lib/groupBoxes'
import { packGroupMembers, groupBoxAt } from '../../lib/groupReflow'
import { GROUP_BOX_PAD, GROUP_BOX_INSET_STEP } from '../GroupBoxLayer'
import type { BoardFlowNode } from '../BoardNode'

/** Single-board/group focus framing (DESIGN.md §5/§9). Mirrors Canvas's FOCUS_OPTIONS — kept local
 *  so fitGroup stays a verbatim move (FOCUS_OPTIONS is not group-specific, so it isn't re-exported). */
const FOCUS_OPTIONS = { padding: 0.3, maxZoom: Z_MAX } as const

export interface GroupInteractionsDeps {
  rf: ReactFlowInstance
  paneRef: RefObject<HTMLDivElement>
  setFocusedId: Dispatch<SetStateAction<string | null>>
}

export function useGroupInteractions(deps: GroupInteractionsDeps) {
  const { rf, paneRef, setFocusedId } = deps
  const addBoardsToGroupReflowed = useCanvasStore((s) => s.addBoardsToGroupReflowed)

  // Group create/rename: the inline name popover (anchored in client space) + the group whose
  // name it is editing (null = closed). Ephemeral — never persisted.
  const [namingGroupId, setNamingGroupId] = useState<string | null>(null)
  const [namePopAt, setNamePopAt] = useState<{ x: number; y: number } | null>(null)
  // Grouped focus: when >1 group exists the focus action opens this picker (anchored top-center
  // of the pane); null = closed. The camera fit itself is in `fitGroup`.
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null)
  // Right-click-a-tab context menu (manage a group): null = closed. Anchored at the click point.
  const [groupMenu, setGroupMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(
    null
  )
  // S6 "absorb" reflow: while true, a `.reflowing` class arms the board-node + group-box
  // CSS transition so members glide into the re-packed cluster. EPHEMERAL — never persisted.
  const [reflowing, setReflowing] = useState(false)
  const reflowTimerRef = useRef<number | null>(null)
  // S6 drag-onto-box: the group box under the dragged board's center (a non-member drop
  // target), glowing accent; null = no target. EPHEMERAL — never persisted.
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null)

  // Create a group from the current multi-selection (>=2 boards). Mints the group with an
  // auto-name, then opens the inline name popover over the selection's top-left so the user can
  // rename immediately (Esc keeps the auto-name). No-op for <2 selected.
  const groupSelection = useCallback(() => {
    const st = useCanvasStore.getState()
    const ids = st.selectedIds
    // Resolve the selection to LIVE boards first, and require >=2 of them BEFORE minting the
    // group — otherwise boards deleted between selection and Ctrl+G would commit a group over
    // stale ids with no locatable bounds (no popover), leaving an orphan the user can't rename.
    const sel = st.boards.filter((b) => ids.includes(b.id))
    const bb = boardsBounds(sel)
    if (sel.length < 2 || !bb) return
    const name = nextGroupName(st.groups)
    const gid = st.addGroup(
      name,
      sel.map((b) => b.id)
    )
    const p = rf.flowToScreenPosition({ x: bb.minX, y: bb.minY })
    setNamePopAt({ x: p.x, y: Math.max(8, p.y - 40) })
    setNamingGroupId(gid)
  }, [rf])

  // Fit the camera to one group's member boards (raster-capped). Mirrors focusBoard but over the
  // whole member set; exits dim-focus first so the others aren't left dimmed (#14 parity).
  const fitGroup = useCallback(
    (groupId: string) => {
      const st = useCanvasStore.getState()
      const g = st.groups.find((x) => x.id === groupId)
      if (!g) return
      const members = st.boards.filter((b) => g.boardIds.includes(b.id))
      if (members.length === 0) return
      setFocusedId(null)
      const maxZoom = groupFitMaxZoom(members, Z_MAX)
      void rf.fitView(
        cameraAnim({ ...FOCUS_OPTIONS, maxZoom, nodes: members.map((b) => ({ id: b.id })) })
      )
    },
    [rf, setFocusedId]
  )

  // Tab single-click selects all of a group's members (also reused by S5).
  const selectGroupMembers = useCallback((groupId: string) => {
    const st = useCanvasStore.getState()
    const g = st.groups.find((x) => x.id === groupId)
    if (g) st.setSelection(g.boardIds)
  }, [])

  // Focus action (key `f` + camera-cluster button + tab double-click): 0 groups → no-op,
  // 1 group → fit it directly, >1 → open the picker anchored at the pane's top-center.
  const focusGroup = useCallback(() => {
    const st = useCanvasStore.getState()
    if (st.groups.length === 0) return
    if (st.groups.length === 1) {
      fitGroup(st.groups[0].id)
      return
    }
    const r = paneRef.current?.getBoundingClientRect()
    setPickerAt({
      x: r ? r.left + r.width / 2 : window.innerWidth / 2,
      y: (r?.top ?? 0) + 56
    })
  }, [fitGroup, paneRef])

  // S6 "absorb": add board(s) to a group and animate the cluster re-packing to absorb them.
  // Arms the .reflowing transition for one window, commits membership + the packed member
  // positions in ONE tracked step, then disarms. Honors reduced motion (the CSS no-ops the
  // transition); the membership/position commit happens regardless.
  const reflowAddToGroup = useCallback(
    (groupId: string, boardIds: string[]) => {
      const st = useCanvasStore.getState()
      const g = st.groups.find((x) => x.id === groupId)
      if (!g) return
      const memberIds = new Set([...g.boardIds, ...boardIds])
      const members = st.boards.filter((b) => memberIds.has(b.id))
      const placements = packGroupMembers(members)
      setReflowing(true)
      addBoardsToGroupReflowed(groupId, boardIds, placements)
      if (reflowTimerRef.current != null) clearTimeout(reflowTimerRef.current)
      reflowTimerRef.current = window.setTimeout(() => {
        setReflowing(false)
        reflowTimerRef.current = null
      }, 340)
    },
    [addBoardsToGroupReflowed]
  )
  // Clear the reflow disarm timer on unmount so a pending setState can't fire post-teardown.
  useEffect(
    () => () => {
      if (reflowTimerRef.current != null) clearTimeout(reflowTimerRef.current)
    },
    []
  )

  // NEW small wrapper so the reflow timer/flag stay fully encapsulated (replaces the inline
  // disarm block that was in Canvas's onNodeDragStart):
  const disarmReflow = useCallback(() => {
    if (reflowTimerRef.current != null) {
      clearTimeout(reflowTimerRef.current)
      reflowTimerRef.current = null
    }
    setReflowing(false)
  }, [])

  // NEW: the onNodeDrag S6 hit-test body, moved verbatim (carry its big comment here). It takes
  // only the dragged node — the pointer event is unused by the hit-test.
  const onNodeDragGroupHitTest = useCallback((node: BoardFlowNode) => {
    // S6 drag-onto-box: while a board is dragged, hit-test its CENTER against every group box
    // (excluding the groups it already belongs to) and light the hovered box as a drop target.
    const st = useCanvasStore.getState()
    const boxes = computeGroupBoxes(st.groups, st.boards, {
      pad: GROUP_BOX_PAD,
      insetStep: GROUP_BOX_INSET_STEP
    })
    // Exclude groups the dragged board is already in (can't "add" to its own group).
    const inGroups = new Set(st.groups.filter((g) => g.boardIds.includes(node.id)).map((g) => g.id))
    // node.position is the live world position; size comes from the store board (the RF
    // node carries w/h on `style`, not the measured `width`/`height` during a drag).
    const b = st.boards.find((x) => x.id === node.id)
    const w = b?.w ?? 0
    const h = b?.h ?? 0
    const center = { x: node.position.x + w / 2, y: node.position.y + h / 2 }
    const target = groupBoxAt(boxes, center, inGroups)
    setDropTargetGroupId((prev) => (prev === target ? prev : target))
  }, [])

  return {
    namingGroupId,
    namePopAt,
    pickerAt,
    groupMenu,
    reflowing,
    dropTargetGroupId,
    setNamingGroupId,
    setNamePopAt,
    setPickerAt,
    setGroupMenu,
    setDropTargetGroupId,
    groupSelection,
    fitGroup,
    selectGroupMembers,
    focusGroup,
    reflowAddToGroup,
    disarmReflow,
    onNodeDragGroupHitTest
  }
}
