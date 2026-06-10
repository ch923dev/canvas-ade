/**
 * The Planning whiteboard's pointer state machine (Wave-5 B5 extraction). A
 * behavior-preserving lift of the gesture handlers + transient gesture state out of
 * `PlanningBoard.tsx` — moved VERBATIM, with the cross-boundary inputs now threaded
 * in via a `deps` object instead of read from the component closure.
 *
 * Coordinate model + commit/undo discipline are unchanged: every element is stored in
 * BOARD-LOCAL space; moves/arrows/pen/erase commit ONCE on pointer-up so a gesture is a
 * single undo checkpoint; a no-movement grab pushes no phantom undo snapshot.
 */
import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type MouseEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type SetStateAction
} from 'react'
import type { ArrowElement, PlanningElement } from '../../../lib/boardSchema'
import { pushBoardPoint } from '../../../lib/pen'
import { eraseHitTest } from './erase'
import { rectFromPoints, marqueeHits } from './marquee'
import { computeSnap, SNAP_TOL, type Guide } from './snapping'
import type { PlanTool } from './tools'
import type { MenuEntry } from './ElementContextMenu'
import {
  makeArrow,
  makeChecklist,
  makeNote,
  makeStroke,
  makeText,
  nextNoteIndex,
  translateMany,
  elementBBox,
  unionBBox,
  isLocked,
  expandGroups,
  duplicateElements
} from './elements'
import { tokenFromHeight, MIN_TEXT_WIDTH_PX } from './textStyle'

const newId = (): string => crypto.randomUUID()

export interface PlanningPointerDeps {
  tool: PlanTool
  setTool: Dispatch<SetStateAction<PlanTool>>
  elements: PlanningElement[]
  commit: (next: PlanningElement[]) => void
  beginChange: () => void
  toBoard: (e: { clientX: number; clientY: number }) => { x: number; y: number }
  selectedIds: ReadonlySet<string>
  setSelectedIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  clearSel: () => void
  snapEnabled: boolean
  measuredRef: MutableRefObject<Map<string, { w: number; h: number }>>
  wellRef: MutableRefObject<HTMLDivElement | null>
  buildMenuEntries: (sel: ReadonlySet<string>) => MenuEntry[]
  setContextMenu: Dispatch<SetStateAction<{ x: number; y: number; entries: MenuEntry[] } | null>>
}

export interface PlanningPointerApi {
  startElementDrag: (e: PointerEvent, id: string) => void
  onWellPointerDown: (e: PointerEvent<HTMLDivElement>) => void
  onWellPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onWellDoubleClick: (e: MouseEvent<HTMLDivElement>) => void
  onWellContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => void
  onWellPointerUp: (e?: PointerEvent<HTMLDivElement>) => void
  onWellPointerCancel: () => void
  draftArrow: ArrowElement | null
  draftStroke: number[] | null
  dragPos: { ids: string[]; dx: number; dy: number; alt: boolean } | null
  marqueeRect: { x: number; y: number; w: number; h: number } | null
  draftTextBox: { x: number; y: number; w: number; h: number } | null
  pendingErase: Set<string> | null
  snapGuides: Guide[] | null
}

