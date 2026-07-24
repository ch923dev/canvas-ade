/**
 * Command-board dispatch choreography (Phase C / C2 · C2d) — the side-effecting half of the dispatch
 * core (`lib/commandDispatch.ts` holds the pure logic). Drives the renderer → MAIN orchestrator IPC
 * (`window.api.mcp`, the C1 surface) to turn a submitted task into real work:
 *
 *   submit → addTask(queued) → engineer (LLM: zoneName + prompt) → WORKER CONFIG dialog
 *          → Dispatch (task gets {launchCommand, prompt} = "ready") → [pump] → routing (spawnGroup,
 *            BARE `<command>`) → executing → boot-settle → gated dispatchPrompt → awaitSettled →
 *            done | failed
 *
 * Why the config dialog (C2d): a freshly-spawned worker's CLI shows a first-run "trust this folder?"
 * gate that ate an auto-fired prompt. The user now picks the agent + its skip/auto flag and
 * reviews/edits the engineered instruction BEFORE the worker spawns. No hardcoded launch command.
 *
 * Why REPL delivery (C2f): the prompt is delivered into the agent's INPUT BOX via the gated
 * `dispatchPrompt` PTY write — NEVER the shell launch line. Putting a free-text prompt in the shell
 * line was unsafe (`$()`/backtick command-substitution) AND broke on long lines (PowerShell `>>`); the
 * shell can't run a prose prompt anyway. The launch command is a BARE, controlled `<command>` (no user
 * prose → shell-safe); the prompt rides the existing human-confirm gate (the user's chosen "Gated"
 * authorization). A `--dangerously-skip-permissions`-class flag (the worker-config default) clears the
 * trust gate so the boot-settle lands the write at a ready REPL. Verdict from `awaitSettled` (output
 * silence — read-only, no write).
 *
 * A **pump** still serializes spawns at the orchestrator's concurrency cap; only CONFIGURED queued
 * tasks (a `launchCommand` committed via the dialog) are spawned. The renderer holds NO token. The
 * board is a singleton, so this hook (and its one `onTaskStatus` subscription) mounts once.
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
  singleLinePrompt,
  type Composition,
  type EngineeredDispatch
} from '../../../lib/commandDispatch'
import { packDispatchPrompt, rolePackById } from '../../../lib/rolePacks'

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

// The just-spawned terminal must reach MAIN's board mirror (publish debounced ~150ms) before a
// dispatch / await-settle can resolve it. Retry only the initial board-not-found window (~5s).
const READY_RETRIES = 25
const READY_BACKOFF_MS = 200
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Give the freshly-launched worker a boot window before the gated prompt write so it lands at a
// ready REPL (with the trust gate cleared by the worker's skip-permissions flag), not mid-boot. The
// human confirm-gate approval adds further margin. Zero under vitest so the deterministic hook test
// isn't paced by a real-time delay (the sequence is unchanged).
const WORKER_BOOT_SETTLE_MS = import.meta.env.MODE === 'test' ? 0 : 1500

// GAP-007: bound the reporting-phase diff fetch so a stalled MAIN gitDiff (network FS, an
// .git/index.lock contention, a credential prompt on a hook) can't pin the task in 'reporting'
// forever — the IPC invoke would never settle and neither the MAIN re-throw nor the renderer
// catch→'' fires on a hang. Race the call against a timeout that resolves to '' (best-effort,
// matching the existing catch→'' contract) so the task always advances to done/failed. Short under
// vitest so the deterministic hook test isn't paced by a real-time delay.
const GITDIFF_TIMEOUT_MS = import.meta.env.MODE === 'test' ? 50 : 8000

/** Resolve to '' after `ms` — the best-effort fallback when a MAIN gitDiff stalls (GAP-007). */
function diffTimeout(ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve(''), ms))
}

/**
 * Run a worker operation once the worker is addressable: retry ONLY the pre-side-effect readiness
 * failure (board-not-found / not-a-terminal — thrown before the gate / before any write, so no
 * confirm and no PTY write happened) while the just-spawned board reaches MAIN's mirror. A post-gate
 * error (denied / write-failed) or a settled result is NEVER retried (so a retry can't re-pop the
 * confirm). Resolves with the op's value, or throws the underlying error.
 */
