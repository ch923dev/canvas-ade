/**
 * "Spawn as orchestrator" — the creation-time lead grant row (orchestration S1), extracted from
 * NewTerminalDialog.tsx at the max-lines ratchet. CREATE-ONLY: the designation must land BEFORE
 * the held spawn is released so the terminal boots holding a lead token (the spawn-time seam
 * mints by designation — no restart, unlike the deleted Settings picker which always granted
 * after the spawn); a live board promotes from its ⋯ menu instead. Disabled states carry the
 * reason inline — never a click that fails.
 */
import { type CSSProperties, type ReactElement } from 'react'
import { Icon } from '../../Icon'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'

/** Row availability: consent on + no OTHER board holding the role + a project open. */
export interface LeadRowGate {
  disabled: boolean
  heldElsewhere: boolean
  holderTitle: string
  orchestrationEnabled: boolean
}

export function useLeadRowGate(boardId: string): LeadRowGate {
  const orchestrationEnabled = useOrchestrationStore((s) => s.enabled)
  const leadBoardId = useOrchestrationStore((s) => s.leadBoardId)
  const holderTitle = useCanvasStore(
    (s) => s.boards.find((b) => b.id === leadBoardId)?.title ?? 'Another terminal'
  )
  const projectDir = useCanvasStore((s) => s.project.dir)
  const heldElsewhere = leadBoardId !== null && leadBoardId !== boardId
  return {
    disabled: !orchestrationEnabled || heldElsewhere || projectDir === null,
    heldElsewhere,
    holderTitle,
    orchestrationEnabled
  }
}

/**
 * Grant with a brief `not-found` retry (the placed board reaches MAIN's mirror on a ~150ms
 * publish debounce). Resolves null on success, else the inline error copy.
 */
export async function grantLeadWithRetry(boardId: string): Promise<string | null> {
  try {
    let r = await window.api.orchestration.grantLead(boardId)
    for (let i = 0; i < 3 && !r.ok && r.reason === 'not-found'; i++) {
      await new Promise((res) => setTimeout(res, 250))
      r = await window.api.orchestration.grantLead(boardId)
    }
    if (r.ok) return null
    return r.reason === 'already-active'
      ? 'Another terminal took the orchestrator role just now — revoke it from that board’s menu first, or untick the option.'
      : r.reason === 'consent'
        ? 'Agent orchestration was disabled for this project — enable it first, or untick the option.'
        : r.reason === 'no-server'
          ? 'The orchestration server could not start — try again, or untick the option.'
          : 'Could not grant the orchestrator role — try again, or untick the option.'
  } catch {
    return 'Could not grant the orchestrator role — try again, or untick the option.'
  }
}

export function OrchestratorLeadRow({
  gate,
  ticked,
  error,
  onToggle
}: {
  gate: LeadRowGate
  ticked: boolean
  error: string | null
  onToggle: () => void
}): ReactElement {
  const on = ticked && !gate.disabled
  return (
    <div style={{ ...block, ...(on ? blockOn : null) }} data-test="new-terminal-lead-row">
      <button
        type="button"
        style={{ ...check, ...(gate.disabled ? { cursor: 'not-allowed' } : null) }}
        onClick={() => {
          if (!gate.disabled) onToggle()
        }}
        aria-pressed={ticked}
        aria-disabled={gate.disabled || undefined}
        data-test="new-terminal-lead-toggle"
      >
        <span
          style={{ ...box, ...(on ? boxOn : null), ...(gate.disabled ? { opacity: 0.4 } : null) }}
        >
          {on && <Icon name="check" size={11} style={{ color: 'var(--void)' }} />}
        </span>
        <span style={{ ...lbl, ...(gate.disabled ? { color: 'var(--text-3)' } : null) }}>
          Spawn as orchestrator
        </span>
        <span style={hint}>grants the lead role</span>
      </button>
      <span style={why}>
        {gate.heldElsewhere ? (
          <>
            <b style={{ color: 'var(--text-2)' }}>{gate.holderTitle}</b> already holds the lead
            role. Revoke it from that board&rsquo;s menu first.
          </>
        ) : !gate.orchestrationEnabled ? (
          <>
            Enable Agent orchestration for this project first — the lead role rides the same
            consent.
          </>
        ) : (
          <>
            This terminal&rsquo;s agent can spawn worker terminals and dispatch along its own
            cables. <b style={{ color: 'var(--text-2)' }}>Every dispatch still asks you first.</b>{' '}
            One orchestrator at a time; revoke from the board menu.
          </>
        )}
      </span>
      {error && (
        <span
          role="alert"
          style={{ ...why, color: 'var(--err)' }}
          data-test="new-terminal-lead-error"
        >
          {error}
        </span>
      )}
    </div>
  )
}

// The dialog's check/box recipe (kept visually identical) + the S1 inset block.
const block: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  borderRadius: 'var(--r-inner)',
  padding: '9px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6
}
const blockOn: CSSProperties = {
  borderColor: 'rgba(79, 140, 255, 0.28)',
  background: 'var(--accent-wash)'
}
const check: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  border: 'none',
  background: 'transparent',
  padding: 0,
  cursor: 'pointer',
  textAlign: 'left'
}
const box: CSSProperties = {
  width: 16,
  height: 16,
  flex: 'none',
  borderRadius: 4,
  border: '1px solid var(--border-strong)',
  background: 'transparent',
  display: 'grid',
  placeItems: 'center'
}
const boxOn: CSSProperties = { background: 'var(--accent)', borderColor: 'var(--accent)' }
const lbl: CSSProperties = { fontSize: 12.5, color: 'var(--text)' }
const hint: CSSProperties = { fontSize: 11, color: 'var(--text-3)' }
const why: CSSProperties = { fontSize: 11, lineHeight: '16px', color: 'var(--text-3)' }
