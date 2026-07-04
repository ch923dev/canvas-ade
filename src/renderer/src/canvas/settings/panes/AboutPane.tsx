/**
 * About detail pane — the `about` tile (System group). Product identity + the auto-update surface.
 * Auto-update (electron-updater) is Phase-5 + compiler-gated (`__ENABLE_AUTO_UPDATE__`): in an
 * unsigned/dev build MAIN wires no updater and `onStatus` never fires, so the pane shows the neutral
 * "updates are automatic" line. In a packaged build the same subscription (used by `useUpdateToasts`)
 * drives a live status line + a Restart button when an update is downloaded and ready.
 *
 * No fabricated version number: the app exposes a version string only inside an update event
 * (`available`/`ready`), so we show it when we have it and stay silent otherwise.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { pane } from '../paneStyles'

/** Mirrors preload `UpdateStatus` (kept local — no shared import across the process boundary). */
type UpdateStatus =
  | { state: 'checking' }
  | { state: 'available'; version: string }
  | { state: 'none' }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

function statusLine(s: UpdateStatus | null): string {
  if (!s) return 'Updates install automatically in the background.'
  switch (s.state) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Downloading update ${s.version}…`
    case 'downloading':
      return `Downloading update… ${s.percent}%`
    case 'ready':
      return `Update ${s.version} is ready.`
    case 'none':
      return 'You’re on the latest version.'
    case 'error':
      return 'Updates install automatically in the background.'
  }
}

export function AboutPane(): ReactElement {
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    const update = window.api?.update
    if (!update) return
    return update.onStatus((s) => setStatus(s))
  }, [])

  return (
    <div style={pane.section}>
      <div style={pane.acctRow} data-test="about-product-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.acctEmail}>Expanse</div>
          <div style={pane.acctSub}>An infinite canvas for AI-assisted development.</div>
        </div>
      </div>

      <div style={pane.setrow} data-test="about-updates-row">
        <div style={{ flex: 1 }}>
          <div style={pane.rowTitle}>Updates</div>
          <div style={pane.rowSub} data-test="about-update-status">
            {statusLine(status)}
          </div>
        </div>
        {status?.state === 'ready' && (
          <button
            className="ca-btn-primary"
            data-test="about-update-install"
            onClick={() => void window.api.update.install()}
          >
            Restart to update
          </button>
        )}
      </div>
    </div>
  )
}
