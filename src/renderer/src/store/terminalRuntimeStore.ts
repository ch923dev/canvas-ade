/**
 * Ephemeral terminal runtime state (running-by-id), mirroring `previewStore`'s role
 * for native views. The Terminal board publishes its live PTY lifecycle here so the
 * preview-link edge can be rendered stale (dashed/dimmed) when its source terminal is
 * not running (bug 3). Not persisted — derived purely from the in-session PTY state.
 */
import { create } from 'zustand'
import type { TerminalState } from '../canvas/boards/terminalState'
import { isRunning } from '../canvas/boards/terminalState'

interface TerminalRuntimeState {
  running: Record<string, boolean>
  setRunning: (id: string, state: TerminalState) => void
  clear: (id: string) => void
}

export const useTerminalRuntimeStore = create<TerminalRuntimeState>((set) => ({
  running: {},
  setRunning: (id, state) =>
    set((s) => {
      const next = isRunning(state)
      return s.running[id] === next ? s : { running: { ...s.running, [id]: next } }
    }),
  clear: (id) =>
    set((s) => {
      if (!(id in s.running)) return s
      const r = { ...s.running }
      delete r[id]
      return { running: r }
    })
}))

export const selectRunningIds = (s: TerminalRuntimeState): Set<string> =>
  new Set(Object.keys(s.running).filter((id) => s.running[id]))
