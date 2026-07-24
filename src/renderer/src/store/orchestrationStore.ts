/**
 * Agent Orchestration Onboarding (P1) — renderer-side reactive state for the orchestration
 * consent + onboarding modals.
 *
 * Source of truth is MAIN (the userData consent store, via the orchestration:* IPC). `enabled`
 * here is a REACTIVE CACHE: hydrated from IPC on project open (OrchestrationModals) and updated
 * only AFTER a successful IPC write — so the Settings toggle and any future consumer (the P3 Sync
 * modal's gating, the orchestration-cable affordance) stay live without each re-querying MAIN.
 *
 * `modal` is the cross-component channel for WHICH onboarding modal is showing: the first-init
 * trigger and the Settings re-open controls all route through it so the single host
 * (OrchestrationModals, mounted once in AppChrome) renders exactly one at a time. Ephemeral
 * session state — never serialized; reset per project by the host.
 */
import { create } from 'zustand'

/** Which orchestration onboarding modal the host should show. */
export type OrchestrationModalView = 'none' | 'enable' | 'sync'

interface OrchestrationStore {
  /** Reactive cache of THIS project's consent (MAIN/userData is authoritative). */
  enabled: boolean
  /** Which onboarding modal to show (cross-component channel: Settings → host). */
  modal: OrchestrationModalView
  /**
   * S1: reactive cache of the designated lead board id (null = none). MAIN's leadAuthority is
   * authoritative; hydrated once on mount (getLeadStatus) and kept live by the
   * `orchestration:leadChanged` push (OrchestrationModals owns the subscription). Drives the
   * terminal LEAD badge, the board-menu grant/revoke state, and the creation-time row.
   */
  leadBoardId: string | null
  /** Set the cached flag (after a getConsent read on open, or a successful consent write). */
  setEnabled: (on: boolean) => void
  /** Open/close an onboarding modal. */
  setModal: (view: OrchestrationModalView) => void
  /** Set the cached lead designation (hydrate read or the MAIN push). */
  setLeadBoardId: (boardId: string | null) => void
}

export const useOrchestrationStore = create<OrchestrationStore>((set) => ({
  enabled: false,
  modal: 'none',
  leadBoardId: null,
  // Conditional sets — skip the swap when unchanged so a re-hydrate to the same value
  // (project open / autosave-adjacent renders) doesn't churn subscribers.
  setEnabled: (on) => set((s) => (s.enabled === on ? s : { enabled: on })),
  setModal: (view) => set((s) => (s.modal === view ? s : { modal: view })),
  setLeadBoardId: (boardId) =>
    set((s) => (s.leadBoardId === boardId ? s : { leadBoardId: boardId }))
}))
