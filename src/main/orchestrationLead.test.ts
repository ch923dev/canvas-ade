/**
 * Unit tests for orchestrationLead.ts — the lead-terminal consent-gated IPC (orchestration
 * Phase 1). The MCP server is mocked, so what is under test is the handler logic itself: the
 * frame guard, the no-project / consent / no-server gates, arg validation, and the pass-through
 * of the single-active-lead result. No token ever appears anywhere in this surface.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'
import type { RunningMcp } from './mcp'

const { isOrchestrationEnabled } = vi.hoisted(() => ({ isOrchestrationEnabled: vi.fn() }))
vi.mock('./orchestration/seam', () => ({ isOrchestrationEnabled }))

import { registerOrchestrationLeadHandlers } from './orchestrationLead'

function makeMcp(overrides: Partial<RunningMcp> = {}): RunningMcp {
  return {
    getLeadBoardId: vi.fn(() => null),
    grantLead: vi.fn(() => ({ ok: true }) as const),
    revokeLead: vi.fn(),
    ...overrides
  } as unknown as RunningMcp
}

function setup(opts: { projectDir?: string | null; mcp?: RunningMcp | null } = {}) {
  const mcp = opts.mcp === undefined ? makeMcp() : opts.mcp
  const cap = createIpcCapture()
  registerOrchestrationLeadHandlers(cap.ipcMain, mainWin, {
    getCurrentDir: () => (opts.projectDir === undefined ? '/proj/test' : opts.projectDir),
    ensureMcp: vi.fn(async () => mcp),
    getMcp: () => mcp
  })
  return { cap, mcp }
}

beforeEach(() => {
  vi.clearAllMocks()
  isOrchestrationEnabled.mockReturnValue(true)
})

describe('orchestration:getLeadStatus', () => {
  it('returns the designated board id from the running server', async () => {
    const mcp = makeMcp({ getLeadBoardId: vi.fn(() => 't1') })
    const { cap } = setup({ mcp })
    expect(await cap.invoke('orchestration:getLeadStatus')).toEqual({ boardId: 't1' })
  })

  it('returns null when no server is mounted (never force-starts one)', async () => {
    const { cap } = setup({ mcp: null })
    expect(await cap.invoke('orchestration:getLeadStatus')).toEqual({ boardId: null })
  })

  it('returns null for a foreign sender', async () => {
    const mcp = makeMcp({ getLeadBoardId: vi.fn(() => 't1') })
    const { cap } = setup({ mcp })
    expect(await cap.invokeAs(foreignEvent, 'orchestration:getLeadStatus')).toEqual({
      boardId: null
    })
    expect(mcp.getLeadBoardId).not.toHaveBeenCalled()
  })
})

describe('orchestration:grantLead', () => {
  it('grants through the server and returns its result', async () => {
    const { cap, mcp } = setup()
    expect(await cap.invoke('orchestration:grantLead', 't1')).toEqual({ ok: true })
    expect(mcp!.grantLead).toHaveBeenCalledWith('t1')
  })

  it('passes the single-active-lead refusal through untouched', async () => {
    const mcp = makeMcp({
      grantLead: vi.fn(() => ({ ok: false, reason: 'already-active', holder: 't0' }) as const)
    })
    const { cap } = setup({ mcp })
    expect(await cap.invoke('orchestration:grantLead', 't1')).toEqual({
      ok: false,
      reason: 'already-active',
      holder: 't0'
    })
  })

  it('🔒 refuses a foreign sender before any validation', async () => {
    const { cap, mcp } = setup()
    expect(await cap.invokeAs(foreignEvent, 'orchestration:grantLead', 't1')).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(mcp!.grantLead).not.toHaveBeenCalled()
  })

  it('rejects a non-string / empty board id', async () => {
    const { cap, mcp } = setup()
    expect(await cap.invoke('orchestration:grantLead', 42)).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(await cap.invoke('orchestration:grantLead', '  ')).toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(mcp!.grantLead).not.toHaveBeenCalled()
  })

  it('refuses with no project open', async () => {
    const { cap, mcp } = setup({ projectDir: null })
    expect(await cap.invoke('orchestration:grantLead', 't1')).toEqual({
      ok: false,
      reason: 'no-project'
    })
    expect(mcp!.grantLead).not.toHaveBeenCalled()
  })

  it('🔒 refuses when the project has not granted orchestration consent', async () => {
    isOrchestrationEnabled.mockReturnValue(false)
    const { cap, mcp } = setup()
    expect(await cap.invoke('orchestration:grantLead', 't1')).toEqual({
      ok: false,
      reason: 'consent'
    })
    expect(mcp!.grantLead).not.toHaveBeenCalled()
  })

  it('refuses when the server cannot start', async () => {
    const cap = createIpcCapture()
    registerOrchestrationLeadHandlers(cap.ipcMain, mainWin, {
      getCurrentDir: () => '/proj/test',
      ensureMcp: vi.fn(async () => null),
      getMcp: () => null
    })
    expect(await cap.invoke('orchestration:grantLead', 't1')).toEqual({
      ok: false,
      reason: 'no-server'
    })
  })
})

describe('orchestration:revokeLead', () => {
  it('revokes through the running server (idempotent ok)', async () => {
    const { cap, mcp } = setup()
    expect(await cap.invoke('orchestration:revokeLead')).toEqual({ ok: true })
    expect(mcp!.revokeLead).toHaveBeenCalled()
  })

  it('ok even with no server mounted (nothing to revoke)', async () => {
    const { cap } = setup({ mcp: null })
    expect(await cap.invoke('orchestration:revokeLead')).toEqual({ ok: true })
  })

  it('refuses a foreign sender', async () => {
    const { cap, mcp } = setup()
    expect(await cap.invokeAs(foreignEvent, 'orchestration:revokeLead')).toEqual({ ok: false })
    expect(mcp!.revokeLead).not.toHaveBeenCalled()
  })
})
