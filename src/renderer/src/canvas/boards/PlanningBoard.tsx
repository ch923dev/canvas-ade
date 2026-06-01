/**
 * Planning board content (Phase 2.3 — DESIGN.md §7.3). The whiteboard layer:
 * sticky notes, free text, SVG-bezier arrows, freehand pen (vendored
 * perfect-freehand), and the Checklist element. A mini tool cluster
 * (`select · note · check · arrow · pen`) shows in the BoardFrame action slot
 * ONLY while the board is selected; otherwise the board is just its content.
 *
 * Coordinate model: every element is stored in BOARD-LOCAL space (zoom-1 px from
 * the content well's top-left) on `board.elements`. Pointer interactions map the
 * screen position to board-local via `lib/pen.screenToBoard` (subtract the well's
 * on-screen origin, then ÷ camera zoom — the unit-tested mapping that keeps
 * strokes/notes under the cursor at any zoom). Edits persist immediately through
 * `store.updateBoard(board.id, { elements })`.
 *
 * Owns this file + everything under `boards/planning/`; the shared surface
 * (`BoardFrame`, schema, store) is consumed, never modified.
 */
import {
  useCallback,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactElement
} from 'react'
import { useStore } from '@xyflow/react'
import type {
  ArrowElement,
  ChecklistElement,
  NoteElement,
  PlanningElement,
  PlanningBoard as PlanningBoardData,
  StrokeElement,
  TextElement
} from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { screenToBoard, pushBoardPoint, screenScale } from '../../lib/pen'
import { BoardFrame, IconBtn } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { NoteCard } from './planning/NoteCard'
import { FreeText } from './planning/FreeText'
import { ChecklistCard } from './planning/ChecklistCard'
import { WhiteboardSvg } from './planning/WhiteboardSvg'
import { eraseHitTest } from './planning/erase'
import { rectFromPoints, marqueeHits } from './planning/marquee'
import { shortcutTool, type PlanTool } from './planning/tools'
import {
  makeArrow,
  makeChecklist,
  makeNote,
  makeStroke,
  makeText,
  nextNoteIndex,
  patchElement,
  translateMany,
  removeElement,
  toggleItem,
  addItem,
  removeItem,
  setItemLabel
} from './planning/elements'

const TOOLS: ReadonlyArray<{
  tool: PlanTool
  icon: 'select' | 'note' | 'check' | 'arrow' | 'pen' | 'erase'
}> = [
  { tool: 'select', icon: 'select' },
  { tool: 'note', icon: 'note' },
  { tool: 'check', icon: 'check' },
  { tool: 'arrow', icon: 'arrow' },
  { tool: 'pen', icon: 'pen' },
  { tool: 'erase', icon: 'erase' }
]

const newId = (): string => crypto.randomUUID()

