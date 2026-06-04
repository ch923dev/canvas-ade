/**
 * Integration tier (TESTING.md): exercises the registered `llm:*` IPC handlers via the
 * standard `ipcTestHarness` — no Electron boot. `cap.invoke` calls as a trusted internal
 * sender (synthetic senderFrame); `cap.invokeAs(foreignEvent, …)` proves the foreign-sender
 * guard on every channel (checklist #17/#20). The pure `isForeignSender` helper is unit-tested
 * in llmIpc.test.ts. No network is ever hit (mock seam via CANVAS_LLM_MOCK).
 */
import { describe, it, expect } from 'vitest'
import { registerLlmHandlers, type LlmStatus } from './llmIpc'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeLlmConfig, readLlmConfig } from './llmConfig'
import type { Encryptor } from './llmKeyStore'
import { createIpcCapture, foreignEvent, mainWin } from './ipcTestHarness'

/** A fetch that must never be called under the mock seam. */
const noNetwork = (() => {
  throw new Error('no network')
}) as never

describe('registerLlmHandlers', () => {
  it('summarize round-trips through the handler (mock env, no network)', async () => {
    const cap = createIpcCapture()
    registerLlmHandlers(cap.ipcMain, mainWin, '/no/such/dir', {
      fetch: noNetwork,
      env: { CANVAS_LLM_MOCK: '1' }
    })
    const r = await cap.invoke('llm:summarize', { text: 'ping' })
    expect(r).toEqual({ ok: true, text: '[mock] ping' })
  })

  it('enforces a configured cap through the summarize handler (mock seam, no network)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmipc-budget-'))
    try {
      // Explicit cap of 1 → mock-seam enforcement opts in (shouldEnforceBudget). The budget
      // store registerLlmHandlers builds (none injected) shares the temp dir with the config.
      writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 1 })
      let fetched = false
      const cap = createIpcCapture()
      registerLlmHandlers(cap.ipcMain, mainWin, dir, {
        fetch: (() => {
          fetched = true
          throw new Error('network must not be hit under mock')
        }) as never,
        env: { CANVAS_LLM_MOCK: '1' }
      })
      const r1 = await cap.invoke('llm:summarize', { text: 'a' })
      const r2 = await cap.invoke('llm:summarize', { text: 'b' })
      expect(r1).toEqual({ ok: true, text: '[mock] a' })
      expect(r2).toEqual({ ok: false, reason: 'budget-exceeded' })
      expect(fetched).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('status reports a provider + model and never leaks key material', async () => {
    const cap = createIpcCapture()
    registerLlmHandlers(cap.ipcMain, mainWin, '/no/such/dir', {
      fetch: noNetwork,
      env: { OPENROUTER_API_KEY: 'secret-key' }
    })
    const s = (await cap.invoke('llm:status')) as LlmStatus
    expect(s.hasProvider).toBe(true)
    expect(s.provider).toBe('openrouter')
    expect(JSON.stringify(s)).not.toContain('secret-key')
    // T-F6: no encryptor wired here → a key can't be stored encrypted.
    expect(s.encryptionAvailable).toBe(false)
  })

  it('summarize rejects a foreign sender (guard chain through the handler)', async () => {
    const cap = createIpcCapture()
    registerLlmHandlers(cap.ipcMain, mainWin, '/no/such/dir', {
      fetch: noNetwork,
      env: { CANVAS_LLM_MOCK: '1' }
    })
    const r = await cap.invokeAs(foreignEvent, 'llm:summarize', { text: 'x' })
    expect(r).toEqual({ ok: false, reason: 'provider-error', message: 'forbidden sender' })
  })

  it('status returns the degraded shape for a foreign sender', async () => {
    const cap = createIpcCapture()
    registerLlmHandlers(cap.ipcMain, mainWin, '/no/such/dir', {
      fetch: noNetwork,
      env: { OPENROUTER_API_KEY: 'secret-key' }
    })
    const s = (await cap.invokeAs(foreignEvent, 'llm:status')) as LlmStatus
    expect(s.hasProvider).toBe(false)
    expect(JSON.stringify(s)).not.toContain('secret-key')
  })
})

const fakeEncryptor = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
  decryptString: (e) => e.toString('utf8').replace(/^ENC:/, '')
})

function setupKeyed(encryptor: Encryptor): {
  dir: string
  cap: ReturnType<typeof createIpcCapture>
} {
  const dir = mkdtempSync(join(tmpdir(), 'llm-ipc-'))
  const cap = createIpcCapture()
  registerLlmHandlers(cap.ipcMain, mainWin, dir, undefined, encryptor)
  return { dir, cap }
}

