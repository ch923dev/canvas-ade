/**
 * About detail pane — the `about` tile (System group). Product identity + the manual-update surface.
 * Auto-update (electron-updater) is Phase-5 + compiler-gated (`__ENABLE_AUTO_UPDATE__`): in an
 * unsigned/dev build MAIN wires no updater and `onStatus` never fires, so the pane rests on the
 * neutral "check for updates" state (the button is a no-op there — no handler is registered).
 *
 * MANUAL model: the app only CHECKS on launch. When an update exists this pane shows it and the
 * user drives the rest — Download, then Restart & install. Nothing downloads or installs on its own.
 * The version string is only known from an update event (`available`/`ready`), so it is shown when
 * we have it and never fabricated.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { pane } from '../paneStyles'
import type { UpdateStatus } from '../../../store/updateStore'

const dotBase: CSSProperties = { width: 8, height: 8, borderRadius: 999, flex: 'none' }

export function AboutPane(): ReactElement {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  // The available/ready version, kept across the download (download-progress carries no version).
  const [version, setVersion] = useState('')

  useEffect(() => {
    const update = window.api?.update
    if (!update) return
    return update.onStatus((s) => {
      setStatus(s)
      if (s.state === 'available' || s.state === 'ready' || s.state === 'mandatory')
        setVersion(s.version)
    })
  }, [])

  const check = (): void => {
    setStatus({ state: 'checking' })
    void window.api.update.check().catch(() => setStatus({ state: 'error', message: '' }))
  }
  const download = (): void => void window.api.update.download()
  const install = (): void => void window.api.update.install()

  // Derive the row's dot / title / sub / action from the current state.
  let dot: ReactElement | null = null
  let title = 'Updates'
  let sub = 'Check for a newer version.'
  let action: ReactElement | null = (
    <button className="ca-btn-ghost" data-test="about-update-check" onClick={check}>
      Check for updates
    </button>
  )

  switch (status?.state) {
    case 'checking':
      sub = 'Checking for updates…'
      action = (
        <button className="ca-btn-ghost" data-test="about-update-check" disabled>
          Checking…
        </button>
      )
      break
    case 'available': {
      // Recommended reads louder (accent dot + filled primary); optional is calm (neutral
      // dot + ghost). The mandatory tier never reaches here — it is its own state below.
      const recommended = status.tier === 'recommended'
      dot = (
        <span style={{ ...dotBase, background: recommended ? 'var(--accent)' : 'var(--text-2)' }} />
      )
      title = `Update ${version} available`
      sub = recommended ? 'Recommended · new features and fixes.' : 'Optional · ready to download.'
      action = (
        <button
          className={recommended ? 'ca-btn-primary' : 'ca-btn-ghost'}
          data-test="about-update-download"
          onClick={download}
        >
          Download update
        </button>
      )
      break
    }
    case 'mandatory':
      dot = <span style={{ ...dotBase, background: 'var(--warn)' }} />
      title = `Update required — ${version}`
      sub = 'This version is no longer supported.'
      action = (
        <button className="ca-btn-primary" data-test="about-update-download" onClick={download}>
          Download update
        </button>
      )
      break
    case 'downloading':
      dot = <span style={{ ...dotBase, background: 'var(--accent)' }} />
      title = 'Downloading update…'
      sub = `${status.percent}%`
      action = null
      break
    case 'ready':
      dot = <span style={{ ...dotBase, background: 'var(--ok)' }} />
      title = `Update ${version} ready`
      sub = 'Installs on restart — your work is saved first.'
      action = (
        <button className="ca-btn-primary" data-test="about-update-install" onClick={install}>
          Restart &amp; install
        </button>
      )
      break
    case 'error':
      sub = 'Couldn’t reach the update server.'
      break
    case 'none':
      sub = 'You’re on the latest version.'
      break
    // null (no event yet) → the neutral default above.
  }

  return (
    <div style={pane.section}>
      <div style={pane.acctRow} data-test="about-product-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={pane.acctEmail}>Expanse</div>
          <div style={pane.acctSub}>An infinite canvas for AI-assisted development.</div>
        </div>
      </div>

      <div style={pane.setrow} data-test="about-updates-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...pane.rowTitle, display: 'flex', alignItems: 'center', gap: 8 }}>
            {dot}
            <span>{title}</span>
          </div>
          <div style={pane.rowSub} data-test="about-update-status">
            {sub}
          </div>
          {status?.state === 'downloading' && (
            <div
              style={{
                marginTop: 6,
                height: 4,
                borderRadius: 999,
                background: 'var(--inset)',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${status.percent}%`,
                  background: 'var(--accent)',
                  borderRadius: 999,
                  transition: 'width 0.3s ease-out'
                }}
              />
            </div>
          )}
        </div>
        {action}
      </div>
    </div>
  )
}
