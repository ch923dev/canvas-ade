/**
 * Keyboard interactions for the Planning whiteboard well (D3-C — audit A4 partial, A10's
 * sibling fixes live in ChecklistCard). Owns EVERY key the focused `.pl-well` handles:
 *
 * - Delete/Backspace — remove the selection (group- then lock-precedence), one checkpoint.
 * - Arrow keys — nudge the selected elements 1px (Shift = 10px). A contiguous arrow-key
 *   burst (key-repeat or rapid presses) coalesces into ONE undo step: `beginChange()` is
 *   called only on the burst's first nudge, and the burst ends on arrow keyup, any
 *   non-arrow keydown, or well blur. Mirrors the drag grammar: groups move whole
 *   (`expandGroups`), locked members stay put (lock wins over group).
 * - Ctrl/⌘+G / Ctrl/⌘+Shift+G — group / ungroup the selection (same enable rules as the
 *   context-menu entries). The chord is ALWAYS swallowed while the well is focused —
 *   even as a no-op — so the canvas-level Ctrl+G (BOARD groups, a window-keydown handler
 *   above the React root) can never fire from inside a whiteboard; with the well
 *   unfocused this handler never sees the key, so board-grouping is not shadowed.
 * - Shift+F10 / ContextMenu key — open the element context menu anchored at the
 *   selection's union-bbox center (keyboard parity for right-click, A4). preventDefault
 *   suppresses Chromium's synthesized `contextmenu` event so the pointer path
 *   (onWellContextMenu, which needs a hit under the cursor) never double-fires.
 * - Tool-shortcut letters (s/n/c/a/p/e) — unchanged, moved verbatim from the board.
 *
 * All three returned handlers are React props on the well (attached once at the React
 * root, read at dispatch time) — NOT effect-registered window/document listeners — so the
 * mid-dispatch listener-removal class (D1-B/C) structurally cannot bite here. The only
 * cross-render state is the burst flag, kept in a ref.
 */
import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { PlanningElement } from '../../../lib/boardSchema'
import { screenScale } from '../../../lib/pen'
import {
  elementBBox,
  expandGroups,
  groupElements,
  isLocked,
  translateMany,
  ungroupElements,
  unionBBox
} from './elements'
import { shortcutTool, type PlanTool } from './tools'
import type { MenuEntry } from './ElementContextMenu'

/** Per-keypress nudge distance (board-local px); Shift steps by the coarse value. */
export const NUDGE_PX = 1
export const NUDGE_SHIFT_PX = 10

// A Map (not a record) so an exotic e.key can never hit an inherited Object key.
const ARROW_DELTA = new Map<string, readonly [number, number]>([
  ['ArrowLeft', [-1, 0]],
  ['ArrowRight', [1, 0]],
  ['ArrowUp', [0, -1]],
  ['ArrowDown', [0, 1]]
])

export interface PlanningKeyboardDeps {
  tool: PlanTool
  setTool: (t: PlanTool) => void
  elements: PlanningElement[]
  selectedIds: ReadonlySet<string>
  setSelectedIds: Dispatch<SetStateAction<ReadonlySet<string>>>
  clearSel: () => void
  commit: (next: PlanningElement[] | ((cur: PlanningElement[]) => PlanningElement[])) => void
  beginChange: () => void
  /** Live camera zoom — screenScale fallback when the well has no layout yet. */
  zoom: number
  wellRef: MutableRefObject<HTMLDivElement | null>
  measuredRef: MutableRefObject<Map<string, { w: number; h: number }>>
  buildMenuEntries: (sel: ReadonlySet<string>) => MenuEntry[]
  setContextMenu: Dispatch<SetStateAction<{ x: number; y: number; entries: MenuEntry[] } | null>>
  newId: () => string
}

export interface PlanningKeyboardApi {
  onWellKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onWellKeyUp: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onWellBlur: () => void
}

