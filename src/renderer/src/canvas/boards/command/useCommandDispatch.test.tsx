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
 * `window.api` — no real spawn, no MAIN cap leak. The real spawn primitive is covered by spawnGroup.e2e
 * and the confirm gate by mcp.e2e; here we pin the C2d WIRING: submit → engineer (zoneName + prompt) →
 * open the config dialog → on Dispatch spawn the group with the CHOSEN launch command → hand off the
 * EDITED prompt → settle. Plus cancel (un-ready) and cap serialize. (The boot-settle is 0 under vitest.)
 */
type Result = { present?: boolean; status?: string }

const CFG: WorkerConfig = { presetId: 'claude', values: {}, rawOverride: null }

function setupApi(
  opts: {
    spawnGroup?: () => Promise<{ groupId: string; terminalId: string }>
    handoffPrompt?: () => Promise<Result>
    summarize?: () => Promise<{ ok: boolean; text?: string; reason?: string }>
  } = {}
): {
  spawnGroup: ReturnType<typeof vi.fn>
  handoffPrompt: ReturnType<typeof vi.fn>
  interrupt: ReturnType<typeof vi.fn>
  summarize: ReturnType<typeof vi.fn>
} {
  const spawnGroup = vi.fn(opts.spawnGroup ?? (async () => ({ groupId: 'g1', terminalId: 't1' })))
  const handoffPrompt = vi.fn(opts.handoffPrompt ?? (async () => ({ present: false })))
  const interrupt = vi.fn(async () => {})
  const onTaskStatus = vi.fn(() => () => {})
  const summarize = vi.fn(
    opts.summarize ??
      (async () => ({ ok: true, text: 'TITLE: Build Feature\n\nBuild the feature end to end.' }))
  )
  ;(window as unknown as { api: unknown }).api = {
    mcp: { spawnGroup, handoffPrompt, interrupt, onTaskStatus },
    llm: { summarize }
  }
  return { spawnGroup, handoffPrompt, interrupt, summarize }
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

  it('on Dispatch: spawns with the CHOSEN command + hands off the EDITED prompt → done', async () => {
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

    // The zone spawns under the smart name with the user's chosen launch command (the trust flag)…
    await waitFor(() =>
      expect(api.spawnGroup).toHaveBeenCalledWith({
        name: 'Build Feature',
        planning: false,
        browser: false,
        launchCommand: 'claude --dangerously-skip-permissions'
      })
    )
    // …and the worker gets the EDITED instruction, not the raw input.
    await waitFor(() =>
      expect(api.handoffPrompt).toHaveBeenCalledWith('t1', 'Do the thing, carefully.')
    )
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

  it('an explicit failure verdict settles the card to failed', async () => {
    setupApi({ handoffPrompt: async () => ({ present: true, status: 'failure' }) })
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

  it('serializes at the cap — 5 configured terminal-only tasks, only 4 spawn', async () => {
    // spawnGroup resolves (unique ids) but handoff never settles → 4 tasks hold all 4 slots.
    let n = 0
    setupApi({
      spawnGroup: async () => ({ groupId: `g${++n}`, terminalId: `t${n}` }),
      handoffPrompt: () => new Promise<Result>(() => {})
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
