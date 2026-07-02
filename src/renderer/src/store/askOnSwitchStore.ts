import { create } from 'zustand'

/**
 * Ask-on-switch dialog state (Background Project Sessions, Phase 4).
 *
 * `performProjectSwitch` (a plain store module, no JSX) needs a modal decision mid-pipeline:
 * it calls `requestAskOnSwitch` and awaits the promise; `AskOnSwitchModal` renders whenever
 * `pending` is set and resolves it with the user's choice. One request at a time by
 * construction — the switch pipeline holds the cross-surface switch lock while asking, so a
 * second switch can't even reach the dialog (it settles 'locked').
 */

/** What the outgoing project has running (the dialog body copy). */
export interface AskOnSwitchRequest {
  /** Outgoing project's display name (dialog body). */
  outgoingName: string
  /** Incoming project's display name, when known (dialog title); null → generic title. */
  incomingName: string | null
  terminals: number
  previews: number
}

export type AskOnSwitchChoice =
  | { action: 'keep'; forever: boolean }
  | { action: 'stop' }
  | { action: 'cancel' }

interface AskOnSwitchState {
  pending:
    | (AskOnSwitchRequest & { reqId: number; resolve: (choice: AskOnSwitchChoice) => void })
    | null
  request(req: AskOnSwitchRequest): Promise<AskOnSwitchChoice>
  settle(choice: AskOnSwitchChoice): void
}

// Monotonic request id — the modal keys its card on it so React remounts (fresh tile/checkbox
// state) per ask, with no reset-effect (react-hooks/set-state-in-effect).
let nextReqId = 1

export const useAskOnSwitchStore = create<AskOnSwitchState>((set, get) => ({
  pending: null,
  request(req) {
    return new Promise<AskOnSwitchChoice>((resolve) => {
      set({ pending: { ...req, reqId: nextReqId++, resolve } })
    })
  },
  settle(choice) {
    const p = get().pending
    if (!p) return
    set({ pending: null })
    p.resolve(choice)
  }
}))

export function requestAskOnSwitch(req: AskOnSwitchRequest): Promise<AskOnSwitchChoice> {
  return useAskOnSwitchStore.getState().request(req)
}
