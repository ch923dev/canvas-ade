/**
 * Renderer-side reactive cache of the app-wide MCP spawn cap (the runaway-swarm guard, configured in
 * Settings → Agent orchestration). MAIN (orchestration-config.json in userData) is authoritative;
 * this store hydrates from `window.api.orchestration.getSpawnCap()` once and is updated AFTER a
 * successful `setSpawnCap` write, so the Command board's worker-pool readout + dispatch pre-check and
 * the Settings field stay in sync without each re-querying MAIN.
 *
 * App-level (the MCP server is a process singleton), so — unlike the per-project orchestration
 * CONSENT cache in orchestrationStore — this is never reset per project.
 */
import { create } from 'zustand'
import { WORKER_SPAWN_CAP, clampWorkerSpawnCap } from './workerPool'

interface OrchestrationConfigStore {
  /** Effective spawn cap (the WORKER_SPAWN_CAP default until hydrated from MAIN). */
  spawnCap: number
  /** True once hydrated (or once hydration failed) so `load()` is effectively one-shot. */
  loaded: boolean
  /** Hydrate the cap from MAIN. No-op once loaded; safe to call on every consumer mount. */
  load: () => Promise<void>
  /** Persist a new cap to MAIN; on success update the cache. Returns the IPC result. */
  save: (cap: number) => Promise<{ ok: boolean; reason?: string }>
  /** Update the cached value directly (clamped); skips the swap when unchanged. */
  setSpawnCap: (cap: number) => void
}

export const useOrchestrationConfigStore = create<OrchestrationConfigStore>((set, get) => ({
  spawnCap: WORKER_SPAWN_CAP,
  loaded: false,
  load: async () => {
    if (get().loaded) return
    try {
      const cap = await window.api.orchestration.getSpawnCap()
      set({ spawnCap: clampWorkerSpawnCap(cap), loaded: true })
    } catch {
      // IPC unavailable (teardown race / no preload) — keep the default but mark loaded so a
      // remounting consumer doesn't retry on a loop.
      set({ loaded: true })
    }
  },
  save: async (cap) => {
    const clamped = clampWorkerSpawnCap(cap)
    try {
      const r = await window.api.orchestration.setSpawnCap(clamped)
      // Only adopt the value once MAIN confirms the write (mirrors orchestrationStore's
      // update-after-successful-IPC discipline) — a rejected write leaves the cache untouched.
      if (r.ok) set({ spawnCap: clamped, loaded: true })
      return r
    } catch {
      return { ok: false, reason: 'ipc-error' }
    }
  },
  setSpawnCap: (cap) =>
    set((s) => {
      const next = clampWorkerSpawnCap(cap)
      return s.spawnCap === next ? s : { spawnCap: next }
    })
}))
