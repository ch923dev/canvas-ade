/**
 * Canvas keyboard bindings, extracted from Canvas.tsx (Wave-5 B5 god-file split; the
 * extraction was behavior-preserving — D3-C/D4-A added bindings since). Owns the four
 * keydown concerns as one cohesive hook:
 *   1. selected-connector Delete/Backspace (bubble)
 *   2. the main keymap: undo/redo · Esc-clear · diag toggle · 1 fit / 0 reset · t tidy ·
 *      Ctrl/⌘+K palette / ? shortcuts (D4-A) · m minimap (D4-C) (bubble)
 *   3. Esc-always-exits-full-view (CAPTURE phase — must beat xterm's stopPropagation)
 *   4. Ctrl/⌘ snap-suppress tracking (keydown+keyup, reset on blur/visibilitychange)
 *
 * The bug-prone part — the main keymap's modifier/precedence matching — is a PURE function
 * (`resolveCanvasKeyAction`), unit-tested independently; the hook just dispatches the action
 * with the exact same preventDefault behavior the inline effect had.
 */
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ReactFlowInstance } from '@xyflow/react'
import { cameraAnim } from '../../lib/motion'
import { FIT_FRAME, RESET_FRAME } from '../../lib/canvasView'
import { shouldFireBoardNavKey, shouldFireCameraShortcut } from '../cameraShortcut'

/** The keydown fields the main-keymap resolver reads (a subset of KeyboardEvent). */
export interface KeyChord {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** A resolved main-keymap action (or null = no binding). */
export type CanvasKeyAction =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'clearSelection' }
  | { kind: 'toggleDiag' }
  | { kind: 'toggleAuditLog' }
  | { kind: 'fit' }
  | { kind: 'reset' }
  | { kind: 'tidy' }
  | { kind: 'group' }
  | { kind: 'focusGroup' }
  | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | { kind: 'toggleMinimap' }
  | { kind: 'cycleBoard'; dir: 1 | -1 }
  | { kind: 'moveBoard'; dx: number; dy: number }
  | { kind: 'resizeBoard'; dw: number; dh: number }
  | { kind: 'focusBoard' }

/** Arrow-key → unit delta for the board move/resize chords (D4-B). A Map so an
 *  exotic e.key can never hit an inherited Object key (the D3-C discipline). */
const BOARD_ARROW_DELTA = new Map<string, readonly [number, number]>([
  ['ArrowLeft', [-1, 0]],
  ['ArrowRight', [1, 0]],
  ['ArrowUp', [0, -1]],
  ['ArrowDown', [0, 1]]
])

/** Per-keypress board nudge distance (world px); Shift steps by the coarse value —
 *  the same 1/10 grammar as the planning-element nudge (D3-C). */
export const BOARD_NUDGE_PX = 1
export const BOARD_NUDGE_SHIFT_PX = 10

/**
 * Pure: map a bubble-phase keydown to its canvas action, preserving the EXACT precedence of
 * the original else-if chain. `typing` = focus is in an INPUT/TEXTAREA/contenteditable;
 * `bareKeyAllowed` = the shared bare-key guard (`shouldFireCameraShortcut`: not typing AND the
 * target is not inside a `.react-flow__node`), gating the 1/0/t shortcuts so they never fire
 * from a focusable board surface like the pen well. `boardNavAllowed` = the stricter D4-B
 * whitelist (`shouldFireBoardNavKey`: focus is on body / the pane — nothing else owns it),
 * gating Tab/arrows/Enter so they can never shadow a focus trap, the planning well's own
 * arrows, or native Tab order inside chrome. Esc-in-full-view is handled separately in
 * the capture-phase listener.
 */
