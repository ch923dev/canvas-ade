/**
 * Task 13: per-project consent modal for the terminal-recap feature.
 * Rendered on the shared Modal primitive (scrim/portal/Esc/focus — design-audit D1-B).
 * Shows once per project when consent is 'undecided'; user picks Enable or No thanks.
 * "No thanks" persists a 'declined' decision (re-enable later via Settings) — the label is
 * deliberately NOT "Not now", which would imply a per-session deferral we don't do.
 * Privacy copy is a hard requirement — keep accurate (no false "nothing ever leaves" claim).
 */
import { useState, type ReactElement } from 'react'
import { Modal } from './Modal'
import { showToast } from '../store/toastStore'

export function RecapConsentModal({ onClose }: { onClose: () => void }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [showSnippet, setShowSnippet] = useState(false)

  // D1-A: the save-failure message is a keyed error toast (repeat failures replace in
  // place), not an inline note. The modal still stays open for the retry.
  const saveError = (): void => {
    showToast({
      id: 'recap-consent-save',
      kind: 'error',
      message: "Couldn't save your choice. Please try again."
    })
  }

  const decide = async (decision: 'enabled' | 'declined'): Promise<void> => {
    setBusy(true)
    try {
      // BUG-066: a MAIN-side dir desync / frame guard replies with a RESOLVED { ok: false }
      // (nothing persisted, no hook installed) — treat it like a rejection, never close on it.
      const r = await window.api.recap.setConsent(decision)
      if (!r.ok) {
        setBusy(false)
        saveError()
        return
      }
      onClose() // close ONLY once the decision is durably persisted
    } catch (err) {
      // Don't close on failure (IPC teardown race / disk error) — closing would leave the user
      // believing their choice stuck when nothing was saved. Re-enable so they can retry.
      // eslint-disable-next-line no-console
      console.error('[recap] setConsent failed; keeping the modal open to retry', err)
      setBusy(false)
      saveError()
    }
  }

  return (
    <Modal
      label="Agent recaps"
      onClose={onClose}
      closeDisabled={busy}
      zIndex={1000}
      scrimProps={{ 'data-test': 'recap-consent-scrim' }}
      cardProps={{ 'data-test': 'recap-consent-modal' }}
      cardStyle={{ padding: 20, maxWidth: 460 }}
    >
      <h2 style={{ margin: 0, fontSize: 'var(--fs-h)', lineHeight: 'var(--lh-h)' }}>
        Turn on agent recaps for this project?
      </h2>
      <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: '1.5', color: 'var(--text-2)' }}>
        See what each terminal agent is doing at a glance. Canvas ADE gives every terminal a
        flip-to-recap &mdash; a short &ldquo;now&rdquo; summary + a timestamped timeline of what the
        agent and you decided &mdash; so you can resume instantly instead of re-reading the whole
        session.
      </p>
      <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: '1.5', color: 'var(--text-2)' }}>
        To do this, Canvas ADE adds <b>one hook</b> to this project&apos;s{' '}
        <code>.claude/settings.local.json</code> (<b>gitignored &mdash; never committed</b>; it does{' '}
        <b>not</b> touch your global <code>~/.claude</code> or your own hooks). It records only each
        session&apos;s id + transcript path.
      </p>
      <button style={linkBtn} onClick={() => setShowSnippet((v) => !v)} data-test="recap-what">
        {showSnippet ? '▾' : '▸'} What gets added?
      </button>
      {showSnippet && (
        <pre style={snippet}>{`.claude/settings.local.json
{ "hooks": { "SessionStart": [ { "matcher": "",
  "hooks": [ { "type": "command", "command": "<node>", "args": ["recordSession.js", "<map>"] } ] } ] } }`}</pre>
      )}
      <div style={assure}>
        <b>&#x1F512; Your data stays yours</b>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          <li>
            No Canvas ADE server, no account, no telemetry &mdash; nothing is ever sent to us.
          </li>
          <li>Transcripts are read locally, on your machine.</li>
          <li>
            The only thing that leaves is a short, secret-scrubbed slice sent to the LLM provider{' '}
            <i>you</i> choose, with <i>your</i> key &mdash; only if you set one. Pick a local model
            &rarr; nothing leaves.
          </li>
          <li>
            Raw files and full command output are never attached &mdash; only the agent&apos;s own
            recap text, secret-scrubbed. (If the agent quoted a snippet in its summary, that quote
            rides along in the text.)
          </li>
        </ul>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        {/* STYLE-01: shared modal-button grammar (filled accent primary at AA contrast). */}
        <button
          className="ca-btn-ghost"
          disabled={busy}
          onClick={() => void decide('declined')}
          data-test="recap-decline"
        >
          No thanks
        </button>
        <button
          className="ca-btn-primary"
          disabled={busy}
          onClick={() => void decide('enabled')}
          data-test="recap-enable"
        >
          Enable recaps
        </button>
      </div>
    </Modal>
  )
}

const linkBtn = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  fontSize: 12,
  marginTop: 4
} as const

const snippet = {
  background: 'var(--inset)',
  padding: 10,
  borderRadius: 8,
  fontSize: 11,
  overflow: 'auto',
  margin: '4px 0 0'
} as const

const assure = {
  background: 'var(--inset)',
  borderRadius: 8,
  padding: 12,
  fontSize: 12,
  marginTop: 10
} as const