export function usePlanningKeyboard(deps: PlanningKeyboardDeps): PlanningKeyboardApi {
  const {
    tool,
    setTool,
    elements,
    selectedIds,
    setSelectedIds,
    clearSel,
    commit,
    beginChange,
    zoom,
    wellRef,
    measuredRef,
    buildMenuEntries,
    setContextMenu,
    newId
  } = deps

  // True while an arrow-key burst is in flight: the first nudge of a burst takes the
  // (lazy, #BUG-004) undo checkpoint; every further nudge in the same burst commits
  // without one, so the whole burst undoes as a single step back to the pre-burst state.
  const nudging = useRef(false)
  const endNudgeBurst = useCallback(() => {
    nudging.current = false
  }, [])

  /** Keyboard-open the element context menu at the selection's union-bbox center. */
  const openMenuAtSelection = useCallback(() => {
    // Self-guarded (not just at the call site): the element menu is a select-tool
    // surface; a future second caller must not be able to open it mid-pen/erase.
    if (tool !== 'select') return
    // Select-then-act parity with the right-click path: act on whole groups.
    const effective = expandGroups(elements, selectedIds)
    if (effective.size === 0) return
    if (effective.size !== selectedIds.size) setSelectedIds(effective)
    const well = wellRef.current
    const r = well?.getBoundingClientRect()
    const scale = screenScale(r?.width ?? 0, well?.offsetWidth ?? 0, zoom)
    const bbox = unionBBox(
      elements
        .filter((el) => effective.has(el.id))
        .map((el) => elementBBox(el, measuredRef.current.get(el.id)))
    )
    // Board-local bbox center → screen (the inverse of toBoard's mapping); the Menu
    // shell's unified viewport clamp handles an off-screen anchor.
    setContextMenu({
      x: (r?.left ?? 0) + (bbox.x + bbox.w / 2) * scale,
      y: (r?.top ?? 0) + (bbox.y + bbox.h / 2) * scale,
      entries: buildMenuEntries(effective)
    })
  }, [
    tool,
    elements,
    selectedIds,
    setSelectedIds,
    wellRef,
    zoom,
    measuredRef,
    buildMenuEntries,
    setContextMenu
  ])

  const onWellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Any non-arrow key ends the current nudge burst, so e.g. nudge → Ctrl+Z → nudge
      // takes a FRESH checkpoint for the second burst (never mutates the undone-to
      // state under the first burst's consumed one).
      if (!ARROW_DELTA.has(e.key)) endNudgeBurst()

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

      // Ctrl/⌘+G group · Ctrl/⌘+Shift+G ungroup (D3-C). Swallow the chord whenever the
      // well is focused — even when it no-ops — so the canvas-level Ctrl+G (BOARD
      // groups) can't fire from inside a whiteboard (see file header).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'g') {
        e.stopPropagation()
        e.preventDefault()
        // Group-expand FIRST (right-click parity): the menu path always acts on the
        // expanded effective set, so grouping {A,B} where A∈G1={A,C} must produce
        // ONE group {A,B,C} — not a new {A,B} that strands C alone in G1.
        const expanded = expandGroups(elements, selectedIds)
        const selEls = elements.filter((el) => expanded.has(el.id))
        if (e.shiftKey) {
          // Same enable rule as the menu's Ungroup entry: any selected member grouped.
          if (selEls.some((el) => !!el.groupId)) {
            beginChange()
            commit(ungroupElements(elements, expanded))
          }
          return
        }
        // Same enable rule as the menu's Group entry: ≥2 selected, not already one group.
        const groupIds = new Set(selEls.map((el) => el.groupId).filter(Boolean))
        const isOneGroup =
          expanded.size >= 2 && groupIds.size === 1 && selEls.every((el) => !!el.groupId)
        if (expanded.size >= 2 && !isOneGroup) {
          beginChange()
          commit(groupElements(elements, expanded, newId()))
          // Ring follows the group (openMenuAtSelection parity): a silent sibling
          // that rode along via expansion must show selected, not leave the ring
          // on the partial subset of a now-atomic group.
          if (expanded.size !== selectedIds.size) setSelectedIds(expanded)
        }
        return
      }

      // Arrow-key nudge (A4): select tool + non-empty selection only; otherwise the
      // key falls through untouched.
      const delta = ARROW_DELTA.get(e.key)
      if (delta && tool === 'select' && selectedIds.size > 0) {
        e.stopPropagation()
        e.preventDefault() // a focused well must never scroll/pan on arrows
        // Drag-grammar moving set: whole groups, minus locked members. Derived from
        // the render-time `elements` snapshot — every commit re-renders, so the NEXT
        // keydown recomputes it fresh; only POSITIONS need the live-read transform
        // below. Group/lock reads can lag at most the single not-yet-rendered commit
        // of the BUG-023 window (a benign one-frame race; the burst ref is unaffected
        // by re-renders, so coalescing continues across the refresh).
        const expanded = expandGroups(elements, selectedIds)
        const movingIds = [...expanded].filter((mid) => {
          const el = elements.find((x) => x.id === mid)
          return el !== undefined && !isLocked(el)
        })
        if (movingIds.length === 0) return // all locked → no checkpoint, no commit
        if (!nudging.current) {
          beginChange()
          nudging.current = true
        }
        const step = e.shiftKey ? NUDGE_SHIFT_PX : NUDGE_PX
        // Live-read transform: key-repeat lands rapid commits, and the render-time
        // `elements` closure can lag a commit behind — re-reading at commit time chains
        // the nudges instead of clobbering (BUG-023 class).
        commit((cur) => translateMany(cur, movingIds, delta[0] * step, delta[1] * step))
        return
      }

      // Shift+F10 / ContextMenu key (A4): keyboard-open the element context menu.
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        // Consume UNCONDITIONALLY: Chromium synthesizes a `contextmenu` DOM event for
        // these keys at a position unrelated to the selection — letting it leak (e.g.
        // when nothing is selected) would run onWellContextMenu's hit-test at bogus
        // coordinates and could open the pointer-path menu on a stray element.
        e.stopPropagation()
        e.preventDefault()
        openMenuAtSelection() // self-guards tool + empty selection
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
    },
    [
      elements,
      selectedIds,
      setSelectedIds,
      tool,
      beginChange,
      commit,
      clearSel,
      setTool,
      newId,
      openMenuAtSelection,
      endNudgeBurst
    ]
  )

  // Arrow keyup ends the burst: the next press starts a new undo step. (Holding the
  // key auto-repeats keydown only, so a press-and-hold stays ONE step.)
  const onWellKeyUp = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (ARROW_DELTA.has(e.key)) endNudgeBurst()
    },
    [endNudgeBurst]
  )

  return { onWellKeyDown, onWellKeyUp, onWellBlur: endNudgeBurst }
}