export function resolveCanvasKeyAction(
  e: KeyChord,
  ctx: { typing: boolean; bareKeyAllowed: boolean; boardNavAllowed: boolean }
): CanvasKeyAction | null {
  const { typing, bareKeyAllowed, boardNavAllowed } = ctx
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey
  const k = e.key.toLowerCase()
  // Undo/redo first (early-return in the original, so they win over the Esc/d/1/0/t chain).
  if (mod && k === 'z' && !typing) return { kind: e.shiftKey ? 'redo' : 'undo' }
  if (mod && k === 'y' && !e.shiftKey && !typing) return { kind: 'redo' }
  // Ctrl/⌘+K opens (toggles) the command palette — deliberately NO typing guard
  // (D4-A sign-off: the chord is never text entry, Linear/VS Code convention). A
  // focused xterm never lets this bubble (stopPropagation), so a terminal keeps
  // Ctrl+K for the agent automatically.
  if (mod && k === 'k' && !e.shiftKey) return { kind: 'palette' }
  // Ctrl/⌘+G groups the current selection (no Alt — different chord). Wins over the bare-key
  // chain like undo/redo. Guarded against firing while typing in a field.
  if (mod && k === 'g' && !e.shiftKey && !typing) return { kind: 'group' }
  // Then the mutually-exclusive chain.
  if (e.key === 'Escape' && !typing) return { kind: 'clearSelection' }
  if (k === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing) return { kind: 'toggleDiag' }
  // Ctrl/⌘+Shift+A toggles the MCP dispatch audit log (W1-A / F3 — moved out of a
  // self-registered listener in AuditLogViewer into this drift-guarded keymap). Same
  // modifier grammar as the diag toggle; no `!e.altKey` guard needed (Alt+Shift+A is an
  // unrelated OS chord, and the registry chip never claims it).
  if (k === 'a' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing)
    return { kind: 'toggleAuditLog' }
  if (e.key === '1' && bareKeyAllowed) return { kind: 'fit' }
  if (e.key === '0' && bareKeyAllowed) return { kind: 'reset' }
  if (k === 't' && bareKeyAllowed && !e.ctrlKey && !e.metaKey && !e.altKey) return { kind: 'tidy' }
  if (k === 'f' && bareKeyAllowed && !e.ctrlKey && !e.metaKey && !e.altKey)
    return { kind: 'focusGroup' }
  // `m` toggles the wayfinding minimap island (D4-C) — same bare-key grammar as t/f.
  if (k === 'm' && bareKeyAllowed && !e.ctrlKey && !e.metaKey && !e.altKey)
    return { kind: 'toggleMinimap' }
  // `?` opens the palette's shortcuts view. Bare-key guarded like 1/0/t (never from
  // an input or a focusable board surface); `?` arrives as Shift+/ so shiftKey is NOT
  // excluded — only Ctrl/⌘/Alt chords are.
  if (e.key === '?' && bareKeyAllowed && !e.ctrlKey && !e.metaKey && !e.altKey)
    return { kind: 'shortcuts' }
  // ── D4-B board nav (audit A3/A4) — whitelist-gated: only when focus is on body/pane. ──
  // Tab cycles board selection (Shift reverses). No Ctrl/⌘/Alt: Ctrl+Tab stays free for
  // a future surface and Alt+Tab belongs to the OS.
  if (e.key === 'Tab' && boardNavAllowed && !e.ctrlKey && !e.metaKey && !e.altKey)
    return { kind: 'cycleBoard', dir: e.shiftKey ? -1 : 1 }
  // Enter focuses the selected board (the double-click camera-fit path; Esc exits).
  if (e.key === 'Enter' && boardNavAllowed && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)
    return { kind: 'focusBoard' }
  // Arrows move the selected board(s) 1px (Shift = 10); Alt+arrows resize by the same
  // steps. Ctrl/⌘+arrows stay unbound (word-nav muscle memory; macOS Mission Control).
  const delta = BOARD_ARROW_DELTA.get(e.key)
  if (delta && boardNavAllowed && !e.ctrlKey && !e.metaKey) {
    const step = e.shiftKey ? BOARD_NUDGE_SHIFT_PX : BOARD_NUDGE_PX
    if (e.altKey) return { kind: 'resizeBoard', dw: delta[0] * step, dh: delta[1] * step }
    return { kind: 'moveBoard', dx: delta[0] * step, dy: delta[1] * step }
  }
  return null
}

