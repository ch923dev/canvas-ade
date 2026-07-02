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
import { pushBoardPoint, screenScale } from '../../../lib/pen'
import { useCanvasStore } from '../../../store/canvasStore'
import { showToast } from '../../../store/toastStore'
import { dropPlacement, grabAnchorOffset, resolveDropTarget } from './crossBoardDrag'
import { eraseHitTest } from './erase'
import { rectFromPoints, marqueeHits } from './marquee'
import { computeSnap, precomputeStatics, SNAP_TOL, type Guide, type StaticSnap } from './snapping'
import type { PlanTool } from './tools'
import type { MenuEntry } from './ElementContextMenu'
import {
  makeArrow,
  makeChecklist,
  makeDiagram,
  makeNote,
  makeStroke,
  makeText,
  nextNoteIndex,
  translateMany,
  elementBBox,
  unionBBox,
  isLocked,
  expandGroups,
  duplicateElements,
  setArrowEndpoint,
  type ArrowEnd
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
  /** Tracks the last board-local pointer position over the well (Phase 3 clipboard, §2.4) —
   *  the Ctrl+V paste anchor read by usePlanningKeyboard. Updated on EVERY well pointermove,
   *  including idle moves with no active gesture, so a paste lands under the cursor. */
  lastPointerRef: MutableRefObject<{ x: number; y: number } | null>
  /** This board's id (Phase 4 cross-board drag) — the SOURCE the hit-test rejects + the
   *  `transferElements` source on a foreign-well drop. */
  boardId: string
}

/**
 * Transient cross-board drag affordance (Phase 4 §3.C) — surfaced once the cursor leaves the
 * SOURCE well during a move, consumed by `CrossBoardDragGhost`. EPHEMERAL session state: it is
 * NEVER serialized, never routed into `elements[]`/`PATCHABLE_KEYS` (scene/session split). All
 * coordinates are SCREEN px (the ghost is a screen-fixed body portal).
 */
export interface CrossBoardDrag {
  /** The cursor position (anchors the count chip + the footprint offset). */
  cursor: { x: number; y: number }
  /** How many elements are being dragged (the chip label). */
  count: number
  /** The selection's union footprint in SCREEN px, plus the cursor's offset within it (the
   *  grab anchor, scaled) — so the outline tracks where the payload will land. */
  ghost: { w: number; h: number; offsetX: number; offsetY: number }
  /** The drop-target well's screen rect when over a valid foreign Planning board; else null
   *  (over the source / empty canvas / a non-planning board). */
  target: {
    boardId: string
    rect: { left: number; top: number; width: number; height: number }
  } | null
}

