import { create } from 'zustand'

/**
 * OS-3 Phase 2 (M2 / 2B) — which offscreen Browser previews may EXIST (the MAX_LIVE RAM cap).
 *
 * `useOffscreenLiveness` (the manager) ranks all Browser boards each settle (visible-first, then
 * nearest the pane centre — `osrLiveness.rankOsrAlive`) and writes the `alive` flag for every
 * existing board here. `useOffscreenPreview` reads its own board's flag and gates the offscreen
 * window's open/close on it: an over-cap board is closed (its hidden renderer process freed) and
 * its last frame stays on the <canvas> as a frozen snapshot; it re-opens when it climbs back into
 * the cap. Default-true (an id absent from the record — e.g. a freshly-mounted board before the
 * first reconcile — opens immediately; the manager assigns it on the next settle).
 *
 * A Zustand primitive-selector (`s.alive[id] ?? true`) only re-renders a board when ITS OWN flag
 * flips, so re-writing the whole record each reconcile is cheap (no broad re-render).
 */
interface OsrLivenessState {
  /** Per-board existence flag. Absent ⇒ not yet ranked ⇒ treat as alive. */
  alive: Record<string, boolean>
  /** Replace the whole record (the manager writes every existing board each reconcile). */
  setAlive: (next: Record<string, boolean>) => void
}

export const useOsrLivenessStore = create<OsrLivenessState>((set) => ({
  alive: {},
  setAlive: (next) => set({ alive: next })
}))
