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
import { useCallback, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import type {
  ArrowElement,
  ChecklistElement,
  NoteElement,
  NoteTint,
  PlanningElement,
  PlanningBoard as PlanningBoardData,
  StrokeElement,
  TextElement
} from '../../lib/boardSchema'
import { useCanvasStore } from '../../store/canvasStore'
import { screenToBoard, screenScale } from '../../lib/pen'
import { BoardFrame } from '../BoardFrame'
import type { BoardViewProps } from '../BoardNode'
import { NoteCard } from './planning/NoteCard'
import { FreeText } from './planning/FreeText'
import { TextToolbar, type TextStylePatch } from './planning/TextToolbar'
import { SIZE_PX, tokenFromHeight } from './planning/textStyle'
import { ChecklistCard } from './planning/ChecklistCard'
import { ImageCard } from './planning/ImageCard'
import { WhiteboardSvg } from './planning/WhiteboardSvg'
import { shortcutTool, type PlanTool } from './planning/tools'
import {
  patchElement,
  translateMany,
  removeElement,
  toggleItem,
  addItem,
  removeItem,
  setItemLabel,
  isLocked,
  expandGroups,
  setNoteTint
} from './planning/elements'
import { buildContextMenuEntries } from './planning/contextMenuEntries'
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'
import { usePlanningPointer } from './planning/usePlanningPointer'
import { usePlanningImageIO } from './planning/usePlanningImageIO'
import { PlanningToolbar } from './planning/PlanningToolbar'

const newId = (): string => crypto.randomUUID()

export function PlanningBoard({
  board,
  selected,
  hovered,
  dimmed,
  onFull,
  onDuplicate,
  onDelete,
  onAddToGroup,
  onRemoveFromGroup,
  onStartConnect
}: BoardViewProps<PlanningBoardData>): ReactElement {
  const updateBoard = useCanvasStore((s) => s.updateBoard)
  const beginChange = useCanvasStore((s) => s.beginChange)
  // Live camera zoom for the ÷zoom screen→board mapping (handoff 2.3).
  const zoom = useStore((s) => s.transform[2])

  const [tool, setTool] = useState<PlanTool>('select')
  // In-board snapping (W2.2): edge/center alignment to neighbors while dragging.
  // Default ON, toggled by the snap pill; guides are transient (session-only).
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  // Ephemeral editing state — tracks which free-text element has its textarea focused.
  // NEVER serialized (scene/session split); cleared on blur, set on focus.
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
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
  // BUG-052: ref that mirrors the live dragPos from usePlanningPointer so
  // growForChecklist can gate on it without a forward-reference (the useCallback
  // is defined before usePlanningPointer is called in the component body).
  const dragPosRef = useRef<{ ids: string[]; dx: number; dy: number; alt: boolean } | null>(null)
  const elements = board.elements

  // Right-click element context menu (W3): raw screen coords + the entries built at
  // open time (so the ref-reading builder runs in the event handler, not render —
  // react-hooks/refs); null when closed.
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    entries: MenuEntry[]
  } | null>(null)

  // Live DOM sizes (board-local px) for the auto-sized kinds (text, checklist), fed by
  // the cards. Refines elementBBox for marquee/snap; a plain ref (no re-render needed —
  // reads happen at gesture time). Stale-on-first-frame is bounded by elementBBox's nominal fallback.
  const measuredRef = useRef<Map<string, { w: number; h: number }>>(new Map())
  const reportMeasure = useCallback((id: string, w: number, h: number) => {
    measuredRef.current.set(id, { w, h })
  }, [])

  /** Commit elements to the store. Pass a new array OUTRIGHT, or — for ops that must
   *  survive a sibling op landing in the same scheduling window — a transform
   *  `(current) => next`. `updateBoard` REPLACES `elements` (no merge), so a callback
   *  that pre-computes `next` from the render-time `elements` closure silently drops a
   *  mutation that committed before React refreshed the closure (BUG-023 lost update).
   *  The transform form re-reads the LIVE elements at commit time, so two rapid ops
   *  chain instead of clobbering. Mirrors addImageFromBlob's getState() discipline. */
  const commit = useCallback(
    (next: PlanningElement[] | ((current: PlanningElement[]) => PlanningElement[])) => {
      if (typeof next === 'function') {
        const live = useCanvasStore.getState().boards.find((b) => b.id === board.id)
        const cur = live?.type === 'planning' ? live.elements : []
        updateBoard(board.id, { elements: next(cur) })
      } else {
        updateBoard(board.id, { elements: next })
      }
    },
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

  // Image paste/drop pipeline (god-file split 6.3): the document-level clipboard
  // listener + file-drop handlers + the asset.write→element commit live in the hook;
  // only the two drag handlers (wired onto the well below) are surfaced.
  const { onWellDragOver, onWellDrop } = usePlanningImageIO({
    wellRef,
    toBoard,
    commit,
    beginChange,
    board
  })

  // ── Element-level handlers (passed to the element components) ────────────────
  const interactive = tool === 'select'

  const setNoteText = useCallback(
    (id: string, text: string) =>
      commit(patchElement<NoteElement>(elements, id, (n) => ({ ...n, text }))),
    [commit, elements]
  )
  // Live-read transform (not the render-time `elements` closure): a text edit and a
  // typography patch from the toolbar can land in the same window, and the closure form
  // would replace `elements` from a stale snapshot, dropping the typography change (BUG-023).
  const setTextText = useCallback(
    (id: string, text: string) =>
      commit((cur) => patchElement<TextElement>(cur, id, (t) => ({ ...t, text }))),
    [commit]
  )
  // Typography patch from the floating TextToolbar — one undo step, live-read transform
  // (so it can't clobber a concurrent text edit landing in the same window; BUG-023 class).
  const onTextPatch = useCallback(
    (id: string, partial: TextStylePatch) => {
      // Bail if the element vanished between the toolbar's render and this click (eraser,
      // blur-prune, concurrent delete) so beginChange() never pushes an empty checkpoint
      // for a patch that would no-op (#BUG M3 phantom-undo class).
      const live = useCanvasStore.getState().boards.find((b) => b.id === board.id)
      const els = live?.type === 'planning' ? live.elements : []
      if (!els.some((e) => e.id === id)) return
      beginChange()
      commit((cur) => patchElement<TextElement>(cur, id, (t) => ({ ...t, ...partial })))
    },
    [beginChange, commit, board.id]
  )
  // D3-A hover-swatch tint: exactly one undo step, live-read transform. Bail BEFORE
  // beginChange when the note vanished / is locked / already has the tint, so a no-op
  // click never arms a checkpoint (#BUG M3 phantom-undo class — onTextPatch pattern).
  const setTint = useCallback(
    (id: string, tint: NoteTint) => {
      const live = useCanvasStore.getState().boards.find((b) => b.id === board.id)
      const els = live?.type === 'planning' ? live.elements : []
      const el = els.find((e) => e.id === id)
      if (!el || el.kind !== 'note' || isLocked(el) || el.tint === tint) return
      beginChange()
      commit((cur) => setNoteTint(cur, [id], tint))
    },
    [beginChange, commit, board.id]
  )
  const deleteEl = useCallback(
    (id: string) => {
      const el = elements.find((x) => x.id === id)
      if (el && isLocked(el)) return // locked resists the per-element X (closes the prior bypass)
      beginChange()
      commit(removeElement(elements, id))
    },
    [beginChange, commit, elements]
  )

  // Checklist mutators commit via the live-read transform (not the render-time
  // `elements` closure) so two rapid toggles/appends/removes — key-repeat, a fast
  // double-click — chain instead of the second clobbering the first (BUG-023).
  const toggle = useCallback(
    (elId: string, itemId: string) => {
      beginChange()
      commit((cur) => toggleItem(cur, elId, itemId))
    },
    [beginChange, commit]
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
      commit((cur) => addItem(cur, elId, newId()))
    },
    [beginChange, commit]
  )
  const dropItem = useCallback(
    (elId: string, itemId: string) => {
      beginChange()
      commit((cur) => removeItem(cur, elId, itemId))
    },
    [beginChange, commit]
  )

  // Auto-grow the board so a tall checklist (its rows + "Add item" button) is
  // never clipped by the well's overflow:hidden (#12). Only ever grows; the
  // measured `bottom` is board-local (element.y + card height), so the board must
  // be tall enough for the titlebar + that bottom + a small margin.
  const TITLEBAR_H = 34
  const WELL_PAD = 14
  const growForChecklist = useCallback(
    (elId: string, bottom: number) => {
      // BUG-052: skip __ghost__ alt-drag copies and any element mid-drag — drag
      // positions are uncommitted, and growBoardHeight is untracked + only-grows,
      // so a cancelled/zero-net drag would permanently inflate the board height.
      if (elId.startsWith('__ghost__')) return
      if (dragPosRef.current?.ids.includes(elId)) return
      const needed = Math.ceil(bottom + TITLEBAR_H + WELL_PAD)
      // Untracked layout-only grow (#BUG-024): a measured content-fit bump is not a
      // user edit, so it routes through a dedicated store action that NEVER touches the
      // undo/redo rails — it can't push an undo checkpoint nor wipe an armed redo
      // branch. Only-grows; a no-op when the board is already tall enough.
      if (needed > board.h) useCanvasStore.getState().growBoardHeight(board.id, needed)
    },
    [board.id, board.h, dragPosRef]
  )

  // Build the right-click menu entries off an explicit selection set (the
  // post-select-then-act set; React state is async, so the handler can't read it back
  // — it passes the set in). The construction lives in planning/contextMenuEntries.ts
  // (verbatim extraction, D3-A); this wrapper threads the store callbacks + the well's
  // content box in. Called from the event handler (NOT render), so `measuredRef`
  // access is allowed (react-hooks/refs).
  const buildMenuEntries = useCallback(
    (sel: ReadonlySet<string>): MenuEntry[] =>
      buildContextMenuEntries({
        elements,
        sel,
        // Align/distribute reference the well's content box (board-local px) so edges
        // flush to the BOARD and results clamp inside it.
        wb: {
          w: wellRef.current?.offsetWidth || board.w,
          h: wellRef.current?.offsetHeight || board.h
        },
        measured: measuredRef.current,
        beginChange,
        commit,
        clearSel,
        setSelectedIds,
        newId
      }),
    [elements, beginChange, commit, clearSel, board.w, board.h]
  )

  // ── Whiteboard pointer state machine (Wave-5 B5 extraction) ──────────────────
  // The gesture handlers + transient gesture render-state live in usePlanningPointer;
  // the inputs it can't own (selection, store commit/undo, the well/measure refs, the
  // menu builder) are threaded in here.
  const {
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
    endpointDrag
  } = usePlanningPointer({
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
  })

  // Mirror dragPos into the ref so growForChecklist (defined earlier) reads it lazily.
  // useLayoutEffect, not useEffect: it must run BEFORE ChecklistCard's passive measure
  // effect in the same commit, so the first drag frame is gated and the drop commit
  // (dragPos -> null + committed y) re-fires measure with the ref already cleared.
  useLayoutEffect(() => void (dragPosRef.current = dragPos), [dragPos])

  // ── Tool cluster (BoardFrame actions) — selected-only ────────────────────────
  const actions = selected ? (
    <PlanningToolbar
      board={board}
      tool={tool}
      snapEnabled={snapEnabled}
      onPickTool={(t) => {
        setTool(t)
        clearSel()
      }}
      onToggleSnap={() => setSnapEnabled((v) => !v)}
    />
  ) : undefined

  // While a move is in flight, render the dragged element shifted by its transient
  // delta (the store still holds the pre-drag position until pointer-up — #9).
  // Any kind is movable now (cards + arrows + strokes), so derive the SVG vectors
  // from viewElements too so a dragged arrow/stroke tracks the cursor live (#28, #37).
  const movedView = dragPos ? translateMany(elements, dragPos.ids, dragPos.dx, dragPos.dy) : null
  // During a normal move the originals shift; during an ALT drag the originals stay
  // put and translated GHOST copies (temporary `__ghost__` ids, NEVER committed)
  // preview the duplicate. The captured pointer means onSelect/onDragStart never fire
  // on a ghost, and its id is dropped the instant the alt-drag ends.
  const ghostCopies =
    dragPos && dragPos.alt && movedView
      ? movedView
          .filter((e) => dragPos.ids.includes(e.id))
          .map((e) => ({ ...e, id: `__ghost__${e.id}` }) as PlanningElement)
      : []
  const baseView =
    dragPos && !dragPos.alt && movedView
      ? movedView
      : pendingErase && pendingErase.size > 0
        ? elements.filter((el) => !pendingErase.has(el.id))
        : elements
  const viewElements = [...baseView, ...ghostCopies]

  const arrows = viewElements.filter((e): e is ArrowElement => e.kind === 'arrow')
  const strokes = viewElements.filter((e): e is StrokeElement => e.kind === 'stroke')

  // The well captures the pen/arrow/place gestures; the draw tools also force a
  // crosshair cursor so the active mode is legible.
  const drawing = tool === 'arrow' || tool === 'pen'

  // The typography toolbar shows for exactly one selected free-text element (select tool
  // only). Derived here so the JSX stays flat (the file uses named consts, not IIFEs).
  // From viewElements so it tracks a live drag; a ghost copy can never be in selectedIds.
  const selectedOne =
    interactive && selectedIds.size === 1
      ? (viewElements.find((e) => e.id === [...selectedIds][0]) ?? null)
      : null
  const selectedTextEl = selectedOne?.kind === 'text' ? selectedOne : null
  // Widen the toolbar gate: also show when a text element is being edited (focused),
  // even if its grip isn't selected. Gated on interactive so it stays invisible in
  // read-only / non-select-tool modes. The blur only clears editingTextId if it's the
  // one currently editing (cur === id guard) — avoids a stale clear when focus moves.
  const editingTextEl =
    editingTextId && interactive
      ? (viewElements.find((e): e is TextElement => e.id === editingTextId && e.kind === 'text') ??
        null)
      : null
  const toolbarTextEl = selectedTextEl ?? editingTextEl

  return (
    <BoardFrame
      type="planning"
      boardId={board.id}
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
      onAddToGroup={onAddToGroup}
      onRemoveFromGroup={onRemoveFromGroup}
      onStartConnect={onStartConnect}
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
        onContextMenu={onWellContextMenu}
        onDrop={onWellDrop}
        onDragOver={onWellDragOver}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0) {
            e.stopPropagation()
            e.preventDefault()
            // Group precedence then lock precedence: expand to whole groups, then keep
            // only the unlocked members (lock wins over group). One checkpoint, and
            // none if nothing was removable.
            const expanded = expandGroups(elements, selectedIds)
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
          guides={snapGuides}
          // Disable committed-vector hit-testing for ANY non-select tool (not just
          // pen/arrow) so a note/check placement over committed ink falls through
          // to onWellPointerDown and the element is placed where clicked (#4/BUG-022).
          drawing={tool !== 'select'}
          onSelect={(id, additive) => {
            selectOnPress(id, additive)
            wellRef.current?.focus()
          }}
          onDragStart={startElementDrag}
          endpointDrag={endpointDrag}
          onEndpointDragStart={startEndpointDrag}
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
                onMeasure={reportMeasure}
                onSetTint={setTint}
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
                onMeasure={reportMeasure}
                onEditingChange={(id, editing) =>
                  setEditingTextId((cur) => (editing ? id : cur === id ? null : cur))
                }
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
                onEditStart={beginChange}
                onMeasureBottom={growForChecklist}
                selected={selectedIds.has(el.id)}
                onSelect={selectOnPress}
                onMeasure={reportMeasure}
              />
            )
          }
          if (el.kind === 'image') {
            return (
              <ImageCard
                key={el.id}
                image={el}
                interactive={interactive}
                onDragStart={startElementDrag}
                selected={selectedIds.has(el.id)}
                onSelect={selectOnPress}
              />
            )
          }
          return null
        })}

        {/* Typography toolbar — sibling to the cards, board-local coords (see toolbarTextEl).
            Shows when a text element is selected (grip) OR being edited (focused textarea). */}
        {toolbarTextEl && (
          <TextToolbar
            element={toolbarTextEl}
            boardW={board.w}
            onPatch={(partial) => onTextPatch(toolbarTextEl.id, partial)}
          />
        )}

        {/* Draft text-box preview: dashed rectangle + live size letter while dragging the text tool. */}
        {draftTextBox && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              left: draftTextBox.x,
              top: draftTextBox.y,
              width: Math.max(1, draftTextBox.w),
              height: Math.max(1, draftTextBox.h),
              border: '1.5px dashed var(--accent)',
              borderRadius: 'var(--r-inner)',
              background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
              display: 'grid',
              placeItems: 'center',
              pointerEvents: 'none',
              color: 'color-mix(in srgb, var(--accent) 85%, transparent)',
              // Decorative serif glyph (reads as a "ghost" size indicator, per the wireframe);
              // explicit so it doesn't inherit the surrounding UI sans by accident.
              fontFamily: 'Georgia, "Times New Roman", serif',
              fontWeight: 700,
              lineHeight: 1,
              fontSize: SIZE_PX[tokenFromHeight(draftTextBox.h)]
            }}
          >
            A
          </div>
        )}

        {elements.length === 0 && (
          <div
            className="t-meta"
            style={{
              position: 'absolute',
              left: 14,
              top: 12,
              color: 'var(--text-3)', // D0-2: a readable hint — faint is disabled-only
              pointerEvents: 'none'
            }}
          >
            {selected ? 'pick a tool above · note · check · arrow · pen · erase' : 'empty plan'}
          </div>
        )}
      </div>
      {contextMenu && (
        <ElementContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entries={contextMenu.entries}
          onClose={() => setContextMenu(null)}
        />
      )}
    </BoardFrame>
  )
}
