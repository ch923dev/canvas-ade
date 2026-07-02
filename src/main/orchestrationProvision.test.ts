/**
 * Unit tests for orchestrationProvision.ts — the Sync modal's data-plane IPC. The connected-tier
 * minter (P0 seam) and the P3 provisioner surface are mocked so the handler logic is tested in
 * isolation: frame guard, no-project gate, consent gate, CLI-id filtering, and the mint-throws
 * fallback. No MCP server is mounted and no real CLI configs are written.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'

const { mintTerminalToken, isOrchestrationEnabled, getProvisionStatus, runProvisionerSync } =
  vi.hoisted(() => ({
    mintTerminalToken: vi.fn(),
    isOrchestrationEnabled: vi.fn(),
    getProvisionStatus: vi.fn(),
    runProvisionerSync: vi.fn()
  }))

vi.mock('./orchestration/seam', () => ({ mintTerminalToken, isOrchestrationEnabled }))
vi.mock('./cliProvisioners', () => ({
  CLI_IDS: ['claude', 'codex', 'gemini', 'opencode'],
  getProvisionStatus,
  runProvisionerSync
}))

import { registerOrchestrationProvisionHandlers } from './orchestrationProvision'

const TOKEN = { token: 'tok-secret', tier: 'connected' as const, port: 4321 }

function setup(projectDir: string | null = '/proj/test') {
  const cap = createIpcCapture()
  registerOrchestrationProvisionHandlers(cap.ipcMain, mainWin, () => projectDir)
  return cap
}

beforeEach(() => {
  vi.clearAllMocks()
  // Orchestration consent is granted by default so the pre-existing behavioral tests below (which
  // predate the consent gate) keep exercising the mint/sync path; the dedicated "consent" describe
  // block below flips this to false to assert the gate itself.
  isOrchestrationEnabled.mockReturnValue(true)
  mintTerminalToken.mockReturnValue(TOKEN)
  getProvisionStatus.mockResolvedValue({
    endpoint: { host: '127.0.0.1', port: 4321, maskedToken: '••••••' },
    rows: []
  })
  runProvisionerSync.mockResolvedValue([
    { id: 'claude', status: 'synced', detail: 'Wrote .mcp.json' }
  ])
})

describe('orchestration:getProvisionStatus', () => {
  it('returns the status with the LIVE minted port (token discarded, never returned)', async () => {
    const cap = setup()
    const out = await cap.invoke('orchestration:getProvisionStatus')
    expect(getProvisionStatus).toHaveBeenCalledWith({ projectDir: '/proj/test', port: 4321 })
    expect(out).toEqual({
      endpoint: { host: '127.0.0.1', port: 4321, maskedToken: '••••••' },
      rows: []
    })
    // The raw token never crosses the boundary.
    expect(JSON.stringify(out)).not.toContain('tok-secret')
  })

  it('returns null for a foreign sender (guard blocks; never mints)', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'orchestration:getProvisionStatus')).toBeNull()
    expect(mintTerminalToken).not.toHaveBeenCalled()
  })

  it('returns null when no project is open', async () => {
    const cap = setup(null)
    expect(await cap.invoke('orchestration:getProvisionStatus')).toBeNull()
    expect(getProvisionStatus).not.toHaveBeenCalled()
  })

  it('returns null (loading state) when the MCP server is not mounted (mint throws)', async () => {
    mintTerminalToken.mockImplementation(() => {
      throw new Error('MCP server not mounted')
    })
    const cap = setup()
    expect(await cap.invoke('orchestration:getProvisionStatus')).toBeNull()
    expect(getProvisionStatus).not.toHaveBeenCalled()
  })
})

describe('orchestration:syncProvisioners', () => {
  it('runs the requested provisioners with the minted token', async () => {
    const cap = setup()
    const out = await cap.invoke('orchestration:syncProvisioners', ['claude', 'gemini'])
    expect(runProvisionerSync).toHaveBeenCalledWith({
      projectDir: '/proj/test',
      ids: ['claude', 'gemini'],
      token: TOKEN
    })
    expect(out).toEqual([{ id: 'claude', status: 'synced', detail: 'Wrote .mcp.json' }])
  })

  it('filters out unknown CLI ids before syncing', async () => {
    const cap = setup()
    await cap.invoke('orchestration:syncProvisioners', ['claude', 'bogus', 'codex'])
    expect(runProvisionerSync).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ['claude', 'codex'] })
    )
  })

  it('returns [] without minting when no valid ids are given', async () => {
    const cap = setup()
    expect(await cap.invoke('orchestration:syncProvisioners', ['bogus'])).toEqual([])
    expect(await cap.invoke('orchestration:syncProvisioners', 'not-an-array')).toEqual([])
    expect(mintTerminalToken).not.toHaveBeenCalled()
    expect(runProvisionerSync).not.toHaveBeenCalled()
  })

  it('returns [] for a foreign sender (guard blocks; never syncs)', async () => {
    const cap = setup()
    expect(await cap.invokeAs(foreignEvent, 'orchestration:syncProvisioners', ['claude'])).toEqual(
      []
    )
    expect(runProvisionerSync).not.toHaveBeenCalled()
  })

  it('returns [] when no project is open', async () => {
    const cap = setup(null)
    expect(await cap.invoke('orchestration:syncProvisioners', ['claude'])).toEqual([])
    expect(runProvisionerSync).not.toHaveBeenCalled()
  })

  it('marks every requested CLI errored when the MCP server is not mounted (mint throws)', async () => {
    mintTerminalToken.mockImplementation(() => {
      throw new Error('MCP server not mounted')
    })
    const cap = setup()
    const out = await cap.invoke('orchestration:syncProvisioners', ['claude', 'codex'])
    expect(out).toEqual([
      { id: 'claude', status: 'error', detail: expect.stringMatching(/not running/i) },
      { id: 'codex', status: 'error', detail: expect.stringMatching(/not running/i) }
    ])
    expect(runProvisionerSync).not.toHaveBeenCalled()
  })
})

// BUG-004: without orchestration consent, neither handler may mint or persist a live bearer
// token — mirrors the spawn-time gate in `makeOrchestrationSyncProvider`
// (cliProvisioners/index.ts).
describe('BUG-004: consent gate (isOrchestrationEnabled)', () => {
  beforeEach(() => {
    isOrchestrationEnabled.mockReturnValue(false)
  })

  it('getProvisionStatus returns null and never mints when consent is not granted', async () => {
    const cap = setup()
    expect(await cap.invoke('orchestration:getProvisionStatus')).toBeNull()
    expect(isOrchestrationEnabled).toHaveBeenCalledWith('/proj/test')
    expect(mintTerminalToken).not.toHaveBeenCalled()
    expect(getProvisionStatus).not.toHaveBeenCalled()
  })

  it('syncProvisioners errors every requested CLI and never mints/writes when consent is not granted', async () => {
    const cap = setup()
    const out = await cap.invoke('orchestration:syncProvisioners', ['claude', 'codex'])
    expect(out).toEqual([
      { id: 'claude', status: 'error', detail: expect.stringMatching(/not enabled/i) },
      { id: 'codex', status: 'error', detail: expect.stringMatching(/not enabled/i) }
    ])
    expect(mintTerminalToken).not.toHaveBeenCalled()
    expect(runProvisionerSync).not.toHaveBeenCalled()
  })
})
