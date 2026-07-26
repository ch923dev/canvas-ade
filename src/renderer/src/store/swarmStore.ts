/**
 * Swarm board run state (orchestration S1) — EPHEMERAL, per-board-keyed. MULTI-INSTANCE by
 * design: unlike the singleton commandStore, every swarm board is one independent RUN / feature
 * zone, so all state here lives in a `Map<boardId, SwarmRun>` and every action takes the board
 * id. Nothing is ever serialized into `canvas.json` (the scene/session split — the persisted
 * SwarmBoard is `BoardCommon` only; the durable run ledger is S2's deliverable, 09 §6): a reload
 * starts a fresh run on the same board chrome.
 *
 * The chat transcript mirrors MAIN's per-board orchestrator session (swarmChat IPC) — MAIN owns
 * the LLM history; this store holds what the human SEES (you/orch bubbles + collapsed status
 * lines), streamed via `swarm:turn:event` pushes. Worker membership (`workerIds`) is the Q11
 * lens model: workers stay ordinary terminal boards on the canvas; the run only records which
 * boards belong to it, in spawn order.
 */
import { create } from 'zustand'

/** One chat-spine row: a human/orchestrator bubble, or a collapsed one-line status divider. */
export type SwarmMessageRole = 'you' | 'orch' | 'status'

export interface SwarmMessage {
  id: number
  role: SwarmMessageRole
  text: string
  /** Streaming tail — deltas still appending (renders the live cursor). */
  streaming?: boolean
}

/** Per-worker card glance data the orchestrator narrates (09 §4 Layer A). */
export interface SwarmWorkerMeta {
  /** Role-pack id/label shown as the card's role badge (e.g. 'builder'). */
  role?: string
  /** The current task's activeForm line ("Migrating settings schema…"). */
  activity?: string
  /** Wall-clock ms the worker joined the run — drives the card timer. */
  joinedAt?: number
  /** Settled-result provenance for a done card (09 §1: claimed | synthesized). */
  provenance?: 'claimed' | 'synthesized'
}

export interface SwarmRun {
  messages: SwarmMessage[]
  /** A turn is in flight (composer shows Stop; sends queue behind the confirm gate as usual). */
  turnActive: boolean
  /** Worker boards belonging to this run, spawn order (Q11 lens — ordinary terminal boards). */
  workerIds: string[]
  /** Per-worker glance data, keyed by worker board id. */
  workerMeta: Record<string, SwarmWorkerMeta>
  /** The run's Planning board (the read-only plan-strip projection); null = no plan drawn yet. */
  planBoardId: string | null
  /** Wall-clock ms of the first message — drives the header run timer. */
  startedAt: number | null
  /** Pause-all: dispatch tools refuse while paused; running workers finish their turn. */
  paused: boolean
}

/** Per-run transcript cap — the chat is a working surface, not an archive (MAIN owns history). */
const MAX_MESSAGES = 500

const emptyRun = (): SwarmRun => ({
  messages: [],
  turnActive: false,
  workerIds: [],
  workerMeta: {},
  planBoardId: null,
  startedAt: null,
  paused: false
})

/**
 * The one shared "no run yet" snapshot. `runFor` is used as a zustand SELECTOR — it must return
 * a REFERENCE-STABLE value for an absent run, or every store snapshot yields a fresh object and
 * React's useSyncExternalStore loops ("getSnapshot should be cached"), error-bounding the board.
 * Frozen: nothing may mutate it — writes always go through `patch`, which clones via emptyRun().
 */
const EMPTY_RUN: SwarmRun = Object.freeze(emptyRun())

let msgSeq = 0

interface SwarmState {
  runs: Map<string, SwarmRun>
  /** Append a human bubble (stamps startedAt on the first message). */
  addUserMessage: (boardId: string, text: string) => void
  /** Open a streaming orchestrator bubble (the turn's reply tail). Returns the message id. */
  beginOrchMessage: (boardId: string) => number
  /** Append a streamed delta to a (streaming) orchestrator bubble. */
  appendOrchDelta: (boardId: string, msgId: number, delta: string) => void
  /** Settle a streaming bubble (done/cancelled/error). Empty settled bubbles are dropped. */
  settleOrchMessage: (boardId: string, msgId: number, finalText?: string) => void
  /** Append a collapsed one-line status divider (worker events the orchestrator narrates). */
  addStatusLine: (boardId: string, text: string) => void
  setTurnActive: (boardId: string, active: boolean) => void
  /** Record a worker board joining this run (idempotent; spawn order preserved). */
  addWorker: (boardId: string, workerBoardId: string, meta?: SwarmWorkerMeta) => void
  /** Merge glance data onto a worker's card (role/activity/provenance — 09 §4 Layer A). */
  setWorkerMeta: (boardId: string, workerBoardId: string, meta: SwarmWorkerMeta) => void
  /** Drop a worker from the run (its board was deleted). */
  removeWorker: (boardId: string, workerBoardId: string) => void
  setPlanBoard: (boardId: string, planBoardId: string | null) => void
  setPaused: (boardId: string, paused: boolean) => void
  /** Board deleted → drop its run. */
  removeRun: (boardId: string) => void
  /** Project load/switch → all runs are dead (the reset-on-load discipline, commandStore's). */
  clearAll: () => void
}

