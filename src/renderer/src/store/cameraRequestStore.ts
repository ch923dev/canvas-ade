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
