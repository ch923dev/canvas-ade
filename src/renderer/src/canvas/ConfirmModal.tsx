import { useCallback, useEffect, useState } from 'react'

/**
 * 🔒 Human-confirm modal (T4.2). MAIN posts a confirm request over `mcp:confirm`
 * (every dangerous MCP action — dispatch/merge/permission — gates on it); this renders
 * a blocking modal and replies the human's decision. MAIN owns the gate: the calling
 * tool stays blocked until a reply arrives, and MAIN treats anything but an explicit
 * approve as a deny (fail-closed, see `mcpConfirm.ts`).
 *
 * Requests queue (FIFO) so two dispatches can't race a single modal; the head shows,
 * and answering advances to the next. Esc / clicking the backdrop denies.
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

  // Esc denies the head (only while a modal is showing). Re-registers when the head
  // changes so the listener always reflects whether a modal is up.
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, answer])

  if (!current) return null

  return (
    <div
      data-testid="confirm-backdrop"
      // Marks an active human-confirm gate so other window-level Esc handlers (e.g. the
      // full-view capture-phase listener in useCanvasKeybindings) can detect it and refrain
      // from stealing Esc — Esc must reach this modal's bubble listener to DENY first (BUG-005).
      data-confirm-active=""
      onClick={() => answer(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)'
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
        data-testid="confirm-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 420,
          maxWidth: '90vw',
          background: 'var(--surface-overlay)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 20,
          fontFamily: 'var(--ui)',
          color: 'var(--text)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)'
        }}
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
              color: '#fff',
              background: 'var(--accent)',
              borderColor: 'var(--accent)'
            }}
          >
            {current.confirmLabel ?? 'Approve'}
          </button>
        </div>
      </div>
    </div>
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
