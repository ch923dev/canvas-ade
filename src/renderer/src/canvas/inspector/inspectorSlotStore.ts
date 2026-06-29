/**
 * Inspector slot channel (P0.5) — the cross-tree wiring that lets a board feed its OWN per-type
 * content into the single Board Inspector shell.
 *
 * The shell (`BoardInspector`) lives in app chrome; the boards live inside the React Flow tree —
 * sibling subtrees. Rather than a context provider straddling both, the shell publishes two things
 * here: the DOM node of its content slot, and the id of the single eligible board. Each board reads
 * this; the matching board `createPortal`s its `<XInspector>` into the slot — so the per-type inspector
 * renders inside the BOARD's React subtree (reusing its exact handlers/state) while painting into the
 * SHELL's DOM. One panel, per-type content, zero handler duplication.
 */
import { create } from 'zustand'

interface InspectorSlotState {
  /** The shell's content-slot DOM node (portal target), or null before the shell mounts. */
  slotEl: HTMLElement | null
  /** The single selected + eligible board whose content should fill the slot (null = none). */
  activeBoardId: string | null
  setSlotEl: (el: HTMLElement | null) => void
  setActiveBoardId: (id: string | null) => void
}

export const useInspectorSlotStore = create<InspectorSlotState>((set) => ({
  slotEl: null,
  activeBoardId: null,
  setSlotEl: (slotEl) => set({ slotEl }),
  // Boards subscribe through the `useInspectorSlot` selector, so an unchanged value never re-renders
  // them regardless; the shell also only calls this when `activeBoardId` actually changes.
  setActiveBoardId: (activeBoardId) => set({ activeBoardId })
}))

/**
 * Hook for a board: returns the portal target IFF this board is the active one, else null.
 * `createPortal(content, useInspectorSlot(board.id) ?? document.createElement('div'))` is NOT the
 * pattern — callers must null-check and skip the portal when this returns null.
 */
export function useInspectorSlot(boardId: string): HTMLElement | null {
  return useInspectorSlotStore((s) => (s.activeBoardId === boardId ? s.slotEl : null))
}
