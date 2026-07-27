/**
 * The resident-projects list, once (audit R10).
 *
 * "Which projects are running in the background, and which are keep-forever" is ONE fact, and it
 * was being kept in two places: `ProjectDock` and `ProjectSwitcher` each held their own
 * `bgList` + `foreverDirs` `useState` pair, each re-fetched it on open and after every ✕ / ∞
 * action, and — the part that actually bites — NEITHER subscribed to `project:bgLifecycle`. MAIN
 * closes residents on its own schedule (idle TTL, the MAX_BACKGROUND cap evicting the coldest),
 * so an open surface would keep rendering a resident that no longer exists until the user closed
 * and reopened it. A dot, a counts badge and a ✕ that acts on a dead registry entry.
 *
 * Consolidating fixes both halves at once: one cache, and one place to invalidate it from. The
 * subscription is shared and reference-counted, so two mounted surfaces are one listener and one
 * fetch, not two of each.
 *
 * NOT a consumer: `runningSwitcherStore`. Its list is a deliberately FROZEN snapshot taken when
 * the Alt-Tab overlay opens — a live list would re-order the cards under the user mid-cycle, which
 * is the exact bug that snapshot was introduced to fix. Leave it alone.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { fetchLiveDecorations } from '../canvas/projectSessionsShared'
import type { BackgroundProjectInfo } from '../../../preload'

interface ResidentProjectsStore {
  /** Backgrounded residents, as MAIN's registry last reported them. */
  bg: BackgroundProjectInfo[]
  /** Dirs the user pinned keep-forever (the ∞ badge). */
  forever: string[]
  /** Re-read both from MAIN. Concurrent calls share one in-flight fetch. */
  refresh: () => Promise<void>
}

/** In-flight fetch, shared so N surfaces refreshing at once make ONE pair of IPC reads. */
let inFlight: Promise<void> | null = null

export const useResidentProjectsStore = create<ResidentProjectsStore>((set) => ({
  bg: [],
  forever: [],
  refresh: () => {
    if (inFlight) return inFlight
    inFlight = fetchLiveDecorations()
      .then(({ bg, forever }) => set({ bg, forever }))
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
}))

/** Live consumers, so the lifecycle listener exists exactly while something is rendering it. */
let mounted = 0
let unsubscribe: (() => void) | null = null

/**
 * Subscribe a component to the resident list. Fetches on mount and re-fetches whenever MAIN
 * reports a background-lifecycle change; `refresh` is for renderer-initiated changes MAIN does not
 * push (closing a resident, toggling keep-forever).
 */
export function useResidentProjects(): {
  bg: BackgroundProjectInfo[]
  forever: string[]
  refresh: () => Promise<void>
} {
  const bg = useResidentProjectsStore((s) => s.bg)
  const forever = useResidentProjectsStore((s) => s.forever)
  const refresh = useResidentProjectsStore((s) => s.refresh)

  useEffect(() => {
    mounted += 1
    if (mounted === 1) {
      // Guarded for non-electron test runtimes (a partial window.api mock), like the App's
      // recap effect — an absent channel must degrade to "no live updates", never throw.
      unsubscribe = window.api?.project?.onBgLifecycle?.(() => void refresh()) ?? null
    }
    void refresh()
    return () => {
      mounted -= 1
      if (mounted === 0) {
        unsubscribe?.()
        unsubscribe = null
      }
    }
  }, [refresh])

  return { bg, forever, refresh }
}

/** Test-only: drop the shared subscription bookkeeping between cases. */
export function resetResidentProjectsSubscription(): void {
  mounted = 0
  unsubscribe?.()
  unsubscribe = null
  inFlight = null
}
