/**
 * Running-projects switcher (the Alt-Tab-style picker). Ephemeral Zustand slice — runtime-only,
 * never serialized (same discipline as commandStore / auditLogStore).
 *
 * The switch hotkey (MAIN forwards a direction over project:cycleHotkey) opens this overlay
 * instead of blind-committing a cycle. On open we SNAPSHOT the running set ONCE — the active
 * project first, then the backgrounded residents in a fixed order (the shared `dockCards` model,
 * same ordering the ProjectDock uses) — and navigate within that frozen list. Snapshotting is why
 * the cycle is stable and always returns to where it started: the old path re-read the MRU recents
 * on every press and `project.open` reordered it, so the rotation churned and lost the origin.
 *
 * The universe is running projects ONLY (active + residents) — cold recents never appear here (they
 * stay in the ProjectSwitcher pill). With a single running project the overlay shows just it and
 * never dips into history. The actual switch is committed by the component via performProjectSwitch.
 */
import { create } from 'zustand'
import { dockCards, type ProjectDockCard } from '../canvas/projectSessionsShared'
import { useCanvasStore } from './canvasStore'

interface RunningSwitcherStore {
  open: boolean
  /** Frozen snapshot for the current interaction — active first, residents most-recent first. */
  cards: ProjectDockCard[]
  /** Highlighted card index into `cards`. */
  index: number
  /**
   * Open the overlay, snapshotting the running set and highlighting the neighbour of the active
   * card in `dir` (1 = next / -1 = prev). If it's already open, this just advances the highlight —
   * so a repeated hotkey tap steps through the frozen list (the Alt-Tab feel). No-op (stays closed)
   * when nothing is running.
   */
  openWith: (dir: 1 | -1) => Promise<void>
  /** Step the highlight by `dir`, wrapping. No-op when closed or fewer than 2 cards. */
  advance: (dir: 1 | -1) => void
  /** Point the highlight at a specific card (hover / arrow to a card). */
  setIndex: (i: number) => void
  close: () => void
}

/** Guards against a second openWith racing the first's async snapshot fetch (rapid double-tap). */
let opening = false

export const useRunningSwitcherStore = create<RunningSwitcherStore>((set, get) => ({
  open: false,
  cards: [],
  index: 0,

  async openWith(dir) {
    // Already up (or a fetch already in flight) → treat the press as an advance, not a re-open.
    if (get().open) {
      get().advance(dir)
      return
    }
    if (opening) return
    opening = true
    try {
      const project = useCanvasStore.getState().project
      const bg = await window.api.project.listBackground().catch(() => [])
      // activeCounts null: the active card wears a "now" tag, not a counts badge (residents carry
      // their own counts) — so we skip the extra askOnSwitchInfo round-trip on the hot path.
      const cards = dockCards({ dir: project.dir, name: project.name }, null, bg)
      // A second press may have opened us while the fetch was in flight — respect it.
      if (get().open || cards.length === 0) return
      const len = cards.length
      const activeFirst = cards[0]?.active === true
      const index = len === 1 ? 0 : dir === 1 ? (activeFirst ? 1 : 0) : len - 1
      set({ open: true, cards, index })
    } finally {
      opening = false
    }
  },

  advance(dir) {
    const s = get()
    if (!s.open || s.cards.length < 2) return
    const len = s.cards.length
    set({ index: (s.index + dir + len) % len })
  },

  setIndex(i) {
    const s = get()
    if (!s.open || i < 0 || i >= s.cards.length) return
    set({ index: i })
  },

  close() {
    if (get().open) set({ open: false, cards: [], index: 0 })
  }
}))
