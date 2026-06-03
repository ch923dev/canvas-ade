import { describe, it, expect } from 'vitest'
import { isForeignSender, registerLlmHandlers, type LlmStatus } from './llmIpc'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeLlmConfig } from './llmConfig'
import type { Encryptor } from './llmKeyStore'

describe('isForeignSender', () => {
  const frame = {} as never
  it('allows a synthetic call (no senderFrame)', () => {
    expect(isForeignSender({ senderFrame: null } as never, () => frame)).toBe(false)
  })
  it('denies a real sender when the window is unresolved', () => {
    expect(isForeignSender({ senderFrame: frame } as never, () => null)).toBe(true)
  })
  it('allows the main frame and denies a different frame', () => {
    expect(isForeignSender({ senderFrame: frame } as never, () => frame)).toBe(false)
    expect(isForeignSender({ senderFrame: {} as never } as never, () => frame)).toBe(true)
  })
})

describe('registerLlmHandlers', () => {
  function fakeIpc(): {
    ipcMain: { handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void }
    call: (c: string, a?: unknown) => Promise<unknown>
  } {
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    return {
      ipcMain: { handle: (c, h) => void handlers.set(c, h) },
      call: (c, a) => Promise.resolve(handlers.get(c)!({ senderFrame: null }, a))
    }
  }

  it('summarize round-trips through the handler (mock env, no network)', async () => {
    const f = fakeIpc()
    registerLlmHandlers(f.ipcMain as never, () => null, '/no/such/dir', {
      fetch: (() => {
        throw new Error('no network')
      }) as never,
      env: { CANVAS_LLM_MOCK: '1' }
    })
    const r = await f.call('llm:summarize', { text: 'ping' })
    expect(r).toEqual({ ok: true, text: '[mock] ping' })
  })

  it('enforces a configured cap through the summarize handler (mock seam, no network)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmipc-budget-'))
    try {
      // Explicit cap of 1 → mock-seam enforcement opts in (shouldEnforceBudget).
      writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 1 })
      // Reuse the file's handler-capture pattern, but against the real temp dir so the
      // budget store registerLlmHandlers builds (no budget injected) shares it with the config.
      const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
      let fetched = false
      registerLlmHandlers(
        {
          handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
        } as never,
        () => null,
        dir,
        {
          fetch: (() => {
            fetched = true
            throw new Error('network must not be hit under mock')
          }) as never,
          env: { CANVAS_SMOKE: 'e2e' }
        }
      )
      const summarize = handlers.get('llm:summarize')!
      const evt = { senderFrame: null } // synthetic → guard allows
      const r1 = await Promise.resolve(summarize(evt, { text: 'a' }))
      const r2 = await Promise.resolve(summarize(evt, { text: 'b' }))
      expect(r1).toEqual({ ok: true, text: '[mock] a' })
      expect(r2).toEqual({ ok: false, reason: 'budget-exceeded' })
      expect(fetched).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('status reports a provider + model and never leaks key material', async () => {
    const f = fakeIpc()
    registerLlmHandlers(f.ipcMain as never, () => null, '/no/such/dir', {
      fetch: (() => {
        throw new Error('no network')
      }) as never,
      env: { OPENROUTER_API_KEY: 'secret-key' }
    })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.hasProvider).toBe(true)
    expect(s.provider).toBe('openrouter')
    expect(JSON.stringify(s)).not.toContain('secret-key')
  })

  it('summarize rejects a foreign sender (guard chain through the handler)', async () => {
    const mainFrame = {}
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    registerLlmHandlers(
      {
        handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
      } as never,
      () => ({ webContents: { mainFrame } }) as never,
      '/no/such/dir',
      {
        fetch: (() => {
          throw new Error('no network')
        }) as never,
        env: { CANVAS_LLM_MOCK: '1' }
      }
    )
    const r = await Promise.resolve(
      handlers.get('llm:summarize')!({ senderFrame: {} }, { text: 'x' })
    )
    expect(r).toEqual({ ok: false, reason: 'provider-error', message: 'forbidden sender' })
  })

  it('status returns the degraded shape for a foreign sender', async () => {
    const mainFrame = {}
    const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
    registerLlmHandlers(
      {
        handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
      } as never,
      () => ({ webContents: { mainFrame } }) as never,
      '/no/such/dir',
      {
        fetch: (() => {
          throw new Error('no network')
        }) as never,
        env: { OPENROUTER_API_KEY: 'secret-key' }
      }
    )
    const s = (await Promise.resolve(
      handlers.get('llm:status')!({ senderFrame: {} }, undefined)
    )) as LlmStatus
    expect(s.hasProvider).toBe(false)
    expect(JSON.stringify(s)).not.toContain('secret-key')
  })
})

