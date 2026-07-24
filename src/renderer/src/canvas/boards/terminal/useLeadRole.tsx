/**
 * Terminal lead-role surface (orchestration S1) — the board-level half of the lead entry-point
 * revamp that replaced the Settings › Lead terminal picker. One hook per TerminalBoard provides:
 *
 *   - `isLead` — this board holds the designation (drives the LEAD title badge + frame ring).
 *   - `menuItems` — the ⋯-menu rows: Grant orchestrator role (none held), the state row +
 *     Revoke (this board holds it), or Grant-with-confirm (ANOTHER board holds it — the
 *     revoke-and-grant confirm below). Omitted entirely while orchestration consent is off:
 *     no dead rows in every terminal menu; the New Terminal dialog + Settings teach the feature.
 *   - `confirmEl` — the already-active confirm modal (Q2 single-active-lead stays enforced in
 *     MAIN's leadAuthority; this UI just stops making the user go find the other board).
 *
 * Semantics are UNCHANGED from Phase 1: granting DESIGNATES only — the lead token is minted by
 * the spawn-time provisioning seam when the agent next (re)starts. Promoting a LIVE terminal
 * therefore discloses the required restart in a toast and makes it one click (the palette
 * restart intent); revoke is immediate. State is the orchestrationStore reactive cache, kept
 * live by MAIN's `orchestration:leadChanged` push.
 */
import { useCallback, useState, type ReactElement } from 'react'
import type { CSSProperties } from 'react'
import type { BoardMenuExtraItem } from '../../BoardFrame'
import { Modal } from '../../Modal'
import { useCanvasStore } from '../../../store/canvasStore'
import { useOrchestrationStore } from '../../../store/orchestrationStore'
import { showToast } from '../../../store/toastStore'
import { sendPaletteIntent } from '../../palette/paletteIntentStore'

/** The quiet accent-tinted LEAD chip rendered beside the title (BoardFrame `titleBadge`). */
export function LeadBadge(): ReactElement {
  return (
    <span style={badge} data-test="terminal-lead-badge">
      Lead
    </span>
  )
}

