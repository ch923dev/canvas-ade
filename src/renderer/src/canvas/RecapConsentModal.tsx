/**
 * Task 13: per-project consent modal for the terminal-recap feature.
 * Portaled to <body> over a scrim, design-token styled (mirrors SettingsModal).
 * Shows once per project when consent is 'undecided'; user picks Enable or Not now.
 * Privacy copy is a hard requirement — keep accurate (no false "nothing ever leaves" claim).
 */
import { createPortal } from 'react-dom'
import { useEffect, useState, type ReactElement } from 'react'

export function RecapConsentModal({ onClose }: { onClose: () => void }): ReactElement {
  const [busy, setBusy] = useState(false)
  const [showSnippet, setShowSnippet] = useState(false)

  const decide = async (decision: 'enabled' | 'declined'): Promise<void> => {
    setBusy(true)
    try {
      await window.api.recap.setConsent(decision)
    } finally {
      setBusy(false)
      onClose()
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  return createPortal(
    <div style={scrim} data-test="recap-consent-scrim" onPointerDown={() => !busy && onClose()}>
      <div
        style={card}
        role="dialog"
        aria-modal="true"
        aria-label="Agent recaps"
        data-test="recap-consent-modal"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: 0, fontSize: 16 }}>Turn on agent recaps for this project?</h2>
        <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: '1.5', color: 'var(--text-2)' }}>
          See what each terminal agent is doing at a glance. Expanse gives every terminal a
          flip-to-recap &mdash; a short &ldquo;now&rdquo; summary + a timestamped timeline of what
          the agent and you decided &mdash; so you can resume instantly instead of re-reading the
          whole session.
        </p>
        <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: '1.5', color: 'var(--text-2)' }}>
          To do this, Expanse adds <b>one hook</b> to this project&apos;s{' '}
          <code>.claude/settings.local.json</code> (<b>gitignored &mdash; never committed</b>; it
          does <b>not</b> touch your global <code>~/.claude</code> or your own hooks). It records
          only each session&apos;s id + transcript path.
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
            <li>No Expanse server, no account, no telemetry &mdash; nothing is ever sent to us.</li>
            <li>Transcripts are read locally, on your machine.</li>
            <li>
              The only thing that leaves is a short, secret-scrubbed slice sent to the LLM provider{' '}
              <i>you</i> choose, with <i>your</i> key &mdash; only if you set one. Pick a local
              model &rarr; nothing leaves.
            </li>
            <li>File contents and command output are never sent.</li>
          </ul>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button
            disabled={busy}
            onClick={() => void decide('declined')}
            data-test="recap-decline"
            style={ghostBtn}
          >
            Not now
          </button>
          <button
            disabled={busy}
            onClick={() => void decide('enabled')}
            data-test="recap-enable"
            style={primaryBtn}
          >
            Enable recaps
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

const scrim = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.45)',
  display: 'grid',
  placeItems: 'center',
  zIndex: 1000
} as const

const card = {
  background: 'var(--surface-raised)',
  color: 'var(--text)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  padding: 20,
  maxWidth: 460,
  boxShadow: 'var(--shadow-pop)'
} as const

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

const ghostBtn = {
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontSize: 12.5,
  cursor: 'pointer'
} as const

const primaryBtn = {
  height: 30,
  padding: '0 14px',
  borderRadius: 6,
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer'
} as const
