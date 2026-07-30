import { create } from 'zustand'

/**
 * Unseen agent-attention per board (desktop-notifications P2). An agent lifecycle event
 * (done / needs-input / error) marks its board until the user "sees" it — selecting or
 * focusing the board clears the mark (useNotifications owns that wiring). Ephemeral
 * session state: never serialized. A stale entry for a deleted board stays in `byId`
 * but every consumer joins against live boards before rendering (the Jarvis panel
 * filters explicitly — BADGE-1; the mirror snapshot only reads ids of live boards).
 *
 * Consumers: BoardAttention (the on-canvas ring/badge overlay), boardStatus (bucket
 * override → the MCP mirror + `canvas://attention`), TerminalBoard (pill dot re-tint),
 * JarvisPanel (edge-tab badge + panel-foot event chips).
 */
/**
 * P4 adds `blocked` — a worker that CANNOT PROCEED (lost / stalled / failing check / dependency /
 * overlap / preserved dirty worktree), as distinct from `needs-input`, which is a worker ASKING YOU
 * something right now. They read differently on the canvas (steady vs pulsing ring) because they
 * demand different urgency, and the split is what finally gives `BoardStatusBucket.'blocked'` a
 * producer: it has been declared and styled since T1.1 with no code path ever emitting it.
 */
export type AttentionKind = 'done' | 'needs-input' | 'blocked' | 'error'

interface AttentionState {
  byId: Record<string, AttentionKind>
  /** Mark a board. Last-write-wins: a later event is the newer truth (e.g. a
   *  needs-input followed by the run's Stop settles as done). */
  setAttention: (boardId: string, kind: AttentionKind) => void
  /** The user saw the board (select / focus) — drop the mark. No-op (no state
   *  identity change) when the board carries none, so subscribers don't churn. */
  clearAttention: (boardId: string) => void
}

export const useAttentionStore = create<AttentionState>()((set, get) => ({
  byId: {},
  setAttention: (boardId, kind) => {
    if (get().byId[boardId] === kind) return
    set((s) => ({ byId: { ...s.byId, [boardId]: kind } }))
  },
  clearAttention: (boardId) => {
    if (!(boardId in get().byId)) return
    set((s) => {
      const next = { ...s.byId }
      delete next[boardId]
      return { byId: next }
    })
  }
}))
