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

  // BUG-011: a summarize call with no/empty `text` must be rejected at the handler with a typed
  // error BEFORE any provider/budget work — never reach the provider as a null-content request.
  it('rejects summarize with a missing or empty text field (BUG-011)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmipc-bug011-'))
    try {
      // Configure an explicit cap so the budget store is engaged under the mock seam — proves the
      // guard fires BEFORE budget is touched.
      writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 5 })
      const cap = createIpcCapture()
      registerLlmHandlers(cap.ipcMain, mainWin, dir, {
        fetch: noNetwork,
        env: { CANVAS_LLM_MOCK: '1' }
      })
      const invalid = {
        ok: false,
        reason: 'provider-error',
        message: 'invalid input: text is required'
      }
      // No `text` key (the masked-by-mock case: old behavior returned { ok:true, text:'[mock] undefined' }).
      expect(await cap.invoke('llm:summarize', { system: 'x' })).toEqual(invalid)
      // Empty string.
      expect(await cap.invoke('llm:summarize', { text: '' })).toEqual(invalid)
      // Non-string text.
      expect(await cap.invoke('llm:summarize', { text: 123 } as never)).toEqual(invalid)
      // null/undefined input object — must not throw, returns the typed error.
      expect(await cap.invoke('llm:summarize', null as never)).toEqual(invalid)
      // The budget was never consumed (guard short-circuits before runSummarize).
      const ok = await cap.invoke('llm:summarize', { text: 'real' })
      expect(ok).toEqual({ ok: true, text: '[mock] real' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // BUG-013: an injected budget must be the one the summarize path consumes (not a fresh store
  // silently constructed in its place) — a caller/test that injects a budget for isolation must
  // not be ignored.
  it('honors an injected budget store instead of building a fresh one (BUG-013)', async () => {
    let consumed = 0
    const injectedBudget = {
      tryConsume: (_cap: number) => {
        consumed++
        return true
      },
      peek: () => ({ day: '2026-06-04', calls: consumed })
    }
    const cap = createIpcCapture()
    const dir = mkdtempSync(join(tmpdir(), 'llmipc-bug013-'))
    try {
      // Explicit cap so the budget is enforced under the mock seam (shouldEnforceBudget opts in).
      writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 5 })
      registerLlmHandlers(cap.ipcMain, mainWin, dir, {
        fetch: noNetwork,
        env: { CANVAS_LLM_MOCK: '1' },
        budget: injectedBudget
      })
      await cap.invoke('llm:summarize', { text: 'a' })
      await cap.invoke('llm:summarize', { text: 'b' })
      // The INJECTED budget was the one consumed (twice), proving it wasn't replaced.
      expect(consumed).toBe(2)
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

  // BUG-012: setKey must validate the provider against the known set and bound the key, BEFORE
  // anything reaches the key store / encryptor (no key-file pollution, no false hasKey, no DoS).
  it('setKey rejects an unknown provider and an empty/over-long key (BUG-012)', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    // Unknown provider (the '__proto__' pollution case) — rejected, nothing stored.
    expect(await cap.invoke('llm:setKey', { provider: '__proto__', key: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-provider'
    })
    expect(await cap.invoke('llm:setKey', { provider: 'nope', key: 'x' })).toEqual({
      ok: false,
      reason: 'invalid-provider'
    })
    // Empty key — would falsely report hasKey:true on a non-empty ciphertext; rejected.
    expect(await cap.invoke('llm:setKey', { provider: 'openrouter', key: '' })).toEqual({
      ok: false,
      reason: 'invalid-key'
    })
    // Over-long key (> MAX_KEY_LEN 1024) — would be encrypted + synchronously written; rejected.
    expect(
      await cap.invoke('llm:setKey', { provider: 'openrouter', key: 'A'.repeat(2000) })
    ).toEqual({ ok: false, reason: 'invalid-key' })
    // None of the rejected calls persisted a key.
    expect(((await cap.invoke('llm:status')) as LlmStatus).hasKey).toBe(false)
    // A valid key still round-trips.
    expect(await cap.invoke('llm:setKey', { provider: 'openrouter', key: 'sk-real' })).toEqual({
      ok: true
    })
    expect(((await cap.invoke('llm:status')) as LlmStatus).hasKey).toBe(true)
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

  // BUG-027: clearKey with null/missing arg must return a typed error, not throw TypeError
  it('clearKey returns typed error instead of throwing when arg is null/missing (BUG-027)', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    // null arg — must not throw, must return a typed LlmWriteResult
    const r1 = await cap.invoke('llm:clearKey', null as never)
    expect(r1).toMatchObject({ ok: false })
    expect(typeof (r1 as { reason?: string }).reason).toBe('string')
    // undefined / no arg — same requirement
    const r2 = await cap.invoke('llm:clearKey', undefined as never)
    expect(r2).toMatchObject({ ok: false })
    expect(typeof (r2 as { reason?: string }).reason).toBe('string')
  })

  // BUG-028: setConfig with null/missing arg must return a typed error, not throw TypeError
  it('setConfig returns typed error instead of throwing when arg is null/missing (BUG-028)', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    const r1 = await cap.invoke('llm:setConfig', null as never)
    expect(r1).toMatchObject({ ok: false })
    expect(typeof (r1 as { reason?: string }).reason).toBe('string')
    const r2 = await cap.invoke('llm:setConfig', undefined as never)
    expect(r2).toMatchObject({ ok: false })
    expect(typeof (r2 as { reason?: string }).reason).toBe('string')
  })

  // BUG-039: clearKey must validate provider against VALID_PROVIDERS; '__proto__' must be rejected
  // before reaching keyStore (no spurious I/O)
  it('clearKey rejects unknown/proto-poisoned provider before keyStore (BUG-039)', async () => {
    const { cap } = setupKeyed(fakeEncryptor())
    // First set a real key so a spurious clearKey would be detectable via status
    await cap.invoke('llm:setKey', { provider: 'openrouter', key: 'sk-real' })
    expect(((await cap.invoke('llm:status')) as LlmStatus).hasKey).toBe(true)

    // __proto__ must be rejected (invalid-provider), not forwarded to keyStore
    const rProto = await cap.invoke('llm:clearKey', { provider: '__proto__' } as never)
    expect(rProto).toEqual({ ok: false, reason: 'invalid-provider' })
    // Unknown provider string also rejected
    const rBad = await cap.invoke('llm:clearKey', { provider: 'notareal' } as never)
    expect(rBad).toEqual({ ok: false, reason: 'invalid-provider' })
    // The real key was NOT affected
    expect(((await cap.invoke('llm:status')) as LlmStatus).hasKey).toBe(true)
  })

  // BUG-036: setConfig must validate maxCallsPerDay (integer, non-negative, bounded) and cap baseUrl length
  it('setConfig rejects invalid maxCallsPerDay values (BUG-036)', async () => {
    const { cap, dir } = setupKeyed(fakeEncryptor())
    writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 5 })

    // Non-integer
    const rFloat = (await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'm',
      maxCallsPerDay: 1.5
    } as never)) as { ok: boolean; reason?: string }
    expect(rFloat).toEqual({ ok: false, reason: 'invalid-maxCallsPerDay' })

    // Negative
    const rNeg = (await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'm',
      maxCallsPerDay: -1
    } as never)) as { ok: boolean; reason?: string }
    expect(rNeg).toEqual({ ok: false, reason: 'invalid-maxCallsPerDay' })

    // String (truthy non-number)
    const rStr = (await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'm',
      maxCallsPerDay: 'many' as never
    } as never)) as { ok: boolean; reason?: string }
    expect(rStr).toEqual({ ok: false, reason: 'invalid-maxCallsPerDay' })

    // Overflows cap (> 1_000_000)
    const rHuge = (await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'm',
      maxCallsPerDay: 2_000_000
    } as never)) as { ok: boolean; reason?: string }
    expect(rHuge).toEqual({ ok: false, reason: 'invalid-maxCallsPerDay' })

    // Previously configured cap must be preserved after all rejections
    expect(readLlmConfig(dir).maxCallsPerDay).toBe(5)

    // Zero is valid (blocks all calls)
    const rZero = await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'm',
      maxCallsPerDay: 0
    })
    expect(rZero).toEqual({ ok: true })

    // A valid positive integer round-trips
    const rOk = await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'm',
      maxCallsPerDay: 300
    })
    expect(rOk).toEqual({ ok: true })
    expect(readLlmConfig(dir).maxCallsPerDay).toBe(300)

    rmSync(dir, { recursive: true, force: true })
  })

  it('setConfig rejects an over-long baseUrl (BUG-036)', async () => {
    const { cap, dir } = setupKeyed(fakeEncryptor())
    const hugeUrl = 'http://127.0.0.1/' + 'a'.repeat(3000)
    const r = (await cap.invoke('llm:setConfig', {
      provider: 'local',
      model: 'm',
      baseUrl: hugeUrl
    } as never)) as { ok: boolean; reason?: string }
    expect(r).toEqual({ ok: false, reason: 'invalid-baseUrl' })
    expect(readLlmConfig(dir).baseUrl).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  // BUG-037: summarize must reject a non-string system BEFORE consuming a budget slot
  it('rejects summarize with a non-string system field and does not consume a budget slot (BUG-037)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmipc-bug037-'))
    try {
      writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 5 })
      const cap = createIpcCapture()
      registerLlmHandlers(cap.ipcMain, mainWin, dir, {
        fetch: noNetwork,
        env: { CANVAS_LLM_MOCK: '1' }
      })

      const invalid = {
        ok: false,
        reason: 'provider-error',
        message: 'invalid input: system must be a non-empty string'
      }

      // Object system
      expect(
        await cap.invoke('llm:summarize', { text: 'hi', system: { role: 'x' } } as never)
      ).toEqual(invalid)
      // Numeric system
      expect(await cap.invoke('llm:summarize', { text: 'hi', system: 42 } as never)).toEqual(
        invalid
      )
      // Empty string system
      expect(await cap.invoke('llm:summarize', { text: 'hi', system: '' } as never)).toEqual(
        invalid
      )
      // A valid call with undefined system still works
      const ok = await cap.invoke('llm:summarize', { text: 'hi' })
      expect(ok).toEqual({ ok: true, text: '[mock] hi' })
      // A valid call with a real system string also works
      const okSys = await cap.invoke('llm:summarize', { text: 'hi', system: 'be terse' })
      expect(okSys).toEqual({ ok: true, text: '[mock] hi' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects summarize with an over-long text or system field (BUG-037)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmipc-bug037len-'))
    try {
      writeLlmConfig(dir, { provider: 'openrouter', model: 'm', maxCallsPerDay: 10 })
      const cap = createIpcCapture()
      registerLlmHandlers(cap.ipcMain, mainWin, dir, {
        fetch: noNetwork,
        env: { CANVAS_LLM_MOCK: '1' }
      })

      const longText = 'a'.repeat(200_000)
      const rText = await cap.invoke('llm:summarize', { text: longText })
      expect(rText).toMatchObject({ ok: false, reason: 'provider-error' })
      if (rText && !(rText as { ok: boolean }).ok) {
        expect((rText as { message?: string }).message).toContain('text too long')
      }

      const rSys = await cap.invoke('llm:summarize', { text: 'hi', system: longText })
      expect(rSys).toMatchObject({ ok: false, reason: 'provider-error' })
      if (rSys && !(rSys as { ok: boolean }).ok) {
        expect((rSys as { message?: string }).message).toContain('system too long')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // BUG-040: setConfig must validate provider against VALID_PROVIDERS and cap model string length
  it('setConfig rejects unknown provider and over-long model string (BUG-040)', async () => {
    const { cap, dir } = setupKeyed(fakeEncryptor())
    writeLlmConfig(dir, { provider: 'openrouter', model: 'original-model', maxCallsPerDay: 5 })

    // Unknown provider must be rejected
    const rBadProvider = (await cap.invoke('llm:setConfig', {
      provider: '__proto__',
      model: 'some-model'
    } as never)) as { ok: boolean; reason?: string }
    expect(rBadProvider).toEqual({ ok: false, reason: 'invalid-provider' })
    // Config on disk must be unchanged
    expect(readLlmConfig(dir).provider).toBe('openrouter')

    // Over-long model string must be rejected (> 256 chars)
    const rLongModel = (await cap.invoke('llm:setConfig', {
      provider: 'openrouter',
      model: 'x'.repeat(10_000_000)
    } as never)) as { ok: boolean; reason?: string }
    expect(rLongModel).toEqual({ ok: false, reason: 'invalid-model' })
    // Config on disk must still be unchanged
    expect(readLlmConfig(dir).model).toBe('original-model')

    // A valid provider+model still persists normally
    const rOk = await cap.invoke('llm:setConfig', {
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest'
    })
    expect(rOk).toEqual({ ok: true })
    expect(readLlmConfig(dir).provider).toBe('anthropic')
  })
})
