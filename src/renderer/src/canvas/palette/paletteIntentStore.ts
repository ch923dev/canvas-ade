/**
 * Ephemeral palette → board-component intent channel (D4-A). Some palette verbs are
 * implemented INSIDE a board component (BoardFrame's inline title edit, the terminal
 * spawn hook's restart) — the palette can't call them directly. It posts a one-shot
 * intent here; the owning component consumes it by board id. Never persisted
 * (scene/session split), never on the undo rail.
 *
 * Nonce semantics: every send bumps `nonce` so an identical back-to-back intent
 * (rename, close, rename again) still re-fires the consumer's effect. `consume`
 * clears the slot so a remounting consumer can't replay a stale intent.
 */
import { create } from 'zustand'

export type PaletteIntentKind = 'rename' | 'restart-resume' | 'restart-new'

export interface PaletteIntent {
  nonce: number
  boardId: string
  kind: PaletteIntentKind
}

interface PaletteIntentState {
  intent: PaletteIntent | null
  send: (boardId: string, kind: PaletteIntentKind) => void
  consume: (nonce: number) => void
}

let nextNonce = 1

export const usePaletteIntentStore = create<PaletteIntentState>((set) => ({
  intent: null,
  send: (boardId, kind) => set({ intent: { nonce: nextNonce++, boardId, kind } }),
  consume: (nonce) => set((s) => (s.intent?.nonce === nonce ? { intent: null } : s))
}))

/** Imperative send for non-React call sites (the registry's verb callbacks). */
export function sendPaletteIntent(boardId: string, kind: PaletteIntentKind): void {
  usePaletteIntentStore.getState().send(boardId, kind)
}
