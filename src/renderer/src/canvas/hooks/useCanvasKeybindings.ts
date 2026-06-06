/**
 * Canvas keyboard bindings, extracted from Canvas.tsx (Wave-5 B5 god-file split). Owns
 * the four keydown concerns as one cohesive hook — behavior-preserving, no new bindings:
 *   1. selected-connector Delete/Backspace (bubble)
 *   2. the main keymap: undo/redo · Esc-clear · diag toggle · 1 fit / 0 reset · t tidy (bubble)
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
import { shouldFireCameraShortcut } from '../cameraShortcut'

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
  | { kind: 'fit' }
  | { kind: 'reset' }
  | { kind: 'tidy' }

/**
 * Pure: map a bubble-phase keydown to its canvas action, preserving the EXACT precedence of
 * the original else-if chain. `typing` = focus is in an INPUT/TEXTAREA/contenteditable;
 * `bareKeyAllowed` = the shared bare-key guard (`shouldFireCameraShortcut`: not typing AND the
 * target is not inside a `.react-flow__node`), gating the 1/0/t shortcuts so they never fire
 * from a focusable board surface like the pen well. Esc-in-full-view is handled separately in
 * the capture-phase listener.
 */
export function resolveCanvasKeyAction(
  e: KeyChord,
  ctx: { typing: boolean; bareKeyAllowed: boolean }
): CanvasKeyAction | null {
  const { typing, bareKeyAllowed } = ctx
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey
  const k = e.key.toLowerCase()
  // Undo/redo first (early-return in the original, so they win over the Esc/d/1/0/t chain).
  if (mod && k === 'z' && !typing) return { kind: e.shiftKey ? 'redo' : 'undo' }
  if (mod && k === 'y' && !e.shiftKey && !typing) return { kind: 'redo' }
  // Then the mutually-exclusive chain.
  if (e.key === 'Escape' && !typing) return { kind: 'clearSelection' }
  if (k === 'd' && (e.ctrlKey || e.metaKey) && e.shiftKey && !typing) return { kind: 'toggleDiag' }
  if (e.key === '1' && bareKeyAllowed) return { kind: 'fit' }
  if (e.key === '0' && bareKeyAllowed) return { kind: 'reset' }
  if (k === 't' && bareKeyAllowed && !e.ctrlKey && !e.metaKey && !e.altKey) return { kind: 'tidy' }
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
    snapSuppressRef
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
        bareKeyAllowed: shouldFireCameraShortcut(t, typing)
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rf, clearSelection, doUndo, doRedo, tidyAndFit, setDiag])

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
