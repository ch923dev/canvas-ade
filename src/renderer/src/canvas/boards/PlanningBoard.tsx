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
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
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
import { ImageCard } from './planning/ImageCard'
import { WhiteboardSvg } from './planning/WhiteboardSvg'
import { eraseHitTest } from './planning/erase'
import { rectFromPoints, marqueeHits } from './planning/marquee'
import { computeSnap, SNAP_TOL, type Guide } from './planning/snapping'
import { shortcutTool, type PlanTool } from './planning/tools'
import {
  makeArrow,
  makeChecklist,
  makeImage,
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
  setItemLabel,
  elementBBox,
  unionBBox,
  isLocked,
  expandGroups,
  duplicateElements,
  groupElements,
  ungroupElements,
  setLocked,
  fitImageSize,
  IMAGE_MAX
} from './planning/elements'
import {
  alignElements,
  distributeElements,
  type AlignEdge,
  type AlignBoard
} from './planning/align'
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'

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

/** Clipboard/file MIME → the ext the assets pipeline stores (undefined = not an image we accept). */
const imageExt = (type: string): string | undefined =>
  ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg'
  })[type]

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
  // In-board snapping (W2.2): edge/center alignment to neighbors while dragging.
  // Default ON, toggled by the snap pill; guides are transient (session-only).
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [snapGuides, setSnapGuides] = useState<Guide[] | null>(null)
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

  /** Persist an image blob and drop an image element at `at` (one undo step). */
  const addImageFromBlob = useCallback(
    async (blob: Blob, at: { x: number; y: number }): Promise<void> => {
      const ext = imageExt(blob.type)
      if (!ext) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const res = await window.api.asset.write(bytes, ext)
      if ('error' in res) return
      let w = IMAGE_MAX
      let h = IMAGE_MAX
      try {
        const bmp = await createImageBitmap(blob)
        const fit = fitImageSize(bmp.width, bmp.height)
        w = fit.w
        h = fit.h
        bmp.close()
      } catch {
        /* undecodable → keep the square fallback size */
      }
      beginChange()
      commit([...elements, makeImage(newId(), at, res.assetId, w, h)])
    },
    [beginChange, commit, elements]
  )

  /** Paste an image from the clipboard → board centre. Bound at the DOCUMENT level, not
   *  as the well's React onPaste: Chromium dispatches the `paste` event at the document
   *  (not the focused non-editable well), so an onPaste on the well never fires for a real
   *  Ctrl+V — only drag-drop reaches the well. We listen on the document and gate on this
   *  board's well owning focus, so Ctrl+V only lands an image on the board the user is
   *  working in (the Excalidraw/tldraw pattern). No image in the clipboard → we no-op
   *  without preventDefault, so a text paste into a focused note still proceeds normally. */
  const onWellPaste = useCallback(
    (e: ClipboardEvent): void => {
      const well = wellRef.current
      if (!well || !well.contains(document.activeElement)) return
      const data = e.clipboardData
      if (!data) return
      // A pasted bitmap can surface either as a DataTransferItem (kind 'file') OR only in
      // `.files` — which one depends on the OS/source. Check both so paste is robust.
      let file: File | null = null
      for (const it of data.items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          file = it.getAsFile()
          if (file) break
        }
      }
      if (!file) file = Array.from(data.files).find((f) => f.type.startsWith('image/')) ?? null
      if (!file) return
      e.preventDefault()
      const r = well.getBoundingClientRect()
      void addImageFromBlob(
        file,
        toBoard({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
      )
    },
    [addImageFromBlob, toBoard]
  )
  useEffect(() => {
    document.addEventListener('paste', onWellPaste)
    return () => document.removeEventListener('paste', onWellPaste)
  }, [onWellPaste])

  /** Allow a file drag over the well (required for onDrop to fire). */
  const onWellDragOver = useCallback((e: ReactDragEvent): void => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  }, [])

  /** Drop an image file → at the cursor (board-local). */
  const onWellDrop = useCallback(
    (e: ReactDragEvent): void => {
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      const file = Array.from(files).find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      void addImageFromBlob(file, toBoard(e))
    },
    [addImageFromBlob, toBoard]
  )

  // ── Export popover (W5) ──────────────────────────────────────────────────────
  // The popover is PORTALED to <body> (like BoardMenu): the title bar + board root
  // are `overflow:hidden`, so an in-place absolute popover is clipped invisible.
  const [exportOpen, setExportOpen] = useState(false)
  const exportTriggerRef = useRef<HTMLDivElement>(null)
  const [exportPos, setExportPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999
  })
  const runExport = useCallback(
    async (format: 'png' | 'svg') => {
      setExportOpen(false)
      try {
        const { buildExport } = await import('./planning/exportBoard')
        const { bytes, ext } = await buildExport(board, format)
        await window.api.export.save({ bytes, ext, defaultName: board.title || 'whiteboard' })
      } catch (err) {
        console.error('whiteboard export failed', err)
      }
    },
    [board]
  )
  useEffect(() => {
    if (!exportOpen) return
    const close = (): void => setExportOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExportOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [exportOpen])
  // Measure the trigger and right-align the portaled popover under it (clamped into
  // the viewport), before paint so it never flashes at a stale corner.
  useLayoutEffect(() => {
    if (!exportOpen) return
    const t = exportTriggerRef.current?.getBoundingClientRect()
    if (!t) return
    const W = 148
    const PAD = 8
    const left = Math.max(PAD, Math.min(t.right - W, window.innerWidth - W - PAD))
    setExportPos({ top: t.bottom + 4, left })
  }, [exportOpen])

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
      const el = elements.find((x) => x.id === id)
      if (el && isLocked(el)) return // locked resists the per-element X (closes the prior bypass)
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
        for (const el of elements) if (!isLocked(el) && eraseHitTest(el, p)) removed.add(el.id)
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
          if (!d.removed.has(el.id) && !isLocked(el) && eraseHitTest(el, p)) {
            d.removed.add(el.id)
            grew = true
          }
        }
        if (grew) setPendingErase(new Set(d.removed))
      } else if (d.mode === 'marquee') {
        setMarqueeRect(rectFromPoints(d.startX, d.startY, p.x, p.y))
      }
    },
    [toBoard, elements, snapEnabled]
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

  // Build the right-click menu entries off an explicit selection set (the
  // post-select-then-act set; React state is async, so the handler can't read it back
  // — it passes the set in). Every action is exactly ONE undo checkpoint via `run`
  // (beginChange + commit); the no-op-no-checkpoint discipline is delegated to the pure
  // transforms (align/distribute/group/etc. return the input by reference when there's
  // nothing to do) backed by disabling the entries below when they would be no-ops.
  // Called from the event handler (NOT render), so `measuredRef` access is allowed
  // (react-hooks/refs).
  const buildMenuEntries = useCallback(
    (sel: ReadonlySet<string>): MenuEntry[] => {
      const selEls = elements.filter((e) => sel.has(e.id))
      const allLocked = selEls.length > 0 && selEls.every(isLocked)
      const anyGrouped = selEls.some((e) => !!e.groupId)
      const groupIds = new Set(selEls.map((e) => e.groupId).filter(Boolean))
      const isOneGroup = sel.size >= 2 && groupIds.size === 1 && selEls.every((e) => !!e.groupId)
      const run = (next: PlanningElement[]): void => {
        beginChange()
        commit(next)
      }
      // Align/distribute reference the well's content box (board-local px) so edges
      // flush to the BOARD and results clamp inside it.
      const wb: AlignBoard = {
        w: wellRef.current?.offsetWidth || board.w,
        h: wellRef.current?.offsetHeight || board.h
      }
      const alignBtns = (
        ['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] as AlignEdge[]
      ).map((edge) => ({
        id: edge,
        title: `Align ${edge}`,
        icon: `align-${edge === 'centerX' ? 'center-h' : edge === 'centerY' ? 'middle' : edge}`,
        onSelect: () => run(alignElements(elements, sel, edge, wb, measuredRef.current))
      }))
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
              onSelect: () => run(distributeElements(elements, sel, 'h', wb, measuredRef.current))
            },
            {
              id: 'v',
              title: 'Distribute vertically',
              icon: 'distribute-v',
              onSelect: () => run(distributeElements(elements, sel, 'v', wb, measuredRef.current))
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
    },
    [elements, beginChange, commit, clearSel, board.w, board.h]
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
      const hits = elements.filter((el) => eraseHitTest(el, p))
      const targetId = hits.length > 0 ? hits[hits.length - 1].id : null
      // Compute the EFFECTIVE selection synchronously (React state is async, so we can't
      // read it back after setSelectedIds): a right-click on an element already in the
      // set keeps the set; otherwise it becomes just that element.
      const base = targetId && !selectedIds.has(targetId) ? new Set([targetId]) : selectedIds
      // Expand through groups so right-clicking a GROUPED element acts on (and selects)
      // the whole group — otherwise a one-element selection greys out Align/Distribute/
      // Group even though the element belongs to a multi-element group (the W3 bug).
      const effective = expandGroups(elements, base)
      if (effective.size !== selectedIds.size || (targetId && !selectedIds.has(targetId))) {
        setSelectedIds(effective)
      }
      // Open only if there will be something to act on.
      if (effective.size > 0) {
        setContextMenu({ x: e.clientX, y: e.clientY, entries: buildMenuEntries(effective) })
      }
    },
    [elements, toBoard, selectedIds, buildMenuEntries]
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
    }
  }, [draftArrow, dragPos, commit, elements, beginChange, marqueeRect, clearSel])

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
      <div
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: 'var(--border-subtle)',
          margin: '0 2px'
        }}
      />
      <IconBtn
        name="magnet"
        title={snapEnabled ? 'Snapping on' : 'Snapping off'}
        size={15}
        active={snapEnabled}
        onClick={() => setSnapEnabled((v) => !v)}
      />
      <div
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: 'var(--border-subtle)',
          margin: '0 2px'
        }}
      />
      <div ref={exportTriggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
        <IconBtn
          name="download"
          title="Export"
          size={15}
          active={exportOpen}
          onClick={() => setExportOpen((v) => !v)}
        />
        {exportOpen &&
          createPortal(
            <div
              role="menu"
              onPointerDown={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                top: exportPos.top,
                left: exportPos.left,
                zIndex: 50,
                width: 148,
                display: 'flex',
                flexDirection: 'column',
                padding: 4,
                background: 'var(--surface-overlay)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-inner)',
                boxShadow: 'var(--shadow-pop)'
              }}
            >
              <button className="board-menu-item" onClick={() => void runExport('png')}>
                Export PNG
              </button>
              <button className="board-menu-item" onClick={() => void runExport('svg')}>
                Export SVG
              </button>
            </div>,
            document.body
          )}
      </div>
    </div>
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
                onMeasure={reportMeasure}
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
