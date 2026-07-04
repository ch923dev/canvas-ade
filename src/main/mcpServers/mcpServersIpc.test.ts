import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createIpcCapture, foreignEvent, mainWin } from '../ipcTestHarness'
import type { Encryptor } from '../llmKeyStore'
import { createMcpServersStore } from './mcpServersStore'
import { bindExternalSyncStore, __resetExternalSync } from './externalSync'
import { registerMcpServersHandlers } from './mcpServersIpc'
import type { MaskedServer } from './types'

function fakeEncryptor(): Encryptor {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
    decryptString: (e) => e.toString('utf8').replace(/^ENC:/, '')
  }
}

let ud: string
let home: string
const savedHome = process.env.HOME
const savedUserProfile = process.env.USERPROFILE
let cap: ReturnType<typeof createIpcCapture>
let probe: ReturnType<typeof vi.fn>

const httpBody = {
  name: 'linear',
  enabled: true,
  transport: 'http' as const,
  url: 'https://mcp.linear.app/sse',
  headers: [{ name: 'Authorization', value: 'Bearer secret' }],
  targets: ['claude']
}

beforeEach(() => {
  ud = mkdtempSync(join(tmpdir(), 'ipc-ud-'))
  home = mkdtempSync(join(tmpdir(), 'ipc-home-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  __resetExternalSync()
  bindExternalSyncStore(ud)
  const store = createMcpServersStore(ud, fakeEncryptor())
  probe = vi.fn().mockResolvedValue({ ok: true, toolCount: 3 })
  cap = createIpcCapture()
  registerMcpServersHandlers(cap.ipcMain, mainWin, {
    store,
    probe: probe as never,
    now: () => 12345
  })
})
afterEach(() => {
  process.env.HOME = savedHome
  process.env.USERPROFILE = savedUserProfile
  __resetExternalSync()
})

describe('mcp-servers IPC', () => {
  it('save → list returns a masked row (no secret value)', async () => {
    const r = (await cap.invoke('mcp-servers:save', httpBody)) as { ok: boolean }
    expect(r.ok).toBe(true)
    const list = (await cap.invoke('mcp-servers:list')) as MaskedServer[]
    expect(list).toHaveLength(1)
    expect(list[0].headers).toEqual([{ name: 'Authorization', hasValue: true }])
    expect(JSON.stringify(list)).not.toContain('secret')
  })

  it('rejects the reserved name and a malformed payload', async () => {
    expect(await cap.invoke('mcp-servers:save', { ...httpBody, name: 'canvas-ade' })).toMatchObject(
      {
        ok: false,
        reason: 'validation'
      }
    )
    expect(await cap.invoke('mcp-servers:save', 42)).toMatchObject({ ok: false })
  })

  it('setEnabled + remove mutate the registry', async () => {
    const saved = (await cap.invoke('mcp-servers:save', httpBody)) as { ok: true; id: string }
    await cap.invoke('mcp-servers:setEnabled', saved.id, false)
    expect(((await cap.invoke('mcp-servers:list')) as MaskedServer[])[0].enabled).toBe(false)
    await cap.invoke('mcp-servers:remove', saved.id)
    expect(await cap.invoke('mcp-servers:list')).toHaveLength(0)
  })

  it('test invokes the probe with decrypted secrets and records lastTest', async () => {
    const saved = (await cap.invoke('mcp-servers:save', httpBody)) as { ok: true; id: string }
    const result = await cap.invoke('mcp-servers:test', saved.id)
    expect(probe).toHaveBeenCalledTimes(1)
    // The probe receives the DECRYPTED value (MAIN-only); the renderer result does not.
    expect(probe.mock.calls[0][0].headers[0].value).toBe('Bearer secret')
    expect(result).toEqual({ ok: true, at: 12345, toolCount: 3, detail: undefined })
    const list = (await cap.invoke('mcp-servers:list')) as MaskedServer[]
    expect(list[0].lastTest).toMatchObject({ ok: true, toolCount: 3 })
  })

  it('test on an unknown id returns a safe failure without probing', async () => {
    expect(await cap.invoke('mcp-servers:test', 'nope')).toMatchObject({ ok: false })
    expect(probe).not.toHaveBeenCalled()
  })

  it('detectClis returns a per-CLI map', async () => {
    const d = (await cap.invoke('mcp-servers:detectClis')) as Record<string, boolean>
    expect(Object.keys(d).sort()).toEqual(['claude', 'codex', 'gemini', 'opencode'])
  })

  it('rejects a foreign sender on every channel', async () => {
    expect(await cap.invokeAs(foreignEvent, 'mcp-servers:list')).toEqual([])
    expect(await cap.invokeAs(foreignEvent, 'mcp-servers:save', httpBody)).toMatchObject({
      ok: false
    })
    expect(await cap.invokeAs(foreignEvent, 'mcp-servers:remove', 'x')).toEqual({ ok: false })
    expect(await cap.invokeAs(foreignEvent, 'mcp-servers:test', 'x')).toMatchObject({ ok: false })
    expect(probe).not.toHaveBeenCalled()
  })
})
