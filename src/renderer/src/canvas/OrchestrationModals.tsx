/**
 * Agent Orchestration Onboarding (P2) — the single host for the orchestration onboarding modals,
 * mounted once in AppChrome. Owns:
 *   1. the first-init trigger — fires the Enable modal once per project when consent is undecided,
 *      on project open (recap-style; guarded against firing with no project open);
 *   2. the per-project hydration of the reactive `enabled` cache;
 *   3. rendering exactly one of { Enable, Sync } per the shared `modal` channel — so the Settings
 *      re-open controls (toggle → Enable, "Sync" button → Sync) drive the same single surface.
 *
 * The Sync step is owned by WT-provision (P3): replace <SyncStepPlaceholder/> below with the real
 * `<OrchestrationSyncModal/>` they export (endpoint row + per-CLI target rows + Sync now). The
 * mount point + the `modal === 'sync'` gating are the seam; the placeholder keeps the Enable→Sync
 * flow demonstrable until then.
 */
import { useEffect, type CSSProperties, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useOrchestrationStore } from '../store/orchestrationStore'
import { OrchestrationConsentModal } from './OrchestrationConsentModal'
import { Modal } from './Modal'

export function OrchestrationModals(): ReactElement {
  const projectDir = useCanvasStore((s) => s.project.dir)
  const modal = useOrchestrationStore((s) => s.modal)
  const setModal = useOrchestrationStore((s) => s.setModal)
  const setEnabled = useOrchestrationStore((s) => s.setEnabled)

  // First-init trigger + per-project hydration. Re-runs on a project switch (project.dir change):
  // each project carries its own consent, so an undecided project prompts once on open. Drive the
  // view in BOTH directions — open Enable when undecided, and CLOSE a modal left over from a
  // previous project when the new one is already decided (the recap fixed-scrim leak class). This
  // effect runs ONLY on a project change, so the Settings re-open paths (which set 'enable'/'sync'
  // directly within the same project) are never clobbered.
  useEffect(() => {
    let cancelled = false
    const run = async (): Promise<void> => {
      // Optional-chain the whole surface (matches AppChrome's recap guard): the api bridge can be
      // absent in smoke/test renders, and an unguarded access would throw on mount.
      let consent
      try {
        consent = await window.api?.orchestration?.getConsent?.()
      } catch {
        // IPC rejection (channel unavailable, teardown race) — silently skip the prompt.
        return
      }
      if (cancelled || !consent) return
      setEnabled(consent === 'enabled')
      if (consent !== 'undecided') {
        setModal('none')
        return
      }
      // Undecided → would prompt. But the terminal-recap feature ALSO first-fires its consent
      // modal on project open, and the shared Modal primitive isn't built for two simultaneous
      // instances (duelling focus traps; Esc closes both). So YIELD: defer the orchestration
      // prompt while recap consent is still undecided — recap (the pre-existing first-run prompt)
      // goes first, and orchestration prompts on the next project open (when recap is decided).
      // It is always reachable meanwhile from Settings. If the recap API/consent can't be read,
      // don't block — show orchestration.
      let recapConsent
      try {
        recapConsent = await window.api?.recap?.getConsent?.()
      } catch {
        recapConsent = undefined
      }
      if (cancelled) return
      setModal(recapConsent === 'undecided' ? 'none' : 'enable')
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [projectDir, setModal, setEnabled])

  // Guard: a MAIN/renderer dir desync can leave a modal requested with no project open. Never
  // show an onboarding modal over a project-less canvas (the recap-modal bug class).
  if (projectDir === null) return <></>

  return (
    <>
      {modal === 'enable' && (
        <OrchestrationConsentModal
          onClose={() => setModal('none')}
          onEnabled={() => setModal('sync')}
        />
      )}
      {/* ⚠️ WT-provision (P3): swap this placeholder for the real <OrchestrationSyncModal/>. */}
      {modal === 'sync' && <SyncStepPlaceholder onClose={() => setModal('none')} />}
    </>
  )
}

/**
 * Temporary stand-in for WT-provision's Sync modal. Keeps the Enable→Sync flow (and the Settings
 * "Sync" button) demonstrable in the manual dev check before the provisioners land. P3 replaces
 * this with the endpoint/per-CLI-target UI; the host's mount point and gating stay unchanged.
 */
function SyncStepPlaceholder({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <Modal
      label="Sync"
      onClose={onClose}
      zIndex={1000}
      scrimProps={{ 'data-test': 'orchestration-sync-scrim' }}
      cardProps={{ 'data-test': 'orchestration-sync-modal' }}
      cardStyle={ph.card}
    >
      <h2 style={ph.title}>Sync</h2>
      <p style={ph.body}>
        Push this canvas&apos;s connection to every agent CLI on your machine. Re-runs automatically
        when a terminal starts.
      </p>
      <p style={ph.note}>The per-CLI sync targets arrive with the provisioners (P3).</p>
      <div style={ph.foot}>
        <button style={ph.ghost} onClick={onClose} data-test="orchestration-sync-later">
          Later
        </button>
        <button style={ph.primary} disabled data-test="orchestration-sync-now">
          Sync now
        </button>
      </div>
    </Modal>
  )
}

const ph: Record<string, CSSProperties> = {
  card: {
    width: 446,
    padding: 20,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-board)'
  },
  title: { margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600, letterSpacing: '-.01em' },
  body: { fontSize: 13, lineHeight: '20px', color: 'var(--text-2)', margin: '10px 0 0' },
  note: { fontSize: 11.5, lineHeight: '16px', color: 'var(--text-3)', margin: '8px 0 0' },
  foot: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
  ghost: {
    height: 30,
    padding: '0 14px',
    borderRadius: 'var(--r-ctl)',
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'pointer'
  },
  primary: {
    height: 30,
    padding: '0 14px',
    borderRadius: 'var(--r-ctl)',
    border: '1px solid var(--accent)',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 12.5,
    fontWeight: 500,
    cursor: 'not-allowed',
    opacity: 0.55
  }
}
