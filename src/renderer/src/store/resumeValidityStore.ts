/**
 * F1b: the MAIN-validated resume verdicts, published per board (mirroring
 * `terminalRuntimeStore`'s ephemeral by-id shape). `useResumeValidity` computes the
 * fail-closed boolean from `terminal:resumeCheck` for the board's own chrome; the command
 * palette builds its rows from a SYNCHRONOUS store snapshot and cannot await that IPC, so
 * the hook publishes each verdict here and the palette gates its Resume row on this map
 * instead of the raw `agentSessionId` truthiness (which a dead stored id satisfies).
 * Missing entry ⇒ false — the palette stays fail-closed too. Not persisted.
 */
import { create } from 'zustand'

interface ResumeValidityState {
  validity: Record<string, boolean>
  setResumeValidity: (id: string, ok: boolean) => void
  /** On board removal/unmount — a stale `true` for a deleted board must not linger. */
  clearResumeValidity: (id: string) => void
}

export const useResumeValidityStore = create<ResumeValidityState>((set) => ({
  validity: {},
  setResumeValidity: (id, ok) =>
    set((s) => (s.validity[id] === ok ? s : { validity: { ...s.validity, [id]: ok } })),
  clearResumeValidity: (id) =>
    set((s) => {
      if (!(id in s.validity)) return s
      const v = { ...s.validity }
      delete v[id]
      return { validity: v }
    })
}))