export function PlanningBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete
}: BoardViewProps<PlanningBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  // Live camera zoom for the ÷zoom screen→board mapping (handoff 2.3).
  const zoom = useStore((s) => s.transform[2])

  const [tool, setTool] = useState<PlanTool>('select')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // Selection mutators (board-local, ephemeral — never serialized).
  const toggleSel = useCallback(
    (id: string) =>
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )
  const clearSel = useCallback(() => setSelectedIds(new Set()), [])
  // Select on element press: additive (Shift) toggles; plain press replaces the
  // set with just this element unless it is already in the selection (a press on
  // an already-selected element keeps the multi-selection — Figma drag grammar).
  const selectOnPress = useCallback(
    (id: string, additive: boolean) => {
      if (additive) toggleSel(id)
      else setSelectedIds((prev) => (prev.has(id) ? prev : new Set([id])))
    },
    [toggleSel]
  )
  const wellRef = useRef<HTMLDivElement>(null)
  const elements = board.elements

  // In-progress (uncommitted) gesture state — drawn as a draft until pointer-up.
  const [draftArrow, setDraftArrow] = useState<ArrowElement | null>(null)
  const [draftStroke, setDraftStroke] = useState<number[] | null>(null)
  // Transient element-move delta — rendered live during a drag, committed to the
  // store ONCE on pointer-up (mirrors the arrow/pen draft pattern) so a move is a
  // single undo checkpoint, not one mutation per frame (#9). A delta (not an
  // absolute top-left) so it translates EVERY kind uniformly, including arrows +
  // strokes which have no single top-left (#28, #37).
  const [dragPos, setDragPos] = useState<{ ids: string[]; dx: number; dy: number } | null>(null)
  // Active drag (an element move, an arrow, or a pen stroke) → captured pointer.
  // A move records the grab point in board space so the delta = pointer − grab.
  const drag = useRef<
    | { mode: 'move'; ids: string[]; grabX: number; grabY: number }
    | { mode: 'arrow'; id: string }
    | { mode: 'pen'; points: number[] }
    | { mode: 'erase'; removed: Set<string> }
    | { mode: 'marquee'; startX: number; startY: number; additive: boolean }
    | null
  >(null)
  // Live marquee box (board-local) while box-selecting; null when idle. Transient,
  // session-only (never serialized); resolved to a selection set on pointer-up.
  const [marqueeRect, setMarqueeRect] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null
  )

  // Ids the in-flight erase swipe has marked for deletion. While set, those
  // elements are hidden from the render (immediate feedback) and committed as ONE
  // checkpoint on pointer-up. Null when not erasing.
  const [pendingErase, setPendingErase] = useState<Set<string> | null>(null)

  /** Commit a new elements array to the store. */
  const commit = useCallback(
    (next: PlanningElement[]) => updateBoard(board.id, { elements: next }),
    [board.id, updateBoard]
  )

  /** Map a pointer event to a board-local point using the well's screen origin. */
  const toBoard = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const wellEl = wellRef.current
      const r = wellEl?.getBoundingClientRect()
      const scale = screenScale(r?.width ?? 0, wellEl?.offsetWidth ?? 0, zoom)
      return screenToBoard(
        { x: e.clientX, y: e.clientY },
        { originX: r?.left ?? 0, originY: r?.top ?? 0, zoom: scale }
      )
    },
    [zoom]
  )

  // ── Element-level handlers (passed to the element components) ────────────────
  const interactive = tool === 'select'

  const setNoteText = useCallback(
    (id: string, text: string) =>
      commit(patchElement<NoteElement>(elements, id, (n) => ({ ...n, text }))),
    [commit, elements]
  )
  const setTextText = useCallback(
    (id: string, text: string) =>
      commit(patchElement<TextElement>(elements, id, (t) => ({ ...t, text }))),
    [commit, elements]
  )
  const deleteEl = useCallback(
    (id: string) => {
      beginChange()
      commit(removeElement(elements, id))
    },
    [beginChange, commit, elements]
  )

  const toggle = useCallback(
    (elId: string, itemId: string) => {
      beginChange()
      commit(toggleItem(elements, elId, itemId))
    },
    [beginChange, commit, elements]
  )
  const setTitle = useCallback(
    (elId: string, title: string) =>
      commit(patchElement<ChecklistElement>(elements, elId, (c) => ({ ...c, title }))),
    [commit, elements]
  )
  const setItem = useCallback(
    (elId: string, itemId: string, label: string) =>
      commit(setItemLabel(elements, elId, itemId, label)),
    [commit, elements]
  )
  const appendItem = useCallback(
    (elId: string) => {
      beginChange()
      commit(addItem(elements, elId, newId()))
    },
    [beginChange, commit, elements]
  )
  const dropItem = useCallback(
    (elId: string, itemId: string) => {
      beginChange()
      commit(removeItem(elements, elId, itemId))
    },
    [beginChange, commit, elements]
  )

  // Auto-grow the board so a tall checklist (its rows + "Add item" button) is
  // never clipped by the well's overflow:hidden (#12). Only ever grows; the
  // measured `bottom` is board-local (element.y + card height), so the board must
  // be tall enough for the titlebar + that bottom + a small margin.
  const TITLEBAR_H = 34
  const WELL_PAD = 14
  const growForChecklist = useCallback(
    (_elId: string, bottom: number) => {
      const needed = Math.ceil(bottom + TITLEBAR_H + WELL_PAD)
      // Untracked layout-only grow (#BUG-024): a measured content-fit bump is not a
      // user edit, so it routes through a dedicated store action that NEVER touches the
      // undo/redo rails — it can't push an undo checkpoint nor wipe an armed redo
      // branch. Only-grows; a no-op when the board is already tall enough.
      if (needed > board.h) useCanvasStore.getState().growBoardHeight(board.id, needed)
    },
    [board.id, board.h]
  )

  // ── Element drag (select tool): grab → move in board-local space ─────────────
  const startElementDrag = useCallback(
    (e: PointerEvent, id: string) => {
      const el = elements.find((x) => x.id === id)
      if (!el) return
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
      const movingIds = sel.has(id) ? [...sel] : [id]
      const p = toBoard(e)
      // Record the grab point; the live delta is pointer − grab. Works for every
      // kind (cards + arrows + strokes) since we translate by delta (#28, #37).
      drag.current = { mode: 'move', ids: movingIds, grabX: p.x, grabY: p.y }
      // Capture on the WELL (not the card) so move/up route to the well handlers
      // even when the cursor leaves the card during a fast drag.
      wellRef.current?.setPointerCapture(e.pointerId)
    },
    [elements, toBoard, selectedIds]
  )

  // ── Whiteboard pointer-down: tool-dependent create / draw ────────────────────
  const onWellPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
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
        for (const el of elements) if (eraseHitTest(el, p)) removed.add(el.id)
        drag.current = { mode: 'erase', removed }
        setPendingErase(new Set(removed))
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      // select tool, empty press → place a text caret on double interactions is
      // handled per-element; a single empty press just does nothing here.
    },
    [tool, elements, commit, toBoard, beginChange]
  )

  const onWellPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      const p = toBoard(e)
      if (d.mode === 'move') {
        // Transient: render the dragged set shifted by the live delta; the store is
        // written once on pointer-up so undo stays one checkpoint (#9).
        setDragPos({ ids: d.ids, dx: Math.round(p.x - d.grabX), dy: Math.round(p.y - d.grabY) })
      } else if (d.mode === 'arrow') {
        setDraftArrow((a) => (a ? { ...a, x2: p.x, y2: p.y } : a))
      } else if (d.mode === 'pen') {
        d.points = pushBoardPoint(d.points, p)
        setDraftStroke(d.points)
      } else if (d.mode === 'erase') {
        let grew = false
        for (const el of elements) {
          if (!d.removed.has(el.id) && eraseHitTest(el, p)) {
            d.removed.add(el.id)
            grew = true
          }
        }
        if (grew) setPendingErase(new Set(d.removed))
      } else if (d.mode === 'marquee') {
        setMarqueeRect(rectFromPoints(d.startX, d.startY, p.x, p.y))
      }
    },
    [toBoard, elements]
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

  const onWellPointerUp = useCallback(() => {
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
      if (pos && (pos.dx !== 0 || pos.dy !== 0)) {
        beginChange()
        commit(translateMany(elements, pos.ids, pos.dx, pos.dy))
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
        const hits = marqueeHits(elements, rect) // → marqueeHits(elements, rect, measuredRef.current) in Task 8
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
    }
  }, [draftArrow, dragPos, commit, elements, beginChange, marqueeRect, clearSel])

  const onWellPointerCancel = useCallback(() => {
    // An OS pointer-cancel (palm/stylus/system gesture) mid-erase must NOT commit a
    // destructive delete the user never finished — discard the in-flight swipe. Other
    // gestures (move/arrow/pen) keep their existing pointer-up behavior on cancel.
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
    onWellPointerUp()
  }, [onWellPointerUp])

  // ── Tool cluster (BoardFrame actions) — selected-only ────────────────────────
  const actions = selected ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        padding: 2,
        background: 'var(--inset)',
        borderRadius: 'var(--r-inner)',
        border: '1px solid var(--border-subtle)',
        marginRight: 2
      }}
      // Keep tool clicks from starting the title-bar drag.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {TOOLS.map(({ tool: t, icon }) => (
        <IconBtn
          key={t}
          name={icon}
          title={t}
          size={15}
          active={tool === t}
          onClick={() => {
            setTool(t)
            clearSel()
          }}
        />
      ))}
    </div>
  ) : undefined

  // While a move is in flight, render the dragged element shifted by its transient
  // delta (the store still holds the pre-drag position until pointer-up — #9).
  // Any kind is movable now (cards + arrows + strokes), so derive the SVG vectors
  // from viewElements too so a dragged arrow/stroke tracks the cursor live (#28, #37).
  const viewElements = dragPos
    ? translateMany(elements, dragPos.ids, dragPos.dx, dragPos.dy)
    : pendingErase && pendingErase.size > 0
      ? elements.filter((el) => !pendingErase.has(el.id))
      : elements

  const arrows = viewElements.filter((e): e is ArrowElement => e.kind === 'arrow')
  const strokes = viewElements.filter((e): e is StrokeElement => e.kind === 'stroke')

  // The well captures the pen/arrow/place gestures; the draw tools also force a
  // crosshair cursor so the active mode is legible.
  const drawing = tool === 'arrow' || tool === 'pen'

  return (
    <BoardFrame
      type="planning"
      title={board.title}
      selected={selected}
      hovered={hovered}
      dimmed={dimmed}
      status={null}
      contentBg="var(--surface)"
      actions={actions}
      onFull={onFull}
      onDuplicate={onDuplicate}
      onDelete={onDelete}
    >
      <div
        ref={wellRef}
        className="pl-well"
        tabIndex={0}
        onPointerDown={onWellPointerDown}
        onPointerMove={onWellPointerMove}
        onPointerUp={onWellPointerUp}
        onPointerCancel={onWellPointerCancel}
        onDoubleClick={onWellDoubleClick}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
            e.stopPropagation()
            e.preventDefault()
            beginChange()
            commit(elements.filter((el) => !selectedIds.has(el.id)))
            clearSel()
            return
          }
          const next = shortcutTool(e.key, {
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            alt: e.altKey
          })
          if (next) {
            // Keep a handled tool key from also reaching the global Canvas
            // window-keydown handler. Our letters (s/n/c/a/p/e) don't collide with
            // today's bare-key globals (1/0/t), but the global typing-guard only
            // suppresses INPUT/TEXTAREA/contentEditable — NOT this focusable div — so
            // this native stop (React dispatches at the root container) future-proofs
            // against a new bare-letter global silently double-firing here.
            e.stopPropagation()
            e.preventDefault()
            setTool(next)
            clearSel()
          }
        }}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor:
            tool === 'erase'
              ? 'cell'
              : drawing
                ? 'crosshair'
                : tool === 'note' || tool === 'check'
                  ? 'copy'
                  : 'default',
          // 12px dot grid — finer than the canvas lattice, to read as a sketch
          // surface (DESIGN.md §7.3).
          backgroundImage: 'radial-gradient(var(--grid-dot) 1px, transparent 1px)',
          backgroundSize: '12px 12px',
          backgroundPosition: '6px 6px',
          // Tool gestures own this layer; React Flow node-drag stays on the title.
          touchAction: 'none'
        }}
      >
        {/* Vector layer (under the cards so cards stay clickable). */}
        <WhiteboardSvg
          boardId={board.id}
          arrows={arrows}
          strokes={strokes}
          draftArrow={draftArrow}
          draftStroke={draftStroke}
          selectedIds={selectedIds}
          marquee={marqueeRect}
          // Disable committed-vector hit-testing for ANY non-select tool (not just
          // pen/arrow) so a note/check placement over committed ink falls through
          // to onWellPointerDown and the element is placed where clicked (#4/BUG-022).
          drawing={tool !== 'select'}
          onSelect={(id, additive) => {
            selectOnPress(id, additive)
            wellRef.current?.focus()
          }}
          onDragStart={startElementDrag}
        />

        {/* DOM elements: notes, free text, checklists. */}
        {viewElements.map((el) => {
          if (el.kind === 'note') {
            return (
              <NoteCard
                key={el.id}
                note={el}
                interactive={interactive}
                onDragStart={startElementDrag}
                onChangeText={setNoteText}
                onDelete={deleteEl}
                onEditStart={beginChange}
                selected={selectedIds.has(el.id)}
                onSelect={selectOnPress}
              />
            )
          }
          if (el.kind === 'text') {
            return (
              <FreeText
                key={el.id}
                element={el}
                interactive={interactive}
                onDragStart={startElementDrag}
                onChangeText={setTextText}
                onDelete={deleteEl}
                onEditStart={beginChange}
                selected={selectedIds.has(el.id)}
                onSelect={selectOnPress}
              />
            )
          }
          if (el.kind === 'checklist') {
            return (
              <ChecklistCard
                key={el.id}
                element={el}
                interactive={interactive}
                onDragStart={startElementDrag}
                onToggle={toggle}
                onChangeTitle={setTitle}
                onChangeItem={setItem}
                onAddItem={appendItem}
                onRemoveItem={dropItem}
                onDelete={deleteEl}
                onEditStart={beginChange}
                onMeasureBottom={growForChecklist}
                selected={selectedIds.has(el.id)}
                onSelect={selectOnPress}
              />
            )
          }
          return null
        })}

        {elements.length === 0 && (
          <div
            className="t-meta"
            style={{
              position: 'absolute',
              left: 14,
              top: 12,
              color: 'var(--text-faint)',
              pointerEvents: 'none'
            }}
          >
            {selected ? 'pick a tool above · note · check · arrow · pen · erase' : 'empty plan'}
          </div>
        )}
      </div>
    </BoardFrame>
  )
}
