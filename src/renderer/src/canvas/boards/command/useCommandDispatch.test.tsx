// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import {
  useCommandStore,
  commandStoreDefaults,
  type WorkerConfig
} from '../../../store/commandStore'
import { useCommandDispatch } from './useCommandDispatch'

/**
 * Deterministic coverage of the Phase C dispatch choreography (the side-effecting hook) with a mocked
 * `window.api` — no real spawn, no MAIN cap leak. The real spawn/gate are covered by spawnGroup.e2e /
 * mcp.e2e; here we pin the C2d/C2f WIRING: submit → engineer (zoneName + prompt) → open the config
 * dialog → on Dispatch spawn the group with the chosen BARE command → deliver the prompt to the REPL
 * via the gated dispatchPrompt (never the shell) → awaitSettled drives the verdict. Plus cancel
 * (un-ready) and cap serialize. (The boot-settle is 0 under vitest.)
 */
type Result = { present?: boolean; status?: string }

const CFG: WorkerConfig = { presetId: 'claude', values: {}, rawOverride: null }

function setupApi(
  opts: {
    spawnGroup?: () => Promise<{ groupId: string; terminalId: string }>
    dispatchPrompt?: () => Promise<void>
    awaitSettled?: () => Promise<Result>
    gitDiff?: () => Promise<string>
    summarize?: () => Promise<{ ok: boolean; text?: string; reason?: string }>
  } = {}
): {
  spawnGroup: ReturnType<typeof vi.fn>
  dispatchPrompt: ReturnType<typeof vi.fn>
  awaitSettled: ReturnType<typeof vi.fn>
  gitDiff: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  summarize: ReturnType<typeof vi.fn>
  /** Drive a board-status push (the MAIN → renderer onTaskStatus channel) into the live hook. */
  fireStatus: (change: { id: string; status: string }) => void
} {
  const spawnGroup = vi.fn(opts.spawnGroup ?? (async () => ({ groupId: 'g1', terminalId: 't1' })))
  const dispatchPrompt = vi.fn(opts.dispatchPrompt ?? (async () => {}))
  const awaitSettled = vi.fn(opts.awaitSettled ?? (async () => ({ present: false })))
  const gitDiff = vi.fn(opts.gitDiff ?? (async () => ''))
  const interrupt = vi.fn(async () => {})
  let statusListener: ((change: { id: string; status: string }) => void) | null = null
  const onTaskStatus = vi.fn((l: (change: { id: string; status: string }) => void) => {
    statusListener = l
    return () => {}
  })
  const summarize = vi.fn(
    opts.summarize ??
      (async () => ({ ok: true, text: 'TITLE: Build Feature\n\nBuild the feature end to end.' }))
  )
  ;(window as unknown as { api: unknown }).api = {
    mcp: { spawnGroup, dispatchPrompt, awaitSettled, gitDiff, interrupt, onTaskStatus },
    llm: { summarize }
  }
  return {
    spawnGroup,
    dispatchPrompt,
    awaitSettled,
    gitDiff,
    interrupt,
    summarize,
    fireStatus: (change) => statusListener?.(change)
  }
}

const TERMINAL_ONLY = { planning: false, browser: false }

