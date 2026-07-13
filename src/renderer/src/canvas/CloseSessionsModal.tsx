/**
 * Close modal (PR-2 background sessions, mock 1 of mock-background-sessions.html — the
 * user-approved design): shown by MAIN's close guard for a user-initiated close with ≥1
 * daemon-backed session. Honest status dots (running --ok vs idle-dimmed --text-faint),
 * relative ages, primary (Enter, via initial focus) = "Keep running in background" — the
 * no-work-lost default; "Stop all & close" is explicit red-ink ghost; Esc cancels. The
 * backdrop is inert: closing an app full of live agents is decided by a button, not a
 * stray click (the ConfirmModal contract).
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { CloseSessionRow } from '../../../shared/closeGuardTypes'
import { formatSessionAge } from '../../../shared/closeGuardTypes'
import { Modal } from './Modal'

type Reply = (answer: { action: 'keep' | 'stop' | 'cancel'; remember: boolean }) => void

interface PendingQuery {
  sessions: CloseSessionRow[]
  reply: Reply
  /** Epoch ms at query receipt — the age labels' snapshot base (render must stay pure). */
  now: number
}

/** "board title · cwd folder" locator, mock-1's dimmed middle column. */
function whereOf(row: CloseSessionRow): string {
  const folder = row.cwd ? (row.cwd.replace(/\\/g, '/').split('/').pop() ?? '') : ''
  return [row.title, folder].filter(Boolean).join(' · ')
}

function ageOf(row: CloseSessionRow, now: number): string {
  if (row.running) {
    const age = row.startedAt ? formatSessionAge(now, row.startedAt) : ''
    return age ? `running ${age}` : 'running'
  }
  const idle = row.lastActivityAt ? formatSessionAge(now, row.lastActivityAt) : ''
  return idle ? `idle ${idle}` : 'idle'
}

export default function CloseSessionsModal(): ReactElement | null {
  const [pending, setPending] = useState<PendingQuery | null>(null)
  const [remember, setRemember] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onCloseQuery = window.api?.closeGuard?.onCloseQuery
    if (!onCloseQuery) return
    return onCloseQuery((sessions, reply) => {
      setRemember(false) // never carry a previous ask's tick into a fresh one
      // `now` is captured at receipt (ages are a snapshot of the close moment) — render stays pure.
      setPending({ sessions, reply, now: Date.now() })
    })
  }, [])

  // Reads state + replies outside any setState updater (an updater must stay pure — StrictMode
  // double-invokes it, which would double-fire the reply). Re-entry is a no-op once cleared.
  const answer = (action: 'keep' | 'stop' | 'cancel'): void => {
    if (!pending) return
    pending.reply({ action, remember })
    setPending(null)
  }

  if (!pending) return null
  const now = pending.now
  const runningCount = pending.sessions.filter((s) => s.running).length
  const sub =
    runningCount > 0
      ? `${runningCount} agent${runningCount === 1 ? ' is' : 's are'} still working. Keep them running in the background and pick them up when you reopen — or stop everything now.`
      : 'Your sessions can keep running in the background — pick them up when you reopen, or stop everything now.'

  return (
    <Modal
      label="Close Expanse?"
      onClose={() => answer('cancel')} // Esc = cancel (the safe floor: nothing changes)
      scrimClose={false}
      zIndex={10000}
      confirmGate
      initialFocusRef={keepRef} // Enter answers the focused primary = keep (mock kbd-hint)
      scrimProps={{ 'data-testid': 'close-modal-backdrop' }}
      cardProps={{ 'data-testid': 'close-modal' }}
      cardStyle={{ width: 430, maxWidth: '90vw', padding: '18px 18px 16px' }}
    >
      <h2 style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600 }}>
        Close Expanse?
      </h2>
      <p
        style={{ margin: '6px 0 14px', fontSize: 12.5, lineHeight: '18px', color: 'var(--text-2)' }}
      >
        {sub}
      </p>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          marginBottom: 14,
          maxHeight: '40vh',
          overflowY: 'auto'
        }}
      >
        {pending.sessions.map((s) => (
          <div
            key={s.id}
            data-testid="close-modal-session"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: 'var(--surface-raised)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: '8px 10px',
              opacity: s.running ? 1 : 0.55
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flex: 'none',
                background: s.running ? 'var(--ok)' : 'var(--text-faint)'
              }}
            />
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: 'var(--text)',
                fontWeight: 500,
                whiteSpace: 'nowrap'
              }}
            >
              {s.cmd}
            </span>
            <span
              style={{
                fontSize: 11.5,
                color: 'var(--text-3)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {whereOf(s)}
            </span>
            <span
              style={{
                marginLeft: 'auto',
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--text-3)',
                whiteSpace: 'nowrap'
              }}
            >
              {ageOf(s, now)}
            </span>
          </div>
        ))}
      </div>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: 'var(--text-2)',
          marginBottom: 16,
          cursor: 'pointer'
        }}
      >
        <input
          type="checkbox"
          data-testid="close-modal-remember"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          style={{ accentColor: 'var(--accent)', margin: 0 }}
        />
        Always do this — change later in Settings › Terminal
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
        <span
          style={{
            marginRight: 'auto',
            fontFamily: 'var(--mono)',
            fontSize: 10.5,
            color: 'var(--text-faint)'
          }}
        >
          enter = keep · esc = cancel
        </span>
        <button
          type="button"
          className="ca-btn-ghost"
          data-testid="close-modal-cancel"
          onClick={() => answer('cancel')}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ca-btn-ghost ca-btn-ghost-danger"
          data-testid="close-modal-stop"
          onClick={() => answer('stop')}
        >
          Stop all &amp; close
        </button>
        <button
          type="button"
          ref={keepRef}
          className="ca-btn-primary"
          data-testid="close-modal-keep"
          onClick={() => answer('keep')}
        >
          Keep running in background
        </button>
      </div>
    </Modal>
  )
}