/** Read a run for rendering (absent = the SHARED empty snapshot; never mutates the store). */
export function runFor(runs: Map<string, SwarmRun>, boardId: string): SwarmRun {
  return runs.get(boardId) ?? EMPTY_RUN
}

/** Immutable per-board update: clone the map, replace one run through `fn`. */
const patch = (
  runs: Map<string, SwarmRun>,
  boardId: string,
  fn: (run: SwarmRun) => SwarmRun
): Map<string, SwarmRun> => {
  const next = new Map(runs)
  next.set(boardId, fn(runs.get(boardId) ?? emptyRun()))
  return next
}

const pushMessage = (run: SwarmRun, msg: SwarmMessage): SwarmRun => ({
  ...run,
  startedAt: run.startedAt ?? Date.now(),
  messages: [...run.messages.slice(-(MAX_MESSAGES - 1)), msg]
})

export const useSwarmStore = create<SwarmState>((set) => ({
  runs: new Map(),
  addUserMessage: (boardId, text) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => pushMessage(r, { id: ++msgSeq, role: 'you', text }))
    })),
  beginOrchMessage: (boardId) => {
    const id = ++msgSeq
    set((s) => ({
      runs: patch(s.runs, boardId, (r) =>
        pushMessage(r, { id, role: 'orch', text: '', streaming: true })
      )
    }))
    return id
  },
  appendOrchDelta: (boardId, msgId, delta) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => ({
        ...r,
        messages: r.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + delta } : m))
      }))
    })),
  settleOrchMessage: (boardId, msgId, finalText) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => ({
        ...r,
        messages: r.messages
          .map((m) =>
            m.id === msgId
              ? { ...m, streaming: undefined, text: finalText !== undefined ? finalText : m.text }
              : m
          )
          // An error/cancel can settle an empty tail — drop it rather than render a blank bubble.
          .filter((m) => !(m.id === msgId && m.text.trim() === ''))
      }))
    })),
  addStatusLine: (boardId, text) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => pushMessage(r, { id: ++msgSeq, role: 'status', text }))
    })),
  setTurnActive: (boardId, active) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) =>
        r.turnActive === active ? r : { ...r, turnActive: active }
      )
    })),
  addWorker: (boardId, workerBoardId, meta) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => ({
        ...r,
        workerIds: r.workerIds.includes(workerBoardId)
          ? r.workerIds
          : [...r.workerIds, workerBoardId],
        workerMeta: {
          ...r.workerMeta,
          [workerBoardId]: {
            joinedAt: Date.now(),
            ...r.workerMeta[workerBoardId],
            ...meta
          }
        }
      }))
    })),
  setWorkerMeta: (boardId, workerBoardId, meta) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => ({
        ...r,
        workerMeta: {
          ...r.workerMeta,
          [workerBoardId]: { ...r.workerMeta[workerBoardId], ...meta }
        }
      }))
    })),
  removeWorker: (boardId, workerBoardId) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => {
        const meta = { ...r.workerMeta }
        delete meta[workerBoardId]
        return {
          ...r,
          workerIds: r.workerIds.filter((id) => id !== workerBoardId),
          workerMeta: meta
        }
      })
    })),
  setPlanBoard: (boardId, planBoardId) =>
    set((s) => ({ runs: patch(s.runs, boardId, (r) => ({ ...r, planBoardId })) })),
  setPaused: (boardId, paused) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => (r.paused === paused ? r : { ...r, paused }))
    })),
  removeRun: (boardId) =>
    set((s) => {
      if (!s.runs.has(boardId)) return s
      const next = new Map(s.runs)
      next.delete(boardId)
      return { runs: next }
    }),
  clearAll: () => set((s) => (s.runs.size === 0 ? s : { runs: new Map() }))
}))
