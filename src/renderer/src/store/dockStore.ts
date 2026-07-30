import { create } from 'zustand'

/**
 * Swarm docked-terminals — which docked worker is the ACTIVE tab in each swarm board's dock
 * viewport. EPHEMERAL session state (scene/session split): never serialized, never routed into
 * a board patch — a reload re-derives the selection (the rail defaults to the first docked
 * worker, or the one needing input).
 *
 * One record for every swarm board (keyed by its board id). `active[swarmId]` may point at a
 * worker that has since popped out / been removed — readers resolve against the live boards
 * list and fall back, exactly like the liveness store's default-true discipline (a stale id
 * here must never strand a session; it only mis-selects a tab for one render).
 */
interface DockState {
  /** swarm board id → the docked worker board id whose terminal is currently rendered. */
  active: Record<string, string>
  setActive: (swarmId: string, workerId: string) => void
  /** Drop one swarm board's selection (board deleted / last worker popped out). */
  clear: (swarmId: string) => void
}

export const useDockStore = create<DockState>((set) => ({
  active: {},
  setActive: (swarmId, workerId) =>
    set((s) =>
      s.active[swarmId] === workerId ? s : { active: { ...s.active, [swarmId]: workerId } }
    ),
  clear: (swarmId) =>
    set((s) => {
      if (!(swarmId in s.active)) return s
      const next = { ...s.active }
      delete next[swarmId]
      return { active: next }
    })
}))

/** Non-reactive read of a swarm board's active dock tab (undefined = rail default applies). */
export function activeDockTab(swarmId: string): string | undefined {
  return useDockStore.getState().active[swarmId]
}
