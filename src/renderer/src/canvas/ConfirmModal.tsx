import { useCallback, useEffect, useState } from 'react'
import { Modal } from './Modal'
import { useJarvisStore } from '../store/jarvisStore'

/**
 * 🔒 Human-confirm modal (T4.2). MAIN posts a confirm request over `mcp:confirm`
 * (every dangerous MCP action — dispatch/merge/permission — gates on it); this renders
 * a blocking modal and replies the human's decision. MAIN owns the gate: the calling
 * tool stays blocked until a reply arrives, and MAIN treats anything but an explicit
 * approve as a deny (fail-closed, see `mcpConfirm.ts`).
 *
 * Requests queue (FIFO) so two dispatches can't race a single modal; the head shows,
 * and answering advances to the next. Esc DENIES (routed through the shared Modal's
 * onClose); a backdrop pointerdown is INERT (`scrimClose={false}`) — a dangerous
 * dispatch decision must be an explicit Approve/Deny click, never an accidental
 * click-outside. `confirmGate` marks the scrim with `[data-confirm-active]` so the
 * full-view capture-phase Esc listener in useCanvasKeybindings yields Esc to this
 * modal — it must DENY first (BUG-005).
 */

/** P5: an optional layout chooser attached to a request (mirrors main `ConfirmChoices`). */
interface ConfirmChoices {
  label?: string
  options: Array<{ id: string; label: string }>
  default: string
}
interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  denyLabel?: string
  choices?: ConfirmChoices
  /** J4: MAIN-stamped Jarvis-tool origin (see routing note in the subscribe effect). */
  origin?: 'jarvis'
}
type Reply = (decision: { approved: boolean; choice?: string }) => void
interface Pending extends ConfirmRequest {
  reply: Reply
  // P5: the current chooser pick, initialized to `choices.default` on enqueue. Held ON the queue
  // item (not a separate reset-effect) so it can never leak across requests + rides back on approve.
  choice?: string
}

export default function ConfirmModal(): React.ReactElement | null {
  const [queue, setQueue] = useState<Pending[]>([])
  const current = queue[0] ?? null

  // Answer the head request and advance the queue. Idempotent per request. The chooser pick rides
  // back ONLY on an approve (a deny/cancel picked nothing) and only when the head had choices; MAIN
  // re-validates it against the offered set (fail-safe).
  const answer = useCallback((approved: boolean): void => {
    setQueue((q) => {
      const [head, ...rest] = q
      head?.reply(approved && head.choices ? { approved, choice: head.choice } : { approved })
      return rest
    })
  }, [])

  // P5: update the head request's chooser pick (the tile click).
  const pickChoice = useCallback((id: string): void => {
    setQueue((q) => (q.length ? [{ ...q[0], choice: id }, ...q.slice(1)] : q))
  }, [])

  useEffect(() => {
    const onConfirm = window.api?.mcp?.onConfirm
    if (!onConfirm) return
    return onConfirm((request, reply) => {
      // 🔒 J4 routing — this component owns the ONE 'mcp:confirm' subscriber (BUG-029), so
      // the Jarvis panel cannot subscribe itself; route here instead. A MAIN-stamped
      // origin:'jarvis' request renders as the panel's turn-act card — SAME reply channel,
      // same fail-closed discipline (the panel teardown/supersede answers false) — except:
      // a CHOOSER request (visualize_plan) keeps this modal (the layout tiles need it —
      // user-decided 2026-07-16), and a closed panel falls back here too (no dead gates).
      const r = request as ConfirmRequest
      if (r.origin === 'jarvis' && !r.choices && useJarvisStore.getState().panelOpen) {
        useJarvisStore.getState().confirmRequested({ title: r.title, body: r.body }, reply)
        return
      }
      setQueue((q) => [...q, { ...request, reply, choice: request.choices?.default }])
    })
  }, [])

  if (!current) return null

  return (
    <Modal
      label={current.title}
      // Esc DENIES (fail-safe direction). The backdrop is inert — see scrimClose below.
      onClose={() => answer(false)}
      // 🔒 Click-outside must NOT decide a dangerous dispatch. Only the explicit Deny/Approve
      // buttons (or the Esc deny) answer the gate; a stray backdrop click is a no-op.
      scrimClose={false}
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
          wordBreak: 'break-word',
          // A long body (e.g. an MCP planning write showing the full content, S2) must not
          // push the Approve/Deny buttons off-screen — keep the body scrollable so the gate
          // stays usable and the full content remains reviewable (ADR 0003).
          maxHeight: '50vh',
          overflowY: 'auto'
        }}
      >
        {current.body}
      </p>
      {current.choices && (
        // P5: the layout chooser — the upgraded gate (the `visualize_plan` picker). The pick rides
        // back on the decision's `choice`; MAIN re-validates it against this bounded option set.
        <div style={{ margin: '0 0 18px' }}>
          {current.choices.label && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-micro, 10px)',
                letterSpacing: 'var(--tr-label)',
                textTransform: 'uppercase',
                color: 'var(--text-3)',
                marginBottom: 9
              }}
            >
              {current.choices.label}
            </div>
          )}
          <div
            role="radiogroup"
            aria-label={current.choices.label ?? 'Options'}
            style={{ display: 'flex', gap: 8 }}
          >
            {current.choices.options.map((o) => {
              const on = o.id === current.choice
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-testid={`confirm-choice-${o.id}`}
                  onClick={() => pickChoice(o.id)}
                  style={{
                    flex: 1,
                    padding: '9px 8px',
                    borderRadius: 'var(--r-ctl, 5px)',
                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                    background: on ? 'var(--accent-wash)' : 'var(--surface)',
                    color: on ? 'var(--text)' : 'var(--text-2)',
                    fontSize: 'var(--fs-body)',
                    cursor: 'pointer'
                  }}
                >
                  {o.label}
                </button>
              )
            })}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        {/* STYLE-01: shared modal-button grammar (filled accent primary at AA contrast). */}
        <button
          type="button"
          className="ca-btn-ghost"
          data-testid="confirm-deny"
          onClick={() => answer(false)}
        >
          {current.denyLabel ?? 'Deny'}
        </button>
        <button
          type="button"
          className="ca-btn-primary"
          data-testid="confirm-approve"
          onClick={() => answer(true)}
        >
          {current.confirmLabel ?? 'Approve'}
        </button>
      </div>
    </Modal>
  )
}
