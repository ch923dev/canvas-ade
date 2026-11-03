/**
 * "Update now" row — shown on the Welcome screen under the "saved by a newer version of the app"
 * open error (project-workspaces O-2 / WS-12; wireframe signed off 2026-11-03). A format-changing
 * release forces older apps through the update feed's `minSupported`, but an app that has not
 * checked since — or one that failed OPEN offline — never sees that modal. This row lets the user
 * fix the refusal from where they hit it.
 *
 * One click: `update:check` → when an update is found the download starts by itself (the click
 * already said "update") → progress → Restart & install. It drives the SAME main IPC as Settings ›
 * About and reads the shared updateStore, so a launch check that already found (or downloaded) an
 * update shows up here directly. A mandatory update still opens UpdateSurfaces' blocking modal;
 * this row mirrors its progress underneath.
 *
 * Unsigned / dev builds register no `update:*` handler (ADR 0008 gate), so the check rejects —
 * the row then says updates aren't available in this build instead of spinning forever.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useUpdateStore, type UpdateStatus } from '../store/updateStore'

const install = (): void => void window.api.update.install()

export function UpdateNowRow(): ReactElement {
  const status = useUpdateStore((s) => s.status)
  const version = useUpdateStore((s) => s.version)
  // The user asked for the update: a check that finds one starts the download by itself.
  const [wanted, setWanted] = useState(false)
  // The store status when the check was clicked. Until MAIN pushes a newer one, a stale
  // error/none left by the launch check must read as "checking", not as this click's result.
  const [checkedFrom, setCheckedFrom] = useState<UpdateStatus | null | undefined>(undefined)
  const [unavailable, setUnavailable] = useState(false)
  // The status object a download was started for — one download per "update found" event.
  const downloadedFor = useRef<UpdateStatus | null>(null)

  useEffect(() => {
    if (!wanted || !status || status === downloadedFor.current) return
    if (status.state === 'available' || status.state === 'mandatory') {
      downloadedFor.current = status
      void window.api.update.download()
    }
  }, [wanted, status])

  const onUpdate = (): void => {
    const update = window.api?.update
    if (!update) {
      setUnavailable(true)
      return
    }
    setWanted(true)
    // An update the launch check already found: the effect above downloads it, no re-check.
    if (status?.state === 'available' || status?.state === 'mandatory') return
    setCheckedFrom(status)
    update.check().then(
      (ok) => {
        if (!ok) setUnavailable(true)
      },
      () => setUnavailable(true)
    )
  }

  const found = status?.state === 'available' || status?.state === 'mandatory'
  const checking =
    checkedFrom !== undefined && (status === checkedFrom || status?.state === 'checking')

  let body: ReactElement
  if (unavailable) {
    body = <span className="welcome-update-note">Updates aren&apos;t available in this build.</span>
  } else if (status?.state === 'downloading') {
    body = (
      <div className="welcome-update-progress" data-test="welcome-update-progress">
        <span className="welcome-update-note">
          Downloading {version || 'update'} — {status.percent}%
        </span>
        <div className="welcome-update-bar">
          <div
            className="welcome-update-fill"
            style={{ transform: `scaleX(${Math.min(100, Math.max(0, status.percent)) / 100})` }}
          />
        </div>
      </div>
    )
  } else if (status?.state === 'ready') {
    body = (
      <>
        <span className="welcome-update-note">Update {version} is ready.</span>
        <button data-test="welcome-update-install" onClick={install}>
          Restart &amp; install
        </button>
      </>
    )
  } else if (wanted && (checking || found)) {
    body = (
      <button data-test="welcome-update-now" disabled>
        {found ? 'Starting download…' : 'Checking…'}
      </button>
    )
  } else if (wanted && status?.state === 'none') {
    body = (
      <>
        <span className="welcome-update-note">No newer version on your update feed.</span>
        <button data-test="welcome-update-now" onClick={onUpdate}>
          Check again
        </button>
      </>
    )
  } else if (wanted && status?.state === 'error') {
    body = (
      <>
        <span className="welcome-update-note">Couldn&apos;t reach the update server.</span>
        <button data-test="welcome-update-now" onClick={onUpdate}>
          Retry
        </button>
      </>
    )
  } else {
    body = (
      <button data-test="welcome-update-now" onClick={onUpdate}>
        {found && version ? `Update to ${version}` : 'Update now'}
      </button>
    )
  }

  return (
    <div className="welcome-update" data-test="welcome-update-row" role="status">
      {body}
    </div>
  )
}
