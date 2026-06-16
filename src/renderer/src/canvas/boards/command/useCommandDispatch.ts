/**
 * Command-board dispatch choreography (Phase C / C2) — the side-effecting half of the dispatch
 * core (`lib/commandDispatch.ts` holds the pure logic). Drives the renderer → MAIN orchestrator IPC
 * (`window.api.mcp`, the C1 surface) to turn a queued task into real work:
 *
 *   submit → addTask(queued) → [pump] → routing (spawnGroup) → executing (handoffPrompt)
 *          → done | failed (the worker's two-gate settle / an error / a denied confirm)
 *
 * A **pump** serializes spawns at the orchestrator's concurrency cap: it dispatches queued tasks
 * while a slot is free (reserving each synchronously as routing), and re-runs whenever a slot frees
 * (a settle, a non-cap failure, a `gone`, or a retry). The renderer holds NO token — every write
 * still pays MAIN's `runGatedWrite` confirm gate. The board is a singleton, so this hook (and its
 * one `onTaskStatus` subscription) mounts once.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useCommandStore, type CommandTask } from '../../../store/commandStore'
import {
  canDispatch,
  compositionOf,
  isCapError,
  isFailureResult,
  isWorkerNotReady,
  nextQueuedTask,
  nextStatusForBoardChange,
  type Composition,
  type WorkerResult
} from '../../../lib/commandDispatch'

// The just-spawned terminal must reach MAIN's board mirror (publish debounced ~150ms) + spawn its
// PTY before a handoff can resolve it. Retry the PRE-gate readiness window with backoff (~5s total).
const READY_RETRIES = 25
const READY_BACKOFF_MS = 200
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Hand off once the worker is ready: retry only the pre-gate readiness failure (board-not-found /
 * not-a-terminal — no side effect), never an error AFTER the confirm gate (so a retry can't re-pop
 * the confirm). Resolves with the worker's settle result, or throws the underlying error.
 */
async function handoffWhenReady(
  handoff: (boardId: string, text: string) => Promise<WorkerResult>,
  terminalId: string,
  title: string
): Promise<WorkerResult> {
  for (let attempt = 0; attempt < READY_RETRIES; attempt++) {
    try {
      return await handoff(terminalId, title)
    } catch (err) {
      if (isWorkerNotReady(err) && attempt < READY_RETRIES - 1) {
        await sleep(READY_BACKOFF_MS)
        continue
      }
      throw err
    }
  }
  throw new Error('handoff: worker never became ready') // unreachable (loop returns or throws)
}

export interface CommandDispatch {
  /** Enqueue + begin dispatching a task with the chosen composition (the submit well). */
  dispatch: (title: string, composition: Composition) => void
  /** Re-queue a failed task and re-spawn a fresh group (the failed card's ↻). */
  retry: (task: CommandTask) => void
  /** Gated Ctrl-C into an executing task's worker terminal (the executing card's ■). */
  interrupt: (task: CommandTask) => void
}

export function useCommandDispatch(cap: number): CommandDispatch {
  // `cap` lives in a ref so the stable callbacks below always read the latest pool cap without
  // re-subscribing the status listener. `pump`/`runDispatch` reference each other through refs.
  const capRef = useRef(cap)
  const pumpRef = useRef<() => void>(() => {})
  const runDispatchRef = useRef<(id: string, title: string, comp: Composition) => Promise<void>>(
    async () => {}
  )

  // Keep the cap fresh for the stable callbacks below WITHOUT writing a ref during render.
  useEffect(() => {
    capRef.current = cap
  }, [cap])

  const pump = useCallback(() => {
    // Dispatch queued tasks while a slot is free. Reserve each synchronously (routing) BEFORE the
    // async spawn so the next iteration's `canDispatch` already counts it. Bounded by a guard.
    for (let i = 0; i < 64; i++) {
      const { tasks, setTaskStatus } = useCommandStore.getState()
      const next = nextQueuedTask(tasks)
      if (!next) return
      const comp = compositionOf(next)
      if (!canDispatch(tasks, comp, capRef.current)) return
      setTaskStatus(next.id, 'routing')
      void runDispatchRef.current?.(next.id, next.title, comp)
    }
  }, [])

  const runDispatch = useCallback(
    async (id: string, title: string, comp: Composition): Promise<void> => {
      const { setTaskGroup, setTaskStatus } = useCommandStore.getState()
      const api = window.api?.mcp
      if (!api?.spawnGroup || !api?.handoffPrompt) {
        setTaskStatus(id, 'failed')
        return
      }
      try {
        const group = await api.spawnGroup({
          name: title,
          planning: comp.planning,
          browser: comp.browser
        })
        setTaskGroup(id, group)
        setTaskStatus(id, 'executing')
        // Authoritative done/failed verdict — handoffPrompt awaits the worker's two-gate settle
        // (retried through the post-spawn readiness window until the worker is addressable).
        const handoff = api.handoffPrompt
        const result = await handoffWhenReady((bid, t) => handoff(bid, t), group.terminalId, title)
        setTaskStatus(id, isFailureResult(result) ? 'failed' : 'done')
        pumpRef.current?.() // a slot freed → dispatch the next queued task
      } catch (err) {
        // A MAIN cap rejection (renderer/MAIN drift) re-queues + WAITS for a real settle to pump it
        // — never self-pumps, so a persistent drift can't spin. Any other error fails the card.
        if (isCapError(err)) {
          setTaskStatus(id, 'queued')
        } else {
          setTaskStatus(id, 'failed')
          pumpRef.current?.()
        }
      }
    },
    []
  )

  // Wire the mutually-referencing stable callbacks into refs AFTER render (react-hooks/refs).
  useEffect(() => {
    pumpRef.current = pump
    runDispatchRef.current = runDispatch
  }, [pump, runDispatch])

  const dispatch = useCallback((title: string, composition: Composition): void => {
    const id = useCommandStore.getState().addTask(title, composition)
    if (id) pumpRef.current?.()
  }, [])

  const retry = useCallback((task: CommandTask): void => {
    useCommandStore.getState().retryTask(task.id) // failed → queued, clears the old group
    pumpRef.current?.()
  }, [])

  const interrupt = useCallback((task: CommandTask): void => {
    const tid = task.group?.terminalId
    if (tid) void window.api?.mcp?.interrupt?.(tid)?.catch(() => {})
  }, [])

  // The worker status push: a terminal member going `gone` (board closed mid-flight) fails its task
  // and frees the slot. Registered once (singleton board); the handler reads live store state.
  useEffect(() => {
    const onTaskStatus = window.api?.mcp?.onTaskStatus
    if (!onTaskStatus) return
    return onTaskStatus((change) => {
      const task = useCommandStore.getState().tasks.find((t) => t.group?.terminalId === change.id)
      if (!task) return
      const next = nextStatusForBoardChange(task.status, change.status)
      if (!next) return
      useCommandStore.getState().setTaskStatus(task.id, next)
      if (next === 'failed') pumpRef.current?.()
    })
  }, [])

  return { dispatch, retry, interrupt }
}
