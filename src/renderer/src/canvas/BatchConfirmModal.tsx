import { useCallback, useEffect, useState } from 'react'
import { Modal } from './Modal'

/**
 * 🔒 Per-row BATCH human-confirm modal (relay_prompts). MAIN posts ONE `mcp:confirm:batch` request
 * carrying several dispatch rows; this renders them in ONE modal so the human approves per row in a
 * single gesture, and replies the per-row decisions (positionally 1:1 with the rows). MAIN owns the
 * gate — the calling tool stays blocked until a reply arrives, and MAIN treats anything but an
 * explicit per-row approve as a deny (fail-closed, see `mcpConfirm.ts` `requestConfirmBatch`).
 *
 * Sibling of {@link ConfirmModal} (the single-item gate) — same FIFO queue, same `confirmGate` Esc
 * priority, and the SAME click-outside contract: Esc DENIES ALL (fail-safe), a backdrop pointerdown
 * is INERT (`scrimClose={false}`) — a batch of dangerous dispatches must be answered by the explicit
 * per-row controls, never an accidental click-outside.
 */

interface BatchItem {
  label: string
  body: string
}
interface BatchRequest {
  title: string
  items: BatchItem[]
}
type BatchReply = (decision: { decisions: Array<{ approved: boolean }> }) => void
interface Pending extends BatchRequest {
  reply: BatchReply
  // Per-row selection, initialized all-checked on enqueue. Held ON the queue item (not a separate
  // effect) so it can never leak across requests and rides back verbatim on the decision.
  selected: boolean[]
}

export default function BatchConfirmModal(): React.ReactElement | null {
  const [queue, setQueue] = useState<Pending[]>([])
  const current = queue[0] ?? null

  // Reply with the head's current per-row selection (checked → approved, unchecked → denied) and
  // advance the queue. Idempotent per request.
  const approveSelected = useCallback((): void => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.reply({ decisions: head.selected.map((approved) => ({ approved })) })
      return rest
    })
  }, [])

  // Deny EVERY row (Esc / the Deny-all button) and advance — the fail-safe direction.
  const denyAll = useCallback((): void => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.reply({ decisions: head.items.map(() => ({ approved: false })) })
      return rest
    })
  }, [])

  // Toggle one row's checkbox on the head request.
  const toggle = useCallback((i: number): void => {
    setQueue((q) => {
      if (!q.length) return q
      const head = q[0]
      const selected = head.selected.map((s, idx) => (idx === i ? !s : s))
      return [{ ...head, selected }, ...q.slice(1)]
    })
  }, [])

  useEffect(() => {
    const onConfirmBatch = window.api?.mcp?.onConfirmBatch
    if (!onConfirmBatch) return
    return onConfirmBatch((request, reply) => {
      setQueue((q) => [...q, { ...request, reply, selected: request.items.map(() => true) }])
    })
  }, [])

  if (!current) return null
  const approveCount = current.selected.filter(Boolean).length

  return (
    <Modal
      label={current.title}
      // Esc DENIES ALL (fail-safe). The backdrop is inert — see scrimClose below.
      onClose={denyAll}
      // 🔒 Click-outside must NOT decide a batch of dangerous dispatches; only the explicit
      // per-row controls (or the Esc deny) answer the gate.
      scrimClose={false}
      zIndex={10000}
      confirmGate
      scrimProps={{ 'data-testid': 'batch-confirm-backdrop' }}
      cardProps={{ 'data-testid': 'batch-confirm-modal' }}
      cardStyle={{ width: 520, maxWidth: '90vw', padding: 20 }}
    >
      <h2 style={{ margin: 0, fontSize: 'var(--fs-h)', fontWeight: 600, letterSpacing: '-0.01em' }}>
        {current.title}
      </h2>
      <p
        style={{
          margin: '8px 0 16px',
          fontSize: 'var(--fs-body)',
          lineHeight: 'var(--lh-body)',
          color: 'var(--text-2)'
        }}
      >
        Review each command. Only the rows you approve will run — each is written into its own
        terminal as a single, confirmed line.
      </p>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          maxHeight: '50vh',
          overflowY: 'auto',
          marginBottom: 12
        }}
      >
        {current.items.map((item, i) => {
          const on = current.selected[i]
          return (
            <button
              key={i}
              type="button"
              role="checkbox"
              aria-checked={on}
              data-testid={`batch-confirm-row-${i}`}
              onClick={() => toggle(i)}
              style={{
                display: 'grid',
                gridTemplateColumns: '20px 1fr',
                gap: 10,
                alignItems: 'start',
                textAlign: 'left',
                width: '100%',
                padding: '10px 11px',
                borderRadius: 'var(--r-ctl, 5px)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: on ? 'var(--accent-wash)' : 'var(--surface)',
                color: 'var(--text)',
                cursor: 'pointer',
                font: 'inherit'
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  marginTop: 1,
                  width: 18,
                  height: 18,
                  borderRadius: 4,
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: on ? 'var(--accent)' : 'var(--inset)',
                  color: 'var(--void)',
                  display: 'grid',
                  placeItems: 'center',
                  flex: 'none'
                }}
              >
                {on ? '✓' : ''}
              </span>
              <span>
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--mono)',
                    fontSize: 'var(--fs-meta)',
                    letterSpacing: '0.02em',
                    color: 'var(--text-3)',
                    marginBottom: 3
                  }}
                >
                  {item.label}
                </span>
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--mono)',
                    fontSize: 'var(--fs-term)',
                    lineHeight: 'var(--lh-term)',
                    color: 'var(--text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {item.body}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          className="ca-btn-ghost"
          data-testid="batch-confirm-deny"
          onClick={denyAll}
        >
          Deny all
        </button>
        <button
          type="button"
          className="ca-btn-primary"
          data-testid="batch-confirm-approve"
          disabled={approveCount === 0}
          onClick={approveSelected}
        >
          {approveCount > 0 ? `Approve ${approveCount}` : 'Approve'}
        </button>
      </div>
    </Modal>
  )
}
