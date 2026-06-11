/**
 * Wayfinding state (design-audit D4-C) — the minimap island's visibility, toggled +
 * remembered per the sign-off: hidden on first run, the bare `M` chord / palette verb
 * flips it, and the choice persists across sessions (localStorage, app-level — an
 * interface preference, NOT canvas.json scene state per the scene/session split).
 *
 * The sticky read happens once, at store creation (app launch); writes go through on
 * every toggle. A failed write (quota / storage unavailable) degrades to in-session
 * state — the toggle still works, the preference just doesn't stick.
 */
import { create } from 'zustand'

/** localStorage key (per machine, all projects) — `ca.` prefix per hintDismissal. */
export const MINIMAP_VISIBLE_KEY = 'ca.canvas.minimapVisible'

function readSticky(): boolean {
  try {
    return window.localStorage.getItem(MINIMAP_VISIBLE_KEY) === '1'
  } catch {
    return false // storage unavailable → first-run default (hidden); never throw
  }
}

function writeSticky(visible: boolean): void {
  try {
    window.localStorage.setItem(MINIMAP_VISIBLE_KEY, visible ? '1' : '0')
  } catch {
    // Write failed — the in-session store state still carries the toggle.
  }
}

interface WayfindingState {
  /** The minimap island is shown (renders + joins the ADR 0002 chrome zones). */
  minimapVisible: boolean
  toggleMinimap: () => void
  setMinimapVisible: (visible: boolean) => void
}

export const useWayfindingStore = create<WayfindingState>((set) => ({
  minimapVisible: readSticky(),
  toggleMinimap: () =>
    set((s) => {
      const next = !s.minimapVisible
      writeSticky(next)
      return { minimapVisible: next }
    }),
  // Identity-skip so a same-value set never notifies (and never re-writes storage).
  setMinimapVisible: (visible) =>
    set((s) => {
      if (s.minimapVisible === visible) return s
      writeSticky(visible)
      return { minimapVisible: visible }
    })
}))
