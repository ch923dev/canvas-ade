/**
 * Phase 1 accounts: the focused sign-in screen (DESIGN.md › Surface 3). Built on the shared
 * Modal primitive (scrim/portal/Esc/focus). Three states:
 *   idle    — provider buttons (open the WorkOS AuthKit page in the system browser)
 *   waiting — browser opened; spinner + Cancel/Retry; auto-advances on the auth:statusChanged push
 *   error   — no system keyring (safeStorage off) → sign-in is unavailable; we never store plaintext
 *
 * Used two ways: as an on-demand modal from the chrome account pill (signed-out), and — when the
 * default-OFF `__REQUIRE_ACCOUNT__` build flag is on — as the forced gate in App.tsx (`forced`
 * hides the dismiss affordances + locks Esc/scrim so the app can't be entered signed-out).
 *
 * SECURITY: signIn() only kicks off PKCE in MAIN (system browser, never an embedded webview); the
 * renderer never sees a token. The view reacts purely to the presence-only status push.
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from './Modal'
import { Icon } from './Icon'
import { useAccountStore } from '../store/accountStore'

export function SignInView({
  onClose,
  forced = false
}: {
  onClose: () => void
  /** Forced gate (`__REQUIRE_ACCOUNT__`): no Cancel / offline escape, Esc + scrim locked. */
  forced?: boolean
}): ReactElement {
  const status = useAccountStore((s) => s.status)
  const encryptionAvailable = useAccountStore((s) => s.encryptionAvailable)
  const [phase, setPhase] = useState<'idle' | 'waiting'>('idle')
  const [error, setError] = useState<string | null>(null)

  // Auto-advance: the auth:statusChanged push flips the store to signed-in → close the view
  // (the forced gate also stops rendering once status leaves 'signed-out').
  useEffect(() => {
    if (status === 'signed-in') onClose()
  }, [status, onClose])

  // Both provider buttons open the same hosted AuthKit page in Phase 1 (it presents Google + email
  // itself); a provider deep-link hint is deferred. The exchange runs entirely in MAIN.
  const start = async (): Promise<void> => {
    setError(null)
    setPhase('waiting')
    try {
      const r = await window.api.auth.signIn()
      if (!r.ok) {
        setPhase('idle')
        setError('Sign-in is unavailable on this machine.')
      }
    } catch {
      setPhase('idle')
      setError('Could not start sign-in — please try again.')
    }
  }

  const keyringBlocked = !encryptionAvailable

  return (
    <Modal
      label="Sign in to Expanse"
      onClose={onClose}
      closeDisabled={forced}
      zIndex={310}
      scrimProps={{ 'data-test': 'signin-scrim' }}
      cardProps={{ 'data-test': 'signin-modal' }}
      cardStyle={styles.card}
    >
      <div style={styles.brand}>
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="diamond" size={18} />
        </span>
        Expanse
      </div>

      {keyringBlocked ? (
        // ── Error: no keyring (safeStorage off) ──
        <>
          <div style={styles.title}>Sign in to Expanse</div>
          <div role="alert" data-test="signin-no-keyring" style={styles.notice}>
            <span style={{ color: 'var(--warn)' }}>⚠</span> Can&apos;t store a session on this
            machine — no system keyring was found. Sign-in is unavailable here.
          </div>
          {!forced && (
            <button className="ca-btn-ghost" style={styles.block} onClick={onClose}>
              Continue offline
            </button>
          )}
        </>
      ) : phase === 'waiting' ? (
        // ── Waiting for the system browser ──
        <>
          <div style={styles.title}>Finish in your browser</div>
          <div style={styles.waitRow}>
            <span className="ca-spin" style={{ color: 'var(--text-3)', display: 'inline-flex' }}>
              <Icon name="refresh" size={15} />
            </span>
            <span style={styles.sub} data-test="signin-waiting">
              Waiting for sign-in…
            </span>
          </div>
          <div style={styles.hint}>Completed it? This updates automatically.</div>
          <div style={styles.row}>
            {!forced && (
              <button className="ca-btn-ghost" onClick={onClose}>
                Cancel
              </button>
            )}
            <div style={{ flex: 1 }} />
            <span style={styles.hint}>
              Didn&apos;t open?{' '}
              <button type="button" style={styles.linkBtn} onClick={() => void start()}>
                Retry
              </button>
            </span>
          </div>
        </>
      ) : (
        // ── Idle: provider choice ──
        <>
          <div style={styles.title}>Sign in to Expanse</div>
          <div style={styles.sub}>Sync your settings across machines and unlock Pro.</div>

          {error && (
            <div role="alert" data-test="signin-error" style={styles.notice}>
              {error}
            </div>
          )}

          <button
            className="ca-btn-primary"
            style={styles.block}
            data-test="signin-google"
            onClick={() => void start()}
          >
            <span style={styles.gBadge}>G</span>
            Continue with Google
          </button>
          <button
            className="ca-btn-ghost"
            style={styles.block}
            data-test="signin-email"
            onClick={() => void start()}
          >
            Continue with email
          </button>

          <div style={styles.legal}>By continuing you agree to the Terms and Privacy Policy.</div>
        </>
      )}
    </Modal>
  )
}

const styles: Record<string, CSSProperties> = {
  card: { width: 340, padding: 22, display: 'flex', flexDirection: 'column', gap: 12 },
  brand: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text)'
  },
  title: { fontSize: 15, fontWeight: 600, color: 'var(--text)', textAlign: 'center', marginTop: 2 },
  sub: { fontSize: 12, color: 'var(--text-3)', textAlign: 'center', lineHeight: '17px' },
  hint: { fontSize: 11, color: 'var(--text-3)', lineHeight: '15px' },
  // Full-width buttons (the .ca-btn-* classes are inline-flex auto-width by default).
  block: { width: '100%', gap: 8 },
  gBadge: {
    display: 'grid',
    placeItems: 'center',
    width: 16,
    height: 16,
    borderRadius: 999,
    background: 'var(--void)',
    color: 'var(--text)',
    fontSize: 10,
    fontWeight: 700,
    lineHeight: 1
  },
  waitRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '4px 0'
  },
  legal: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    textAlign: 'center',
    lineHeight: '15px',
    marginTop: 2
  },
  notice: {
    fontSize: 11.5,
    lineHeight: '16px',
    color: 'var(--text-2)',
    background: 'var(--inset)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 6,
    padding: '9px 11px'
  },
  row: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 },
  linkBtn: {
    border: 'none',
    background: 'none',
    padding: 0,
    color: 'var(--accent)',
    fontFamily: 'var(--ui)',
    fontSize: 11,
    cursor: 'pointer'
  }
}
