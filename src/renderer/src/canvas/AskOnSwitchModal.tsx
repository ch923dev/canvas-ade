import { useState } from 'react'
import { Modal } from './Modal'
import {
  useAskOnSwitchStore,
  type AskOnSwitchChoice,
  type AskOnSwitchRequest
} from '../store/askOnSwitchStore'

/**
 * Ask-on-switch dialog (Background Project Sessions, Phase 4 — the approved
 * PHASE4-UX-DESIGN.md §1 card). Shown by `performProjectSwitch` ONLY when the outgoing
 * project has live resources AND no remembered keep policy. Chooser tiles (Keep default /
 * Stop), the opt-in forever checkbox (Keep-only — Stop disables it), ghost Cancel + primary
 * Switch. Esc / backdrop = Cancel (fail-safe, mirrors ConfirmModal).
 */

function counts(terminals: number, previews: number): string {
  const parts: string[] = []
  if (terminals > 0)
    parts.push(`${terminals} ${terminals === 1 ? 'terminal' : 'terminals'} running`)
  if (previews > 0) parts.push(`${previews} live ${previews === 1 ? 'preview' : 'previews'}`)
  return parts.join(' and ')
}

export default function AskOnSwitchModal(): React.ReactElement | null {
  const pending = useAskOnSwitchStore((s) => s.pending)
  const settle = useAskOnSwitchStore((s) => s.settle)
  if (!pending) return null
  // Keyed by reqId: React REMOUNTS the card per ask, so the tile/checkbox picks start fresh
  // every time without a reset-effect (state can never leak across requests).
  return <AskOnSwitchCard key={pending.reqId} pending={pending} settle={settle} />
}

function AskOnSwitchCard({
  pending,
  settle
}: {
  pending: AskOnSwitchRequest
  settle: (choice: AskOnSwitchChoice) => void
}): React.ReactElement {
  const [keep, setKeep] = useState(true)
  const [forever, setForever] = useState(false)

  const submit = (): void => {
    const choice: AskOnSwitchChoice = keep ? { action: 'keep', forever } : { action: 'stop' }
    settle(choice)
  }

  const tile = (on: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '9px 8px',
    borderRadius: 'var(--r-ctl, 5px)',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
    background: on ? 'var(--accent-wash)' : 'var(--surface)',
    color: on ? 'var(--text)' : 'var(--text-2)',
    fontSize: 'var(--fs-body)',
    cursor: 'pointer'
  })
  const cap: React.CSSProperties = {
    flex: 1,
    fontSize: 'var(--fs-meta)',
    lineHeight: 'var(--lh-meta)',
    color: 'var(--text-3)',
    textAlign: 'center'
  }

  return (
    <Modal
      label="Switch project"
      onClose={() => settle({ action: 'cancel' })}
      zIndex={10000}
      confirmGate
      scrimProps={{ 'data-testid': 'ask-switch-backdrop' }}
      cardProps={{ 'data-testid': 'ask-switch-modal' }}
      cardStyle={{ width: 420, maxWidth: '90vw', padding: 20 }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 'var(--fs-label)',
          fontWeight: 600,
          letterSpacing: 'var(--tr-label)'
        }}
      >
        {pending.incomingName ? `Switch to “${pending.incomingName}”?` : 'Switch project?'}
      </h2>
      <p
        style={{
          margin: '10px 0 18px',
          fontSize: 'var(--fs-body)',
          lineHeight: 'var(--lh-body)',
          color: 'var(--text-2)'
        }}
      >
        {pending.outgoingName} has {counts(pending.terminals, pending.previews)}.
      </p>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 'var(--fs-micro, 10px)',
          letterSpacing: 'var(--tr-micro)',
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          marginBottom: 9
        }}
      >
        What happens to them
      </div>
      <div role="radiogroup" aria-label="What happens to them" style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          role="radio"
          aria-checked={keep}
          data-testid="ask-switch-keep"
          onClick={() => setKeep(true)}
          style={tile(keep)}
        >
          Keep running in background
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!keep}
          data-testid="ask-switch-stop"
          onClick={() => {
            setKeep(false)
            setForever(false) // forever applies to Keep only
          }}
          style={tile(!keep)}
        >
          Stop everything and close
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, margin: '6px 0 14px' }}>
        <div style={cap}>processes keep going; won&rsquo;t ask again for this project</div>
        <div style={cap}>kills the agent processes + closes previews (asks each time)</div>
      </div>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          margin: '0 0 16px',
          fontSize: 'var(--fs-meta)',
          lineHeight: 'var(--lh-meta)',
          color: 'var(--text-2)',
          cursor: keep ? 'pointer' : 'not-allowed',
          opacity: keep ? 1 : 0.45
        }}
      >
        <input
          type="checkbox"
          data-testid="ask-switch-forever"
          checked={forever}
          disabled={!keep}
          onChange={(e) => setForever(e.target.checked)}
          style={{ accentColor: 'var(--accent)', marginTop: 1, cursor: 'inherit' }}
        />
        <span>
          Always keep this project in the background — remember even after Expanse restarts
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            flex: 1,
            fontFamily: 'var(--mono)',
            fontSize: 'var(--fs-micro, 10px)',
            color: 'var(--text-3)'
          }}
        >
          Remembered this app session; check above for forever
        </span>
        <button
          type="button"
          className="ca-btn-ghost"
          data-testid="ask-switch-cancel"
          onClick={() => settle({ action: 'cancel' })}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ca-btn-primary"
          data-testid="ask-switch-confirm"
          onClick={submit}
        >
          Switch
        </button>
      </div>
    </Modal>
  )
}
