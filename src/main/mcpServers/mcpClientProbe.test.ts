import { describe, it, expect } from 'vitest'
import { probeExternalServer } from './mcpClientProbe'
import type { ResolvedServer } from './types'

const base: ResolvedServer = {
  id: '1',
  name: 'x',
  enabled: true,
  transport: 'http',
  targets: []
}

describe('probeExternalServer', () => {
  it('guards a missing url (http) without throwing', async () => {
    const r = await probeExternalServer({ ...base, transport: 'http', url: undefined })
    expect(r).toEqual({ ok: false, detail: 'No URL configured' })
  })

  it('guards a missing command (stdio) without throwing', async () => {
    const r = await probeExternalServer({ ...base, transport: 'stdio', command: undefined })
    expect(r).toEqual({ ok: false, detail: 'No command configured' })
  })

  it('times out on a stdio process that never speaks MCP', async () => {
    // A node process that stays alive but never completes the handshake → the connect times out.
    const r = await probeExternalServer(
      { ...base, transport: 'stdio', command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'] },
      { timeoutMs: 500 }
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/timed out/)
  }, 10_000)

  it('reports a secret-free failure for an unresolvable command', async () => {
    const r = await probeExternalServer(
      {
        ...base,
        transport: 'stdio',
        command: 'definitely-not-a-real-binary-xyz',
        env: [{ name: 'SECRET', value: 'do-not-leak' }]
      },
      { timeoutMs: 3000 }
    )
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('do-not-leak')
  }, 10_000)
})
