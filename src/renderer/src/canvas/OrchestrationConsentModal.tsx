/**
 * Agent Orchestration Onboarding (P2) — the "Enable agent orchestration?" modal (the mock's
 * Step 1). The one-time consent (authority grant) that lets terminal agents drive the canvas:
 * spawn/configure boards, relay a prompt along a cable you drew, write plans onto a Planning
 * board — every action still gated by the per-action ConfirmModal, relay still cable-authorized.
 *
 * Rendered on the shared Modal primitive (scrim/portal/Esc/focus). Mirrors RecapConsentModal's
 * persist-then-act discipline (BUG-065/066 class): a write only counts on a resolved {ok:true};
 * a rejection OR a resolved {ok:false} keeps the modal open + surfaces a keyed error toast.
 *
 * The decision values mirror recap consent ('enabled' | 'declined'); both buttons RECORD a
 * decision so the once-per-project first-init prompt does not nag (re-enable later from Settings).
 * On enable → persist + open Sync (`onEnabled`); on "Not now" → persist 'declined' + close.
 */
import { useState, type CSSProperties, type ReactElement } from 'react'
import { Modal } from './Modal'
import { Icon, type IconName } from './Icon'
import { showToast } from '../store/toastStore'
import { useOrchestrationStore } from '../store/orchestrationStore'

/** The four agent CLIs Expanse provisions (mock's "Works with your agent CLIs"). */
const CLIS: Array<{ icon: IconName; label: string }> = [
  { icon: 'agent-claude', label: 'Claude Code' },
  { icon: 'agent-codex', label: 'Codex CLI' },
  { icon: 'agent-gemini', label: 'Gemini CLI' },
  { icon: 'agent-opencode', label: 'OpenCode' }
]

const CAPS: Array<{ bold: string; rest: string }> = [
  { bold: 'Spawn & configure', rest: ' boards on this canvas' },
  { bold: 'Relay a prompt', rest: " to a terminal you've cabled to" },
  { bold: 'Write plans & diagrams', rest: ' onto a Planning board' }
]

export function OrchestrationConsentModal({
  onClose,
  onEnabled
}: {
  /** Dismiss without granting (Esc / scrim — no persistence, mirrors recap). */
  onClose: () => void
  /** Consent granted + persisted → host advances to the Sync modal. */
  onEnabled: () => void
}): ReactElement {
  const [busy, setBusy] = useState(false)
  const setEnabledCache = useOrchestrationStore((s) => s.setEnabled)

  const saveError = (): void => {
    showToast({
      id: 'orchestration-consent-save',
      kind: 'error',
      message: "Couldn't save your choice. Please try again."
    })
  }

  const decide = async (decision: 'enabled' | 'declined'): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.orchestration.setConsent(decision)
      if (!r.ok) {
        // Resolved {ok:false} (MAIN dir desync / frame guard) — nothing persisted; stay open.
        setBusy(false)
        saveError()
        return
      }
      setEnabledCache(decision === 'enabled')
      // Close ONLY once the decision is durably persisted.
      if (decision === 'enabled') onEnabled()
      else onClose()
    } catch (err) {
      // IPC teardown race / disk error — keep the modal open so the choice can be retried.
      // eslint-disable-next-line no-console
      console.error('[orchestration] setConsent failed; keeping the modal open to retry', err)
      setBusy(false)
      saveError()
    }
  }

  return (
    <Modal
      label="Agent orchestration"
      onClose={onClose}
      closeDisabled={busy}
      zIndex={1000}
      scrimProps={{ 'data-test': 'orchestration-consent-scrim' }}
      cardProps={{ 'data-test': 'orchestration-consent-modal' }}
      cardStyle={styles.card}
    >
      {/* Header — accent-wash diamond mark + title */}
      <div style={styles.head}>
        <span style={styles.mark}>
          <Icon name="diamond" size={16} sw={1.6} />
        </span>
        <h2 style={styles.title}>Enable agent orchestration?</h2>
      </div>

      <div style={styles.body}>
        <p style={styles.intro}>
          Let agents in your <b style={styles.strong}>Terminal</b> boards drive this canvas through
          Canvas ADE&apos;s built-in connection &mdash; so a prompt can flow along the cables you
          draw.
        </p>

        <div style={styles.lbl}>What an agent can do</div>
        <ul style={styles.caps}>
          {CAPS.map((c) => (
            <li key={c.bold} style={styles.cap}>
              <span style={styles.pip} aria-hidden="true">
                &#9656;
              </span>
              <span>
                <b style={styles.strong}>{c.bold}</b>
                {c.rest}
              </span>
            </li>
          ))}
        </ul>

        {/* Security callout — load-bearing (annotation D): the two invariants users trust. */}
        <div style={styles.shield} role="note">
          <span style={styles.shieldIc} aria-hidden="true">
            <ShieldIcon />
          </span>
          <div style={styles.shieldTxt}>
            <b style={styles.shieldTitle}>You stay in control</b>
            Every action is shown to you for approval before it runs. An agent can only relay along
            cables you draw.
          </div>
        </div>

        <div style={styles.lbl}>Works with your agent CLIs</div>
        <div style={styles.compat}>
          {CLIS.map((cli) => (
            <div key={cli.label} style={styles.crow}>
              <span style={styles.crowIc} aria-hidden="true">
                <Icon name={cli.icon} size={16} />
              </span>
              <span>{cli.label}</span>
              <span style={styles.crowSt}>supported</span>
            </div>
          ))}
        </div>

        <div style={styles.note}>
          On enable, Canvas ADE writes the right MCP config for{' '}
          <code style={styles.code}>each</code> CLI. Turn this off anytime in{' '}
          <code style={styles.code}>Settings</code>.
        </div>
      </div>

      <div style={styles.foot}>
        <button
          style={styles.ghost}
          disabled={busy}
          onClick={() => void decide('declined')}
          data-test="orchestration-not-now"
        >
          Not now
        </button>
        <button
          style={styles.primary}
          disabled={busy}
          onClick={() => void decide('enabled')}
          data-test="orchestration-enable"
        >
          Enable orchestration
        </button>
      </div>
    </Modal>
  )
}