export interface PlanningPointerApi {
  startElementDrag: (e: PointerEvent, id: string) => void
  /** Begin dragging ONE endpoint of a selected arrow (D3-B endpoint editing). */
  startEndpointDrag: (e: PointerEvent, id: string, end: ArrowEnd) => void
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
  /** Live endpoint-drag preview (board-local); null when idle. Transient, never serialized. */
  endpointDrag: { id: string; end: ArrowEnd; x: number; y: number } | null
  /** Live cross-board drag affordance (Phase 4 §3.C); null unless a move has left this well.
   *  Rendered by CrossBoardDragGhost. Transient, never serialized. */
  crossBoardDrag: CrossBoardDrag | null
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
    setContextMenu,
    lastPointerRef,
    boardId
  } = deps

  const [snapGuides, setSnapGuides] = useState<Guide[] | null>(null)
  // Transient cross-board drag affordance (Phase 4 §3.C) — set once a move leaves this well,
  // read by CrossBoardDragGhost; null otherwise. Ephemeral, never serialized.
  const [crossBoardDrag, setCrossBoardDrag] = useState<CrossBoardDrag | null>(null)

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
  //
  // SLICE-004: a move also carries a lazily-built `snapCache` — the static (non-moving)
  // neighbors' bboxes + anchors, which are IDENTICAL for the whole single drag. Computed
  // once on the first move frame and reused across every frame, instead of rebuilding the
  // statics set + bboxes + anchors from scratch each pointermove (the per-frame allocation
  // + recompute hot spot). It is invalidated implicitly when the drag record is cleared on
  // pointer-up/cancel (a fresh drag starts with `snapCache: null`), and defensively rebuilt
  // if the `elements` reference changes mid-gesture (so a stale cache is impossible).
  const drag = useRef<
    | {
        mode: 'move'
        ids: string[]
        grabX: number
        grabY: number
        alt: boolean
        snapCache: { elements: PlanningElement[]; statics: StaticSnap[] } | null
        // Phase 4 cross-board drag (§4.3): the grab point's offset from the (mode-aware,
        // group-expanded, lock-filtered) selection's NOMINAL union top-left — IDENTICAL to the
        // basis `extractForTransfer` normalizes the payload against — plus that union's
        // board-local size for the ghost footprint. `count` is the mode-aware transferred-element
        // count (= `taken.length`, which on a COPY re-includes a group's locked members), so the
        // ghost chip matches the payload + toast — `ids.length` would under-count that case.
        // Fixed for the whole gesture (computed at grab). The drop adds grabOffset back so the
        // grabbed point lands under the cursor.
        transfer: {
          grabOffset: { x: number; y: number }
          unionW: number
          unionH: number
          count: number
        }
      }
    | { mode: 'arrow'; id: string }
    | { mode: 'arrowEnd'; id: string; end: ArrowEnd; sx: number; sy: number; moved: boolean }
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

  // Live endpoint-drag preview (D3-B): the board renders the arrow with this end
  // substituted (via setArrowEndpoint) so the bezier + arrowhead re-bow live, like
  // draftArrow. Committed ONCE on pointer-up; null when idle. Never serialized.
  const [endpointDrag, setEndpointDrag] = useState<{
    id: string
    end: ArrowEnd
    x: number
    y: number
  } | null>(null)

  // ── Cross-board drag hit-test (Phase 4 §3.C) ─────────────────────────────────
  // The board under the screen cursor, resolved to a foreign Planning well's drop target.
  // `document.elementFromPoint` ignores pointer-capture (it redirects EVENTS, not hit-testing)
  // AND the pointer-events:none ghost, so this works mid-drag. `closest('[data-planning-well]')`
  // climbs from whatever child the cursor is over (a card — incl. a DiagramCard, which carries
  // its own `data-board-id`, hence a DISTINCT well attribute) to the owning well. Returns the
  // resolved target board id + the well element (for its fresh rect/offsetWidth at drop), or
  // null over the source / empty canvas / a non-planning board.
  const hitTest = useCallback(
    (clientX: number, clientY: number): { boardId: string; wellEl: HTMLElement } | null => {
      // jsdom (unit tests) has no elementFromPoint → no hit-test, no cross-board target.
      if (typeof document.elementFromPoint !== 'function') return null
      const hit = document.elementFromPoint(clientX, clientY)
      const wellEl = hit?.closest<HTMLElement>('[data-planning-well]') ?? null
      const targetId = resolveDropTarget(
        wellEl?.getAttribute('data-planning-well') ?? null,
        boardId,
        useCanvasStore.getState().boards
      )
      return targetId && wellEl ? { boardId: targetId, wellEl } : null
    },
    [boardId]
  )

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
      // Phase 4 (§4.3): precompute the cross-board grab anchor ONCE here (the selection is
      // fixed for the gesture). The union is over the SAME set + at the SAME nominal sizes the
      // transfer engine normalizes against — mirror `extractForTransfer`'s `taken` exactly
      // (re-expand `movingIds` through groups, then drop locked on a MOVE) so the grabbed point
      // lands precisely under the cursor on drop. Alt (captured below) decides copy-vs-move.
      const alt = e.altKey
      const expandedForUnion = expandGroups(elements, movingIds)
      const taken = elements.filter((el) => expandedForUnion.has(el.id) && (alt || !isLocked(el)))
      const union = unionBBox(taken.map((el) => elementBBox(el)))
      // Record the grab point; the live delta is pointer − grab. Works for every
      // kind (cards + arrows + strokes) since we translate by delta (#28, #37).
      // Capture Alt at grab → an alt-drag duplicates rather than moves on pointer-up.
      // snapCache starts null and is filled on the first move frame (SLICE-004).
      drag.current = {
        mode: 'move',
        ids: movingIds,
        grabX: p.x,
        grabY: p.y,
        alt,
        snapCache: null,
        transfer: {
          grabOffset: grabAnchorOffset(p, union),
          unionW: union.w,
          unionH: union.h,
          count: taken.length
        }
      }
      // Capture on the WELL (not the card) so move/up route to the well handlers
      // even when the cursor leaves the card during a fast drag.
      wellRef.current?.setPointerCapture(e.pointerId)
    },
    [elements, toBoard, selectedIds, wellRef]
  )

  // ── Arrow endpoint drag (select tool, D3-B): grab a handle → move one end ────
  const startEndpointDrag = useCallback(
    (e: PointerEvent, id: string, end: ArrowEnd) => {
      if (e.button !== 0) return // right/middle: ignore, let contextmenu handle it
      const el = elements.find((x) => x.id === id)
      if (!el || el.kind !== 'arrow' || isLocked(el)) return
      // No checkpoint here — taken lazily on pointer-up, only if the endpoint
      // actually travelled (>4 screen px), so a tap on a handle pushes no phantom
      // undo snapshot (#11 / WB-1 discipline, mirrors move + arrow-create).
      // `moved` is tracked on the drag record (screen-px, zoom-independent like the
      // textbox threshold) so pointer-cancel/up can decide without a pointer event.
      drag.current = { mode: 'arrowEnd', id, end, sx: e.clientX, sy: e.clientY, moved: false }
      setEndpointDrag(
        end === 'start' ? { id, end, x: el.x, y: el.y } : { id, end, x: el.x2, y: el.y2 }
      )
      // Capture on the WELL (not the handle) so move/up route to the well handlers
      // even when the cursor leaves the handle during a fast drag.
      wellRef.current?.setPointerCapture(e.pointerId)
    },
    [elements, wellRef]
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
        // Select the fresh element so the inspector's Element section (typography/tint/appearance)
        // shows immediately — "create → its settings appear", matching the area-text path + Figma.
        setSelectedIds(new Set([note.id]))
        setTool('select')
        return
      }
      if (tool === 'check') {
        beginChange()
        const cl = makeChecklist(newId(), newId(), p)
        commit([...elements, cl])
        setSelectedIds(new Set([cl.id]))
        setTool('select')
        return
      }
      if (tool === 'diagram') {
        beginChange()
        const dg = makeDiagram(newId(), p)
        commit([...elements, dg])
        setSelectedIds(new Set([dg.id]))
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
      // Track the last in-well pointer position (board-local) for Ctrl+V paste placement
      // (Phase 3, §2.4). Computed on EVERY move — including idle moves with no active gesture,
      // which the `if (!d) return` below would otherwise skip — so a paste lands under the
      // cursor; usePlanningKeyboard reads this ref (board-center fallback while it is null).
      const p = toBoard(e)
      lastPointerRef.current = p
      const d = drag.current
      if (!d) return
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
          // The static set + its bboxes/anchors are IDENTICAL for the whole single
          // drag, so build them ONCE (here, on the first frame) and reuse the cache
          // across every subsequent frame instead of rebuilding from scratch each
          // pointermove (SLICE-004). Defensively rebuild if the `elements` reference
          // changed mid-gesture so a stale cache is impossible.
          if (!d.snapCache || d.snapCache.elements !== elements) {
            const staticBoxes = elements
              .filter((el) => !moving.has(el.id))
              .map((el) => elementBBox(el, measuredRef.current.get(el.id)))
            d.snapCache = { elements, statics: precomputeStatics(staticBoxes) }
          }
          const snap = computeSnap(movingUnion, d.snapCache.statics, SNAP_TOL)
          dx += snap.dx
          dy += snap.dy
          setSnapGuides(snap.guides.length > 0 ? snap.guides : null)
        } else {
          // Snap toggled OFF mid-drag → clear any guides on the very next move frame
          // (don't wait for pointer-up to stop showing stale guides).
          setSnapGuides(null)
        }
        setDragPos({ ids: d.ids, dx, dy, alt: d.alt })
        // Cross-board sub-mode (Phase 4 §3.C): the within-board preview above is UNCHANGED.
        // Once the cursor leaves the SOURCE well, surface the canvas-level ghost + hit-test a
        // foreign Planning well as the drop target. Inside the well (the common case) we clear
        // it — so within-board dragging never touches this state. The ghost is screen-fixed, so
        // everything here is in SCREEN px.
        const sourceRect = wellRef.current?.getBoundingClientRect()
        const cursorInside =
          !!sourceRect &&
          e.clientX >= sourceRect.left &&
          e.clientX <= sourceRect.right &&
          e.clientY >= sourceRect.top &&
          e.clientY <= sourceRect.bottom
        // Cross-board sub-mode runs only for a LAID-OUT well the cursor has LEFT. A zero-size
        // rect (jsdom unit tests, or a not-yet-measured well) is excluded so within-board
        // dragging is untouched there. (setState(null) bails when already null — no-op on every
        // in-well frame, so within-board drag stays allocation-free.)
        if (!sourceRect || sourceRect.width === 0 || sourceRect.height === 0 || cursorInside) {
          setCrossBoardDrag(null)
        } else {
          // The source well is laid out mid-gesture (offsetWidth > 0), so screenScale always
          // takes the measured ratio — the fallback (1) is dead-path here (and at drop, below).
          const s = screenScale(sourceRect.width, wellRef.current?.offsetWidth ?? 0, 1)
          const t = d.transfer
          const hit = hitTest(e.clientX, e.clientY)
          let target: CrossBoardDrag['target'] = null
          if (hit) {
            const r = hit.wellEl.getBoundingClientRect()
            target = {
              boardId: hit.boardId,
              rect: { left: r.left, top: r.top, width: r.width, height: r.height }
            }
          }
          setCrossBoardDrag({
            cursor: { x: e.clientX, y: e.clientY },
            count: d.transfer.count,
            ghost: {
              w: t.unionW * s,
              h: t.unionH * s,
              offsetX: t.grabOffset.x * s,
              offsetY: t.grabOffset.y * s
            },
            target
          })
        }
      } else if (d.mode === 'arrow') {
        setDraftArrow((a) => (a ? { ...a, x2: p.x, y2: p.y } : a))
      } else if (d.mode === 'arrowEnd') {
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true
        setEndpointDrag({ id: d.id, end: d.end, x: p.x, y: p.y })
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
    [toBoard, elements, snapEnabled, measuredRef, lastPointerRef, wellRef, hitTest]
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
        // Clear the cross-board ghost regardless of where we dropped (no-op if never set).
        setCrossBoardDrag(null)
        // Cross-board drop (Phase 4 §3.C) — branch on a FOREIGN Planning well FIRST: re-home
        // (or copy, on alt) through the shared engine and SKIP the within-board commit. Only
        // with a real pointer-up position (no `e` on an OS pointer-cancel → within-board).
        if (e) {
          const hit = hitTest(e.clientX, e.clientY)
          if (hit) {
            const rect = hit.wellEl.getBoundingClientRect()
            const at = dropPlacement({
              cursor: { x: e.clientX, y: e.clientY },
              targetRect: rect,
              targetLayoutWidth: hit.wellEl.offsetWidth,
              // Dead-path mid-drop (the target well is laid out → screenScale measures it).
              fallbackZoom: 1,
              grabOffset: d.transfer.grabOffset
            })
            const mode = d.alt ? 'copy' : 'move'
            // The engine's ONE undo step (no second beginChange/updateBoard path here).
            const { newIds } = useCanvasStore
              .getState()
              .transferElements(boardId, hit.boardId, d.ids, mode, at)
            if (newIds.length > 0) {
              // A move removed the source ids → the stale selection must drop (a copy leaves
              // the originals selected). Then the same confirmation toast as the other triggers
              // (Q3) — sans the Focus action, which is moot for a drag (the target is on-screen,
              // under the cursor you just dropped at; the picker keeps Focus for its off-screen case).
              if (mode === 'move') clearSel()
              const title =
                useCanvasStore.getState().boards.find((b) => b.id === hit.boardId)?.title ??
                'planning board'
              showToast({
                message: `${mode === 'move' ? 'Moved' : 'Copied'} ${newIds.length} item${
                  newIds.length === 1 ? '' : 's'
                } to ${title}`
              })
            }
            return // handled cross-board — do NOT also run the within-board commit
          }
        }
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
          // Select the committed arrow so its Appearance controls (stroke/opacity/z-order) show.
          setSelectedIds(new Set([a.id]))
        }
        setTool('select')
      } else if (d.mode === 'arrowEnd') {
        const ep = endpointDrag
        setEndpointDrag(null)
        // Commit ONCE, only if the pointer actually travelled (>4 screen px) and the
        // arrow still exists — a tap pushes no phantom undo step, and a mid-drag
        // delete (eraser can't run concurrently, but defensive) commits nothing.
        if (d.moved && ep && elements.some((el) => el.id === ep.id && el.kind === 'arrow')) {
          beginChange()
          commit(setArrowEndpoint(elements, ep.id, ep.end, ep.x, ep.y))
        }
      } else if (d.mode === 'pen') {
        const pts = d.points
        setDraftStroke(null)
        if (pts.length >= 4) {
          beginChange()
          const st = makeStroke(newId(), pts)
          commit([...elements, st])
          setSelectedIds(new Set([st.id]))
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
          const t = makeText(newId(), { x: d.startX, y: d.startY })
          commit([...elements, t])
          setSelectedIds(new Set([t.id]))
        }
        setTool('select')
      }
    },
    [
      draftArrow,
      draftTextBox,
      dragPos,
      endpointDrag,
      commit,
      elements,
      beginChange,
      marqueeRect,
      clearSel,
      measuredRef,
      setSelectedIds,
      setTool,
      hitTest,
      boardId
    ]
  )

  const onWellPointerCancel = useCallback(() => {
    // An OS pointer-cancel (palm/stylus/system gesture) mid-erase must NOT commit a
    // destructive delete the user never finished — discard the in-flight swipe. Other
    // gestures (move/arrow/pen) keep their existing pointer-up behavior on cancel.
    // Always drop any live snap guides + the cross-board ghost so neither lingers past a
    // cancelled move (the move fall-through to onWellPointerUp clears the ghost too, but the
    // early-return modes below never set it, so this is the single belt-and-braces clear).
    setSnapGuides(null)
    setCrossBoardDrag(null)
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
    if (drag.current?.mode === 'arrowEnd') {
      // Discard the in-flight endpoint edit (the store still holds the committed
      // arrow) — an OS cancel mid-edit must not commit a half-finished change
      // (mirrors the marquee/textbox discard, not the move fall-through).
      drag.current = null
      setEndpointDrag(null)
      return
    }
    onWellPointerUp()
  }, [onWellPointerUp])

  return {
    startElementDrag,
    startEndpointDrag,
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
    snapGuides,
    endpointDrag,
    crossBoardDrag
  }
}
