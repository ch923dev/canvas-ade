/**
 * Command-board dispatch choreography (Phase C / C2 · C2d) — the side-effecting half of the dispatch
 * core (`lib/commandDispatch.ts` holds the pure logic). Drives the renderer → MAIN orchestrator IPC
 * (`window.api.mcp`, the C1 surface) to turn a submitted task into real work:
 *
 *   submit → addTask(queued) → engineer (LLM: zoneName + prompt) → WORKER CONFIG dialog
 *          → Dispatch (task gets {launchCommand, prompt} = "ready") → [pump] → routing (spawnGroup)
 *          → executing → ready-gate → handoffPrompt → done | failed
 *
 * Why the config dialog (C2d): a freshly-spawned worker's CLI shows a first-run "trust this folder?"
 * gate that ate an auto-fired prompt. The user now picks the agent + its skip/auto flag (clearing the
 * trust gate) and reviews/edits the engineered instruction BEFORE the worker spawns. No hardcoded
 * launch command. A **pump** still serializes spawns at the orchestrator's concurrency cap; only
 * CONFIGURED queued tasks (a `launchCommand` committed via the dialog) are spawned. The renderer holds
 * NO token — every write still pays MAIN's `runGatedWrite` confirm gate. The board is a singleton, so
 * this hook (and its one `onTaskStatus` subscription) mounts once.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useCommandStore, type CommandTask, type WorkerConfig } from '../../../store/commandStore'
import {
  canDispatch,
  compositionOf,
  DISPATCH_ENGINEER_SYSTEM,
  fallbackTitle,
  isCapError,
  isFailureResult,
  isWorkerNotReady,
  nextQueuedTask,
  nextStatusForBoardChange,
  parseEngineeredDispatch,
  type Composition,
  type EngineeredDispatch,
  type WorkerResult
} from '../../../lib/commandDispatch'

/**
 * Engineer the dispatch: ask the in-app LLM to turn the user's terse task into BOTH a short intent
 * NAME for the spawned zone (a raw verbose task is a poor group name) AND a clear agent INSTRUCTION.
 * Falls back to the raw task whenever the LLM is unavailable (no key / budget / error) so dispatch is
 * never blocked.
 */
async function engineerDispatch(task: string): Promise<EngineeredDispatch> {
  const summarize = window.api?.llm?.summarize
  if (!summarize) return { title: fallbackTitle(task), prompt: task }
  try {
    return parseEngineeredDispatch(
      await summarize({ system: DISPATCH_ENGINEER_SYSTEM, text: task }),
      task
    )
  } catch {
    return { title: fallbackTitle(task), prompt: task }
  }
}

// The just-spawned terminal must reach MAIN's board mirror (publish debounced ~150ms) + spawn its
// PTY before a handoff can resolve it. Retry the PRE-gate readiness window with backoff (~5s total).
const READY_RETRIES = 25
const READY_BACKOFF_MS = 200
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Terminal status is only PTY-alive vs exited (boardStatus.ts) — it CANNOT signal "REPL ready". So we
// give the freshly-launched worker a fixed boot-settle window before the handoff, so the engineered
// prompt lands at the agent's prompt rather than mid-boot (the human confirm-gate approval adds more
// margin). A content-aware readiness probe (output quiet after boot) is a follow-up. Zero under
// vitest so the deterministic hook test isn't paced by a real-time delay (the sequence is unchanged).
const WORKER_BOOT_SETTLE_MS = import.meta.env.MODE === 'test' ? 0 : 2000

/**
 * Hand off once the worker is ready: retry only the pre-gate readiness failure (board-not-found /
 * not-a-terminal — no side effect), never an error AFTER the confirm gate (so a retry can't re-pop
 * the confirm). Resolves with the worker's settle result, or throws the underlying error.
 */
