/**
 * TERM-07: the right-click context-menu entries for the terminal well (Copy / Paste /
 * Select all / Clear / font bigger·smaller·reset), extracted from the TerminalBoard host
 * so the host stays under its size pin and the menu shape is unit-testable in isolation.
 *
 * The actions read `termRef.current` at click time (a stable hook ref). `hasSel` is
 * captured by the caller at menu-OPEN time so the Copy entry's disabled state is fixed
 * for the menu's lifetime (no ref read during render).
 */
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { MenuEntry } from '../planning/ElementContextMenu'
import { useCanvasStore } from '../../../store/canvasStore'
import { pasteIntoTerminal } from './pasteIntoTerminal'
import { runTerminalSave } from './terminalSaveOutput'

export interface TerminalMenuParams {
  /** Selection present at open-time (live OR snapshot fallback) → enables Copy. */
  hasSel: boolean
  /**
   * Terminal-copy fix: the last-known selection text ('' when none). Copy falls back to it
   * when the live selection was wiped between menu-open and the click — a streaming agent's
   * mouse-tracking toggles do exactly that (docs/reviews/2026-07-11-terminal-copy-paste-research).
   */
  selectionFallback: () => string
  boardId: string
  /** Current effective (pinned-space) font, for the ± disabled bounds. */
  effectiveFont: number
  minFont: number
  maxFont: number
  termRef: RefObject<Terminal | null>
  nudgeFont: (delta: number) => void
  resetFont: () => void
}

export function buildTerminalMenuEntries(p: TerminalMenuParams): MenuEntry[] {
  const { termRef, boardId } = p
  return [
    {
      kind: 'action',
      id: 'copy',
      label: 'Copy',
      disabled: !p.hasSel,
      onSelect: () => {
        const t = termRef.current
        const sel = t?.getSelection() || p.selectionFallback()
        if (t && sel) {
          // Clear the highlight only when MAIN verified the write landed (readback in
          // clipboardIpc); on failure it stays as the "not copied" signal.
          void window.api.clipboard.writeText(sel).then((ok) => {
            if (ok && termRef.current === t) t.clearSelection()
          })
        }
      }
    },
    {
      kind: 'action',
      id: 'paste',
      label: 'Paste',
      onSelect: () => {
        const t = termRef.current
        if (t) void pasteIntoTerminal(t, boardId, () => termRef.current === t)
      }
    },
    {
      kind: 'action',
      id: 'selectall',
      label: 'Select all',
      onSelect: () => termRef.current?.selectAll()
    },
    {
      kind: 'action',
      id: 'clear',
      label: 'Clear',
      onSelect: () => termRef.current?.clear()
    },
    // Phase 5 · S1 — the export action reads as its own group (hairlines above + below).
    { kind: 'separator', id: 'sep-save-top' },
    {
      kind: 'action',
      id: 'save-output',
      label: 'Save output…',
      onSelect: () => {
        const t = termRef.current
        if (!t) return
        // Title → filename slug; read at click time (the board may have been renamed).
        const title = useCanvasStore.getState().boards.find((b) => b.id === boardId)?.title
        void runTerminalSave(t, title, boardId)
      }
    },
    { kind: 'separator', id: 'sep-save-bottom' },
    {
      kind: 'action',
      id: 'font-bigger',
      label: 'Bigger font',
      disabled: p.effectiveFont >= p.maxFont,
      onSelect: () => p.nudgeFont(1)
    },
    {
      kind: 'action',
      id: 'font-smaller',
      label: 'Smaller font',
      disabled: p.effectiveFont <= p.minFont,
      onSelect: () => p.nudgeFont(-1)
    },
    {
      kind: 'action',
      id: 'font-reset',
      label: 'Reset font',
      onSelect: () => p.resetFont()
    }
  ]
}