beforeEach(() => useCommandStore.setState(commandStoreDefaults()))
afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useCommandDispatch', () => {
  it('engineers the prompt + zone name onto the task, then opens the config dialog', async () => {
    setupApi()
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('build it', TERMINAL_ONLY)
    await waitFor(() => {
      const st = useCommandStore.getState()
      expect(st.configuringTaskId).not.toBeNull()
      const t = st.tasks[0]
      expect(t.prompt).toBe('Build the feature end to end.')
      expect(t.zoneName).toBe('Build Feature')
      expect(t.launchCommand).toBeUndefined() // not yet dispatchable
    })
  })

  it('on Dispatch: spawns the BARE command, then delivers the prompt to the REPL → done', async () => {
    const api = setupApi()
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('build it', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const taskId = useCommandStore.getState().configuringTaskId as string

    result.current.confirmConfig(taskId, {
      launchCommand: 'claude --dangerously-skip-permissions',
      prompt: 'Do the thing, carefully.',
      config: {
        presetId: 'claude',
        values: {},
        rawOverride: 'claude --dangerously-skip-permissions'
      }
    })

    // The zone spawns under the smart name with the user's chosen command — BARE, no prompt in the
    // shell line (the prompt is delivered to the REPL, never shell-parsed).
    await waitFor(() =>
      expect(api.spawnGroup).toHaveBeenCalledWith({
        name: 'Build Feature',
        planning: false,
        browser: false,
        launchCommand: 'claude --dangerously-skip-permissions'
      })
    )
    // The engineered prompt is delivered into the agent's input box via the gated dispatchPrompt…
    await waitFor(() =>
      expect(api.dispatchPrompt).toHaveBeenCalledWith('t1', 'Do the thing, carefully.')
    )
    // …and the verdict comes from awaitSettled (read-only output-silence).
    await waitFor(() => expect(api.awaitSettled).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('done'))
    // The kanban CARD keeps the user's terse task; the dialog lock is released.
    expect(useCommandStore.getState().tasks[0].title).toBe('build it')
    expect(useCommandStore.getState().tasks[0].group?.terminalId).toBe('t1')
    expect(useCommandStore.getState().configuringTaskId).toBeNull()
    // The chosen config is remembered to pre-fill the next dispatch.
    expect(useCommandStore.getState().lastWorkerConfig?.rawOverride).toBe(
      'claude --dangerously-skip-permissions'
    )
  })

  it('delivers a multi-line prompt as a single line (the gated write rejects embedded CR/LF)', async () => {
    const api = setupApi()
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const id = useCommandStore.getState().configuringTaskId as string
    result.current.confirmConfig(id, {
      launchCommand: 'claude',
      prompt: 'line one\nline two\n\nline three',
      config: CFG
    })
    await waitFor(() =>
      expect(api.dispatchPrompt).toHaveBeenCalledWith('t1', 'line one line two line three')
    )
  })

  it('falls back to the raw task as BOTH prompt + zone name when the LLM has no provider', async () => {
    setupApi({ summarize: async () => ({ ok: false, reason: 'no-provider' }) })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('raw task', TERMINAL_ONLY)
    await waitFor(() => {
      const t = useCommandStore.getState().tasks[0]
      expect(t.prompt).toBe('raw task')
      expect(t.zoneName).toBe('raw task')
    })
  })

  it('Cancel leaves the task queued-not-ready and never spawns', async () => {
    const api = setupApi()
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('build it', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const taskId = useCommandStore.getState().configuringTaskId as string

    result.current.cancelConfig(taskId)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).toBeNull())
    const t = useCommandStore.getState().tasks[0]
    expect(t.status).toBe('queued')
    expect(t.launchCommand).toBeUndefined()
    expect(api.spawnGroup).not.toHaveBeenCalled()
  })

  it('an explicit failure verdict (from awaitSettled) settles the card to failed', async () => {
    setupApi({ awaitSettled: async () => ({ present: true, status: 'failure' }) })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const id = useCommandStore.getState().configuringTaskId as string
    result.current.confirmConfig(id, { launchCommand: 'claude', prompt: 'go', config: CFG })
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('failed'))
  })

  it('a MAIN cap rejection re-queues the configured task (waits — never fails)', async () => {
    const api = setupApi({
      spawnGroup: async () => {
        throw new Error('MCP spawn concurrency cap reached (4 live spawned boards)')
      }
    })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const id = useCommandStore.getState().configuringTaskId as string
    result.current.confirmConfig(id, { launchCommand: 'claude', prompt: 'go', config: CFG })
    await waitFor(() => expect(api.spawnGroup).toHaveBeenCalled())
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('queued'))
  })

  // FIND-005: a board-gone failure (set by onTaskStatus) must not be clobbered back to 'done' when
  // the in-flight runDispatch's awaitSettled finally resolves with a now-dead verdict.
  it('does not let a stale run flip a board-gone failure back to done (FIND-005)', async () => {
    let resolveSettled: (r: Result) => void = () => {}
    const api = setupApi({
      awaitSettled: () => new Promise<Result>((r) => (resolveSettled = r))
    })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const id = useCommandStore.getState().configuringTaskId as string
    result.current.confirmConfig(id, { launchCommand: 'claude', prompt: 'go', config: CFG })
    // Run reaches 'executing' and parks in awaitSettled (still in-flight).
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('executing'))

    // The worker board closes mid-flight → task fails.
    api.fireStatus({ id: 't1', status: 'gone' })
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('failed'))

    // The stale run's awaitSettled now resolves with a (dead) success verdict — it must be ignored.
    resolveSettled({ present: false })
    await new Promise((r) => setTimeout(r, 0)) // flush the run's post-await continuation
    expect(useCommandStore.getState().tasks[0]?.status).toBe('failed')
  })

  // FIND-006: a cap-rejected task re-queues with no pump; a worker board going 'gone' frees a MAIN
  // slot and must re-pump the queue so the stuck task finally spawns (previously it hung forever).
  it('re-pumps a cap-rejected queued task when a board frees a slot (FIND-006)', async () => {
    let calls = 0
    const api = setupApi({
      spawnGroup: async () => {
        if (++calls === 1) {
          throw new Error('MCP spawn concurrency cap reached (4 live spawned boards)')
        }
        return { groupId: 'g2', terminalId: 't2' }
      }
    })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const id = useCommandStore.getState().configuringTaskId as string
    result.current.confirmConfig(id, { launchCommand: 'claude', prompt: 'go', config: CFG })

    // First spawn is cap-rejected → the task re-queues and (by design) does NOT self-pump.
    await waitFor(() => expect(api.spawnGroup).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('queued'))

    // Some other worker board closes → a MAIN slot freed → the queue must re-pump and spawn it.
    api.fireStatus({ id: 'some-other-board', status: 'gone' })
    await waitFor(() => expect(api.spawnGroup).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('done'))
  })

  // GAP-007: a hung MAIN gitDiff must not pin the task in 'reporting' — the renderer races the
  // fetch against a timeout that resolves to '' so the task always advances to done/failed.
  it('advances to done with no diff when gitDiff hangs (GAP-007)', async () => {
    setupApi({ gitDiff: () => new Promise<string>(() => {}) }) // never resolves
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().configuringTaskId).not.toBeNull())
    const id = useCommandStore.getState().configuringTaskId as string
    result.current.confirmConfig(id, { launchCommand: 'claude', prompt: 'go', config: CFG })
    // Despite the stalled diff, the timeout fires (50ms under vitest) → task settles, no diff captured.
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('done'))
    expect(useCommandStore.getState().tasks[0]?.diff ?? '').toBe('')
  })

  it('serializes at the cap — 5 configured terminal-only tasks, only 4 spawn', async () => {
    // spawnGroup resolves (unique ids), dispatchPrompt resolves, but awaitSettled never resolves →
    // 4 tasks hold all 4 slots.
    let n = 0
    setupApi({
      spawnGroup: async () => ({ groupId: `g${++n}`, terminalId: `t${n}` }),
      awaitSettled: () => new Promise<Result>(() => {})
    })
    const { result } = renderHook(() => useCommandDispatch(4))
    for (let i = 0; i < 5; i++) result.current.dispatch(`task ${i}`, TERMINAL_ONLY)
    // all 5 engineered (the modal serializes config in the UI; here we commit each directly).
    await waitFor(() =>
      expect(useCommandStore.getState().tasks.filter((t) => t.prompt).length).toBe(5)
    )
    for (const id of useCommandStore.getState().tasks.map((t) => t.id)) {
      result.current.confirmConfig(id, { launchCommand: 'claude', prompt: 'go', config: CFG })
    }
    await waitFor(() => {
      const tasks = useCommandStore.getState().tasks
      expect(tasks.filter((t) => t.status === 'executing').length).toBe(4)
      expect(tasks.filter((t) => t.status === 'queued').length).toBe(1)
    })
  })
})