export interface CanvasKeybindingDeps {
  rf: ReactFlowInstance
  clearSelection: () => void
  doUndo: () => void
  doRedo: () => void
  tidyAndFit: () => void
  setDiag: Dispatch<SetStateAction<boolean>>
  selectedConnectorId: string | null
  removeConnector: (id: string) => void
  setSelectedConnectorId: Dispatch<SetStateAction<string | null>>
  fullViewId: string | null
  cameraFullViewId: string | null
  closeFullView: () => void
  exitCameraFullView: () => void
  snapSuppressRef: MutableRefObject<boolean>
  /** Group the current multi-selection (Ctrl/⌘+G). Optional: wired by Canvas in S3. */
  groupSelection?: () => void
  /** Focus a group (bare `f`). Optional: real impl wired by Canvas in S4. */
  focusGroup?: () => void
  /** Open/toggle the command palette (Ctrl/⌘+K → 'commands', `?` → 'shortcuts'). D4-A. */
  openPalette?: (view: 'commands' | 'shortcuts') => void
  /** Toggle the wayfinding minimap island (bare `m`). D4-C. */
  toggleMinimap?: () => void
  /** Toggle the MCP dispatch audit log panel (Ctrl/⌘+Shift+A). W1-A. */
  toggleAuditLog?: () => void
  /** D4-B board nav (useBoardKeyboardNav). Each returns true if it ACTED — only then is
   *  the key swallowed (preventDefault), so e.g. Tab on an empty canvas falls through to
   *  native focus order and the chrome stays keyboard-reachable. */
  cycleBoard?: (dir: 1 | -1) => boolean
  moveSelectedBoards?: (dx: number, dy: number) => boolean
  resizeSelectedBoards?: (dw: number, dh: number) => boolean
  focusSelectedBoard?: () => boolean
}

