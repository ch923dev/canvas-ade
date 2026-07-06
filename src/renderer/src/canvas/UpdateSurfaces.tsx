/**
 * Auto-update surfaces (MANUAL model, three tiers). One subscriber to main's update status
 * (`window.api.update.onStatus`) that routes the flow to at most ONE transient surface by tier:
 *
 *   • optional     → NO transient surface. The persistent Settings badge (updateStore →
 *                    UpdateBadgeDot on the gear / About tile / account pill) is its only prompt.
 *   • recommended  → a persistent top banner (dismissable per session).
 *   • mandatory    → a BLOCKING modal the user cannot dismiss until they update.
 *
 * (The badge shows for EVERY tier — see updateStore; this file only adds the louder banner/modal
 * for the two higher tiers.) The tier is LATCHED: once main reports `mandatory` (or `recommended`)
 * for a version, the later `downloading`/`ready`/`error` events — which carry no tier — stay
 * attributed to that surface, so the banner/modal drives the whole download → restart flow. A
 * forced latch never downgrades. Settings ▸ About is the separate always-available surface.
 *
 * No-op when `window.api.update` is absent (older preload) or the gate is off in main
 * (unsigned/dev builds emit no status events at all).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Modal } from './Modal'
import type { UpdateStatus } from '../store/updateStore'

type Channel = 'none' | 'optional' | 'recommended' | 'forced'

const download = (): void => void window.api.update.download()
const install = (): void => void window.api.update.install()

const dot = (color: string, halo = false): ReactElement => (
  <span
    style={{
      width: 8,
      height: 8,
      borderRadius: 999,
      background: color,
      flex: 'none',
      boxShadow: halo ? '0 0 0 4px var(--accent-wash)' : undefined
    }}
  />
)

export function UpdateSurfaces(): ReactElement | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [channel, setChannel] = useState<Channel>('none')
  const [dismissed, setDismissed] = useState(false)
  // The version is latched HERE (in the status event handler — where setState is allowed) and
  // passed down: the tier-less download/error events carry none, and the surfaces must not
  // access a ref during render (react-hooks) nor setState in an effect.
  const [version, setVersion] = useState('')
  const channelRef = useRef<Channel>('none')

  useEffect(() => {
    const update = window.api?.update
    if (!update) return
    return update.onStatus((s) => {
      setStatus(s)
      if (s.state === 'available' || s.state === 'ready' || s.state === 'mandatory')
        setVersion(s.version)
      // Decide the latched channel. `mandatory` wins and never downgrades; `available` sets
      // the tier; `none` clears; the tier-less events (downloading/ready/error/checking) keep
      // whatever surface is already showing.
      let next = channelRef.current
      if (s.state === 'mandatory') next = 'forced'
      else if (channelRef.current !== 'forced') {
        if (s.state === 'available') next = s.tier === 'recommended' ? 'recommended' : 'optional'
        else if (s.state === 'none') next = 'none'
      }
      if (next !== channelRef.current) {
        channelRef.current = next
        setChannel(next)
        setDismissed(false) // a fresh channel re-shows the banner
      }
      // Optional shows NO transient surface — the persistent Settings badge (updateStore) is its
      // only prompt. Recommended → banner, mandatory → modal (rendered below).
    })
  }, [])

  if (channel === 'forced') return <ForceUpdateModal status={status} version={version} />
  if (channel === 'recommended' && !dismissed)
    return <UpdateBanner status={status} version={version} onDismiss={() => setDismissed(true)} />
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Mandatory — the blocking modal
// ─────────────────────────────────────────────────────────────────────────────

const barWrap: CSSProperties = {
  marginTop: 6,
  height: 4,
  borderRadius: 999,
  background: 'var(--inset)',
  overflow: 'hidden'
}
const barFill = (pct: number): CSSProperties => ({
  height: '100%',
  width: `${pct}%`,
  background: 'var(--accent)',
  borderRadius: 999,
  transition: 'width 0.3s ease-out'
})

function ForceUpdateModal({
  status,
  version
}: {
  status: UpdateStatus | null
  version: string
}): ReactElement {
  const st = status?.state
  const to = version || 'the latest version'

  let body =
    'This version is no longer supported. Update to keep using Expanse — your open work is saved before the app restarts.'
  let action: ReactElement | null = (
    <button className="ca-btn-primary" data-test="force-update-download" onClick={download}>
      Download update
    </button>
  )
  if (st === 'downloading') {
    body = 'Downloading the required update…'
    action = null
  } else if (st === 'ready') {
    body = 'The update is ready. Restart to install it — your work is saved first.'
    action = (
      <button className="ca-btn-primary" data-test="force-update-install" onClick={install}>
        Restart &amp; install
      </button>
    )
  } else if (st === 'error') {
    body = "The update couldn't be downloaded. Check your connection and try again."
  }

  return (
    <Modal
      label="Update required"
      onClose={() => {}}
      blocking
      zIndex={10001}
      scrimProps={{ 'data-testid': 'force-update-backdrop' }}
      cardProps={{ 'data-testid': 'force-update-modal' }}
      cardStyle={{ width: 430, maxWidth: '90vw', padding: 24 }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 'var(--fs-micro)',
          fontWeight: 600,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--warn)',
          background: 'var(--warn-wash, rgba(232,179,57,0.12))',
          border: '1px solid rgba(232,179,57,0.24)',
          padding: '3px 8px',
          borderRadius: 'var(--r-pill)',
          marginBottom: 14
        }}
      >
        {dot('var(--warn)')} Update required
      </span>
      <h2
        style={{
          margin: '0 0 8px',
          fontSize: 'var(--fs-h)',
          fontWeight: 600,
          letterSpacing: 'var(--tr-h)'
        }}
      >
        Update to {to} to keep using Expanse
      </h2>
      <p
        style={{
          margin: '0 0 18px',
          fontSize: 'var(--fs-body)',
          lineHeight: 'var(--lh-body)',
          color: 'var(--text-2)'
        }}
      >
        {body}
      </p>
      {st === 'downloading' && status?.state === 'downloading' && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--text-3)' }}>
            {status.percent}%
          </div>
          <div style={barWrap}>
            <div style={barFill(status.percent)} />
          </div>
        </div>
      )}
      {action && <div style={{ display: 'flex', gap: 10 }}>{action}</div>}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Recommended — the persistent top banner
// ─────────────────────────────────────────────────────────────────────────────

function UpdateBanner({
  status,
  version: v,
  onDismiss
}: {
  status: UpdateStatus | null
  version: string
  onDismiss: () => void
}): ReactElement {
  const st = status?.state
  let dotEl = dot('var(--accent)', true)
  let title = `Update ${v} available`
  let sub: string | null = 'New features and fixes.'
  let actions: ReactElement | null = (
    <>
      <button className="ca-btn-primary" data-test="banner-update-download" onClick={download}>
        Download
      </button>
      <button className="ca-btn-ghost" data-test="banner-update-later" onClick={onDismiss}>
        Later
      </button>
    </>
  )
  if (st === 'downloading' && status?.state === 'downloading') {
    title = `Downloading update… ${status.percent}%`
    sub = null
    actions = null
  } else if (st === 'ready') {
    dotEl = dot('var(--ok)')
    title = `Update ${v} ready`
    sub = 'Installs on restart — your work is saved first.'
    actions = (
      <button className="ca-btn-primary" data-test="banner-update-install" onClick={install}>
        Restart &amp; install
      </button>
    )
  } else if (st === 'error') {
    title = "Update couldn't be downloaded"
    sub = 'Check your connection and try again.'
    actions = (
      <button className="ca-btn-primary" data-test="banner-update-retry" onClick={download}>
        Try again
      </button>
    )
  }

  return createPortal(
    <div
      data-testid="update-banner"
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        width: 620,
        maxWidth: 'calc(100vw - 32px)',
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-board)',
        boxShadow: 'var(--shadow-board)',
        padding: '14px 14px 14px 16px'
      }}
    >
      {dotEl}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-body)', fontWeight: 500 }}>
          {title}
          {st === 'available' && (
            <span
              style={{
                fontSize: 'var(--fs-micro)',
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                marginLeft: 8
              }}
            >
              Recommended
            </span>
          )}
        </div>
        {sub && (
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-2)', marginTop: 2 }}>
            {sub}
          </div>
        )}
      </div>
      {actions}
      <button
        type="button"
        aria-label="Dismiss"
        data-test="banner-update-dismiss"
        onClick={onDismiss}
        style={{
          width: 26,
          height: 26,
          borderRadius: 'var(--r-ctl)',
          border: '1px solid transparent',
          background: 'transparent',
          color: 'var(--text-3)',
          fontSize: 15,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        ×
      </button>
    </div>,
    document.body
  )
}