async function retryUntilReady<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < READY_RETRIES; attempt++) {
    try {
      return await op()
    } catch (err) {
      if (isWorkerNotReady(err) && attempt < READY_RETRIES - 1) {
        await sleep(READY_BACKOFF_MS)
        continue
      }
      throw err
    }
  }
  throw new Error('worker never became ready') // unreachable (loop returns or throws)
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
  // FIND-005: per-task dispatch GENERATION. runDispatch captures its generation at start and checks
  // it after every await before writing task state; retry and the board-gone handler BUMP it to
  // invalidate an in-flight run. This stops a stale runDispatch — one still awaiting when the board
  // went gone (→ task 'failed') or the user hit Retry (→ a fresh run) — from clobbering the live
  // state with a dead run's result (failed→done flip, or a dead verdict on the live retry).
  const runGenRef = useRef(new Map<string, number>())
  const bumpRunGen = (id: string): number => {
    const next = (runGenRef.current.get(id) ?? 0) + 1
    runGenRef.current.set(id, next)
    return next
  }

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
    if (!task || !api?.spawnGroup || !api?.dispatchPrompt || !api?.awaitSettled) {
      store.setTaskStatus(id, 'failed')
      return
    }
    // FIND-005: claim this run's generation. `stale()` is true once retry / board-gone has bumped it
    // — every post-await write below bails when stale, so a superseded run never clobbers the task.
    const gen = bumpRunGen(id)
    const stale = (): boolean => runGenRef.current.get(id) !== gen
    const comp = compositionOf(task)
    try {
      // Spawn the agent zone under the smart name with the user's BARE chosen command (NO prompt in
      // the shell line — the prompt goes to the REPL, see below; the kanban CARD keeps the raw task).
      const group = await api.spawnGroup({
        name: task.zoneName ?? task.title,
        planning: comp.planning,
        browser: comp.browser,
        ...(typeof task.launchCommand === 'string' ? { launchCommand: task.launchCommand } : {})
      })
      if (stale()) return // superseded while spawning — don't overwrite the live state
      const { terminalId } = group
      useCommandStore.getState().setTaskGroup(id, group)
      useCommandStore.getState().setTaskStatus(id, 'executing')
      // Boot-settle so the prompt lands at a ready REPL (trust gate cleared by skip-permissions), then
      // deliver it into the agent's INPUT BOX via the GATED dispatchPrompt write (shell-safe: REPL
      // text, never shell-parsed). Retry only the pre-gate board-not-found window.
      await sleep(WORKER_BOOT_SETTLE_MS)
      if (stale()) return
      const dispatchPrompt = api.dispatchPrompt
      // Phase 0 role packs: the pack's role brief is prepended to the engineered prompt HERE (the
      // gated REPL write), never the shell launch line — the launch stays a BARE command and the
      // brief pays the same single human confirm as the task prompt it rides.
      const pack = rolePackById(task.rolePackId)
      const prompt = singleLinePrompt(packDispatchPrompt(pack, task.prompt ?? task.title))
      await retryUntilReady(() => dispatchPrompt(terminalId, prompt))
      // Authoritative done/failed verdict — awaitSettled resolves on output silence after the worker
      // finishes (read-only; the board is already addressable here, but guard the window anyway).
      const awaitSettled = api.awaitSettled
      const result = await retryUntilReady(() => awaitSettled(terminalId))
      if (stale()) return // board went gone / retry fired during the settle — the verdict is dead
      // Phase D (collect/merge): settle → Reporting while the diff loads → snapshot the result + the
      // captured raw diff onto the task (the result zone + recap timeline read them) → done/failed.
      // gitDiff is read-only + best-effort: a missing api / non-repo cwd / error → no diff (chip hidden).
      // GAP-007: race the fetch against a timeout that resolves to '' so a hung MAIN gitDiff can't pin
      // the task in 'reporting' forever — it always advances to done/failed.
      useCommandStore.getState().setTaskStatus(id, 'reporting')
      let diff = ''
      try {
        const gitDiff = api.gitDiff
        diff = gitDiff
          ? ((await Promise.race([gitDiff(terminalId), diffTimeout(GITDIFF_TIMEOUT_MS)])) ?? '')
          : ''
      } catch {
        diff = ''
      }
      if (stale()) return
      useCommandStore.getState().setTaskResult(id, result, diff)
      useCommandStore.getState().setTaskStatus(id, isFailureResult(result) ? 'failed' : 'done')
      pumpRef.current?.() // a slot freed → dispatch the next queued task
    } catch (err) {
      if (stale()) return // a superseding run/board-gone owns the task now — don't touch it
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
      store.setTaskConfig(taskId, {
        launchCommand: result.launchCommand,
        prompt: result.prompt,
        rolePackId: result.config.rolePackId ?? undefined
      })
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
    // FIND-005: invalidate any still-in-flight run for this task FIRST, so the prior run (which may
    // still be awaiting when the card went 'failed') can't write its dead verdict onto the fresh run.
    bumpRunGen(task.id)
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
      if (task) {
        const next = nextStatusForBoardChange(task.status, change.status)
        if (next) {
          // FIND-005: a board going gone fails an in-flight task — invalidate its run so the dying
          // runDispatch can't flip 'failed' back to 'done' when its awaitSettled finally resolves.
          bumpRunGen(task.id)
          useCommandStore.getState().setTaskStatus(task.id, next)
        }
      }
      // FIND-006: a worker board going 'gone' frees a MAIN cap slot, so re-pump the queue — even when
      // NO task transitions here (e.g. the user closed a DONE worker's board). Previously the pump
      // fired only on a 'failed' transition, so a cap-rejected task could stay 'queued' forever once
      // every slot was held by completed-but-still-open workers. A board-gone is a discrete event
      // (not a cap-drift retry), so pumping here cannot busy-loop.
      if (change.status === 'gone') pumpRef.current?.()
    })
  }, [])

  return { dispatch, confirmConfig, cancelConfig, reconfigure, retry, interrupt }
}