/** Shield + check — no `shield` glyph in the Icon catalogue, so inline the mock's path. */
function ShieldIcon(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" />
    </svg>
  )
}

const styles: Record<string, CSSProperties> = {
  // The shared Modal owns scrim/shadow; this matches the mock's card chrome (border + 8px radius,
  // section-managed padding) over the primitive's defaults.
  card: {
    width: 446,
    padding: 0,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-board)',
    overflow: 'hidden'
  },
  head: { display: 'flex', alignItems: 'center', gap: 11, padding: '18px 20px 12px' },
  mark: {
    width: 30,
    height: 30,
    flex: 'none',
    borderRadius: 'var(--r-ctl)',
    background: 'var(--accent-wash)',
    border: '1px solid rgba(79,140,255,.32)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--accent)'
  },
  title: { margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600, letterSpacing: '-.01em' },
  body: { padding: '0 20px 4px' },
  intro: { fontSize: 13, lineHeight: '20px', color: 'var(--text-2)', margin: '0 0 16px' },
  strong: { color: 'var(--text)', fontWeight: 500 },
  lbl: {
    fontFamily: 'var(--mono)',
    fontSize: 10,
    lineHeight: '14px',
    fontWeight: 500,
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: 'var(--text-3)',
    margin: '0 0 7px'
  },
  caps: {
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    margin: '0 0 16px',
    padding: 0
  },
  cap: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 9,
    fontSize: 13,
    lineHeight: '18px',
    color: 'var(--text-2)'
  },
  pip: { color: 'var(--accent)', fontSize: 11, flex: 'none', position: 'relative', top: -1 },
  shield: {
    display: 'flex',
    gap: 10,
    padding: '11px 12px',
    margin: '0 0 16px',
    background: 'var(--accent-wash)',
    border: '1px solid rgba(79,140,255,.32)',
    borderRadius: 'var(--r-inner)'
  },
  shieldIc: { color: 'var(--accent)', flex: 'none', display: 'flex' },
  shieldTxt: { fontSize: 12, lineHeight: '17px', color: 'var(--text-2)' },
  shieldTitle: {
    color: 'var(--text)',
    fontWeight: 600,
    display: 'block',
    marginBottom: 2,
    fontSize: 12.5
  },
  compat: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', margin: '0 0 14px' },
  crow: { display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text-2)' },
  crowIc: { width: 16, height: 16, flex: 'none', color: 'var(--text-2)', display: 'flex' },
  crowSt: { marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 9.5, color: 'var(--ok)' },
  note: {
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    lineHeight: '16px',
    color: 'var(--text-3)',
    padding: '11px 0 0',
    borderTop: '1px solid var(--border-subtle)'
  },
  code: { color: 'var(--text-2)' },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px 18px' },
  ghost: {
    height: 30,
    padding: '0 14px',
    borderRadius: 'var(--r-ctl)',
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: 'var(--ui)',
    cursor: 'pointer'
  },
  primary: {
    height: 30,
    padding: '0 14px',
    borderRadius: 'var(--r-ctl)',
    border: '1px solid var(--accent)',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 500,
    fontFamily: 'var(--ui)',
    cursor: 'pointer'
  }
}
