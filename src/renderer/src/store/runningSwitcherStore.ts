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
 *
 * R16 (commit-on-release) adds two things to this slice, both OBSERVATION only — the store still
 * runs no switch itself:
 *   • `holdKey` / `holdReleased` — which modifier the user is holding for this interaction, and
 *     whether it has been let go yet. The release can land BEFORE the overlay opens (the snapshot
 *     fetch is async and a tap is faster), so the hold is recorded at chord time, not at open time;
 *     otherwise the most common Alt-Tab gesture of all would leave the overlay stranded open.
 *   • a QUEUE for presses that race the snapshot fetch. The old guard returned without ever
 *     applying the racing press's `dir` — the comment said "respect it" but the direction was
 *     dropped on the floor, so a fast double-tap moved one step instead of two. That drop gets more
 *     load-bearing under commit-on-release, where a hold-and-tap-twice is a normal gesture.
 */
import { create } from 'zustand'
import { dockCards, type ProjectDockCard } from '../canvas/projectSessionsShared'
import type { ProjectCycleHold } from '../../../preload'
import { useCanvasStore } from './canvasStore'

interface RunningSwitcherStore {
  open: boolean
  /** Frozen snapshot for the current interaction — active first, residents most-recent first. */
  cards: ProjectDockCard[]
  /** Highlighted card index into `cards`. */
  index: number
  /** R16: the modifier held for THIS interaction; null when the overlay was not raised by a
   *  hotkey, or the bound chord carries no modifier. Cleared on close. */
  holdKey: ProjectCycleHold
  /** R16: the hold has been let go — the component commits the highlight when it sees this. */
  holdReleased: boolean
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
  /**
   * R16: arm the hold for a fresh hotkey interaction. Called SYNCHRONOUSLY when the chord fires,
   * before `openWith`'s fetch — a tap can release the modifier while that fetch is still in
   * flight, and a hold armed only after it lands would miss the release entirely.
   */
  noteHoldKey: (hold: ProjectCycleHold) => void
  /** R16: the held modifier was released. No-op when nothing is armed. */
  noteHoldReleased: () => void
  close: () => void
}

/** Guards against a second openWith racing the first's async snapshot fetch (rapid double-tap). */
let opening = false
/**
 * R16: presses that arrived while that fetch was in flight. NET steps, not a list — the frozen
 * list is a ring, so two nexts and a prev is one net advance. Applied to the highlight the instant
 * the snapshot lands, so a fast double-tap ends up where the user aimed instead of one short.
 */
let queuedSteps = 0

/** Ring-wrap a highlight index (negative-safe). */
function wrapIndex(i: number, steps: number, len: number): number {
  return (((i + steps) % len) + len) % len
}

/**
 * Drop the in-flight-interaction state — the module-scoped half of this slice, which
 * `useRunningSwitcherStore.setState` cannot reach because it lives in a closure rather than in the
 * store.
 *
 * This exists for the e2e harness's `reset()`, and it is the same class of leak as the pending
 * ask-on-switch promise that reset() has to settle: ONE app instance is reused across every spec
 * file, so anything stranded here outlives the spec that stranded it. A stuck `opening` is
 * particularly nasty because it is silent and total — every later `openWith` takes the
 * queue-and-return path, so the overlay simply never opens again for the rest of the run, and the
 * spec that trips over it looks like an unrelated flake.
 */
export function resetRunningSwitcherInteraction(): void {
  opening = false
  queuedSteps = 0
}

export const useRunningSwitcherStore = create<RunningSwitcherStore>((set, get) => ({
  open: false,
  cards: [],
  index: 0,
  holdKey: null,
  holdReleased: false,

  async openWith(dir) {
    // Already up (or a fetch already in flight) → treat the press as an advance, not a re-open.
    if (get().open) {
      get().advance(dir)
      return
    }
    // R16: QUEUE rather than drop. This used to `return` outright, so every press but the first of
    // a fast multi-tap vanished — the exact bug PS-3 flagged, and one the commit-on-release gesture
    // makes routine (hold the modifier, tap the key twice).
    if (opening) {
      queuedSteps += dir
      return
    }
    opening = true
    try {
      const project = useCanvasStore.getState().project
      const bg = await window.api.project.listBackground().catch(() => [])
      // activeCounts null: the active card wears a "now" tag, not a counts badge (residents carry
      // their own counts) — so we skip the extra askOnSwitchInfo round-trip on the hot path.
      const cards = dockCards({ dir: project.dir, name: project.name }, null, bg)
      if (cards.length === 0) {
        // Nothing running: the overlay stays closed, so the armed hold has nothing to commit and
        // must not survive into the NEXT interaction (a stale release would fire it instantly).
        set({ holdKey: null, holdReleased: false })
        return
      }
      if (get().open) {
        // Defensive: another surface raised the overlay while we fetched. Respect ITS snapshot —
        // never clobber a list the user is already looking at — but do not swallow the presses
        // either; they land as advances on what is actually on screen.
        get().advance(dir)
        stepOpen(set, get, queuedSteps)
        return
      }
      const len = cards.length
      const activeFirst = cards[0]?.active === true
      const base = len === 1 ? 0 : dir === 1 ? (activeFirst ? 1 : 0) : len - 1
      // The queued presses land as extra steps from where this press would have put us.
      const index = len < 2 ? 0 : wrapIndex(base, queuedSteps, len)
      set({ open: true, cards, index })
    } finally {
      opening = false
      queuedSteps = 0
    }
  },

  advance(dir) {
    stepOpen(set, get, dir)
  },

  setIndex(i) {
    const s = get()
    if (!s.open || i < 0 || i >= s.cards.length) return
    set({ index: i })
  },

  noteHoldKey(hold) {
    // A fresh chord re-arms: the modifier is demonstrably down again, so any release recorded for
    // the previous press is stale.
    set({ holdKey: hold, holdReleased: false })
  },

  noteHoldReleased() {
    if (get().holdKey === null || get().holdReleased) return
    set({ holdReleased: true })
  },

  close() {
    if (get().open || get().holdKey !== null) {
      set({ open: false, cards: [], index: 0, holdKey: null, holdReleased: false })
    }
  }
}))

/** Step the highlight of an OPEN overlay by `steps`, wrapping. No-op when closed, when there is
 *  nothing to cycle between, or when the net step is zero. Shared by `advance` and the queue. */
function stepOpen(
  set: (partial: Partial<RunningSwitcherStore>) => void,
  get: () => RunningSwitcherStore,
  steps: number
): void {
  const s = get()
  if (!s.open || s.cards.length < 2 || steps === 0) return
  set({ index: wrapIndex(s.index, steps, s.cards.length) })
}