async function handoffWhenReady(
  handoff: (boardId: string, text: string) => Promise<WorkerResult>,
  terminalId: string,
  text: string
): Promise<WorkerResult> {
  for (let attempt = 0; attempt < READY_RETRIES; attempt++) {
    try {
      return await handoff(terminalId, text)
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
  /** Submit well: enqueue a task, engineer its prompt, then open the worker-config dialog. */
  dispatch: (title: string, composition: Composition) => void
  /** Config dialog Dispatch: commit the chosen launch command + (edited) prompt → the pump spawns it. */
  confirmConfig: (
    taskId: string,
    result: { launchCommand: string; prompt: string; config: WorkerConfig }
  ) => void
  /** Config dialog Cancel: close it; the task stays queued-not-ready (re-openable from the card). */
  cancelConfig: (taskId: string) => void
  /** Card "Configure": re-open the config dialog for a queued task that was cancelled / not yet set. */
  reconfigure: (task: CommandTask) => void
  /** Re-queue a failed task and re-spawn (reuses its stored config) — the failed card's ↻. */
  retry: (task: CommandTask) => void
  /** Gated Ctrl-C into an executing task's worker terminal (the executing card's ■). */
  interrupt: (task: CommandTask) => void
}

export function useCommandDispatch(cap: number): CommandDispatch {
  // `cap` lives in a ref so the stable callbacks below always read the latest pool cap without
  // re-subscribing the status listener. `pump`/`runDispatch` reference each other through refs.
  const capRef = useRef(cap)
  const pumpRef = useRef<() => void>(() => {})
  const runDispatchRef = useRef<(id: string) => Promise<void>>(async () => {})

  // Keep the cap fresh for the stable callbacks below WITHOUT writing a ref during render.
  useEffect(() => {
    capRef.current = cap
  }, [cap])

  const pump = useCallback(() => {
    // Spawn CONFIGURED queued tasks while a slot is free. Reserve each synchronously (routing) BEFORE
    // the async spawn so the next iteration's `canDispatch` already counts it. Bounded by a guard.
    for (let i = 0; i < 64; i++) {
      const { tasks, setTaskStatus } = useCommandStore.getState()
      const next = nextQueuedTask(tasks)
      if (!next) return
      const comp = compositionOf(next)
      if (!canDispatch(tasks, comp, capRef.current)) return
      setTaskStatus(next.id, 'routing')
      void runDispatchRef.current?.(next.id)
    }
  }, [])

  const runDispatch = useCallback(async (id: string): Promise<void> => {
    const store = useCommandStore.getState()
    const task = store.tasks.find((t) => t.id === id)
    const api = window.api?.mcp
    if (!task || !api?.spawnGroup || !api?.handoffPrompt) {
      store.setTaskStatus(id, 'failed')
      return
    }
    const comp = compositionOf(task)
    try {
      // The agent zone + worker are launched with the USER-CHOSEN command (config dialog) under the
      // smart zone name. The kanban CARD keeps the user's raw task; the engineered prompt is the
      // task's `prompt` (delivered after the worker boots; shown in the gate confirm for review).
      const group = await api.spawnGroup({
        name: task.zoneName ?? task.title,
        planning: comp.planning,
        browser: comp.browser,
        ...(typeof task.launchCommand === 'string' ? { launchCommand: task.launchCommand } : {})
      })
      useCommandStore.getState().setTaskGroup(id, group)
      useCommandStore.getState().setTaskStatus(id, 'executing')
      // Boot-settle so the prompt lands at a ready REPL, not mid-boot (see WORKER_BOOT_SETTLE_MS).
      await sleep(WORKER_BOOT_SETTLE_MS)
      // Authoritative done/failed verdict — handoffPrompt awaits the worker's two-gate settle
      // (retried through the post-spawn readiness window until the agent is addressable).
      const handoff = api.handoffPrompt
      const result = await handoffWhenReady(
        (bid, t) => handoff(bid, t),
        group.terminalId,
        task.prompt ?? task.title
      )
      useCommandStore.getState().setTaskStatus(id, isFailureResult(result) ? 'failed' : 'done')
      pumpRef.current?.() // a slot freed → dispatch the next queued task
    } catch (err) {
      // A MAIN cap rejection (renderer/MAIN drift) re-queues + WAITS for a real settle to pump it
      // — never self-pumps, so a persistent drift can't spin. Any other error fails the card.
      if (isCapError(err)) {
        useCommandStore.getState().setTaskStatus(id, 'queued')
      } else {
        useCommandStore.getState().setTaskStatus(id, 'failed')
        pumpRef.current?.()
      }
    }
  }, [])

  // Wire the mutually-referencing stable callbacks into refs AFTER render (react-hooks/refs).
  useEffect(() => {
    pumpRef.current = pump
    runDispatchRef.current = runDispatch
  }, [pump, runDispatch])

  // Submit → enqueue (card appears) → engineer the prompt async → open the config dialog. The task is
  // NOT dispatchable until the user confirms the config (the pump skips un-configured tasks).
  const dispatch = useCallback((title: string, composition: Composition): void => {
    const id = useCommandStore.getState().addTask(title, composition)
    if (!id) return
    void (async () => {
      const eng = await engineerDispatch(title)
      const store = useCommandStore.getState()
      if (!store.tasks.some((t) => t.id === id)) return // task cleared while engineering
      store.setTaskPrompt(id, eng.prompt, eng.title)
      store.setConfiguring(id) // open the worker-config dialog (modal serializes the common case)
    })()
  }, [])

  const confirmConfig = useCallback(
    (
      taskId: string,
      result: { launchCommand: string; prompt: string; config: WorkerConfig }
    ): void => {
      const store = useCommandStore.getState()
      store.setTaskConfig(taskId, { launchCommand: result.launchCommand, prompt: result.prompt })
      store.setLastWorkerConfig(result.config)
      store.setConfiguring(null)
      pumpRef.current?.()
    },
    []
  )

  const cancelConfig = useCallback((_taskId: string): void => {
    useCommandStore.getState().setConfiguring(null) // task stays queued-not-ready (card → Configure)
  }, [])

  const reconfigure = useCallback((task: CommandTask): void => {
    useCommandStore.getState().setConfiguring(task.id)
  }, [])

  const retry = useCallback((task: CommandTask): void => {
    useCommandStore.getState().retryTask(task.id) // failed → queued, clears the group, KEEPS config
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

  return { dispatch, confirmConfig, cancelConfig, reconfigure, retry, interrupt }
}
