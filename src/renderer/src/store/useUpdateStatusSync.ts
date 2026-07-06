/**
 * The single subscriber that pipes MAIN's `update:status` stream into the updateStore, so the
 * persistent Settings badge + every other consumer read one source. Armed once at App boot
 * (alongside useAccountSync). No-op when the preload update api is absent (older build) or the
 * updater gate is off in main (unsigned/dev builds emit no status at all).
 */
import { useEffect } from 'react'
import { useUpdateStore } from './updateStore'

export function useUpdateStatusSync(): void {
  useEffect(() => {
    const update = window.api?.update
    if (!update) return
    return update.onStatus((s) => useUpdateStore.getState().setStatus(s))
  }, [])
}
