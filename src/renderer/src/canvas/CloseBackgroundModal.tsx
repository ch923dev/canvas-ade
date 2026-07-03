import type { ReactElement } from 'react'
import { Modal } from './Modal'
import { closeBody } from './projectSessionsShared'

/**
 * The §3 per-project Close confirm (PHASE4-UX-DESIGN) — plain two-button card; the body
 * carries the consequence (no red-button grammar). Shared by the ProjectSwitcher's row-✕
 * and the ProjectDock's card-✕ (Phase 4b) so the confirm is literally the same surface.
 * Rendered only for a RUNNING target — idle residents close silently at the call sites.
 */
export function CloseBackgroundModal({
  target,
  onCancel,
  onConfirm
}: {
  target: { name: string; terminalsRunning: number; previews: number }
  onCancel: () => void
  onConfirm: () => void
}): ReactElement {
  return (
    <Modal
      label="Close project"
      onClose={onCancel}
      zIndex={10000}
      scrimProps={{ 'data-testid': 'close-bg-backdrop' }}
      cardProps={{ 'data-testid': 'close-bg-modal' }}
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
        Close “{target.name}”?
      </h2>
      <p
        style={{
          margin: '10px 0 18px',
          fontSize: 'var(--fs-body)',
          lineHeight: 'var(--lh-body)',
          color: 'var(--text-2)'
        }}
      >
        This stops {closeBody(target)}. The project stays on disk and in recents.
      </p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          className="ca-btn-ghost"
          data-testid="close-bg-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="ca-btn-primary"
          data-testid="close-bg-confirm"
          onClick={onConfirm}
        >
          Stop &amp; close
        </button>
      </div>
    </Modal>
  )
}
