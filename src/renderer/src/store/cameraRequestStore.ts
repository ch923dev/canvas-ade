import { create } from 'zustand'

/**
 * Ephemeral camera-focus request bus (H1 / Lane H). The MCP applier (`useMcpCommands`) is
 * React-free and cannot reach the React Flow instance, so a validated `focusCamera` command is
 * parked HERE and executed by `useCameraFocusRequests` (mounted inside the ReactFlow provider,
 * where the camera verbs live). SESSION STATE ONLY — never serialized, never routed into
 * boardSchema or PATCHABLE_KEYS (the scene/session split, like voiceStore).
 *
 * `seq` monotonically identifies each request so the consumer effect fires once per request
 * (a re-mount consuming a stale, already-executed target would yank the camera again — `consume`
 * clears it after execution).
 */

export type CameraFocusTarget =
  | { kind: 'board'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'all' }
  // Spatial I2 (tidy framing, C5 `fit !== false`). `rect` frames a world rect with FIT_FRAME,
  // computed from the ARRANGED geometry — race-free against React Flow's not-yet-synced nodes,
  // which `rf.fitView` would read stale right after a store write. `viewport` sets the exact
  // camera `roleLayout` solved (the stage at its target zoom). `groupPicker` opens the group
  // switcher (the W3 toast's "Focus a group" — the F-key verb).
  | { kind: 'rect'; rect: { x: number; y: number; w: number; h: number } }
  | { kind: 'viewport'; viewport: { x: number; y: number; zoom: number } }
  | { kind: 'groupPicker' }

interface CameraRequestState {
  seq: number
  target: CameraFocusTarget | null
  request: (target: CameraFocusTarget) => void
  consume: () => void
}

export const useCameraRequestStore = create<CameraRequestState>((set) => ({
  seq: 0,
  target: null,
  request: (target) => set((s) => ({ seq: s.seq + 1, target })),
  consume: () => set({ target: null })
}))

/** Park one camera-focus request for the in-provider consumer (callable outside React). */
export function requestCameraFocus(target: CameraFocusTarget): void {
  useCameraRequestStore.getState().request(target)
}
