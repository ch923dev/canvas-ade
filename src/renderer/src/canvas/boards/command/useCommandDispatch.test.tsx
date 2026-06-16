// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useCommandStore, commandStoreDefaults } from '../../../store/commandStore'
import { useCommandDispatch } from './useCommandDispatch'

/**
 * Deterministic coverage of the Phase C dispatch choreography (the side-effecting hook) with a
 * mocked `window.api` — no real spawn, no MAIN cap leak. The real spawn primitive is covered by
 * spawnGroup.e2e and the confirm gate by mcp.e2e; here we pin the WIRING: submit → engineer prompt
 * + spawn the agent group concurrently → hand off the engineered prompt → settle the card.
 */
type Result = { present?: boolean; status?: string }

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
  it('spawns under the SMART zone name + hands off the ENGINEERED instruction → done', async () => {
    const api = setupApi()
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('build it', TERMINAL_ONLY)

    // Zone spawns under the LLM's smart intent NAME (not the raw verbose task)…
    await waitFor(() =>
      expect(api.spawnGroup).toHaveBeenCalledWith({
        name: 'Build Feature',
        planning: false,
        browser: false,
        launchCommand: 'claude'
      })
    )
    // …and the worker gets the engineered INSTRUCTION, not the terse input.
    await waitFor(() =>
      expect(api.handoffPrompt).toHaveBeenCalledWith('t1', 'Build the feature end to end.')
    )
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('done'))
    // The group is attached; the kanban CARD keeps the user's terse task (only the zone is renamed).
    expect(useCommandStore.getState().tasks[0].group?.terminalId).toBe('t1')
    expect(useCommandStore.getState().tasks[0].title).toBe('build it')
  })

  it('falls back to the raw task when the LLM has no provider', async () => {
    const api = setupApi({ summarize: async () => ({ ok: false, reason: 'no-provider' }) })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('raw task', TERMINAL_ONLY)
    await waitFor(() => expect(api.handoffPrompt).toHaveBeenCalledWith('t1', 'raw task'))
  })

  it('an explicit failure verdict settles the card to failed', async () => {
    setupApi({ handoffPrompt: async () => ({ present: true, status: 'failure' }) })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('failed'))
  })

  it('a MAIN cap rejection re-queues the task (waits — never fails)', async () => {
    const api = setupApi({
      spawnGroup: async () => {
        throw new Error('MCP spawn concurrency cap reached (4 live spawned boards)')
      }
    })
    const { result } = renderHook(() => useCommandDispatch(4))
    result.current.dispatch('x', TERMINAL_ONLY)
    await waitFor(() => expect(api.spawnGroup).toHaveBeenCalled())
    await waitFor(() => expect(useCommandStore.getState().tasks[0]?.status).toBe('queued'))
  })

  it('serializes at the cap — a 5th terminal-only task waits in queued (4 in flight)', async () => {
    // spawnGroup resolves but handoff never settles → 4 tasks stay executing, holding all 4 slots.
    setupApi({
      spawnGroup: async () => ({ groupId: `g`, terminalId: `t` }),
      handoffPrompt: () => new Promise<Result>(() => {})
    })
    const { result } = renderHook(() => useCommandDispatch(4))
    for (let i = 0; i < 5; i++) result.current.dispatch(`task ${i}`, TERMINAL_ONLY)
    await waitFor(() => {
      const tasks = useCommandStore.getState().tasks
      expect(tasks.filter((t) => t.status === 'executing').length).toBe(4)
      expect(tasks.filter((t) => t.status === 'queued').length).toBe(1)
    })
  })
})
