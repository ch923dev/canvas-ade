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
import { screenToBoard, pushBoardPoint } from '../../lib/pen'
import { BoardFrame, IconBtn } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { NoteCard } from './planning/NoteCard'
import { FreeText } from './planning/FreeText'
import { ChecklistCard } from './planning/ChecklistCard'
import { WhiteboardSvg } from './planning/WhiteboardSvg'
import {
  makeArrow,
  makeChecklist,
  makeNote,
  makeStroke,
  makeText,
  nextNoteIndex,
  patchElement,
  translateElement,
  removeElement,
  toggleItem,
  addItem,
  removeItem,
  setItemLabel
} from './planning/elements'

/** The whiteboard tools (board-internal; distinct from the dock add-board tool). */
type PlanTool = 'select' | 'note' | 'check' | 'arrow' | 'pen'

const TOOLS: ReadonlyArray<{
  tool: PlanTool
  icon: 'select' | 'note' | 'check' | 'arrow' | 'pen'
}> = [
  { tool: 'select', icon: 'select' },
  { tool: 'note', icon: 'note' },
  { tool: 'check', icon: 'check' },
  { tool: 'arrow', icon: 'arrow' },
  { tool: 'pen', icon: 'pen' }
]

const newId = (): string => crypto.randomUUID()

export function PlanningBoard({
  board,
  selected,
  hovered,
  dimmed
}: BoardViewProps<PlanningBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  // Live camera zoom for the ÷zoom screen→board mapping (handoff 2.3).
  const zoom = useStore((s) => s.transform[2])

  const [tool, setTool] = useState<PlanTool>('select')
  const [selectedElId, setSelectedElId] = useState<string | null>(null)
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
  const [dragPos, setDragPos] = useState<{ id: string; dx: number; dy: number } | null>(null)
  // Active drag (an element move, an arrow, or a pen stroke) → captured pointer.
  // A move records the grab point in board space so the delta = pointer − grab.
  const drag = useRef<
    | { mode: 'move'; id: string; grabX: number; grabY: number }
    | { mode: 'arrow'; id: string }
    | { mode: 'pen'; points: number[] }
    | null
  >(null)

  /** Commit a new elements array to the store. */
  const commit = useCallback(
    (next: PlanningElement[]) => updateBoard(board.id, { elements: next }),
    [board.id, updateBoard]
  )

  /** Map a pointer event to a board-local point using the well's screen origin. */
  const toBoard = useCallback(
    (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const r = wellRef.current?.getBoundingClientRect()
      return screenToBoard(
        { x: e.clientX, y: e.clientY },
        { originX: r?.left ?? 0, originY: r?.top ?? 0, zoom }
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
      if (needed > board.h) updateBoard(board.id, { h: needed })
    },
    [board.id, board.h, updateBoard]
  )

  // ── Element drag (select tool): grab → move in board-local space ─────────────
  const startElementDrag = useCallback(
    (e: PointerEvent, id: string) => {
      const el = elements.find((x) => x.id === id)
      if (!el) return
      // Do NOT checkpoint here: a zero-movement grab (plain click) would push a
      // no-op undo snapshot and wipe an armed redo branch (#11). The checkpoint is
      // taken lazily in onWellPointerUp, only if the move actually committed.
      const p = toBoard(e)
      // Record the grab point; the live delta is pointer − grab. Works for every
      // kind (cards + arrows + strokes) since we translate by delta (#28, #37).
      drag.current = { mode: 'move', id, grabX: p.x, grabY: p.y }
      // Capture on the WELL (not the card) so move/up route to the well handlers
      // even when the cursor leaves the card during a fast drag.
      wellRef.current?.setPointerCapture(e.pointerId)
    },
    [elements, toBoard]
  )

  // ── Whiteboard pointer-down: tool-dependent create / draw ────────────────────
  const onWellPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // In select mode, only react to a press on the EMPTY well (element presses
      // are owned by the cards). In a DRAW mode the press may have fallen through
      // a card (cards no longer stop it — #6), so proceed regardless of target and
      // let the well capture the whole gesture below.
      if (tool === 'select' && e.target !== e.currentTarget) return
      setSelectedElId(null)
      const p = toBoard(e)

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
        beginChange()
        const arrow = makeArrow(newId(), p)
        drag.current = { mode: 'arrow', id: arrow.id }
        setDraftArrow(arrow)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (tool === 'pen') {
        beginChange()
        const points = pushBoardPoint([], p)
        drag.current = { mode: 'pen', points }
        setDraftStroke(points)
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
        // Transient: render the dragged element shifted by the live delta; the
        // store is written once on pointer-up so undo stays one checkpoint (#9).
        setDragPos({ id: d.id, dx: Math.round(p.x - d.grabX), dy: Math.round(p.y - d.grabY) })
      } else if (d.mode === 'arrow') {
        setDraftArrow((a) => (a ? { ...a, x2: p.x, y2: p.y } : a))
      } else if (d.mode === 'pen') {
        d.points = pushBoardPoint(d.points, p)
        setDraftStroke(d.points)
      }
    },
    [toBoard]
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
      // Checkpoint + commit the final position ONCE, and only if the element
      // actually moved (dragPos set on the first move frame). A zero-movement grab
      // leaves dragPos null → no snapshot, no future-wipe (#11). The whole drag is
      // a single undo checkpoint (#9).
      const pos = dragPos
      setDragPos(null)
      if (pos && (pos.dx !== 0 || pos.dy !== 0)) {
        beginChange()
        commit(translateElement(elements, pos.id, pos.dx, pos.dy))
      }
    } else if (d.mode === 'arrow') {
      const a = draftArrow
      setDraftArrow(null)
      // Discard a degenerate (no-drag) arrow.
      if (a && (Math.abs(a.x2 - a.x) > 4 || Math.abs(a.y2 - a.y) > 4)) {
        commit([...elements, a])
      }
      setTool('select')
    } else if (d.mode === 'pen') {
      const pts = d.points
      setDraftStroke(null)
      if (pts.length >= 4) commit([...elements, makeStroke(newId(), pts)])
      setTool('select')
    }
  }, [draftArrow, dragPos, commit, elements, beginChange])

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
            setSelectedElId(null)
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
    ? translateElement(elements, dragPos.id, dragPos.dx, dragPos.dy)
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
    >
      <div
        ref={wellRef}
        className="pl-well"
        tabIndex={0}
        onPointerDown={onWellPointerDown}
        onPointerMove={onWellPointerMove}
        onPointerUp={onWellPointerUp}
        onPointerCancel={onWellPointerUp}
        onDoubleClick={onWellDoubleClick}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElId) {
            e.stopPropagation()
            e.preventDefault()
            beginChange()
            commit(removeElement(elements, selectedElId))
            setSelectedElId(null)
          }
        }}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          cursor: drawing ? 'crosshair' : tool === 'note' || tool === 'check' ? 'copy' : 'default',
          // 13px dot grid — finer than the canvas lattice, to read as a sketch
          // surface (DESIGN.md §7.3).
          backgroundImage: 'radial-gradient(var(--grid-dot) 1px, transparent 1px)',
          backgroundSize: '13px 13px',
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
          selectedId={selectedElId}
          drawing={drawing}
          onSelect={(id) => {
            setSelectedElId(id)
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
            {selected ? 'pick a tool above · note · check · arrow · pen' : 'empty plan'}
          </div>
        )}
      </div>
    </BoardFrame>
  )
}
