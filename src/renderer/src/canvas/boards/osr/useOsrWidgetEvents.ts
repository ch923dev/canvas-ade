import { useEffect } from 'react'
import { useOsrWidgetStore } from '../../../store/osrWidgetStore'
import { showToast, dismissToast } from '../../../store/toastStore'
import type { OsrDownloadEvent } from '../../../../../preload'

/**
 * OS-3 Phase 4 — subscribe a board's native-widget event streams (MAIN → renderer) and route them
 * to the `osrWidgetStore` (dialog / popup / audible) + the toast channel (downloads). One effect
 * per OSR board. Mounted by `BrowserBoard` alongside `useOffscreenPreview` so the URL-bar mute
 * toggle + the `.bb-frame` overlay layer both have state.
 */
export function useOsrWidgetEvents(boardId: string): void {
  useEffect(() => {
    const store = useOsrWidgetStore.getState()
    const offDialog = window.api.onPreviewOsrDialog((d) => {
      if (d.id === boardId) store.setDialog(boardId, d)
    })
    const offPopup = window.api.onPreviewOsrPopup((p) => {
      if (p.id === boardId) store.setPopup(boardId, p)
    })
    const offAudible = window.api.onPreviewOsrAudible((a) => {
      if (a.id === boardId) store.setAudible(boardId, a.audible)
    })
    const offDownload = window.api.onPreviewOsrDownload((d) => {
      if (d.id === boardId) toastForDownload(boardId, d)
    })
    return () => {
      offDialog()
      offPopup()
      offAudible()
      offDownload()
      useOsrWidgetStore.getState().clearBoard(boardId)
    }
  }, [boardId])
}

/** Map a download lifecycle event to a board+file-keyed toast (replace-in-place per file). */
function toastForDownload(boardId: string, d: OsrDownloadEvent): void {
  const id = `osr-dl-${boardId}-${d.name}`
  switch (d.state) {
    case 'start':
      showToast({ id, kind: 'info', message: `Downloading ${d.name}…`, sticky: true })
      break
    case 'progress': {
      const pct =
        d.total && d.total > 0 && d.received !== undefined
          ? ` ${Math.min(100, Math.round((d.received / d.total) * 100))}%`
          : ''
      showToast({ id, kind: 'info', message: `Downloading ${d.name}…${pct}`, sticky: true })
      break
    }
    case 'done':
      showToast({
        id,
        kind: 'ok',
        message: `${d.name} — saved to Downloads`,
        action: d.savePath
          ? { label: 'Show', run: () => void window.api.revealOsrDownload(d.savePath as string) }
          : undefined
      })
      break
    case 'fail':
      showToast({ id, kind: 'error', message: `Download failed: ${d.name}` })
      break
    case 'throttled':
      dismissToast(id)
      showToast({
        id: `osr-dl-throttle-${boardId}`,
        kind: 'error',
        message: 'Too many downloads — try again'
      })
      break
  }
}