const fakeEncryptor = (available = true): Encryptor => ({
  isEncryptionAvailable: () => available,
  encryptString: (p) => Buffer.from('ENC:' + p, 'utf8'),
  decryptString: (e) => e.toString('utf8').replace(/^ENC:/, '')
})

function setupKeyed(encryptor: Encryptor) {
  const handlers = new Map<string, (e: unknown, a: unknown) => unknown>()
  const dir = mkdtempSync(join(tmpdir(), 'llm-ipc-'))
  registerLlmHandlers(
    {
      handle: (c: string, h: (e: unknown, a: unknown) => unknown) => void handlers.set(c, h)
    } as never,
    () => null,
    dir,
    undefined,
    encryptor
  )
  return {
    dir,
    call: (c: string, a?: unknown) => Promise.resolve(handlers.get(c)!({ senderFrame: null }, a)),
    callForeign: (c: string, a?: unknown) =>
      Promise.resolve(handlers.get(c)!({ senderFrame: {} }, a))
  }
}

describe('registerLlmHandlers — key channels', () => {
  it('setKey persists and status reports hasKey:true (key never returned)', async () => {
    const f = setupKeyed(fakeEncryptor())
    const set = (await f.call('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })) as {
      ok: boolean
    }
    expect(set.ok).toBe(true)
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.hasKey).toBe(true)
    expect(Object.values(s)).not.toContain('sk-xyz')
  })

  it('clearKey removes the key (hasKey:false after)', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setKey', { provider: 'openrouter', key: 'sk-xyz' })
    const cleared = (await f.call('llm:clearKey', { provider: 'openrouter' })) as { ok: boolean }
    expect(cleared.ok).toBe(true)
    expect(((await f.call('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setKey refuses cleanly when encryption is unavailable', async () => {
    const f = setupKeyed(fakeEncryptor(false))
    const set = (await f.call('llm:setKey', { provider: 'openrouter', key: 'x' })) as {
      ok: boolean
      reason?: string
    }
    expect(set).toEqual({ ok: false, reason: 'encryption-unavailable' })
    expect(((await f.call('llm:status')) as LlmStatus).hasKey).toBe(false)
  })

  it('setConfig persists provider/model and status reflects it', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setConfig', { provider: 'anthropic', model: 'claude-3-5-haiku-latest' })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.provider).toBe('anthropic')
    expect(s.model).toBe('claude-3-5-haiku-latest')
  })

  it('status echoes the configured baseUrl for the local provider', async () => {
    const f = setupKeyed(fakeEncryptor())
    await f.call('llm:setConfig', {
      provider: 'local',
      model: 'local-model',
      baseUrl: 'http://127.0.0.1:1234/v1'
    })
    const s = (await f.call('llm:status')) as LlmStatus
    expect(s.baseUrl).toBe('http://127.0.0.1:1234/v1')
  })

  it('all new channels reject a foreign sender', async () => {
    const f = setupKeyed(fakeEncryptor())
    expect(await f.callForeign('llm:setKey', { provider: 'openrouter', key: 'x' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await f.callForeign('llm:clearKey', { provider: 'openrouter' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
    expect(await f.callForeign('llm:setConfig', { provider: 'openai', model: 'm' })).toEqual({
      ok: false,
      reason: 'forbidden'
    })
  })
})