export function useLeadRole(
  boardId: string,
  running: boolean
): {
  isLead: boolean
  menuItems: BoardMenuExtraItem[] | undefined
  confirmEl: ReactElement | null
} {
  const enabled = useOrchestrationStore((s) => s.enabled)
  const leadBoardId = useOrchestrationStore((s) => s.leadBoardId)
  const isLead = leadBoardId === boardId
  // The already-active confirm ("Revoke <holder> and grant here?"). null = closed.
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const grantHere = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await window.api.orchestration.grantLead(boardId)
      if (r.ok) {
        // Designation landed. A RUNNING agent keeps its old (connected-tier) token until it
        // restarts — the token mints at spawn — so the restart is real, disclosed, one click.
        showToast(
          running
            ? {
                message:
                  'This terminal holds the orchestrator role. Restart its agent to pick up the lead token.',
                kind: 'info',
                action: {
                  label: 'Restart agent',
                  run: () => sendPaletteIntent(boardId, 'restart-new')
                }
              }
            : {
                message:
                  'This terminal holds the orchestrator role — it applies when the agent starts.',
                kind: 'ok'
              }
        )
      } else if (r.reason === 'already-active') {
        // Raced (someone granted since the menu opened) — fall into the confirm flow.
        setConfirmOpen(true)
      } else {
        showToast({
          message:
            r.reason === 'consent'
              ? 'Enable agent orchestration for this project first.'
              : r.reason === 'no-server'
                ? 'Orchestration server is not running — open a terminal first, then try again.'
                : 'Could not grant the orchestrator role.',
          kind: 'error'
        })
      }
    } catch {
      showToast({ message: 'Could not grant the orchestrator role.', kind: 'error' })
    }
    setBusy(false)
  }, [boardId, running])

  const revoke = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.orchestration.revokeLead()
      showToast({
        message: 'Orchestrator role revoked — its token is dead immediately.',
        kind: 'ok'
      })
    } catch {
      showToast({ message: 'Could not revoke the orchestrator role.', kind: 'error' })
    }
    setBusy(false)
  }, [])

  // Revoke-then-grant for the already-active confirm. Two awaited steps on the SAME consent-gated
  // IPC surface the deleted Settings picker used; a failure between them leaves no lead designated
  // (safe — the next grant attempt starts clean).
  const revokeAndGrant = useCallback(async (): Promise<void> => {
    setConfirmOpen(false)
    setBusy(true)
    try {
      await window.api.orchestration.revokeLead()
    } catch {
      showToast({ message: 'Could not revoke the current orchestrator.', kind: 'error' })
      setBusy(false)
      return
    }
    setBusy(false)
    await grantHere()
  }, [grantHere])

  // Consent off → no rows at all (see header). Menu rows are computed fresh per render — the
  // menu itself only mounts while open, so this stays cheap.
  let menuItems: BoardMenuExtraItem[] | undefined
  if (enabled) {
    menuItems = isLead
      ? [
          {
            id: 'lead-state',
            label: 'Holds the orchestrator role',
            disabled: true,
            onSelect: () => {}
          },
          {
            id: 'lead-revoke',
            label: 'Revoke orchestrator role',
            danger: true,
            disabled: busy,
            onSelect: () => void revoke()
          }
        ]
      : [
          {
            id: 'lead-grant',
            label: 'Grant orchestrator role',
            disabled: busy,
            onSelect: () => {
              if (leadBoardId === null) void grantHere()
              else setConfirmOpen(true)
            }
          }
        ]
  }

  // Holder title resolved at render (the modal is rare + short-lived).
  const holderTitle =
    useCanvasStore((s) => s.boards.find((b) => b.id === leadBoardId)?.title) ?? 'Another terminal'

  const confirmEl = confirmOpen ? (
    <Modal
      label="Grant orchestrator role"
      onClose={() => setConfirmOpen(false)}
      zIndex={600}
      cardProps={{ 'data-test': 'lead-confirm-dialog' }}
      cardStyle={confirmCard}
    >
      <div style={confirmTitle}>Move the orchestrator role?</div>
      <div style={confirmBody}>
        <b>{holderTitle}</b> currently holds the orchestrator role. Revoke it (its token dies
        immediately) and grant the role to this terminal?
      </div>
      <div style={confirmFooter}>
        <button type="button" style={btnGhost} onClick={() => setConfirmOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          style={btnPrimary}
          onClick={() => void revokeAndGrant()}
          data-test="lead-confirm-grant"
        >
          Revoke &amp; grant
        </button>
      </div>
    </Modal>
  ) : null

  return { isLead, menuItems, confirmEl }
}

const badge: CSSProperties = {
  flex: 'none',
  fontFamily: 'var(--mono)',
  fontSize: 'var(--fs-micro)',
  lineHeight: 'var(--lh-micro)',
  fontWeight: 'var(--fw-micro)',
  letterSpacing: 'var(--tr-micro)',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  background: 'var(--accent-wash)',
  border: '1px solid rgba(79, 140, 255, 0.4)',
  borderRadius: 'var(--r-ctl)',
  padding: '0 5px'
}

const confirmCard: CSSProperties = {
  width: 380,
  maxWidth: '92vw',
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 12
}
const confirmTitle: CSSProperties = {
  fontSize: 'var(--fs-h)',
  lineHeight: 'var(--lh-h)',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--text)'
}
const confirmBody: CSSProperties = {
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--text-2)'
}
const confirmFooter: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
const btnGhost: CSSProperties = {
  height: 30,
  padding: '0 14px',
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'transparent',
  color: 'var(--text-2)',
  fontFamily: 'var(--ui)',
  fontSize: 12.5,
  cursor: 'pointer'
}
const btnPrimary: CSSProperties = {
  ...btnGhost,
  border: '1px solid var(--accent)',
  background: 'var(--accent-wash)',
  color: 'var(--accent)',
  fontWeight: 600
}
