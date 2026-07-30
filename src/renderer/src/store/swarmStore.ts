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
import type { SwarmLedgerSnapshot } from '../../../shared/swarmLedgerTypes'

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
  /**
   * S2: the title the worker was spawned with. Remembered here so a narration about a worker whose
   * BOARD has since been deleted ("builder-2 died…") still reads as a name rather than a raw id —
   * the canvas can no longer resolve it, and MAIN never carries titles.
   */
  title?: string
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
  /** The run's Planning board (the plan-strip projection); null = no plan drawn yet. */
  planBoardId: string | null
  /** Wall-clock ms of the first message — drives the header run timer. */
  startedAt: number | null
  /** Pause-all: dispatch tools refuse while paused; running workers finish their turn. */
  paused: boolean
  /**
   * S2: MAIN's durable projection of this run, or null when the run has no ledger (no project,
   * an unwritable sidecar, or a ledger from a newer app). Null is the S1 path, not an error —
   * every consumer treats it as "no extra knowledge" rather than "nothing is happening".
   */
  ledger: SwarmLedgerSnapshot | null
  /** S2: this run came back from disk after a reload — drives the header's `restored` chip. */
  restored: boolean
  /**
   * base P5: the ACTIVE session-consent grants (one revocable header chip per entry). MAIN
   * pushes the full snapshot on any grant/revoke; empty = nothing pre-authorized (no chip row).
   * In-memory on both sides — a reload starts consent-clean by construction.
   */
  consents: Array<{ roleId: string; roleName: string }>
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
  paused: false,
  ledger: null,
  restored: false,
  consents: []
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
  /**
   * S2: append a COMPLETE (non-streaming) orchestrator bubble. Used for the between-turns
   * narrations MAIN composes when a worker dies or stalls — the same one voice as a turn reply,
   * just not streamed, because no turn is running.
   */
  addOrchMessage: (boardId: string, text: string) => void
  setTurnActive: (boardId: string, active: boolean) => void
  /** Record a worker board joining this run (idempotent; spawn order preserved). */
  addWorker: (boardId: string, workerBoardId: string, meta?: SwarmWorkerMeta) => void
  /** Merge glance data onto a worker's card (role/activity/provenance — 09 §4 Layer A). */
  setWorkerMeta: (boardId: string, workerBoardId: string, meta: SwarmWorkerMeta) => void
  /** Drop a worker from the run (its board was deleted). */
  removeWorker: (boardId: string, workerBoardId: string) => void
  setPlanBoard: (boardId: string, planBoardId: string | null) => void
  setPaused: (boardId: string, paused: boolean) => void
  /** S2: adopt MAIN's durable projection. `restored` latches true — a run stays "restored" for
   *  the rest of the session, since later pushes carry restored:false by design. */
  setLedger: (boardId: string, snapshot: SwarmLedgerSnapshot) => void
  /** base P5: adopt MAIN's active session-consent snapshot (full state, idempotent). */
  setConsents: (boardId: string, consents: Array<{ roleId: string; roleName: string }>) => void
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

/**
 * S2: union this session's worker membership with the ledger's, preserving THIS session's spawn
 * order and appending any worker only the ledger knows about (the restore case, where no
 * `workerSpawned` event ever fired). Returns the original array when nothing is new, so the
 * store's reference identity — and every downstream memo — stays stable.
 */
const mergeWorkers = (current: string[], snapshot: SwarmLedgerSnapshot): string[] => {
  const known = new Set(current)
  const added = snapshot.workers.map((w) => w.boardId).filter((id) => !known.has(id))
  return added.length === 0 ? current : [...current, ...added]
}

/** S2: fold the ledger's per-worker facts onto the ephemeral card metadata (ledger wins). */
const mergeWorkerMeta = (
  current: Record<string, SwarmWorkerMeta>,
  snapshot: SwarmLedgerSnapshot
): Record<string, SwarmWorkerMeta> => {
  const next = { ...current }
  for (const w of snapshot.workers) {
    const prev = next[w.boardId] ?? {}
    next[w.boardId] = {
      ...prev,
      // A restored worker has no spawn event, so the ledger supplies the timer's origin.
      joinedAt: prev.joinedAt ?? snapshot.createdAt,
      ...(w.role !== undefined ? { role: w.role } : {}),
      ...(w.activity !== undefined ? { activity: w.activity } : {}),
      ...(w.provenance !== undefined ? { provenance: w.provenance } : {})
    }
  }
  return next
}

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
  addOrchMessage: (boardId, text) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => pushMessage(r, { id: ++msgSeq, role: 'orch', text }))
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
  setLedger: (boardId, snapshot) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) => ({
        ...r,
        ledger: snapshot,
        restored: r.restored || snapshot.restored,
        // The ledger knows the plan board across a reload, when no planDrawn event ever fired.
        planBoardId: r.planBoardId ?? snapshot.planBoardId,
        // A restored run's timer must count from when the RUN started, not when the app booted.
        startedAt: r.startedAt ?? snapshot.createdAt,
        // Restore membership: the workers the ledger recorded are the run's, even though this
        // session never saw their spawn events.
        workerIds: mergeWorkers(r.workerIds, snapshot),
        workerMeta: mergeWorkerMeta(r.workerMeta, snapshot)
      }))
    })),
  setConsents: (boardId, consents) =>
    set((s) => ({
      runs: patch(s.runs, boardId, (r) =>
        // Reference-stable when nothing changed (empty → empty is the common idle push).
        r.consents.length === 0 && consents.length === 0 ? r : { ...r, consents }
      )
    })),
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