export function useCanvasKeybindings(deps: CanvasKeybindingDeps): void {
  const {
    rf,
    clearSelection,
    doUndo,
    doRedo,
    tidyAndFit,
    setDiag,
    selectedConnectorId,
    removeConnector,
    setSelectedConnectorId,
    fullViewId,
    cameraFullViewId,
    closeFullView,
    exitCameraFullView,
    snapSuppressRef,
    groupSelection,
    focusGroup,
    openPalette,
    toggleMinimap,
    toggleAuditLog,
    cycleBoard,
    moveSelectedBoards,
    resizeSelectedBoards,
    focusSelectedBoard
  } = deps

  // 1. While an orchestration connector is selected, Delete/Backspace removes it. Selecting a
  // connector clears the board selection, so React Flow's deleteKeyCode finds no selected node
  // → no double-fire. Guarded against firing while typing.
  useEffect(() => {
    if (!selectedConnectorId) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if ((e.key === 'Delete' || e.key === 'Backspace') && !typing) {
        e.preventDefault()
        removeConnector(selectedConnectorId)
        setSelectedConnectorId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedConnectorId, removeConnector, setSelectedConnectorId])

  // 2. Main keymap: Esc clears, 1 fits, 0 resets zoom, Ctrl/⌘+Shift+D toggles diagnostics,
  // Backspace/Delete deletes the selected board via React Flow's deleteKeyCode, Ctrl/⌘+Z → undo,
  // Ctrl/⌘+Shift+Z (or Ctrl/⌘+Y) → redo, t → tidy (guarded: no-op while typing / inside a node).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const action = resolveCanvasKeyAction(e, {
        typing,
        bareKeyAllowed: shouldFireCameraShortcut(t, typing),
        boardNavAllowed: shouldFireBoardNavKey(t, typing)
      })
      if (!action) return
      switch (action.kind) {
        case 'undo':
          e.preventDefault()
          doUndo()
          break
        case 'redo':
          e.preventDefault()
          doRedo()
          break
        case 'clearSelection':
          // Full-view Esc is handled in the capture-phase listener below (it must beat xterm,
          // which stopPropagation()s keydown). Here, bubble phase, only the non-full-view case.
          clearSelection()
          break
        case 'toggleDiag':
          e.preventDefault()
          setDiag((v) => !v)
          break
        case 'toggleAuditLog':
          e.preventDefault()
          toggleAuditLog?.()
          break
        case 'fit':
          void rf.fitView(cameraAnim(FIT_FRAME))
          break
        case 'reset':
          // Recenter content at 100% rather than zoomTo(1)-in-place, which can strand every
          // board off-screen after a far pan/zoom (#41).
          void rf.fitView(cameraAnim(RESET_FRAME))
          break
        case 'tidy':
          // Auto-tidy + fit: repack scattered boards and frame them filling the pane.
          tidyAndFit()
          break
        case 'group':
          e.preventDefault()
          groupSelection?.()
          break
        case 'focusGroup':
          focusGroup?.()
          break
        case 'palette':
          e.preventDefault()
          openPalette?.('commands')
          break
        case 'shortcuts':
          e.preventDefault()
          openPalette?.('shortcuts')
          break
        // No preventDefault — bare letters keep their default like t/f above.
        case 'toggleMinimap':
          toggleMinimap?.()
          break
        // D4-B board nav: swallow the key ONLY when the handler acted, so an idle
        // Tab/Enter/arrow (no boards, empty selection) keeps its native behavior.
        case 'cycleBoard':
          if (cycleBoard?.(action.dir)) e.preventDefault()
          break
        case 'moveBoard':
          if (moveSelectedBoards?.(action.dx, action.dy)) e.preventDefault()
          break
        case 'resizeBoard':
          if (resizeSelectedBoards?.(action.dw, action.dh)) e.preventDefault()
          break
        case 'focusBoard':
          if (focusSelectedBoard?.()) e.preventDefault()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    rf,
    clearSelection,
    doUndo,
    doRedo,
    tidyAndFit,
    setDiag,
    groupSelection,
    focusGroup,
    openPalette,
    toggleMinimap,
    toggleAuditLog,
    cycleBoard,
    moveSelectedBoards,
    resizeSelectedBoards,
    focusSelectedBoard
  ])

  // 3. Esc ALWAYS exits full view — even when a board's own input owns focus. Must run in the
  // CAPTURE phase (window → target): xterm calls stopPropagation() on keydown, so a bubble-phase
  // listener never sees Esc from a focused full-view terminal. Capturing here beats both xterm and
  // any note editor; preventDefault + stopPropagation keep the same Esc from also reaching them.
  // No-op when not in full view.
  useEffect(() => {
    const onEscapeCapture = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && (fullViewId || cameraFullViewId)) {
        // SECURITY (BUG-005): an active human-confirm gate (ConfirmModal, marked with
        // `[data-confirm-active]`) owns Esc — it must DENY the pending dangerous MCP action.
        // Stealing Esc here (preventDefault + stopPropagation) would close full-view but
        // leave the confirm unanswered (fail-open). Bail so Esc reaches the modal's bubble
        // listener; a second Esc then exits full-view.
        if (document.querySelector('[data-confirm-active]')) return
        // D4-A: an open command palette owns the next Esc layer (after the confirm gate,
        // never before it) — bail so Esc bubbles to the palette's Modal listener and
        // closes it; the following Esc then exits full view. One Esc, one layer.
        if (document.querySelector('[data-palette-open]')) return
        // ESC-1: an Esc pressed INSIDE the Jarvis panel belongs to the panel (its own
        // scoped capture listener closes it + kills the mic) — bail so one press never
        // both closes the panel and exits full view.
        if (e.target instanceof Element && e.target.closest('.jarvis-panel')) return
        e.preventDefault()
        e.stopPropagation()
        if (cameraFullViewId) exitCameraFullView()
        else closeFullView()
      }
    }
    window.addEventListener('keydown', onEscapeCapture, true)
    return () => window.removeEventListener('keydown', onEscapeCapture, true)
  }, [fullViewId, closeFullView, cameraFullViewId, exitCameraFullView])

  // 4. Track Ctrl/⌘ for the snap-suppress escape hatch. keydown AND keyup both read the live
  // modifier state so holding/releasing mid-drag toggles snapping without a stale latch. blur +
  // visibilitychange reset the ref when the window loses focus (e.g. alt-tab while holding Ctrl):
  // the OS swallows the keyup so without this the ref stays latched true.
  useEffect(() => {
    const update = (e: KeyboardEvent): void => {
      snapSuppressRef.current = e.ctrlKey || e.metaKey
    }
    const reset = (): void => {
      snapSuppressRef.current = false
    }
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', reset)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', update)
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', reset)
    }
  }, [snapSuppressRef])
}
