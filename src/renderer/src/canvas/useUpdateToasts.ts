/**
 * Phase 5 auto-update notifications. Subscribes to main's electron-updater status
 * (window.api.update.onStatus) and surfaces it through the shared toast channel
 * (toastStore) — reusing the sticky + action-button pattern (the save-failure Retry
 * precedent), so this adds NO new chrome. A keyed toast ('app-update') updates in place
 * as the download progresses, then offers Restart when the update is ready.
 *
 * No-op when window.api.update is absent (older preload) or the gate is off in main
 * (unsigned/dev builds emit no status events at all).
 */
import { useEffect } from 'react'
import { showToast, dismissToast } from '../store/toastStore'

const TOAST_ID = 'app-update'

export function useUpdateToasts(): void {
  useEffect(() => {
    const update = window.api?.update
    if (!update) return
    return update.onStatus((status) => {
      switch (status.state) {
        case 'available':
          showToast({
            id: TOAST_ID,
            kind: 'info',
            sticky: true,
            message: `Downloading update ${status.version}…`
          })
          break
        case 'downloading':
          showToast({
            id: TOAST_ID,
            kind: 'info',
            sticky: true,
            message: `Downloading update… ${status.percent}%`
          })
          break
        case 'ready':
          showToast({
            id: TOAST_ID,
            kind: 'ok',
            sticky: true,
            message: `Update ${status.version} ready`,
            action: { label: 'Restart', run: () => void window.api.update.install() }
          })
          break
        case 'error':
          // A background update check failing should not nag — clear any in-flight
          // download toast and stay quiet.
          dismissToast(TOAST_ID)
          break
        // 'checking' / 'none' → nothing to show.
      }
    })
  }, [])
}
