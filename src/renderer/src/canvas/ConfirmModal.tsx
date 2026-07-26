import { useCallback, useEffect, useState } from 'react'
import type {
  ConfirmChoices,
  ConfirmDiff,
  ConfirmReplyDecision,
  ConfirmWorkerConfig
} from '../../../shared/mcpTypes'
import { Modal } from './Modal'
import { useJarvisStore } from '../store/jarvisStore'
import { WorkerConfigDialog } from './boards/command/WorkerConfigDialog'
import { packOptionValues, rolePackById } from '../lib/rolePacks'

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

// P5 chooser + S1 worker-config + the reply decision are the CANONICAL shared contract types
// (src/shared/mcpTypes.ts) — the same declarations MAIN's mcpConfirm.ts uses, so a field drift
// between the two sides is a compile error, not a runtime surprise (the McpCommand discipline).
interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  denyLabel?: string
  choices?: ConfirmChoices
  workerConfig?: ConfirmWorkerConfig
  /** Diagram Phase 3 (Option B): optional structured semantic diff for a diagram-spec write —
   *  rendered as coloured rows + lint chips above the plain body. Presentation only; the body
   *  stays the complete fallback (and the ONLY thing the Jarvis panel route renders). */
  diff?: ConfirmDiff
  /** J4: MAIN-stamped Jarvis-tool origin (see routing note in the subscribe effect). */
  origin?: 'jarvis'
}
type Reply = (decision: ConfirmReplyDecision) => void
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
      if (
        r.origin === 'jarvis' &&
        !r.choices &&
        !r.workerConfig &&
        useJarvisStore.getState().panelOpen
      ) {
        useJarvisStore.getState().confirmRequested({ title: r.title, body: r.body }, reply)
        return
      }
      setQueue((q) => [...q, { ...request, reply, choice: request.choices?.default }])
    })
  }, [])

  if (!current) return null

  // 🔒 S1 swarm spawn: a workerConfig request renders the FULL worker-config dialog (the command
  // board's spawn surface — role row, presets, builder, editable launch) instead of the plain
  // approve/deny card. Commit replies the dialog's launch line + role; Cancel/Esc denies. MAIN
  // re-validates the reply (single-line/bounded launch, registry-known pack) before spawning.
  if (current.workerConfig) {
    const wc = current.workerConfig
    const pack = rolePackById(wc.roleId)
    return (
      <WorkerConfigDialog
        mode="spawn"
        zoneName={wc.workerName}
        engineeredPrompt=""
        initial={
          pack
            ? {
                presetId: 'claude',
                values: {
                  ...packOptionValues(pack),
                  ...(wc.modelDefault ? { model: wc.modelDefault } : {})
                },
                rawOverride: null,
                rolePackId: pack.id,
                roleBrief: pack.systemPrompt
              }
            : null
        }
        onDispatch={({ launchCommand, config }) => {
          setQueue((q) => {
            const [head, ...rest] = q
            head?.reply({
              approved: true,
              launchCommand,
              ...(config.rolePackId ? { rolePackId: config.rolePackId } : {}),
              // v20: the dialog's OpenRouter intent rides only when ON; MAIN re-validates the
              // slug (single clean token) before it reaches the spawn.
              ...(config.openRouter?.enabled
                ? {
                    openRouter: {
                      enabled: true,
                      ...(config.openRouter.model ? { model: config.openRouter.model } : {})
                    }
                  }
                : {})
            })
            return rest
          })
        }}
        onCancel={() => answer(false)}
      />
    )
  }

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
      {current.diff && (
        // Diagram Phase 3 (Option B, user-signed mock): semantic-diff rows + lint chips. Pure
        // presentation over text — every string renders as a text node; the complete plain body
        // stays below (scrollable) so nothing is reviewable only through this block.
        <div data-testid="confirm-diff" style={{ margin: '10px 0 0' }}>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 'var(--fs-meta)',
              lineHeight: 'var(--lh-meta)',
              color: 'var(--text-3)',
              whiteSpace: 'pre-wrap',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {current.diff.summary}
          </div>
          <div
            style={{
              margin: '8px 0 0',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-inner)',
              background: 'var(--inset)',
              padding: '8px 0',
              maxHeight: '38vh',
              overflowY: 'auto'
            }}
          >
            {current.diff.sections.map((s, si) => (
              <div key={si}>
                <div
                  style={{
                    padding: '5px 12px 2px',
                    fontSize: 'var(--fs-micro)',
                    lineHeight: 'var(--lh-micro)',
                    fontWeight: 'var(--fw-micro)' as never,
                    letterSpacing: 'var(--tr-micro)',
                    textTransform: 'uppercase',
                    color: 'var(--text-faint)'
                  }}
                >
                  {s.title}
                </div>
                {s.rows.map((row, ri) => (
                  <div
                    key={ri}
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: '1px 12px',
                      fontFamily: 'var(--mono)',
                      fontSize: 'var(--fs-meta)',
                      lineHeight: '18px',
                      color: row.sig === '−' ? 'var(--text-3)' : 'var(--text-2)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }}
                  >
                    <span
                      style={{
                        width: 10,
                        flex: 'none',
                        textAlign: 'center',
                        color:
                          row.sig === '+'
                            ? 'var(--ok)'
                            : row.sig === '~'
                              ? 'var(--warn)'
                              : 'var(--err)'
                      }}
                    >
                      {row.sig}
                    </span>
                    <span>{row.text}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {current.diff.lints.length > 0 && (
            <div style={{ margin: '8px 0 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {current.diff.lints.map((warn, wi) => (
                <div
                  key={wi}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    background: 'var(--warn-wash)',
                    border: '1px solid rgba(232, 179, 57, 0.25)',
                    borderRadius: 'var(--r-ctl)',
                    padding: '6px 10px',
                    fontSize: 'var(--fs-meta)',
                    lineHeight: 'var(--lh-meta)',
                    color: 'var(--text-2)'
                  }}
                >
                  <span style={{ color: 'var(--warn)', fontFamily: 'var(--mono)', flex: 'none' }}>
                    ⚠
                  </span>
                  <span>{warn}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <p
        style={{
          margin: '10px 0 18px',
          // With a structured diff above (Phase 3), the body is the de-emphasized full-text
          // fallback (still visible + scrollable — never hidden; ADR 0003) at meta size so the
          // diff + buttons keep the viewport.
          fontSize: current.diff ? 'var(--fs-meta)' : 'var(--fs-body)',
          lineHeight: current.diff ? 'var(--lh-meta)' : 'var(--lh-body)',
          color: current.diff ? 'var(--text-3)' : 'var(--text-2)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          // A long body (e.g. an MCP planning write showing the full content, S2) must not
          // push the Approve/Deny buttons off-screen — keep the body scrollable so the gate
          // stays usable and the full content remains reviewable (ADR 0003).
          maxHeight: current.diff ? '16vh' : '50vh',
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
