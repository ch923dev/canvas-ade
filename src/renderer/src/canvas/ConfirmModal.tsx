import { useCallback, useEffect, useState } from 'react'
import { Modal } from './Modal'

/**
 * 🔒 Human-confirm modal (T4.2). MAIN posts a confirm request over `mcp:confirm`
 * (every dangerous MCP action — dispatch/merge/permission — gates on it); this renders
 * a blocking modal and replies the human's decision. MAIN owns the gate: the calling
 * tool stays blocked until a reply arrives, and MAIN treats anything but an explicit
 * approve as a deny (fail-closed, see `mcpConfirm.ts`).
 *
 * Requests queue (FIFO) so two dispatches can't race a single modal; the head shows,
 * and answering advances to the next. Esc / a backdrop pointerdown denies (both routed
 * through the shared Modal's onClose). `confirmGate` marks the scrim with
 * `[data-confirm-active]` so the full-view capture-phase Esc listener in
 * useCanvasKeybindings yields Esc to this modal — it must DENY first (BUG-005).
 */

interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  denyLabel?: string
}
type Reply = (decision: { approved: boolean }) => void
interface Pending extends ConfirmRequest {
  reply: Reply
}

export default function ConfirmModal(): React.ReactElement | null {
  const [queue, setQueue] = useState<Pending[]>([])
  const current = queue[0] ?? null

  // Answer the head request and advance the queue. Idempotent per request.
  const answer = useCallback((approved: boolean): void => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.reply({ approved })
      return rest
    })
  }, [])

  useEffect(() => {
    const onConfirm = window.api?.mcp?.onConfirm
    if (!onConfirm) return
    return onConfirm((request, reply) => {
      setQueue((q) => [...q, { ...request, reply }])
    })
  }, [])

  if (!current) return null

  return (
    <Modal
      label={current.title}
      // Esc and the backdrop both DENY (fail-safe direction).
      onClose={() => answer(false)}
      zIndex={10000}
      confirmGate
      scrimProps={{ 'data-testid': 'confirm-backdrop' }}
      cardProps={{ 'data-testid': 'confirm-modal' }}
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
        {current.title}
      </h2>
      <p
        style={{
          margin: '10px 0 18px',
          fontSize: 'var(--fs-body)',
          lineHeight: 'var(--lh-body)',
          color: 'var(--text-2)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {current.body}
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          data-testid="confirm-deny"
          onClick={() => answer(false)}
          style={{ ...btn, color: 'var(--text-2)', background: 'var(--surface-raised)' }}
        >
          {current.denyLabel ?? 'Deny'}
        </button>
        <button
          type="button"
          data-testid="confirm-approve"
          onClick={() => answer(true)}
          style={{
            ...btn,
            color: 'var(--text)',
            background: 'var(--accent)',
            borderColor: 'var(--accent)'
          }}
        >
          {current.confirmLabel ?? 'Approve'}
        </button>
      </div>
    </Modal>
  )
}

const btn: React.CSSProperties = {
  padding: '6px 14px',
  fontFamily: 'var(--ui)',
  fontSize: 'var(--fs-label)',
  fontWeight: 500,
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer'
}