describe('registerLlmHandlers — key channels', () => {
  it('setKey persists and status reports hasKey:true (key never returned)', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    const set = (await cap.invoke('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })) as {
      ok: boolean
    }
    expect(set.ok).toBe(true)
    const s = (await cap.invoke('llm:status')) as LlmStatus
    expect(s.hasKey).toBe(true)
    expect(Object.values(s)).not.toContain('sk-xyz')
  })

  it('clearKey removes the key (hasKey:false after)', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    await cap.invoke('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })
    const cleared = (await cap.invoke('llm:clearKey', { provider: 'openrouter' })) as {
      ok: boolean
    }
    expect(cleared.ok).toBe(true)
    expect(((await cap.invoke('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setKey refuses cleanly when encryption is unavailable', async () => {
    const { cap } = setupKeyed(fakeEncryptor(false))
    const set = (await cap.invoke('llm:setKey', { provider: 'openrouter', key: 'x' })) as {
      ok: boolean
      reason?: string
    }
    expect(set).toEqual({ ok: false, reason: 'encryption-unavailable' })
    expect(((await cap.invoke('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('T-F6: status.encryptionAvailable reflects the encryptor (true / false)', async () => {
    const yes = setupKeyed(fakeEncryptor(true))
    expect(((await yes.cap.invoke('llm:status')) as LlmStatus).encryptionAvailable).toBe(true)
    const no = setupKeyed(fakeEncryptor(false))
    expect(((await no.cap.invoke('llm:status')) as LlmStatus).encryptionAvailable).toBe(false)
    rmSync(yes.dir, { recursive: true, force: true })
    rmSync(no.dir, { recursive: true, force: true })
  })

  it('setConfig persists provider/model and status reflects it', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    await cap.invoke('llm:setConfig', { provider: 'anthropic', model: 'claude-3-5-haiku-latest' })
    const s = (await cap.invoke('llm:status')) as LlmStatus
    expect(s.provider).toBe('anthropic')
    expect(s.model).toBe('claude-3-5-haiku-latest')
  })

  it('setConfig preserves an already-configured maxCallsPerDay when the caller omits it (F-B)', async () => {
    const { cap, dir } = setupKeyed(fakeEncryptor())
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 7 })
    // The Settings modal sends only provider/model/baseUrl — the cap must survive the Save.
    await cap.invoke('llm:setConfig', { provider: 'openai', model: 'gpt-4.1-nano' })
    expect(readLlmConfig(dir).maxCallsPerDay).toBe(7)
  })

  it('status echoes the configured baseUrl for the local provider', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    await cap.invoke('llm:setConfig', {
      provider: 'local',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:1234/v1'
    })
    const s = (await cap.invoke('llm:status')) as LlmStatus
    expect(s.baseUrl).toBe('http://127.0.0.1:1234/v1')
  })

  // BUG-001 (SSRF): setConfig must reject a non-loopback baseUrl BEFORE persisting it, and the
  // rejected URL must never reach a summarize fetch. A valid loopback URL still round-trips.
  it('rejects a non-loopback baseUrl at setConfig and never reaches fetch (BUG-001)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-ssrf-'))
    const cap = createIpcCapture()
    let fetched = false
    // A real (non-mock) env so a poisoned config would actually try to egress.
    registerLlmHandlers(
      cap.ipcMain,
      mainWin,
      dir,
      {
        fetch: (() => {
          fetched = true
          throw new Error('SSRF: fetch must never be reached')
        }) as never,
        env: {}
      },
      fakeEncryptor()
    )
    const res = (await cap.invoke('llm:setConfig', {
      provider: 'local',
      model: 'local-model',
      baseUrl: 'http://169.254.169.254/latest/meta-data/'
    })) as { ok: boolean; reason?: string }
    expect(res).toEqual({ ok: false, reason: 'invalid-baseUrl' })
    // Nothing was persisted → status reports no configured baseUrl.
    expect(readLlmConfig(dir).baseUrl).toBeUndefined()
    // And a follow-up summarize can't egress to the attacker URL.
    const sum = await cap.invoke('llm:summarize', { text: 'secret board content' })
    expect(sum).toEqual({ ok: false, reason: 'no-provider' })
    expect(fetched).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a valid loopback baseUrl at setConfig (BUG-001)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-ssrf-ok-'))
    const cap = createIpcCapture()
    registerLlmHandlers(cap.ipcMain, mainWin, dir, { fetch: noNetwork, env: {} }, fakeEncryptor())
    const res = (await cap.invoke('llm:setConfig', {
      provider: 'local',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:1234'
    })) as { ok: boolean; reason?: string }
    expect(res).toEqual({ ok: true })
    expect(readLlmConfig(dir).baseUrl).toBe('http://127.0.0.1:1234')
    rmSync(dir, { recursive: true, force: true })
  })

  it('all write channels reject a foreign sender', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    expect(
      await cap.invokeAs(foreignEvent, 'llm:setKey', { provider: 'openrouter', key: 'x' })
    ).toEqual({ ok: false, reason: 'forbidden' })
    expect(await cap.invokeAs(foreignEvent, 'llm:clearKey', { provider: 'openrouter' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(
      await cap.invokeAs(foreignEvent, 'llm:setConfig', { provider: 'openai', model: 'm' })
    ).toEqual({ ok: false, reason: 'forbidden' })
  })
})
