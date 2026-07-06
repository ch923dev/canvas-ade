/**
 * Auto-update status store — the single renderer source of truth for the current update state.
 * One subscriber (useUpdateStatusSync) pipes MAIN's `update:status` into here; every consumer
 * reads from it: the persistent Settings badge (gear / About tile / account pill), the tier
 * surfaces (UpdateSurfaces), and the About pane. This is also the canonical renderer mirror of
 * main's `UpdateStatus` (src/main/autoUpdate.ts) — import the type from here, don't re-declare it.
 */
import { create } from 'zustand'

/** Mirrors main `UpdateStatus` (src/main/autoUpdate.ts) — the process boundary means no shared import. */
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string; tier: 'optional' | 'recommended' }
  | { state: 'mandatory'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

/** The badge dot color, semantic: pending update (accent), forced (warn), downloaded/ready (ok). */
export type BadgeColor = 'accent' | 'warn' | 'ok'

interface UpdateState {
  status: UpdateStatus | null
  setStatus: (s: UpdateStatus) => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: null,
  setStatus: (status) => set({ status })
}))

/**
 * The Settings-badge color for the current status, or null for no badge. Shown whenever an update
 * is waiting or downloaded (available/downloading/ready) or required (mandatory); hidden for the
 * transient/idle states (checking/none/error) since there's nothing for the user to act on.
 */
export function selectUpdateBadge(s: UpdateState): BadgeColor | null {
  switch (s.status?.state) {
    case 'mandatory':
      return 'warn'
    case 'ready':
      return 'ok'
    case 'available':
    case 'downloading':
      return 'accent'
    default:
      return null
  }
}
