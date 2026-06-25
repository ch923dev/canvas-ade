/**
 * Phase 1 accounts: the chrome account control (DESIGN.md › Surface 1), extracted from AppChrome
 * to stay under its max-lines ratchet. Signed-out — and during the brief boot 'checking' window
 * (local-first, so signed-out is the common case) — renders a ghost "Sign in" pill; signed-in
 * renders a 22px avatar (email initial) + a 'PRO' micro-tag on Pro. Own store subscription so a
 * status push re-renders only this control, not the whole camera cluster.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import { AccountAvatar } from './AccountAvatar'
import { useAccountStore } from '../store/accountStore'

export function AccountPill({
  onSignIn,
  onAccount
}: {
  /** Signed-out → open SignInView. */
  onSignIn: () => void
  /** Signed-in → open Settings at the Account section (top of the modal). */
  onAccount: () => void
}): ReactElement {
  const status = useAccountStore((s) => s.status)
  const email = useAccountStore((s) => s.email)
  const plan = useAccountStore((s) => s.plan)
  const [hover, setHover] = useState(false)

  if (status === 'signed-in') {
    return (
      <button
        className="ca-t-ctl"
        title={email ? `${email} — account` : 'Account'}
        aria-label="Account"
        data-test="account-pill"
        onClick={onAccount}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 6px',
          border: 'none',
          borderRadius: 6,
          cursor: 'pointer',
          background: hover ? 'var(--surface-overlay)' : 'transparent'
        }}
      >
        <AccountAvatar email={email} plan={plan} size={22} />
        {plan === 'pro' && <span style={proTag}>PRO</span>}
      </button>
    )
  }
  return (
    <button
      className="ca-t-ctl"
      title="Sign in to Expanse"
      data-test="account-signin"
      onClick={onSignIn}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        height: 28,
        padding: '0 12px',
        border: 'none',
        borderRadius: 6,
        cursor: 'pointer',
        background: hover ? 'var(--surface-overlay)' : 'transparent',
        color: hover ? 'var(--text)' : 'var(--text-2)',
        fontSize: 12,
        fontWeight: 500,
        fontFamily: 'var(--ui)'
      }}
    >
      Sign in
    </button>
  )
}

/** The 'PRO' micro-tag beside a Pro avatar. */
const proTag: CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: 'var(--accent)',
  background: 'var(--accent-wash)',
  borderRadius: 4,
  padding: '1px 4px',
  lineHeight: 1.4
}
