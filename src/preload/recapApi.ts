import { ipcRenderer, type IpcRendererEvent } from 'electron'

/**
 * The preload `recap` namespace — consent, the S1 recap-face bundle read, and the learned/updated
 * pushes — factored out of preload/index.ts to stay under the max-lines ratchet (the terminalApi.ts
 * precedent). Every invoke handler is `isForeignSender` frame-guarded in MAIN.
 */

// ── Terminal-recap T12: consent state ──
export type RecapConsentState = 'enabled' | 'declined' | 'undecided'

// ── Recap redesign S1: the recap face's data bundle. MIRRORS src/main (recapFacts.ts +
// summaryLoop.ts RecapNarrative + recapIpc.ts RecapBundle) — the process boundary means no
// shared import (tsconfig.preload ⊥ tsconfig.node); keep the three in lockstep, same as PtyState.
export type RecapStatus =
  | 'spawning'
  | 'running'
  | 'waiting-on-you'
  | 'idle'
  | 'exited'
  | 'spawn-failed'
export interface RecapFacts {
  v: 1
  status: RecapStatus
  /** PTY session currently alive (running/spawning); Resume is offered only when false. */
  live: boolean
  exitCode?: number
  title?: string
  sessionStart?: number
  lastActivity?: number
  turns: { user: number; agent: number }
  lastAsk?: string
  files: { path: string; op: 'edit' | 'write'; count: number; adds?: number; dels?: number }[]
  commands: { label: string; count: number }[]
  // Recap enrichment (2026-07-03): OPTIONAL, feature-detected — see src/main/recapFacts.ts.
  todos?: { done: number; total: number; active?: string }
  errors?: { count: number; last?: string }
  model?: string
  gitBranch?: string
  contextTokens?: number
  agents?: { count: number; labels: string[] }
  generatedAt: number
}
export interface RecapNarrative {
  now: string
  next?: string
  beats: { ts: number; text: string; role: 'user' | 'agent' }[]
  asOf: number
}
export interface RecapBundle {
  facts: RecapFacts
  narrative?: RecapNarrative
}
// Recap-refresh fix: MIRRORS src/main/summaryLoop.ts RefreshOutcome (process boundary, no shared
// import) -- what a manual memory:refresh actually did, so RecapView can say WHY nothing changed.
export type RecapRefreshOutcome =
  | { status: 'recap-written'; asOf: number }
  | {
      status: 'summary-written'
      recapSkipped: 'consent-off' | 'no-transcript' | 'empty-transcript' | 'not-terminal'
    }
  | { status: 'llm-unavailable'; reason: 'no-provider' | 'budget-exceeded' | 'provider-error' }
  | { status: 'skipped'; reason: 'no-project' | 'board-missing' | 'project-switched' | 'error' }
  | { status: 'coalesced'; with: RecapRefreshOutcome }

// F4 (terminal-resume): MIRRORS src/main/recapHealth.ts RecapHealth (process boundary, no
// shared import). Null = no project / consent off — the Inspector renders nothing.
export interface RecapHealthView {
  runner: 'ok' | 'missing'
  hookInstalled: boolean
  captured: boolean
  sessionAgeMs: number | null
}

// ── Terminal-recap T12: consent + learned-patches push ──
export const recapApi = {
  /** S1: one-shot read for the recap face — live LOCAL facts + the cached narrative. */
  get: (boardId: string): Promise<RecapBundle | null> => ipcRenderer.invoke('recap:get', boardId),
  /** F4: per-board hook-health probe for the Inspector's fault-only status line. */
  health: (boardId: string): Promise<RecapHealthView | null> =>
    ipcRenderer.invoke('recap:health', boardId),
  getConsent: (): Promise<RecapConsentState> => ipcRenderer.invoke('recap:getConsent'),
  setConsent: (decision: 'enabled' | 'declined'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('recap:setConsent', decision),
  /** main → renderer: learned patches `{boardId, sessionId, transcriptPath}[]` to persist on boards. */
  onLearned: (
    cb: (patches: { boardId: string; sessionId: string; transcriptPath: string }[]) => void
  ): (() => void) => {
    const h = (
      _e: IpcRendererEvent,
      p: { boardId: string; sessionId: string; transcriptPath: string }[]
    ): void => cb(p)
    ipcRenderer.on('recap:learned', h)
    return () => ipcRenderer.removeListener('recap:learned', h)
  },
  /**
   * main -> renderer: the recap narrative sidecar for a board was regenerated (asOf = its new
   * stamp). Fired for BOTH watcher-driven background regens and manual refreshes, so an open
   * RecapView can re-read instead of waiting for the next flip.
   */
  onUpdated: (cb: (payload: { boardId: string; asOf: number }) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, p: { boardId: string; asOf: number }): void => cb(p)
    ipcRenderer.on('recap:updated', h)
    return () => ipcRenderer.removeListener('recap:updated', h)
  }
}
