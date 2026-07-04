/**
 * Account detail pane — the identity/plan/session block that used to open Settings
 * (`SettingsModal`'s `AccountSection`, DESIGN.md › Surface 2), now the `account` tile's body.
 * Signed-out → a CTA card whose "Sign in" defers to the parent (close Settings → open SignInView;
 * two shared Modals must never stack). Signed-in → identity row + plan badge + Sign out. Its own
 * store subscription so an `auth:statusChanged` push re-renders only this pane.
 */
import { useState, type ReactElement } from 'react'
import { AccountAvatar } from '../../AccountAvatar'
import { useAccountStore } from '../../../store/accountStore'
import { pane } from '../paneStyles'

export function AccountPane({ onSignIn }: { onSignIn?: () => void }): ReactElement {
  const status = useAccountStore((s) => s.status)
  const email = useAccountStore((s) => s.email)
  const plan = useAccountStore((s) => s.plan)
  const [busy, setBusy] = useState(false)

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      // MAIN clears local tokens/session/entitlement and pushes auth:statusChanged, which flips
      // this pane back to the signed-out CTA. A rejected IPC is non-fatal (state is local).
      await window.api.auth.signOut()
    } catch {
      // swallow — sign-out is best-effort local teardown
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={pane.section}>
      {status === 'signed-in' ? (
        <>
          <div style={pane.acctRow} data-test="account-row">
            <AccountAvatar email={email} plan={plan} size={28} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={pane.acctEmail}>{email ?? 'Signed in'}</div>
              <div style={pane.acctSub}>Signed in</div>
            </div>
            <span style={plan === 'pro' ? pane.badgePro : pane.badgeFree}>
              {plan === 'pro' ? 'PRO' : 'FREE'}
            </span>
          </div>
          <div style={pane.row}>
            <div style={{ flex: 1 }} />
            <button
              className="ca-btn-ghost"
              disabled={busy}
              data-test="account-signout"
              onClick={() => void signOut()}
            >
              Sign out
            </button>
          </div>
        </>
      ) : (
        <div style={pane.acctCta} data-test="account-cta">
          <span style={pane.acctCtaText}>
            Sign in to sync settings across machines and unlock Pro.
          </span>
          <button
            className="ca-btn-primary"
            data-test="account-cta-signin"
            onClick={() => onSignIn?.()}
          >
            Sign in
          </button>
        </div>
      )}
    </div>
  )
}
