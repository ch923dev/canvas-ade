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
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useOrchestrationStore } from '../store/orchestrationStore'
import { OrchestrationConsentModal } from './OrchestrationConsentModal'
import {
  OrchestrationSyncModal,
  type SyncCliId,
  type SyncRowResult,
  type SyncStatusData
} from './OrchestrationSyncModal'

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
      {modal === 'sync' && <OrchestrationSyncStep onClose={() => setModal('none')} />}
    </>
  )
}

/**
 * Container for WT-provision's presentational `<OrchestrationSyncModal/>` (the swap-point the
 * onboarding lane owed P3). Fetches the provision status (endpoint + per-CLI detect rows) on
 * mount and provides the `onSync` that runs the selected provisioners — both over the
 * frame-guarded orchestration IPC. The modal owns the selection + per-row result UI; this owns
 * only the data wiring. Status stays null (the modal's "detecting endpoint" loading state) if the
 * bridge/IPC is unavailable; a sync IPC rejection propagates so the modal marks the rows failed.
 */
function OrchestrationSyncStep({ onClose }: { onClose: () => void }): ReactElement {
  const [status, setStatus] = useState<SyncStatusData | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const s = await window.api?.orchestration?.getProvisionStatus?.()
        if (!cancelled && s) setStatus(s)
      } catch {
        // Leave status null → the modal shows its "detecting endpoint" loading state.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const onSync = useCallback(
    (ids: SyncCliId[]): Promise<SyncRowResult[]> => window.api.orchestration.sync(ids),
    []
  )
  return <OrchestrationSyncModal status={status} onSync={onSync} onClose={onClose} />
}
