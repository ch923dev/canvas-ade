import { create } from 'zustand'

/**
 * Terminal-crisp umbrella, Lane A — which Terminal boards are LIVE (should render incoming PTY
 * data) vs gated (off-screen / below-LOD → hold writes). The terminal analogue of the OSR
 * `osrLivenessStore`: `useTerminalLiveness` (the manager, mounted once in CanvasInner) recomputes
 * every settle / board change and writes each terminal's flag here; `useTerminalSpawn` reads its
 * own board's flag (NON-reactively, via `subscribe`) to gate its write coalescer — so a liveness
 * flip costs a ref write + maybe one rAF flush, never a React re-render.
 *
 * Unlike OSR there is NO existence/RAM cap (a hidden terminal keeps its full PTY + xterm buffer
 * alive — only the *rendering* is paused), so this is a plain visibility map with no `alive`
 * ranking. Default-true: a board absent from the record (freshly mounted, before the first
 * reconcile) renders immediately; the manager assigns it on the next settle.
 */
interface TerminalLivenessState {
  /** Per-board render flag. Absent ⇒ not yet reconciled ⇒ treat as live (render). */
  live: Record<string, boolean>
  /** Replace the whole record (the manager writes every terminal board each reconcile). */
  setLive: (next: Record<string, boolean>) => void
}

export const useTerminalLivenessStore = create<TerminalLivenessState>((set) => ({
  live: {},
  setLive: (next) => set({ live: next })
}))

/** Non-reactive read of a board's render flag (default-true for an unreconciled board). */
export function isTerminalLive(id: string): boolean {
  return useTerminalLivenessStore.getState().live[id] ?? true
}