export function usePlanningPointer(deps: PlanningPointerDeps): PlanningPointerApi {
  const {
    tool,
    setTool,
    elements,
    commit,
    beginChange,
    toBoard,
    selectedIds,
    setSelectedIds,
    clearSel,
    snapEnabled,
    measuredRef,
    wellRef,
    buildMenuEntries,
    setContextMenu
  } = deps

  const [snapGuides, setSnapGuides] = useState<Guide[] | null>(null)

  // In-progress (uncommitted) gesture state — drawn as a draft until pointer-up.
  const [draftArrow, setDraftArrow] = useState<ArrowElement | null>(null)
  const [draftStroke, setDraftStroke] = useState<number[] | null>(null)
  // Transient element-move delta — rendered live during a drag, committed to the
  // store ONCE on pointer-up (mirrors the arrow/pen draft pattern) so a move is a
  // single undo checkpoint, not one mutation per frame (#9). A delta (not an
  // absolute top-left) so it translates EVERY kind uniformly, including arrows +
  // strokes which have no single top-left (#28, #37).
  const [dragPos, setDragPos] = useState<{
    ids: string[]
    dx: number
    dy: number
    alt: boolean
  } | null>(null)
  // Active drag (an element move, an arrow, or a pen stroke) → captured pointer.
  // A move records the grab point in board space so the delta = pointer − grab.
  // A move also records whether Alt was held at grab → an alt-drag DUPLICATES the
  // moving set on pointer-up (originals stay put; a ghost preview tracks the copies).
  const drag = useRef<
    | { mode: 'move'; ids: string[]; grabX: number; grabY: number; alt: boolean }
    | { mode: 'arrow'; id: string }
    | { mode: 'pen'; points: number[] }
    | { mode: 'erase'; removed: Set<string> }
    | { mode: 'marquee'; startX: number; startY: number; additive: boolean }
    | { mode: 'textbox'; startX: number; startY: number; sx: number; sy: number }
    | null
  >(null)
  // Live marquee box (board-local) while box-selecting; null when idle. Transient,
  // session-only (never serialized); resolved to a selection set on pointer-up.
  const [marqueeRect, setMarqueeRect] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  // Live text-tool drag box (board-local) while drawing; null when idle. Transient,
  // session-only (never serialized); resolved to a new text element on pointer-up.
  const [draftTextBox, setDraftTextBox] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // Ids the in-flight erase swipe has marked for deletion. While set, those
  // elements are hidden from the render (immediate feedback) and committed as ONE
  // checkpoint on pointer-up. Null when not erasing.
  const [pendingErase, setPendingErase] = useState<Set<string> | null>(null)

  // ── Element drag (select tool): grab → move in board-local space ─────────────
  const startElementDrag = useCallback(
    (e: PointerEvent, id: string) => {
      if (e.button !== 0) return // right/middle: ignore, let contextmenu handle it
      const el = elements.find((x) => x.id === id)
      if (!el || isLocked(el)) return // a locked element can't initiate a drag
      // Do NOT checkpoint here: a zero-movement grab (plain click) would push a
      // no-op undo snapshot and wipe an armed redo branch (#11). The checkpoint is
      // taken lazily in onWellPointerUp, only if the move actually committed.
      // Selection-aware moving set (Figma grammar). Pressing an already-selected
      // element drags the whole set; pressing an unselected one (no Shift) replaces
      // the selection with just it. (The card/vector onSelect already ran
      // selectOnPress with the Shift flag, so read the resulting intent here off the
      // live set — React state is async, so this is the PRE-press set, which is
      // correct: already-selected keeps the set, unselected → [id].)
      const sel = selectedIds
      const base = sel.has(id) ? [...sel] : [id]
      // Group precedence: pull in whole groups, THEN drop any locked member so lock
      // wins over group membership (a locked element never moves with its group).
      const expanded = expandGroups(elements, base)
      const movingIds = [...expanded].filter((mid) => {
        const m = elements.find((x) => x.id === mid)
        return m !== undefined && !isLocked(m)
      })
      if (movingIds.length === 0) return
      const p = toBoard(e)
      // Record the grab point; the live delta is pointer − grab. Works for every
      // kind (cards + arrows + strokes) since we translate by delta (#28, #37).
      // Capture Alt at grab → an alt-drag duplicates rather than moves on pointer-up.
      drag.current = { mode: 'move', ids: movingIds, grabX: p.x, grabY: p.y, alt: e.altKey }
      // Capture on the WELL (not the card) so move/up route to the well handlers
      // even when the cursor leaves the card during a fast drag.
      wellRef.current?.setPointerCapture(e.pointerId)
    },
    [elements, toBoard, selectedIds, wellRef]
  )

  // ── Whiteboard pointer-down: tool-dependent create / draw ────────────────────
  const onWellPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // Only react to primary-button (left) presses. Right/middle clicks are owned
      // by the browser context-menu path (onWellContextMenu) — letting them through
      // would erase/create/move on a right-press and clear the selection on a
      // right-click on empty space, undermining the BUG-013 context-menu fix.
      if (e.button !== 0) return
      // In select mode, only react to a press on the EMPTY well (element presses
      // are owned by the cards). In a DRAW mode the press may have fallen through
      // a card (cards no longer stop it — #6), so proceed regardless of target and
      // let the well capture the whole gesture below.
      if (tool === 'select' && e.target !== e.currentTarget) return
      // An empty-well press focuses the well so the board-scoped letter shortcuts
      // (onKeyDown below) have a focus target. A press on a card focuses that card.
      if (e.target === e.currentTarget) e.currentTarget.focus()
      const p = toBoard(e)
      if (tool === 'select') {
        // Empty-well press → begin a marquee (Shift = additive). Selection is resolved
        // on pointer-up (a no-move click clears unless Shift) — see onWellPointerUp.
        drag.current = { mode: 'marquee', startX: p.x, startY: p.y, additive: e.shiftKey }
        setMarqueeRect({ x: p.x, y: p.y, w: 0, h: 0 })
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }

      if (tool === 'note') {
        beginChange()
        // Index off the least-used tint slot, not the live note count, so variety
        // survives deletions (#27).
        const note = makeNote(newId(), p, nextNoteIndex(elements))
        commit([...elements, note])
        setTool('select')
        return
      }
      if (tool === 'check') {
        beginChange()
        commit([...elements, makeChecklist(newId(), newId(), p)])
        setTool('select')
        return
      }
      if (tool === 'arrow') {
        const arrow = makeArrow(newId(), p)
        drag.current = { mode: 'arrow', id: arrow.id }
        setDraftArrow(arrow)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (tool === 'pen') {
        const points = pushBoardPoint([], p)
        drag.current = { mode: 'pen', points }
        setDraftStroke(points)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (tool === 'erase') {
        // Do NOT beginChange() here — an empty swipe must not push a phantom undo
        // snapshot (the move/draw paths defer for the same reason; WB-1 class). The
        // checkpoint is taken in onWellPointerUp only if something was erased.
        const removed = new Set<string>()
        for (const el of elements)
          if (!isLocked(el) && eraseHitTest(el, p, undefined, measuredRef.current))
            removed.add(el.id)
        drag.current = { mode: 'erase', removed }
        setPendingErase(new Set(removed))
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (tool === 'text') {
        // Do NOT beginChange() here — a no-movement tap must not push a phantom undo
        // snapshot (WB-1 discipline; checkpoint taken in onWellPointerUp on commit).
        // startX/Y = board-local anchor (for the committed element); sx/sy = screen-px press
        // origin (for the zoom-independent click-vs-drag threshold on pointer-up).
        drag.current = { mode: 'textbox', startX: p.x, startY: p.y, sx: e.clientX, sy: e.clientY }
        setDraftTextBox({ x: p.x, y: p.y, w: 0, h: 0 })
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      // select tool, empty press → place a text caret on double interactions is
      // handled per-element; a single empty press just does nothing here.
    },
    [tool, elements, commit, toBoard, beginChange, setTool, measuredRef]
  )

  const onWellPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      const p = toBoard(e)
      if (d.mode === 'move') {
        // Transient: render the dragged set shifted by the live delta; the store is
        // written once on pointer-up so undo stays one checkpoint (#9).
        let dx = Math.round(p.x - d.grabX)
        let dy = Math.round(p.y - d.grabY)
        if (snapEnabled) {
          // Snap the moving set's union box to static neighbors' edges/centers, in
          // board-local px (zoom-stable). Bias the raw delta + surface the guide lines.
          const moving = new Set(d.ids)
          const movingUnion = unionBBox(
            d.ids
              .map((mid) => elements.find((el) => el.id === mid))
              .filter((el): el is PlanningElement => !!el)
              .map((el) => {
                const b = elementBBox(el, measuredRef.current.get(el.id))
                return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }
              })
          )
          const statics = elements
            .filter((el) => !moving.has(el.id))
            .map((el) => elementBBox(el, measuredRef.current.get(el.id)))
          const snap = computeSnap(movingUnion, statics, SNAP_TOL)
          dx += snap.dx
          dy += snap.dy
          setSnapGuides(snap.guides.length > 0 ? snap.guides : null)
        } else {
          // Snap toggled OFF mid-drag → clear any guides on the very next move frame
          // (don't wait for pointer-up to stop showing stale guides).
          setSnapGuides(null)
        }
        setDragPos({ ids: d.ids, dx, dy, alt: d.alt })
      } else if (d.mode === 'arrow') {
        setDraftArrow((a) => (a ? { ...a, x2: p.x, y2: p.y } : a))
      } else if (d.mode === 'pen') {
        d.points = pushBoardPoint(d.points, p)
        setDraftStroke(d.points)
      } else if (d.mode === 'erase') {
        let grew = false
        for (const el of elements) {
          if (
            !d.removed.has(el.id) &&
            !isLocked(el) &&
            eraseHitTest(el, p, undefined, measuredRef.current)
          ) {
            d.removed.add(el.id)
            grew = true
          }
        }
        if (grew) setPendingErase(new Set(d.removed))
      } else if (d.mode === 'marquee') {
        setMarqueeRect(rectFromPoints(d.startX, d.startY, p.x, p.y))
      } else if (d.mode === 'textbox') {
        setDraftTextBox(rectFromPoints(d.startX, d.startY, p.x, p.y))
      }
    },
    [toBoard, elements, snapEnabled, measuredRef]
  )

  // Double-click empty whiteboard in select mode → drop a free-text element.
  // stopPropagation keeps it from triggering the canvas double-click focus.
  const onWellDoubleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      // A dblclick that originated inside this board's well is NEVER a canvas-focus
      // gesture, so always stop it from bubbling to React Flow's onNodeDoubleClick
      // (#40). The select+bare-well check then only decides whether to also drop a
      // free-text element.
      e.stopPropagation()
      if (tool !== 'select' || e.target !== e.currentTarget) return
      beginChange()
      commit([...elements, makeText(newId(), toBoard(e))])
    },
    [tool, elements, commit, toBoard, beginChange]
  )

  // Right-click a whiteboard element (W3) → open the element context menu at the raw
  // pointer screen coords. Select-then-act: a right-click on an UNSELECTED element
  // selects just it; a right-click on one already in a multi-selection keeps the set.
  const onWellContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      const p = toBoard(e)
      // Topmost hit under the cursor (later elements render above; reuse the erase
      // hit-test, which already covers every kind incl. arrows/strokes).
      const hits = elements.filter((el) => eraseHitTest(el, p, undefined, measuredRef.current))
      const targetId = hits.length > 0 ? hits[hits.length - 1].id : null
      // Compute the EFFECTIVE selection synchronously (React state is async, so we can't
      // read it back after setSelectedIds): a right-click on an element already in the
      // set keeps the set; otherwise it becomes just that element.
      const base = targetId && !selectedIds.has(targetId) ? new Set([targetId]) : selectedIds
      // Expand through groups so right-clicking a GROUPED element acts on (and selects)
      // the whole group — otherwise a one-element selection greys out Align/Distribute/
      // Group even though the element belongs to a multi-element group (the W3 bug).
      // When targetId is null (right-click on empty space) we must NOT expand through
      // groups: the user's partial group selection (e.g. only A of grouped {A,B}) must
      // stay partial. Expanding on an empty-space right-click silently pulls in the
      // un-selected sibling B, and the context menu Delete then removes it even though
      // the user never explicitly selected B (BUG-013). The element context menu is only
      // meaningful when a concrete element was targeted; skip it entirely on empty-space
      // clicks so the existing selection state is left unchanged.
      if (targetId === null) return
      const effective = expandGroups(elements, base)
      if (effective.size !== selectedIds.size || !selectedIds.has(targetId)) {
        setSelectedIds(effective)
      }
      // Open only if there will be something to act on.
      if (effective.size > 0) {
        setContextMenu({ x: e.clientX, y: e.clientY, entries: buildMenuEntries(effective) })
      }
    },
    [elements, toBoard, selectedIds, buildMenuEntries, setSelectedIds, setContextMenu, measuredRef]
  )

  const onWellPointerUp = useCallback(
    (e?: PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      drag.current = null
      if (!d) return
      if (d.mode === 'move') {
        // Checkpoint + commit the final position ONCE, and only if the set actually
        // moved (dragPos set on the first move frame). A zero-movement grab leaves
        // dragPos null → no snapshot, no future-wipe (#11). The whole drag is a single
        // undo checkpoint (#9), even when the set has many elements.
        const pos = dragPos
        setDragPos(null)
        setSnapGuides(null)
        if (pos && (pos.dx !== 0 || pos.dy !== 0)) {
          beginChange()
          if (pos.alt) {
            // Alt-drag → clone the moving set at the drop offset; originals stay put.
            // Reselect the copies so a follow-on gesture acts on the new elements.
            const { elements: withCopies, newIds } = duplicateElements(
              elements,
              pos.ids,
              pos.dx,
              pos.dy,
              newId
            )
            commit(withCopies)
            setSelectedIds(new Set(newIds))
          } else {
            commit(translateMany(elements, pos.ids, pos.dx, pos.dy))
          }
        }
      } else if (d.mode === 'arrow') {
        const a = draftArrow
        setDraftArrow(null)
        // Discard a degenerate (no-drag) arrow. Checkpoint ONLY when we actually commit,
        // so a tap-without-drag pushes no phantom undo snapshot (WB-1; mirrors move).
        if (a && (Math.abs(a.x2 - a.x) > 4 || Math.abs(a.y2 - a.y) > 4)) {
          beginChange()
          commit([...elements, a])
        }
        setTool('select')
      } else if (d.mode === 'pen') {
        const pts = d.points
        setDraftStroke(null)
        if (pts.length >= 4) {
          beginChange()
          commit([...elements, makeStroke(newId(), pts)])
        }
        setTool('select')
      } else if (d.mode === 'erase') {
        const removed = d.removed
        setPendingErase(null)
        if (removed.size > 0) {
          // One checkpoint for the whole swipe (phantom-undo discipline).
          beginChange()
          commit(elements.filter((el) => !removed.has(el.id)))
        }
      } else if (d.mode === 'marquee') {
        // No pointer event in scope here — read the box from marqueeRect (updated on
        // every move). Selection is ephemeral (never serialized) → ZERO checkpoints.
        const rect = marqueeRect ?? { x: d.startX, y: d.startY, w: 0, h: 0 }
        setMarqueeRect(null)
        const moved = rect.w > 2 || rect.h > 2
        if (moved) {
          const hits = marqueeHits(elements, rect, measuredRef.current)
          setSelectedIds((prev) => {
            if (!d.additive) return new Set(hits)
            const next = new Set(prev)
            for (const id of hits) next.add(id)
            return next
          })
        } else if (!d.additive) {
          // A bare click on the empty well (no drag, no Shift) clears the selection.
          clearSel()
        }
      } else if (d.mode === 'textbox') {
        // Read the live box from draftTextBox (updated on every move frame, like marqueeRect).
        // Checkpoint ONLY when committing (WB-1 discipline — phantom-undo prevention).
        const box = draftTextBox
        setDraftTextBox(null)
        // Click-vs-drag on SCREEN-px travel (down→up), not board-px: toBoard divides by camera
        // zoom, so a board-px threshold drifts with zoom (a small jitter at zoom 0.5x would
        // spawn area text). 4px in screen space is zoom-independent. width/fontSize below stay
        // board-px (the wrap box + size token are board-space quantities).
        const moved = !!box && !!e && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4
        if (moved && box) {
          // Area text: top-left anchor from rectFromPoints' normalized rect, width drives
          // wrap, height maps to the nearest size token.
          beginChange()
          const el = makeText(
            newId(),
            { x: box.x, y: box.y },
            {
              width: Math.max(MIN_TEXT_WIDTH_PX, box.w),
              fontSize: tokenFromHeight(box.h)
            }
          )
          commit([...elements, el])
          setSelectedIds(new Set([el.id]))
        } else {
          // Click (no drag): point text at the press origin, default size. Use d.startX/Y
          // (board-local grab) rather than the draft box so accuracy is preserved even
          // if the board has been panned between down and up.
          beginChange()
          commit([...elements, makeText(newId(), { x: d.startX, y: d.startY })])
        }
        setTool('select')
      }
    },
    [
      draftArrow,
      draftTextBox,
      dragPos,
      commit,
      elements,
      beginChange,
      marqueeRect,
      clearSel,
      measuredRef,
      setSelectedIds,
      setTool
    ]
  )

  const onWellPointerCancel = useCallback(() => {
    // An OS pointer-cancel (palm/stylus/system gesture) mid-erase must NOT commit a
    // destructive delete the user never finished — discard the in-flight swipe. Other
    // gestures (move/arrow/pen) keep their existing pointer-up behavior on cancel.
    // Always drop any live snap guides so they never linger past a cancelled move.
    setSnapGuides(null)
    if (drag.current?.mode === 'erase') {
      drag.current = null
      setPendingErase(null)
      return
    }
    if (drag.current?.mode === 'marquee') {
      drag.current = null
      setMarqueeRect(null)
      return
    }
    if (drag.current?.mode === 'textbox') {
      drag.current = null
      setDraftTextBox(null)
      return
    }
    onWellPointerUp()
  }, [onWellPointerUp])

  return {
    startElementDrag,
    onWellPointerDown,
    onWellPointerMove,
    onWellDoubleClick,
    onWellContextMenu,
    onWellPointerUp,
    onWellPointerCancel,
    draftArrow,
    draftStroke,
    dragPos,
    marqueeRect,
    draftTextBox,
    pendingErase,
    snapGuides
  }
}
